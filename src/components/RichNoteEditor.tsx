import type { Editor, EditorEvents } from "@tiptap/core";
import { Selection } from "@tiptap/pm/state";
import { NoteMarkdown, NoteMargins } from "./editor/NoteMargins";
import { NoteImage } from "./editor/NoteImage";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import { NoteTable } from "./editor/NoteTable";
import { TablePicker } from "./editor/TablePicker";
import { EditorInsertLayer } from "./editor/EditorInsertLayer";
import { SlashMenu } from "./editor/SlashMenu";
import { NoteBlockControls } from "./editor/NoteBlockControls";
import { insertNoteBlockContent, listNoteBlocks, wrapNoteBlock, wrapSlashNoteBlock, unwrapNoteBlock } from "./editor/noteBlocks";
import { NoteBlock as NoteBlockFrame } from "./editor/NoteBlock";
import type { BlockInsertCommand } from "./editor/BlockInsertMenu";
import type { SlashCommand } from "./editor/slashCommands";
import { ExcerptPicker } from "./editor/ExcerptPicker";
import { NoteExcerpt } from "./editor/NoteExcerpt";
import { requestNoteExcerptNavigation } from "../lib/noteExcerptNavigation";
import { buildNoteExcerptContent, parseNoteExcerptTitle } from "../lib/noteExcerpts";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { JSONContent } from "@tiptap/core";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { NoteStarterKit, NoteTaskItem } from "./editor/NoteStarterKit";
import { NoteTextAlignment } from "./editor/NoteTextAlignment";
import { mergeSavedChatPassages, savedChatEvidence, splitSavedChatPassages } from "../lib/chatCitations";
import { citedPassageStatus } from "./CitedPassage";
import { nanoid } from "nanoid";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  AIWritingAction,
  AIWritingLength,
  AIWritingRequestInput,
} from "../lib/aiWriting";
import type {
  AIImageContextMode,
  AIImageQuality,
  AIImageProposal,
  AIImageRequestInput,
  ImageGenerationProgress,
} from "../lib/aiImages";
import { ImageGenerationSession } from "../lib/aiImages";
import {
  findConceptByPhrase,
  type RegisterWikiLinkInput,
} from "../lib/concepts";
import {
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
} from "../lib/markdown";
import {
  imageFilesFromTransfer,
  noteImageAlt,
  NOTE_IMAGE_ACCEPT,
} from "../lib/noteImages";
import { persistGeneratedNoteImage, saveNoteImage } from "../lib/storage";
import {
  canonicalizeSourceCitations,
  type SourceCitationReference,
} from "../lib/sourceCitations";
import type { Concept, EntityId, Note, NoteTypeface, Source } from "../types";
import {
  AIWritingControls,
  type AIWritingControlPosition,
  type AIWritingPhase,
} from "./AIWritingControls";
import { ConceptLinkPopover } from "./ConceptLinkPopover";
import { EditorToolbar } from "./EditorToolbar";
import { MarginsControl } from "./editor/MarginsControl";
import { NativeFormattingDock } from "./editor/NativeFormattingDock";
import { SourceCitationPopover } from "./SourceCitationPopover";
import { SourceReferences } from "./SourceReferences";
import { AutoConceptLinks } from "./editor/AutoConceptLinks";
import {
  applyConceptLinkToEditor,
  captureConceptLinkSelection,
  isConceptLinkDocumentCurrent,
  type ConceptLinkSelection,
} from "./editor/conceptLinkSelection";
import { FindInNote, findInNotePluginKey } from "./editor/FindInNote";
import { insertVoiceTranscriptAt } from "./editor/voiceDictation";
import { AIWritingPreview } from "./editor/AIWritingPreview";
import {
  acceptAIWritingPreview,
  acceptAIImagePreview,
  captureAIWritingSelection,
  clearAIWritingPreview,
  isAIWritingCaptureCurrent,
  parseAIWritingProposal,
  parseAIImagePreview,
  showAIWritingPreview,
  type AIWritingCapture,
  type AIWritingParsedProposal,
} from "./editor/aiWritingTransaction";
import { resolveAIWritingSelectionPosition } from "./editor/aiWritingPosition";

export interface AIImageGenerationCallbacks {
  session?: ImageGenerationSession;
  onProgress?: (progress: ImageGenerationProgress) => void;
}

interface RichNoteEditorProps {
  noteTypeface?: NoteTypeface;
  onNoteTypefaceChange?: (typeface: NoteTypeface) => void;
  noteId: EntityId;
  markdown: string;
  notes: readonly Note[];
  concepts: readonly Concept[];
  sources: readonly Source[];
  attachedSourceIds: readonly EntityId[];
  onChange: (markdown: string) => void;
  onAttachSource: (sourceId: EntityId) => void;
  onOpenSource?: (sourceId: EntityId) => void;
  onOpenNote?: (noteId: EntityId) => void;
  onRegisterConcept: (input: RegisterWikiLinkInput) => EntityId;
  onGenerateLinkTitle?: (selectedContext: string, signal?: AbortSignal) => Promise<string>;
  onGenerateAIWriting?: (
    input: Omit<AIWritingRequestInput, "originNoteId">,
  ) => Promise<string>;
  onGenerateAIImage?: (
    input: Omit<AIImageRequestInput, "originNoteId">,
    signal: AbortSignal,
    callbacks?: AIImageGenerationCallbacks,
  ) => Promise<AIImageProposal>;
  onDisableConceptAutoLink: (conceptId: EntityId) => void;
  onPrepareVoiceMemoSession?: (sessionId: string) => Promise<void>;
  onTranscribeVoiceMemo?: (audio: Blob, sessionId: string) => Promise<string>;
  onFinishVoiceMemoSession?: (sessionId: string) => Promise<void>;
  aiArticleWritingEnabled?: boolean;
  aiImageGenerationEnabled?: boolean;
  imageContextEnabled?: boolean;
  aiProviderName?: string;
  findQuery?: string;
  onFindDecorationsChanged?: () => void;
}

interface LinkDraft extends ConceptLinkSelection {
  initialPhrase: string;
  initialDestinationIds: EntityId[];
  documentMarkdown: string;
}

interface CitationDraft {
  position: number;
}

interface AIWritingOperation {
  kind: "writing";
  phase: Exclude<AIWritingPhase, "idle">;
  requestId: number;
  action: AIWritingAction;
  length: AIWritingLength;
  instruction: string;
  capture: AIWritingCapture;
  proposal?: AIWritingParsedProposal;
  error?: string;
}

interface AIImageOperation {
  kind: "image";
  phase: Exclude<AIWritingPhase, "idle">;
  requestId: number;
  instruction: string;
  capture: AIWritingCapture;
  assetId: string;
  quality: AIImageQuality;
  contextMode: AIImageContextMode;
  session: ImageGenerationSession;
  progress?: ImageGenerationProgress;
  contextPartial?: boolean;
  image?: AIImageProposal;
  proposal?: AIWritingParsedProposal;
  error?: string;
}

type AIOperation = AIWritingOperation | AIImageOperation;

const HIDDEN_AI_CONTROL: AIWritingControlPosition = {
  left: 0,
  visible: false,
};

function sameCitationReferences(
  left: readonly SourceCitationReference[],
  right: readonly SourceCitationReference[],
) {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index];
      return (
        reference.available === candidate.available &&
        reference.number === candidate.number &&
        reference.sourceId === candidate.sourceId &&
        reference.title === candidate.title
      );
    })
  );
}

export function RichNoteEditor({
  noteTypeface = "sans",
  onNoteTypefaceChange,
  noteId,
  markdown,
  notes,
  concepts,
  sources,
  attachedSourceIds,
  onChange,
  onAttachSource,
  onOpenSource,
  onOpenNote,
  onRegisterConcept,
  onGenerateLinkTitle,
  onGenerateAIWriting,
  onGenerateAIImage,
  onDisableConceptAutoLink,
  onPrepareVoiceMemoSession,
  onTranscribeVoiceMemo,
  onFinishVoiceMemoSession,
  aiArticleWritingEnabled = false,
  aiImageGenerationEnabled = false,
  imageContextEnabled = false,
  aiProviderName,
  findQuery = "",
  onFindDecorationsChanged,
}: RichNoteEditorProps) {
  const [initialDocument] = useState(() => {
    const document = splitMarkdownFrontmatter(markdown);
    const citations = canonicalizeSourceCitations(document.content, sources);
    const passages = splitSavedChatPassages(citations.body);
    return {
      content: passages.body,
      passages,
      prefix: document.prefix,
      references: citations.references,
    };
  });
  const conceptsRef = useRef(concepts);
  const notesRef = useRef(notes);
  const sourcesRef = useRef(sources);
  const onChangeRef = useRef(onChange);
  const onOpenNoteRef = useRef(onOpenNote);
  const frontmatterRef = useRef(initialDocument.prefix);
  const savedPassagesRef = useRef(initialDocument.passages.footer);
  const [savedPassages, setSavedPassages] = useState(initialDocument.passages.evidence);
  const lastEmittedMarkdownRef = useRef(markdown);
  const pendingMarkdownEchoesRef = useRef(new Set<string>());
  const findQueryRef = useRef(findQuery);
  const onFindDecorationsChangedRef = useRef(onFindDecorationsChanged);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const imageUploadActiveRef = useRef(false);
  const voiceMemoInsertionRef = useRef<{
    sessionId: string;
    position: number;
    editor: Editor;
    track: (event: EditorEvents["transaction"]) => void;
  } | null>(null);
  const aiRequestIdRef = useRef(0);
  const aiOperationRef = useRef<AIOperation | null>(null);
  const aiImageAbortRef = useRef<AbortController | null>(null);
  const aiSelectionRef = useRef({ from: 0, to: 0, empty: true });
  const slashImageInputRef = useRef<HTMLInputElement>(null);
  const [pendingInsert, setPendingInsert] = useState<{kind:"table"|"excerpt"|"link"|"image";range:{from:number;to:number};document:ProseMirrorNode;block?:boolean}|null>(null);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [linkTitleBusy, setLinkTitleBusy] = useState(false);
  const [citationDraft, setCitationDraft] = useState<CitationDraft | null>(null);
  const [citationReferences, setCitationReferences] = useState<
    SourceCitationReference[]
  >(initialDocument.references);
  const [imageBusy, setImageBusy] = useState(false);
  const [marginsVisible, setMarginsVisible] = useState(false);
  const toggleMargins = useCallback(() => setMarginsVisible(visible => !visible), []);
  const closeMargins = useCallback(() => setMarginsVisible(false), []);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [aiWritingActive, setAIWritingActive] = useState(false);
  const [aiOperation, setAIOperation] = useState<AIOperation | null>(null);
  const [aiSelectionEmpty, setAISelectionEmpty] = useState(true);
  const [aiSelectionPosition, setAISelectionPosition] =
    useState<AIWritingControlPosition>(HIDDEN_AI_CONTROL);
  const [aiDockPosition, setAIDockPosition] =
    useState<AIWritingControlPosition>(HIDDEN_AI_CONTROL);
  const [announcement, setAnnouncement] = useState(
    "Editing note. Formatting tools are available.",
  );
  conceptsRef.current = concepts;
  notesRef.current = notes;
  sourcesRef.current = sources;
  onChangeRef.current = onChange;
  onOpenNoteRef.current = onOpenNote;
  findQueryRef.current = findQuery;
  onFindDecorationsChangedRef.current = onFindDecorationsChanged;
  aiOperationRef.current = aiOperation;

  const extensions = useMemo(
    () => [
      NoteStarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          autolink: true,
          openOnClick: false,
          enableClickSelection: true,
          protocols: ["orion-note", "orion-concept", "orion-source"],
          HTMLAttributes: {
            target: null,
            rel: null,
            class: "editor-explicit-link",
          },
        },
      }),
      TableKit.configure({ table: false }),
      NoteTable,
      NoteBlockFrame,
      NoteExcerpt,
      TaskList,
      NoteTaskItem.configure({ nested: true }),
      NoteTextAlignment,
      NoteMargins,
      Placeholder.configure({
        placeholder: "Start writing…",
        emptyEditorClass: "is-editor-empty",
      }),
      NoteImage.configure({
        allowBase64: true,
        HTMLAttributes: {
          class: "note-embedded-image",
        },
      }),
      NoteMarkdown.configure({
        markedOptions: { gfm: true },
      }),
      AutoConceptLinks.configure({
        getConcepts: () => conceptsRef.current,
        excludeNoteId: noteId,
      }),
      FindInNote.configure({
        getQuery: () => findQueryRef.current,
      }),
      AIWritingPreview,
    ],
    [noteId],
  );

  const editor = useEditor(
    {
      extensions,
      content: initialDocument.content,
      contentType: "markdown",
      editorProps: {
        attributes: {
          role: "textbox",
          "aria-label": "Note body",
          "aria-multiline": "true",
          spellcheck: "true",
        },
        handleClick: (view, _pos, event) => {
          const anchor=(event.target as HTMLElement).closest<HTMLAnchorElement>('a[data-note-excerpt-source]');
          const href=anchor?.getAttribute("href");
          const id=href?.startsWith("orion-note://") ? href.slice("orion-note://".length) : undefined;
          const openNote=onOpenNoteRef.current;
          if (!anchor || !id || !notesRef.current.some(candidate=>candidate.id===id) || !openNote) return false;
          try {
            const position=view.posAtDOM(anchor,0);
            const node=view.state.doc.nodeAt(position);
            const mark=node?.marks.find(mark=>mark.type.name==="link");
            const passage=parseNoteExcerptTitle(mark?.attrs.title,href??undefined);
            if(passage)requestNoteExcerptNavigation(id,passage.passages);
          } catch { /* A changed source still opens through its stable note ID. */ }
          event.preventDefault();openNote(id);return true;
        },
        handlePaste: (_view, event) => {
          const files = imageFilesFromTransfer(event.clipboardData?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          void insertNoteImages(files);
          return true;
        },
        handleDrop: (view, event) => {
          const files = imageFilesFromTransfer(event.dataTransfer?.files ?? []);
          if (files.length === 0) return false;
          event.preventDefault();
          setImageDragActive(false);
          const coordinates = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });
          void insertNoteImages(files, coordinates?.pos);
          return true;
        },
      },
      onUpdate: ({ editor: current }) => {
        const citations = canonicalizeSourceCitations(
          mergeSavedChatPassages(current.getMarkdown(), savedPassagesRef.current),
          sourcesRef.current,
        );
        setSavedPassages(savedChatEvidence(citations.body));
        const nextMarkdown = restoreMarkdownFrontmatter(
          frontmatterRef.current,
          citations.markdown,
        );
        setCitationReferences((current) =>
          sameCitationReferences(current, citations.references)
            ? current
            : citations.references,
        );
        lastEmittedMarkdownRef.current = nextMarkdown;
        pendingMarkdownEchoesRef.current.add(nextMarkdown);
        onChangeRef.current(nextMarkdown);
      },
    },
    [noteId],
  );
  editorRef.current = editor;
  const blockSelected = useEditorState({ editor, selector: ({ editor: current }) => current?.isActive("noteBlock") ?? false }) ?? false;

  useEffect(() => {
    const input=slashImageInputRef.current;
    const cancel=()=>{setPendingInsert(null);editor?.commands.focus();};
    input?.addEventListener("cancel",cancel);
    return ()=>input?.removeEventListener("cancel",cancel);
  },[editor]);

  useEffect(() => () => clearVoiceMemoInsertion(), [noteId]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (
        document.activeElement instanceof HTMLInputElement ||
        document.activeElement instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (editor.isDestroyed) return;
      // Selection.atStart can be a photo NodeSelection. Enter writing at the
      // first text caret, without revealing image controls or moving the pane.
      const caret = Selection.findFrom(editor.state.doc.resolve(0), 1, true);
      if (caret) editor.commands.setTextSelection(caret.from);
      editor.commands.focus(undefined, { scrollIntoView: false });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    const pendingEchoes = pendingMarkdownEchoesRef.current;
    if (markdown === lastEmittedMarkdownRef.current) {
      pendingEchoes.clear();
      return;
    }
    // A parent render can acknowledge an earlier local edit after another
    // pointer move has already changed the document. Consume that echo without
    // setContent: replacing the document here rewinds the drag and selection.
    // Retire acknowledged values so a later external revert still applies.
    if (pendingEchoes.has(markdown)) {
      for (const value of pendingEchoes) {
        pendingEchoes.delete(value);
        if (value === markdown) break;
      }
      return;
    }
    pendingEchoes.clear();
    const pendingAIWriting = aiOperationRef.current;
    if (pendingAIWriting) {
      aiRequestIdRef.current += 1;
      aiImageAbortRef.current?.abort();
      aiImageAbortRef.current = null;
      if (pendingAIWriting.kind === "image") pendingAIWriting.session.clear();
      clearAIWritingPreview(editor, pendingAIWriting.capture, false);
      editor.setEditable(true, false);
      aiOperationRef.current = null;
      setAIOperation(null);
      setAnnouncement(
        "AI writing was cancelled because this note changed elsewhere.",
      );
    }
    const nextDocument = splitMarkdownFrontmatter(markdown);
    const citations = canonicalizeSourceCitations(
      nextDocument.content,
      sourcesRef.current,
    );
    frontmatterRef.current = nextDocument.prefix;
    const passages = splitSavedChatPassages(citations.body);
    savedPassagesRef.current = passages.footer;
    setSavedPassages(passages.evidence);
    editor.commands.setContent(passages.body, {
      contentType: "markdown",
      emitUpdate: false,
    });
    setCitationReferences((current) =>
      sameCitationReferences(current, citations.references)
        ? current
        : citations.references,
    );
    lastEmittedMarkdownRef.current = markdown;
  }, [editor, markdown]);

  const updateAIControlPositions = useCallback(() => {
    if (!editor || editor.isDestroyed || !editorShellRef.current) return;
    const shell = editorShellRef.current;
    const workspace = shell.closest<HTMLElement>(".workspace-content");
    const prose = shell.querySelector<HTMLElement>(".editor-prose");
    if (!workspace || !prose) {
      setAISelectionPosition(HIDDEN_AI_CONTROL);
      setAIDockPosition(HIDDEN_AI_CONTROL);
      return;
    }

    const workspaceRect = workspace.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const proseRect = prose.getBoundingClientRect();
    const editorVisible =
      shellRect.bottom > workspaceRect.top + 54 &&
      shellRect.top < workspaceRect.bottom - 24;
    const dockLeft = clampNumber(
      proseRect.left + proseRect.width / 2,
      workspaceRect.left + 92,
      workspaceRect.right - 92,
    );
    const nextDock = editorVisible
      ? {
          left: dockLeft,
          bottom: Math.max(
            16,
            window.innerHeight - workspaceRect.bottom + 18,
          ),
          visible: true,
        }
      : HIDDEN_AI_CONTROL;
    setAIDockPosition((current) =>
      sameAIControlPosition(current, nextDock) ? current : nextDock,
    );

    const aiSelection = aiSelectionRef.current;
    if (aiSelection.empty || !editorVisible) {
      setAISelectionPosition((current) =>
        current.visible ? HIDDEN_AI_CONTROL : current,
      );
      return;
    }
    try {
      const start = editor.view.coordsAtPos(aiSelection.from);
      const end = editor.view.coordsAtPos(aiSelection.to);
      const toolbarBottom =
        shell
          .querySelector<HTMLElement>(".editor-formatting-dock, .editor-toolbar-shell")
          ?.getBoundingClientRect().bottom ?? workspaceRect.top + 44;
      const nextSelection = resolveAIWritingSelectionPosition({
        workspace: workspaceRect,
        toolbarBottom,
        start,
        end,
      });
      setAISelectionPosition((current) =>
        sameAIControlPosition(current, nextSelection)
          ? current
          : nextSelection,
      );
    } catch {
      setAISelectionPosition((current) =>
        current.visible ? HIDDEN_AI_CONTROL : current,
      );
    }
  }, [editor]);

  useEffect(() => {
    if (!editor || !aiWritingActive) return undefined;
    const syncSelection = () => {
      const { from, to, empty } = editor.state.selection;
      aiSelectionRef.current = { from, to, empty };
      setAISelectionEmpty((current) =>
        current === empty ? current : empty,
      );
      updateAIControlPositions();
    };
    syncSelection();
    editor.on("selectionUpdate", syncSelection);
    return () => {
      editor.off("selectionUpdate", syncSelection);
    };
  }, [aiWritingActive, editor, updateAIControlPositions]);

  useEffect(() => {
    if (!editor || !aiWritingActive || !editorShellRef.current) {
      return undefined;
    }
    const shell = editorShellRef.current;
    const workspace = shell.closest<HTMLElement>(".workspace-content");
    const frame = window.requestAnimationFrame(updateAIControlPositions);
    const handlePositionChange = () => updateAIControlPositions();
    workspace?.addEventListener("scroll", handlePositionChange, {
      passive: true,
    });
    window.addEventListener("resize", handlePositionChange);
    const observer =
      typeof ResizeObserver === "function"
        ? new ResizeObserver(handlePositionChange)
        : null;
    observer?.observe(shell);
    const prose = shell.querySelector<HTMLElement>(".editor-prose");
    if (prose) observer?.observe(prose);
    return () => {
      window.cancelAnimationFrame(frame);
      workspace?.removeEventListener("scroll", handlePositionChange);
      window.removeEventListener("resize", handlePositionChange);
      observer?.disconnect();
    };
  }, [aiWritingActive, editor, updateAIControlPositions]);

  useEffect(
    () => () => {
      aiRequestIdRef.current += 1;
      aiImageAbortRef.current?.abort();
      aiImageAbortRef.current = null;
      const operation = aiOperationRef.current;
      if (operation?.kind === "image") operation.session.clear();
      if (editor && !editor.isDestroyed) editor.setEditable(true, false);
    },
    [editor],
  );

  useEffect(() => {
    if (!editor) {
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setMeta("orionConceptVocabularyChanged", Date.now()),
    );
  }, [concepts, editor]);

  useEffect(() => {
    if (!editor) return undefined;
    editor.view.dispatch(
      editor.state.tr.setMeta(findInNotePluginKey, Date.now()),
    );
    const frame = window.requestAnimationFrame(() => {
      onFindDecorationsChangedRef.current?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor, findQuery]);

  if (!editor) {
    return null;
  }

  function beginInsert(kind:"table"|"excerpt"|"link"|"image", range={from:editor!.state.selection.from,to:editor!.state.selection.to}, block = false) {
    if (!editor || !editor.isEditable) return;
    setPendingInsert({kind,range,document:editor.state.doc,block});
    if (kind === "image") slashImageInputRef.current?.click();
  }

  function cancelInsert() {
    setPendingInsert(null);
    editor?.commands.focus();
  }

  function insertPickerContent(content:JSONContent[]) {
    if (!editor || !pendingInsert) return;
    if (!editor.state.doc.eq(pendingInsert.document)) {
      setPendingInsert(null);
      setAnnouncement("This note changed while the picker was open. Open the picker again at your cursor.");
      return;
    }
    if (pendingInsert.block) {
      const children = content.every(item => item.type === "text" || item.type === "hardBreak")
        ? [{ type: "paragraph", content }] : content;
      insertNoteBlockContent(editor, pendingInsert.range.from, { type: "noteBlock", content: children });
      editor.view.focus();
    } else editor.chain().focus().insertContentAt(pendingInsert.range,content).run();
    setPendingInsert(null);
  }

  function insertBlock(command: BlockInsertCommand, position: number) {
    if (!editor?.isEditable) return;
    if (["table", "excerpt", "link", "image"].includes(command)) {
      beginInsert(command as "table" | "excerpt" | "link" | "image", { from: position, to: position }, true);
      return;
    }
    const paragraph = { type: "paragraph" };
    let content: JSONContent = paragraph;
    if (/^h[1-6]$/.test(command)) content = { type: "heading", attrs: { level: Number(command[1]) } };
    else if (command === "divider") content = { type: "horizontalRule" };
    else if (command === "code") content = { type: "codeBlock" };
    else if (["todo", "bullet", "numbered"].includes(command)) content = {
      type: command === "todo" ? "taskList" : command === "bullet" ? "bulletList" : "orderedList",
      content: [{ type: command === "todo" ? "taskItem" : "listItem", content: [paragraph] }],
    };
    if (insertNoteBlockContent(editor, position, { type: "noteBlock", content: [content] })) {
      editor.view.focus();
      setAnnouncement("Block inserted. Start typing, or use the formatting tools.");
    }
  }

  function runSlashCommand(command:SlashCommand, range:{from:number;to:number}) {
    if (!editor?.isEditable) return;
    if (command === "block") {
      if (wrapSlashNoteBlock(editor, range)) setAnnouncement("Block ready. Enter starts the next block; Shift+Enter adds a line break.");
      return;
    }
    if (["table","excerpt","link","image"].includes(command)) {
      beginInsert(command as "table"|"excerpt"|"link"|"image",range);return;
    }
    const chain=editor.chain().focus().deleteRange(range);
    if (/^h[1-6]$/.test(command)) chain.setHeading({level:Number(command[1]) as 1|2|3|4|5|6}).run();
    else switch(command) {
      case "todo":chain.toggleTaskList().run();break;
      case "bullet":chain.toggleBulletList().run();break;
      case "numbered":chain.toggleOrderedList().run();break;
      case "divider":chain.setHorizontalRule().run();break;
      case "code":chain.setCodeBlock().run();break;
      case "delete-row":chain.deleteRow().run();break;
      case "delete-column":chain.deleteColumn().run();break;
      case "delete-table":chain.deleteTable().run();break;
    }
  }

  function setCurrentAIOperation(operation: AIOperation | null) {
    aiOperationRef.current = operation;
    setAIOperation(operation);
  }

  async function insertNoteImages(
    files: readonly File[],
    requestedPosition?: number,
    replacementRange?: { from: number; to: number },
    blockInsertion = false,
  ) {
    const currentEditor = editorRef.current;
    if (
      !currentEditor ||
      currentEditor.isDestroyed ||
      !currentEditor.isEditable ||
      imageUploadActiveRef.current
    ) {
      return;
    }
    const selected = files.slice(0, 8);
    const insertion = replacementRange ? { ...replacementRange } : {
      from: requestedPosition ?? currentEditor.state.selection.to,
      to: requestedPosition ?? currentEditor.state.selection.to,
    };
    const replacedText = currentEditor.state.doc.textBetween(insertion.from, insertion.to);
    const trackInsertion = ({ transaction }: EditorEvents["transaction"]) => {
      const collapsed = insertion.from === insertion.to;
      insertion.from = transaction.mapping.map(insertion.from, 1);
      insertion.to = collapsed ? insertion.from : transaction.mapping.map(insertion.to, -1);
    };
    currentEditor.on("transaction", trackInsertion);
    imageUploadActiveRef.current = true;
    setImageBusy(true);
    setAnnouncement(
      selected.length === 1 ? "Adding image…" : `Adding ${selected.length} images…`,
    );
    try {
      const results = await Promise.allSettled(
        selected.map((file) =>
          saveNoteImage(file, `image_${nanoid(18)}`).then((attachment) => ({
            attachment,
            alt: noteImageAlt(file.name),
          })),
        ),
      );
      if (currentEditor.isDestroyed) return;
      const images = results.flatMap((result) =>
        result.status === "fulfilled"
          ? [
              {
                type: "image",
                attrs: {
                  src: result.value.attachment.src,
                  alt: result.value.alt,
                  title: result.value.attachment.fileName,
                },
              },
            ]
          : [],
      );
      if (images.length > 0) {
        if (replacementRange && (insertion.to < insertion.from ||
          currentEditor.state.doc.textBetween(insertion.from, insertion.to) !== replacedText)) {
          setAnnouncement("The image insertion text changed. Insert the image again at your cursor.");
          return;
        }
        if (blockInsertion) {
          if (!insertNoteBlockContent(currentEditor, insertion.from, images.map(image => ({ type: "noteBlock", content: [image] })))) {
            setAnnouncement("The insertion point changed. Choose a block boundary again.");
            return;
          }
          currentEditor.view.focus();
        } else currentEditor.chain().focus().insertContentAt(insertion, images).run();
      }
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        const first = failures[0] as PromiseRejectedResult;
        setAnnouncement(
          `${images.length > 0 ? `${images.length} added. ` : ""}${
            first.reason instanceof Error ? first.reason.message : String(first.reason)
          }`,
        );
      } else {
        setAnnouncement(
          images.length === 1 ? "Image added." : `${images.length} images added.`,
        );
      }
    } finally {
      currentEditor.off("transaction", trackInsertion);
      imageUploadActiveRef.current = false;
      setImageBusy(false);
    }
  }

  function startVoiceMemoAtCaret(sessionId: string) {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed) {
      return Promise.reject(new Error("This note is no longer editable."));
    }
    clearVoiceMemoInsertion();
    const insertion = {
      sessionId,
      position: currentEditor.state.selection.to,
      editor: currentEditor,
      track: (_event: EditorEvents["transaction"]) => {},
    };
    insertion.track = ({
      transaction,
    }: EditorEvents["transaction"]) => {
      if (voiceMemoInsertionRef.current === insertion) {
        insertion.position = transaction.mapping.map(insertion.position, 1);
      }
    };
    voiceMemoInsertionRef.current = insertion;
    currentEditor.on("transaction", insertion.track);
    setAnnouncement("Recording dictation. Text will appear after you stop.");
    return onPrepareVoiceMemoSession?.(sessionId);
  }

  function clearVoiceMemoInsertion(sessionId?: string) {
    const insertion = voiceMemoInsertionRef.current;
    if (!insertion || (sessionId !== undefined && insertion.sessionId !== sessionId)) {
      return;
    }
    if (!insertion.editor.isDestroyed) {
      insertion.editor.off("transaction", insertion.track);
    }
    voiceMemoInsertionRef.current = null;
  }

  async function finishVoiceMemoSession(sessionId: string) {
    clearVoiceMemoInsertion(sessionId);
    await onFinishVoiceMemoSession?.(sessionId);
  }

  async function insertCompletedVoiceMemo(
    sessionId: string,
    transcript: string,
  ) {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.isDestroyed) return;
    const insertion = voiceMemoInsertionRef.current;
    const insertionPosition =
      insertion?.sessionId === sessionId
        ? insertion.position
        : currentEditor.state.selection.to;
    try {
      if (
        !insertVoiceTranscriptAt(currentEditor, insertionPosition, transcript)
      ) {
        throw new Error(
          "Orion could not insert the dictation at this cursor position.",
        );
      }
      setAnnouncement("Dictation inserted at the cursor. Undo is available.");
    } finally {
      clearVoiceMemoInsertion(sessionId);
    }
  }

  function toggleAIWriting() {
    const writingAvailable = aiArticleWritingEnabled && Boolean(onGenerateAIWriting);
    const imageAvailable = aiImageGenerationEnabled && Boolean(onGenerateAIImage);
    if (!writingAvailable && !imageAvailable) {
      setAnnouncement(
        `Add an ${aiProviderName ?? "AI provider"} key in Settings to use AI tools.`,
      );
      return;
    }
    if (aiWritingActive) {
      discardAIWriting(false);
      setAIWritingActive(false);
      setAISelectionPosition(HIDDEN_AI_CONTROL);
      setAIDockPosition(HIDDEN_AI_CONTROL);
      setAnnouncement("AI mode off.");
      return;
    }
    setLinkDraft(null);
    setCitationDraft(null);
    const { from, to, empty } = editor.state.selection;
    aiSelectionRef.current = { from, to, empty };
    setAISelectionEmpty(empty);
    setAIWritingActive(true);
    setAnnouncement(
      empty
        ? writingAvailable
          ? "AI mode on. Continue is available at the bottom of the note."
          : "AI mode on. Select a passage to generate an image."
        : imageAvailable
          ? writingAvailable
            ? "AI mode on. Rewrite and image generation are available for the selection."
            : "AI mode on. Generate image is available for the selected text."
          : "AI mode on. Rewrite is available for the selected text.",
    );
    window.requestAnimationFrame(updateAIControlPositions);
  }

  function requestAIWriting(
    action: AIWritingAction,
    length: AIWritingLength,
    instruction: string,
  ) {
    if (aiOperationRef.current) return;
    let capture: AIWritingCapture;
    try {
      capture = captureAIWritingSelection(editor, length);
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : String(error));
      return;
    }
    if (action !== "continue" && capture.empty) {
      setAnnouncement("Select the passage you want Orion to revise.");
      return;
    }
    void runAIWritingRequest({ action, length, instruction, capture });
  }

  async function runAIWritingRequest(input: {
    action: AIWritingAction;
    length: AIWritingLength;
    instruction: string;
    capture: AIWritingCapture;
  }) {
    if (!onGenerateAIWriting || !aiArticleWritingEnabled) return;
    const requestId = aiRequestIdRef.current + 1;
    aiRequestIdRef.current = requestId;
    clearAIWritingPreview(editor, input.capture, false);
    editor.setEditable(false, false);
    const generating: AIWritingOperation = {
      kind: "writing",
      phase: "generating",
      requestId,
      ...input,
    };
    setCurrentAIOperation(generating);
    setAnnouncement(
      input.action === "continue"
        ? "Orion is continuing this note."
        : `Orion is preparing a ${input.action} revision.`,
    );

    try {
      const markdown = await onGenerateAIWriting({
        action: input.action,
        length: input.length,
        instruction: input.instruction,
        documentMarkdown: input.capture.documentMarkdown,
        selectedMarkdown: input.capture.selectedMarkdown,
        selectedText: input.capture.selectedText,
        caretContext: {
          beforeMarkdown: input.capture.beforeMarkdown,
          afterMarkdown: input.capture.afterMarkdown,
        },
      });
      if (
        requestId !== aiRequestIdRef.current ||
        editor.isDestroyed ||
        !isAIWritingCaptureCurrent(editor, input.capture)
      ) {
        if (
          requestId === aiRequestIdRef.current &&
          !editor.isDestroyed
        ) {
          discardAIWriting(false);
          setAnnouncement(
            "The note changed while Orion was writing, so the proposal was discarded.",
          );
        }
        return;
      }
      const proposal = parseAIWritingProposal(
        editor,
        input.capture,
        markdown,
      );
      if (!showAIWritingPreview(editor, input.capture, proposal)) {
        throw new Error(
          "The note changed before Orion could show this proposal. Try again.",
        );
      }
      setCurrentAIOperation({
        ...generating,
        phase: "preview",
        proposal,
      });
      setAnnouncement(
        "AI writing proposal ready. Accept, try again, or discard it.",
      );
      window.requestAnimationFrame(updateAIControlPositions);
    } catch (error) {
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      setCurrentAIOperation({
        ...generating,
        phase: "error",
        error: message,
      });
      setAnnouncement(`AI writing paused. ${message}`);
    }
  }

  function requestAIImage(instruction: string, options?: { quality: AIImageQuality; contextMode: AIImageContextMode }) {
    if (aiOperationRef.current || !onGenerateAIImage || !aiImageGenerationEnabled) return;
    let capture: AIWritingCapture;
    try {
      capture = captureAIWritingSelection(editor, "paragraph");
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : String(error));
      return;
    }
    if (capture.empty) {
      setAnnouncement("Select the passage you want Orion to illustrate.");
      return;
    }
    void runAIImageRequest({ instruction, capture, assetId: `image_${nanoid(18)}`,
      quality: options?.quality ?? "detailed",
      contextMode: options?.contextMode ?? (imageContextEnabled ? "space" : "selection"),
      session: new ImageGenerationSession(),
    });
  }

  async function runAIImageRequest(input: {
    instruction: string;
    capture: AIWritingCapture;
    assetId: string;
    quality: AIImageQuality;
    contextMode: AIImageContextMode;
    session: ImageGenerationSession;
    contextPartial?: boolean;
  }) {
    if (!onGenerateAIImage || !aiImageGenerationEnabled) return;
    aiImageAbortRef.current?.abort();
    const controller = new AbortController();
    aiImageAbortRef.current = controller;
    const requestId = aiRequestIdRef.current + 1;
    aiRequestIdRef.current = requestId;
    clearAIWritingPreview(editor, input.capture, false);
    editor.setEditable(false, false);
    const generating: AIImageOperation = {
      kind: "image",
      phase: "generating",
      requestId,
      ...input,
    };
    setCurrentAIOperation(generating);
    setAnnouncement("Orion is creating an image from the selected passage.");
    let progress: ImageGenerationProgress | undefined;
    let contextPartial = input.contextPartial ?? false;
    try {
      const image = await onGenerateAIImage(
        {
          instruction: input.instruction,
          quality: input.quality,
          contextMode: input.contextMode,
          selectedMarkdown: input.capture.selectedMarkdown,
          selectedText: input.capture.selectedText,
          documentMarkdown: input.capture.documentMarkdown,
          beforeMarkdown: input.capture.beforeMarkdown,
          afterMarkdown: input.capture.afterMarkdown,
        },
        controller.signal,
        {
          session: input.session,
          onProgress: (next) => {
            if (controller.signal.aborted || requestId !== aiRequestIdRef.current || editor.isDestroyed ||
              aiOperationRef.current?.phase !== "generating") return;
            progress = next;
            contextPartial ||= Boolean(next.partial);
            setCurrentAIOperation({ ...generating, progress, contextPartial });
          },
        },
      );
      if (
        requestId !== aiRequestIdRef.current ||
        editor.isDestroyed ||
        !isAIWritingCaptureCurrent(editor, input.capture)
      ) {
        if (requestId === aiRequestIdRef.current && !editor.isDestroyed) {
          discardAIWriting(false);
          setAnnouncement(
            "The note changed while Orion was creating the image, so the preview was discarded.",
          );
        }
        return;
      }
      const proposal = parseAIImagePreview(editor, image);
      if (
        !showAIWritingPreview(editor, input.capture, proposal, {
          label: "Proposed image",
          ariaLabel: "Generated image preview",
        })
      ) {
        throw new Error("The note changed before Orion could show this image. Try again.");
      }
      setCurrentAIOperation({
        ...generating,
        phase: "preview",
        image,
        proposal,
        progress,
        contextPartial,
      });
      setAnnouncement("Generated image ready. Insert it, try again, or discard it.");
      window.requestAnimationFrame(updateAIControlPositions);
    } catch (error) {
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      setCurrentAIOperation({ ...generating, phase: "error", error: message, progress, contextPartial });
      setAnnouncement(`Image generation paused. ${message}`);
    } finally {
      if (aiImageAbortRef.current === controller) aiImageAbortRef.current = null;
    }
  }

  function retryAIWriting() {
    const current = aiOperationRef.current;
    if (
      !current ||
      current.phase === "generating" ||
      current.phase === "saving"
    ) return;
    if (current.kind === "image") {
      if (!isAIWritingCaptureCurrent(editor, current.capture)) {
        discardAIWriting(false);
        setAnnouncement("The selected passage changed. Select it again to create an image.");
        return;
      }
      if (current.phase === "error" && current.image && current.proposal) {
        // Saving an accepted image can fail independently of generation. Keep the
        // downloaded proposal available without another paid model request.
        showAIWritingPreview(editor, current.capture, current.proposal, {
          label: "Proposed image", ariaLabel: "Generated image preview",
        });
        setCurrentAIOperation({ ...current, phase: "preview", error: undefined });
        setAnnouncement("Generated image restored. Insert it again when ready.");
        return;
      }
      if (current.phase === "preview") current.session.clearImage();
      void runAIImageRequest({
        instruction: current.instruction,
        capture: current.capture,
        assetId: current.phase === "preview" ? `image_${nanoid(18)}` : current.assetId,
        quality: current.quality,
        contextMode: current.contextMode,
        session: current.session,
        contextPartial: current.contextPartial,
      });
      return;
    }
    void runAIWritingRequest({
      action: current.action,
      length: current.length,
      instruction: current.instruction,
      capture: current.capture,
    });
  }

  async function acceptAIWriting() {
    const current = aiOperationRef.current;
    if (!current || current.phase !== "preview" || !current.proposal) return;
    if (!isAIWritingCaptureCurrent(editor, current.capture)) {
      discardAIWriting(false);
      setAnnouncement(
        "The note changed before this proposal could be accepted. Try again.",
      );
      return;
    }
    if (current.kind === "image") {
      if (!current.image) return;
      setCurrentAIOperation({ ...current, phase: "saving" });
      try {
        const attachment = await persistGeneratedNoteImage(
          current.image,
          current.assetId,
        );
        if (
          current.requestId !== aiRequestIdRef.current ||
          editor.isDestroyed ||
          !isAIWritingCaptureCurrent(editor, current.capture)
        ) {
          return;
        }
        const applied = acceptAIImagePreview(
          editor,
          current.capture,
          attachment,
          current.image.alt,
        );
        if (!applied) throw new Error("This image could not be inserted safely.");
        current.session.clear();
        aiRequestIdRef.current += 1;
        editor.setEditable(true, false);
        setCurrentAIOperation(null);
        setAnnouncement(
          "Image inserted after the selected passage. Undo once to remove it.",
        );
        window.requestAnimationFrame(updateAIControlPositions);
      } catch (error) {
        if (current.requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
        const message = error instanceof Error ? error.message : String(error);
        setCurrentAIOperation({ ...current, phase: "error", error: message });
        setAnnouncement(`Image insertion paused. ${message}`);
      }
      return;
    }
    const applied = acceptAIWritingPreview(editor, current.capture, current.proposal);
    if (!applied) {
      setCurrentAIOperation({
        ...current,
        phase: "error",
        error: "This proposal could not be inserted safely.",
      });
      return;
    }
    aiRequestIdRef.current += 1;
    editor.setEditable(true, false);
    setCurrentAIOperation(null);
    const citedSources = canonicalizeSourceCitations(
      current.proposal.markdown,
      sources,
    ).references;
    for (const reference of citedSources) {
      if (
        reference.available &&
        !attachedSourceIds.includes(reference.sourceId)
      ) {
        onAttachSource(reference.sourceId);
      }
    }
    setAnnouncement(
      "AI writing accepted. Undo once to restore the original passage.",
    );
    window.requestAnimationFrame(() => {
      const editorElement =
        editorShellRef.current?.querySelector<HTMLElement>(".ProseMirror");
      if (!editorElement?.isConnected) return;
      editorElement.focus({ preventScroll: true });
      updateAIControlPositions();
    });
  }

  function discardAIWriting(restoreSelection = true) {
    const current = aiOperationRef.current;
    aiRequestIdRef.current += 1;
    aiImageAbortRef.current?.abort();
    aiImageAbortRef.current = null;
    if (current?.kind === "image") current.session.clear();
    if (current && !editor.isDestroyed) {
      clearAIWritingPreview(editor, current.capture, restoreSelection);
    }
    if (!editor.isDestroyed) editor.setEditable(true, false);
    setCurrentAIOperation(null);
    if (restoreSelection && !editor.isDestroyed) {
      window.requestAnimationFrame(() => {
        const editorElement =
          editorShellRef.current?.querySelector<HTMLElement>(".ProseMirror");
        if (!editorElement?.isConnected) return;
        editorElement.focus({ preventScroll: true });
        updateAIControlPositions();
      });
    }
    setAnnouncement(
      current?.kind === "image"
        ? current.phase === "generating"
          ? "Image generation cancelled."
          : "Generated image discarded."
        : current?.phase === "generating"
          ? "AI writing cancelled."
          : "AI writing proposal discarded.",
    );
  }

  function openLinkComposer() {
    const selection = captureConceptLinkSelection(editor);
    const { selectedText } = selection;
    const existingConcept =
      selection.mode === "inline" && selectedText
        ? findConceptByPhrase(concepts, selectedText)
        : undefined;
    setCitationDraft(null);
    setLinkDraft({
      ...selection,
      initialPhrase: selection.mode === "context" ? "" : selectedText,
      initialDestinationIds:
        existingConcept?.noteIds.length && !existingConcept.canonicalNoteId
          ? [...existingConcept.noteIds]
          : [],
      documentMarkdown: editor.getMarkdown(),
    });
    setAnnouncement(
      selection.mode === "context"
        ? "Selected content will stay unchanged. Add the page title that should link to it."
        : selectedText
          ? `Creating a reusable link for ${selectedText}.`
          : "Type a phrase to create or reuse its Space article.",
    );
  }

  function openCitationPicker() {
    if (sources.length === 0) {
      setAnnouncement("This Space has no sources to cite yet.");
      return;
    }
    setLinkDraft(null);
    setCitationDraft({ position: editor.state.selection.to });
    setAnnouncement("Choose a source to cite.");
  }

  function insertSourceCitation(source: Source) {
    if (!citationDraft) return;
    const position = Math.min(
      citationDraft.position,
      editor.state.doc.content.size,
    );
    const before = editor.state.doc.textBetween(
      Math.max(0, position - 1),
      position,
    );
    const after = editor.state.doc.textBetween(
      position,
      Math.min(editor.state.doc.content.size, position + 1),
    );
    const addLeadingSpace = Boolean(before && !/[\s([{"'“‘]/.test(before));
    const addTrailingSpace = Boolean(
      after && !/[\s.,!?;:)\]}'"”’]/.test(after),
    );
    const href = `orion-source://${source.id}`;
    const existingReferences = canonicalizeSourceCitations(
      editor.getMarkdown(),
      sources,
    ).references;
    const citationNumber =
      existingReferences.find((reference) => reference.sourceId === source.id)
        ?.number ?? existingReferences.length + 1;
    const citationMark = {
      type: "link",
      attrs: {
        href,
        target: null,
        rel: null,
        class: "editor-explicit-link",
        title: null,
      },
    };
    const inserted = editor
      .chain()
      .focus()
      .insertContentAt(
        position,
        [
          ...(addLeadingSpace ? [{ type: "text", text: " " }] : []),
          {
            type: "text",
            text: String(citationNumber),
            marks: [citationMark],
          },
          ...(addTrailingSpace ? [{ type: "text", text: " " }] : []),
        ],
        { updateSelection: true },
      )
      .run();
    if (inserted) {
      onAttachSource(source.id);
      setAnnouncement(`Citation to ${source.title} inserted.`);
    } else {
      setAnnouncement("The citation could not be inserted here.");
    }
    setCitationDraft(null);
  }

  function applyConceptLink(
    phrase: string,
    destinationIds: EntityId[],
    options: {
      articleMode: "ai" | "blank";
      articleInstructions?: string;
    },
  ) {
    if (!linkDraft) {
      return;
    }
    if (!isConceptLinkDocumentCurrent(editor, linkDraft.documentMarkdown)) {
      setLinkDraft(null);
      setAnnouncement(
        "The note changed while Orion was naming the page. Select the passage and try again.",
      );
      return;
    }
    const conceptId = onRegisterConcept({
      phrase,
      destinationNoteIds: destinationIds,
      articleMode: options.articleMode,
      articleInstructions: options.articleInstructions,
      ...(linkDraft.selectedText
        ? { selectedContext: linkDraft.selectedText }
        : {}),
    });
    const href = `orion-concept://${conceptId}`;
    const applied = applyConceptLinkToEditor(
      editor,
      linkDraft,
      phrase,
      href,
    );
    setLinkDraft(null);
    setAnnouncement(
      applied &&
        linkDraft.mode !== "none" &&
        (linkDraft.mode === "context" || phrase !== linkDraft.selectedText)
        ? `${phrase} is linked above the unchanged selection.`
        : `${phrase} is now a smart link everywhere it appears in Orion.`,
    );
  }

  function unlinkSelection(conceptId?: EntityId) {
    const explicitLink = editor.isActive("link");
    if (explicitLink) {
      const href = String(editor.getAttributes("link").href ?? "");
      if (href.startsWith("orion-source://")) {
        editor
          .chain()
          .focus()
          .extendMarkRange("link")
          .deleteSelection()
          .run();
        setAnnouncement("Citation removed. References were renumbered.");
        return;
      }
      editor
        .chain()
        .focus()
        .extendMarkRange("link")
        .unsetLink()
        .run();
    }
    if (conceptId) {
      const concept = concepts.find(
        (candidate) => candidate.id === conceptId,
      );
      onDisableConceptAutoLink(conceptId);
      setAnnouncement(
        `${concept?.label ?? "This phrase"} is no longer an automatic link. Its article was kept.`,
      );
      return;
    }
    setAnnouncement(
      explicitLink
        ? "Link removed. The words were kept."
        : "Select linked words before choosing Unlink.",
    );
  }

  return (
    <div
      ref={editorShellRef}
      className={`rich-note-editor${linkTitleBusy ? " is-naming-link" : ""}${
        aiWritingActive ? " is-ai-writing-active" : ""
      }${aiOperation ? " is-ai-writing-busy" : ""}${
        aiOperation?.phase === "preview" ? " is-ai-writing-preview" : ""
      }${imageBusy ? " is-inserting-image" : ""}${
        imageDragActive ? " is-image-drag-active" : ""
      }`}
      aria-busy={
        linkTitleBusy ||
        aiOperation?.phase === "generating" ||
        aiOperation?.phase === "saving" ||
        imageBusy
      }
    >
      <NativeFormattingDock>
      <div className="editor-toolbar-shell">
        <EditorToolbar
          marginsVisible={marginsVisible}
          onToggleMargins={toggleMargins}
          blockControls={blockSelected}
          onToggleBlockControls={() => {
            const block = listNoteBlocks(editor.state.doc).find(item => editor.state.selection.from >= item.from && editor.state.selection.from < item.to);
            if (block?.node.type.name === "noteBlock") unwrapNoteBlock(editor, block);
            else wrapNoteBlock(editor);
            editor.view.focus();
          }}
          noteTypeface={noteTypeface}
          onNoteTypefaceChange={onNoteTypefaceChange}
          editor={editor}
          concepts={concepts}
          onOpenLink={openLinkComposer}
          onOpenExcerpt={() => beginInsert("excerpt")}
          onOpenTable={() => beginInsert("table")}
          onUnlink={unlinkSelection}
          citationAvailable={sources.length > 0}
          onOpenCitation={openCitationPicker}
          onInsertImages={(files) => void insertNoteImages(files)}
          imageBusy={imageBusy}
          noteId={noteId}
          onVoiceMemoSessionStart={
            onTranscribeVoiceMemo ? startVoiceMemoAtCaret : undefined
          }
          onVoiceMemoSessionEnd={finishVoiceMemoSession}
          onTranscribeVoiceMemo={
            onTranscribeVoiceMemo
              ? (audio, sessionId) => onTranscribeVoiceMemo(audio, sessionId)
              : undefined
          }
          onCompleteVoiceMemo={
            onTranscribeVoiceMemo
              ? (sessionId, transcript) =>
                  insertCompletedVoiceMemo(sessionId, transcript)
              : undefined
          }
          aiWritingAvailable={
            (aiArticleWritingEnabled && Boolean(onGenerateAIWriting)) ||
            (aiImageGenerationEnabled && Boolean(onGenerateAIImage))
          }
          aiWritingActive={aiWritingActive}
          aiWritingBusy={Boolean(aiOperation)}
          aiProviderName={aiProviderName}
          onToggleAIWriting={toggleAIWriting}
          onAnnounce={setAnnouncement}
        />
      </div>
      {marginsVisible && <MarginsControl editor={editor} disabled={Boolean(aiOperation) || imageBusy || linkTitleBusy} onClose={closeMargins}/>}
      </NativeFormattingDock>
      <SlashMenu editor={editor} suspended={Boolean(pendingInsert || linkDraft || citationDraft || aiOperation || imageBusy)} onCommand={runSlashCommand}/>
      <input ref={slashImageInputRef} type="file" className="sr-only" accept={NOTE_IMAGE_ACCEPT} multiple tabIndex={-1} aria-hidden="true"
        onChange={(event) => {
          const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";
          if (!files.length || !pendingInsert || !editor.state.doc.eq(pendingInsert.document)) {cancelInsert();return;}
          const range = pendingInsert.range;
          const block = pendingInsert.block;
          setPendingInsert(null);void insertNoteImages(files, undefined, range, block);
        }}/>
      <EditorContent
        editor={editor}
        className="note-prose editor-prose"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
            event.preventDefault();
            openLinkComposer();
          }
        }}
        onDragEnter={(event) => {
          if (imageFilesFromTransfer(event.dataTransfer.files).length > 0) {
            setImageDragActive(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setImageDragActive(false);
          }
        }}
        onDrop={() => setImageDragActive(false)}
      />
      <NoteBlockControls editor={editor}
        suspended={Boolean(pendingInsert || linkDraft || citationDraft || aiOperation || imageBusy)}
        onInsert={insertBlock} onAnnounce={setAnnouncement}/>
      {savedPassages.length > 0 && <section className="source-references" aria-label="Cited passages">
        <h2>Cited passages</h2>
        {savedPassages.map((passage) => <div key={passage.id}>
          <strong>{passage.title}</strong>
          <blockquote>{passage.text}</blockquote>
          <p>{citedPassageStatus(passage, notes, sources, "note").description}</p>
        </div>)}
      </section>}
      <SourceReferences
        references={citationReferences}
        onOpenSource={onOpenSource}
      />
      <AIWritingControls
        active={aiWritingActive}
        suspended={Boolean(pendingInsert || linkDraft || citationDraft || linkTitleBusy || editor.isActive("image") || editor.isActive("table"))}
        phase={aiOperation?.phase ?? "idle"}
        hasSelection={!aiSelectionEmpty}
        selectionPosition={aiSelectionPosition}
        dockPosition={aiDockPosition}
        error={aiOperation?.error}
        writingAvailable={
          aiArticleWritingEnabled && Boolean(onGenerateAIWriting)
        }
        imageGenerationAvailable={
          aiImageGenerationEnabled && Boolean(onGenerateAIImage)
        }
        imageContextEnabled={imageContextEnabled}
        imageProgress={aiOperation?.kind === "image" ? aiOperation.progress : undefined}
        imageContextPartial={aiOperation?.kind === "image" && aiOperation.contextPartial}
        imageContextNotice={aiOperation?.kind === "image" ? aiOperation.image?.contextNotice : undefined}
        imageInsertionRetry={aiOperation?.kind === "image" && Boolean(aiOperation.image)}
        operationKind={aiOperation?.kind ?? "writing"}
        onRequest={requestAIWriting}
        onRequestImage={requestAIImage}
        onAccept={() => void acceptAIWriting()}
        onRetry={retryAIWriting}
        onDiscard={() => discardAIWriting(true)}
      />
      {pendingInsert?.kind === "table" && <EditorInsertLayer editor={editor} position={pendingInsert.range.from}>
        <TablePicker editor={editor} range={pendingInsert.range} blockPosition={pendingInsert.block ? pendingInsert.range.from : undefined} onClose={cancelInsert}
          canInsert={() => editor.state.doc.eq(pendingInsert.document)}
          onInsert={() => setAnnouncement("Table inserted. Tab moves between cells.")}/>

      </EditorInsertLayer>}
      {(pendingInsert?.kind === "excerpt" || pendingInsert?.kind === "link") && <ExcerptPicker
        notes={notes} currentNoteId={noteId} mode={pendingInsert.kind} portalTarget={editor.view.dom.closest(".app-shell")??undefined}
        onClose={cancelInsert}
        onInsertExcerpt={(selection) => insertPickerContent(buildNoteExcerptContent(selection))}
        onInsertLink={(target) => {
          if(!notes.some(candidate=>candidate.id===target.id))return;
          insertPickerContent([{type:"text",text:target.title,marks:[{type:"link",attrs:{href:`orion-note://${target.id}`}}]}]);
        }}/>
      }
      {linkDraft && (
        <ConceptLinkPopover
          initialPhrase={linkDraft.initialPhrase}
          selectedText={linkDraft.selectedText}
          selectionMode={linkDraft.mode}
          initialDestinationIds={linkDraft.initialDestinationIds}
          currentNoteId={noteId}
          notes={notes}
          concepts={concepts}
          aiArticleWritingEnabled={aiArticleWritingEnabled}
          aiProviderName={aiProviderName}
          onGenerateTitle={onGenerateLinkTitle}
          onGeneratingChange={setLinkTitleBusy}
          onCancel={() => {
            setLinkDraft(null);
            setAnnouncement("Link creation cancelled.");
            editor.commands.focus();
          }}
          onSubmit={applyConceptLink}
        />
      )}
      {citationDraft ? (
        <SourceCitationPopover
          sources={sources}
          attachedSourceIds={attachedSourceIds}
          onCancel={() => {
            setCitationDraft(null);
            setAnnouncement("Citation cancelled.");
            editor.commands.focus();
          }}
          onSelect={insertSourceCitation}
        />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
    </div>
  );
}

function clampNumber(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function sameAIControlPosition(
  left: AIWritingControlPosition,
  right: AIWritingControlPosition,
): boolean {
  return (
    left.visible === right.visible &&
    left.left === right.left &&
    left.top === right.top &&
    left.bottom === right.bottom &&
    left.placement === right.placement
  );
}
