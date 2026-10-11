import type { ChatEditorChange } from "../lib/chatEdits";
import { prepareChatEditorChange, applyPreparedChatChange, type PreparedChatChange } from "./editor/chatEditTransaction";
import { ChatNoteReview, showChatNoteReview, clearChatNoteReview } from "./editor/ChatNoteReview";
import "./editor/ChatNoteReview.css";
import type { Editor, EditorEvents } from "@tiptap/core";
import { Selection, TextSelection } from "@tiptap/pm/state";
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
import { FlowWriting, finishInlineFlow, FLOW_INTERNAL, getInlineFlow } from "./editor/FlowWriting";
import {
  acceptAIWritingPreview,
  acceptAIImagePreview,
  captureAIWritingSelection,
  captureAIWorkingContext,
  clearAIWritingPreview,
  isAIWritingCaptureCurrent,
  parseAIWritingProposal,
  parseAIImagePreview,
  showAIWritingPreview,
  type AIWritingCapture,
  type AIWritingParsedProposal,
} from "./editor/aiWritingTransaction";
import { resolveAIWritingSelectionPosition } from "./editor/aiWritingPosition";
import { normalizeExternalLink } from "../lib/externalLinks";
import { openEditorExternalLink } from "../lib/openEditorExternalLink";
import type { EditorCaptureState } from "../lib/editorSelectionContext";
import type { EditorAILinkContext } from "../lib/editorAIWorkingContext";
import type { EditorActionCapture, EditorActionHost, EditorActionSpec, EditorActionStartOptions, EditorActionPhase } from "../lib/assistant/editorActionHost";

export interface AIImageGenerationCallbacks {
  session?: ImageGenerationSession;
  onProgress?: (progress: ImageGenerationProgress) => void;
}
export interface RichEditorContextState extends EditorCaptureState { markdown: string; authored: boolean }

interface RichNoteEditorProps {
  chatEdit?: ChatEditorChange;
  onChatEditComplete?: (id: string, error?: string, accepted?: boolean) => void;
  onChatEditBeforeAccept?: (id: string) => Promise<void>;
  onReviewReadinessChange?: (ready: (() => boolean) | null) => void;
  onEditorContextStateChange?: (read: (() => RichEditorContextState) | null) => void;
  onFlowActiveChange?: (active: boolean) => void;
  onEditorActionHostChange?: (host: EditorActionHost | null) => void;
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
  onGenerateLinkTitle?: (selectedContext: string, signal?: AbortSignal, context?: EditorAILinkContext) => Promise<string>;
  onGenerateAIWriting?: (
    input: Omit<AIWritingRequestInput, "originNoteId">,
    signal?: AbortSignal,
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
  aiWritingUnavailableReason?: string;
  aiImageUnavailableReason?: string;
  imageContextEnabled?: boolean;
  aiProviderName?: string;
  findQuery?: string;
  onFindDecorationsChanged?: () => void;
}

interface LinkDraft extends ConceptLinkSelection {
  aiContext?: EditorAILinkContext;
  selectionJSON: Record<string, unknown>;
  anchorPosition: number;
  initialHref?: string;
  initialNoteId?: string;
  initialPhrase: string;
  initialDestinationIds: EntityId[];
  documentMarkdown: string;
}

interface CitationDraft {
  position: number;
}

interface ExternalEditorOperation {
  metadata: EditorActionCapture;
  capture: AIWritingCapture;
  options?: EditorActionStartOptions;
  invalidated: boolean;
  applied: boolean;
  terminal: boolean;
}

interface AIWritingOperation {
  kind: "writing";
  phase: Exclude<AIWritingPhase, "idle">;
  requestId: number;
  action: AIWritingAction;
  length: AIWritingLength;
  instruction: string;
  capture: AIWritingCapture;
  external?: ExternalEditorOperation;
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
  external?: ExternalEditorOperation;
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
  chatEdit,
  onChatEditComplete,
  onChatEditBeforeAccept,
  onReviewReadinessChange,
  onEditorContextStateChange,
  onFlowActiveChange,
  onEditorActionHostChange,
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
  aiWritingUnavailableReason,
  aiImageUnavailableReason,
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
  const editorAuthoredBody = useRef(false);
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
  const externalActionRef = useRef<ExternalEditorOperation | null>(null);
  const actionDocumentVersion = useRef(`editor-doc_${nanoid(16)}`);
  const actionSelectionVersion = useRef(`editor-selection_${nanoid(16)}`);
  const actionHostRef = useRef<EditorActionHost | null>(null);
  const aiComposerActiveRef = useRef(false);
  const onAIComposerActiveChange = useCallback((active: boolean) => {
    aiComposerActiveRef.current = active;
    if (active && externalActionRef.current && !externalActionRef.current.options) externalActionRef.current.invalidated = true;
  }, []);
  const aiRequestIdRef = useRef(0);
  const aiOperationRef = useRef<AIOperation | null>(null);
  const aiImageAbortRef = useRef<AbortController | null>(null);
  const aiWritingAbortRef = useRef<AbortController | null>(null);
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
  const [chatReview, setChatReview] = useState<{ id: string; prepared: PreparedChatChange; mode: ChatEditorChange["mode"]; count: number } | null>(null);
  const chatReviewRef = useRef<typeof chatReview>(null);
  const chatChangeRef = useRef(chatEdit);
  chatChangeRef.current = chatEdit;
  const chatCompleteRef = useRef(onChatEditComplete);
  chatCompleteRef.current = onChatEditComplete;
  const chatPreflightRef = useRef(onChatEditBeforeAccept);
  chatPreflightRef.current = onChatEditBeforeAccept;
  const acceptingChatReview = useRef<string | null>(null);
  const [chatAccepting, setChatAccepting] = useState(false);
  const [marginsVisible, setMarginsVisible] = useState(false);
  const toggleMargins = useCallback(() => setMarginsVisible(visible => !visible), []);
  const closeMargins = useCallback(() => setMarginsVisible(false), []);
  const [imageDragActive, setImageDragActive] = useState(false);
  const [writeComposerOpen, setWriteComposerOpen] = useState(false);
  const writeCursorRef = useRef<{ position: number; document: ProseMirrorNode } | null>(null);
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
          enableClickSelection: false,
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
      ChatNoteReview,
      FlowWriting,
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
        handleDOMEvents: {
          click: (_view, event) => {
          const webAnchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
          const webHref = webAnchor?.getAttribute("href");
          if (webHref && normalizeExternalLink(webHref)) {
            // Ordinary clicks place the caret. Only an explicit modifier opens a browser.
            event.preventDefault();
            if (event.metaKey || event.ctrlKey) {
              void openEditorExternalLink(webHref).catch(() => setAnnouncement("The link could not be opened. Try Open from the Link control."));
              return true;
            }
          }
          return false;
          },
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
      onUpdate: ({ editor: current, transaction }) => {
        if (getInlineFlow(current) || transaction.getMeta(FLOW_INTERNAL)) return;
        const citations = canonicalizeSourceCitations(
          mergeSavedChatPassages(current.getMarkdown(), savedPassagesRef.current),
          sourcesRef.current,
        );
        setSavedPassages(savedChatEvidence(citations.body));
        const nextMarkdown = restoreMarkdownFrontmatter(
          frontmatterRef.current,
          citations.markdown,
        );
        // Mounting may append Tiptap's empty caret paragraph. A review must
        // not save that normalization before the user accepts any changes.
        if (chatChangeRef.current && nextMarkdown.trimEnd() === chatChangeRef.current.baseMarkdown.trimEnd()) return;
        setCitationReferences((current) =>
          sameCitationReferences(current, citations.references)
            ? current
            : citations.references,
        );
        // A selection-only transaction can append the initial empty caret
        // paragraph. Ignore that presentation-only terminal normalization;
        // every real document transaction, including trailing whitespace, counts.
        editorAuthoredBody.current ||= transaction.docChanged || nextMarkdown.trimEnd() !== lastEmittedMarkdownRef.current.trimEnd();
        lastEmittedMarkdownRef.current = nextMarkdown;
        pendingMarkdownEchoesRef.current.add(nextMarkdown);
        onChangeRef.current(nextMarkdown);
      },
    },
    [noteId],
  );
  editorRef.current = editor;
  const flowActive = useEditorState({ editor, selector: ({ editor: current }) => Boolean(current && getInlineFlow(current)) }) ?? false;
  useEffect(() => { onFlowActiveChange?.(flowActive); }, [flowActive, onFlowActiveChange]);
  useEffect(() => () => onFlowActiveChange?.(false), [onFlowActiveChange]);
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
    actionDocumentVersion.current = `editor-doc_${nanoid(16)}`;
    if (externalActionRef.current && !externalActionRef.current.options) externalActionRef.current.invalidated = true;
    if (chatReviewRef.current) {
      const review = chatReviewRef.current;
      chatReviewRef.current = null;
      clearChatNoteReview(editor); editor.setEditable(true, false); setChatReview(null);
      chatCompleteRef.current?.(review.id, "This note changed while reviewing. Ask Chat to regenerate the edits.");
    }
    if (getInlineFlow(editor)) {
      finishInlineFlow(editor, false);
      setAnnouncement("Flow ended because this note changed elsewhere. Its unsaved passage was discarded.");
    }
    const pendingAIWriting = aiOperationRef.current;
    if (pendingAIWriting) {
      if (pendingAIWriting.external) emitExternalAction(pendingAIWriting.external, "stale", "The note changed elsewhere.");
      aiRequestIdRef.current += 1;
      aiWritingAbortRef.current?.abort();
      aiWritingAbortRef.current = null;
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
    editorAuthoredBody.current = false;
  }, [editor, markdown]);

  const consumedChatEdit = useRef<string | null>(null);
  const reviewReadyRef = useRef<() => boolean>(() => false);
  reviewReadyRef.current = () => Boolean(editor && editor.isInitialized && !editor.isDestroyed && editor.isEditable &&
    !chatReviewRef.current && !chatChangeRef.current && !getInlineFlow(editor) && !aiOperationRef.current &&
    !voiceMemoInsertionRef.current && !imageUploadActiveRef.current && !pendingInsert && !linkDraft &&
    !citationDraft && !linkTitleBusy && !imageBusy && !imageDragActive && !writeComposerOpen && !aiComposerActiveRef.current);
  useEffect(() => {
    onReviewReadinessChange?.(() => reviewReadyRef.current());
    return () => onReviewReadinessChange?.(null);
  }, [onReviewReadinessChange]);
  const editorContextState = useRef<() => RichEditorContextState>(() => ({ available: false, reason: "not-ready", markdown, authored: false }));
  editorContextState.current = () => {
    const current = editorRef.current;
    const unavailable = !current || !current.isInitialized || current.isDestroyed;
    const flow = !unavailable && Boolean(getInlineFlow(current));
    const preview = Boolean(chatReviewRef.current || chatChangeRef.current || aiOperationRef.current);
    const available = !unavailable && !flow && !preview && current.isEditable;
    return { available, markdown: lastEmittedMarkdownRef.current, authored: editorAuthoredBody.current,
      ...(!available ? { reason: flow ? "flow" as const : preview ? "preview" as const : "not-ready" as const } : {}),
      ...(available && current.state.selection.empty
        ? { cursor: { position: current.state.selection.from, unit: "prosemirror-position" as const } } : {}),
    };
  };
  useEffect(() => {
    onEditorContextStateChange?.(() => editorContextState.current());
    return () => onEditorContextStateChange?.(null);
  }, [onEditorContextStateChange]);
  actionHostRef.current = {
    getState: () => {
      const ready = reviewReadyRef.current();
      if (!ready && externalActionRef.current && !externalActionRef.current.options) externalActionRef.current.invalidated = true;
      return { ready, documentVersion: actionDocumentVersion.current, selectionVersion: actionSelectionVersion.current };
    },
    capture: captureExternalAction,
    isCaptureCurrent: isExternalCaptureCurrent,
    start: startExternalAction,
    cancel: cancelExternalAction,
    release: (id) => { if (externalActionRef.current?.metadata.captureId === id && !externalActionRef.current.options) externalActionRef.current = null; },
  };
  useEffect(() => {
    const host: EditorActionHost = {
      getState: () => actionHostRef.current!.getState(), capture: action => actionHostRef.current!.capture(action),
      isCaptureCurrent: id => actionHostRef.current!.isCaptureCurrent(id),
      start: (id, options) => actionHostRef.current!.start(id, options),
      cancel: id => actionHostRef.current!.cancel(id), release: id => actionHostRef.current!.release(id),
    };
    onEditorActionHostChange?.(host);
    return () => onEditorActionHostChange?.(null);
  }, [onEditorActionHostChange]);
  useEffect(() => {
    if (!editor) return;
    let document = editor.state.doc, selection = editor.state.selection;
    const changed = () => {
      const documentChanged = !editor.state.doc.eq(document), selectionChanged = !editor.state.selection.eq(selection);
      document = editor.state.doc; selection = editor.state.selection;
      if (documentChanged) actionDocumentVersion.current = `editor-doc_${nanoid(16)}`;
      if (selectionChanged) actionSelectionVersion.current = `editor-selection_${nanoid(16)}`;
      const external = externalActionRef.current;
      if (!external || external.applied || external.terminal) return;
      if (!external.options && (documentChanged || selectionChanged || !reviewReadyRef.current())) external.invalidated = true;
      if (external.options && documentChanged) {
        discardAIWriting(false, "stale");
      }
    };
    editor.on("transaction", changed);
    return () => { editor.off("transaction", changed); };
  }, [editor]);
  useEffect(() => {
    if (!reviewReadyRef.current() && externalActionRef.current && !externalActionRef.current.options) externalActionRef.current.invalidated = true;
  }, [pendingInsert, linkDraft, citationDraft, linkTitleBusy, imageBusy, imageDragActive, writeComposerOpen, flowActive, chatEdit, chatReview, aiOperation]);

  const finishChatReview = useCallback((accepted: boolean) => {
    const review = chatReviewRef.current;
    if (!review || !editor || editor.isDestroyed) return;
    if (accepted && acceptingChatReview.current === review.id) return;
    const clear = () => {
      chatReviewRef.current = null; setChatReview(null);
      clearChatNoteReview(editor); editor.setEditable(true, false);
    };
    const apply = () => {
      // A native claim can finish after navigation, remote cancellation, or a rich edit.
      if (editor.isDestroyed || editor !== editorRef.current || chatReviewRef.current !== review ||
        chatChangeRef.current?.id !== review.id || !editor.state.doc.eq(review.prepared.original)) {
        throw new Error("The note changed or closed before the edit could be accepted.");
      }
      clear();
      if (accepted) applyPreparedChatChange(editor, review.prepared);
      setAnnouncement(accepted ? "Changes accepted. Undo restores the previous text." : "Changes discarded. Your note is unchanged.");
      chatCompleteRef.current?.(review.id, undefined, accepted);
      editor.commands.focus(undefined, { scrollIntoView: false });
    };
    const failed = (error: unknown) => {
      if (!editor.isDestroyed && chatReviewRef.current === review) clear();
      chatCompleteRef.current?.(review.id, error instanceof Error ? error.message : String(error));
    };
    if (accepted && chatPreflightRef.current) {
      acceptingChatReview.current = review.id; setChatAccepting(true);
      void Promise.resolve().then(() => chatPreflightRef.current!(review.id)).then(apply).catch(failed).finally(() => {
        if (acceptingChatReview.current === review.id) { acceptingChatReview.current = null; setChatAccepting(false); }
      });
    } else {
      try {
        if (accepted) apply();
        else { clear(); chatCompleteRef.current?.(review.id, undefined, false); }
      } catch (error) { failed(error); }
    }
  }, [editor]);

  useEffect(() => {
    if (!chatEdit || !editor || consumedChatEdit.current === chatEdit.id) return;
    const preview = () => {
      if (editor.isDestroyed || editor !== editorRef.current || consumedChatEdit.current === chatEdit.id) return;
      consumedChatEdit.current = chatEdit.id;
      try {
        if (markdown.trimEnd() !== chatEdit.baseMarkdown.trimEnd() || lastEmittedMarkdownRef.current.trimEnd() !== chatEdit.baseMarkdown.trimEnd()) {
          throw new Error("This note has changed. Ask Chat to regenerate the edits.");
        }
        if (getInlineFlow(editor) || aiOperationRef.current || voiceMemoInsertionRef.current || imageUploadActiveRef.current || pendingInsert || linkDraft || citationDraft || linkTitleBusy || imageBusy || writeComposerOpen) {
          throw new Error("Finish the current writing operation before reviewing these changes.");
        }
        const editorBody = (value: string) => splitSavedChatPassages(
          canonicalizeSourceCitations(splitMarkdownFrontmatter(value).content, sourcesRef.current).body,
        ).body;
        const prepared = prepareChatEditorChange(editor, editorBody(chatEdit.baseMarkdown), editorBody(chatEdit.nextMarkdown));
        const count = showChatNoteReview(editor, chatEdit.id, prepared);
        const review = { id: chatEdit.id, prepared, mode: chatEdit.mode, count };
        chatReviewRef.current = review; setChatReview(review);
        editor.setEditable(false, false); setWriteComposerOpen(false); writeCursorRef.current = null;
        setAnnouncement("Review changes in your note. Highlighted text will be replaced; gray text will be added. Accept or discard above.");
      } catch (error) {
        chatCompleteRef.current?.(chatEdit.id, error instanceof Error ? error.message : String(error));
      }
    };
    if (editor.isInitialized) preview();
    else editor.on("create", preview);
    return () => { editor.off("create", preview); };
  }, [chatEdit, editor, markdown, pendingInsert, linkDraft, citationDraft, linkTitleBusy, imageBusy, writeComposerOpen]);

  useEffect(() => {
    if (!editor) return;
    // Programmatic edits, including task/image node views, must not leave a stale review.
    const check = () => {
      const review = chatReviewRef.current;
      if (review && !editor.state.doc.eq(review.prepared.original)) {
        chatReviewRef.current = null; setChatReview(null);
        clearChatNoteReview(editor); editor.setEditable(true, false);
        chatCompleteRef.current?.(review.id, "This note changed while reviewing. Regenerate the edits.");
      }
    };
    editor.on("transaction", check);
    return () => {
      editor.off("transaction", check);
      const review = chatReviewRef.current;
      chatReviewRef.current = null;
      if (review) {
        clearChatNoteReview(editor);
        if (!editor.isDestroyed) editor.setEditable(true, false);
        chatCompleteRef.current?.(review.id, undefined, false);
      }
    };
  }, [editor]);
  useEffect(() => {
    if (!chatEdit && chatReviewRef.current) finishChatReview(false);
  }, [chatEdit, finishChatReview]);
  useEffect(() => {
    if (!chatReview) return;
    const frame = requestAnimationFrame(() => {
      editorShellRef.current?.querySelector<HTMLElement>(".chat-note-review__accept")?.focus({ preventScroll: true });
      editorShellRef.current?.querySelector<HTMLElement>("[data-chat-removal],[data-chat-addition]")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [chatReview]);

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
    let nextDock: AIWritingControlPosition = editorVisible
      ? {
          left: dockLeft,
          bottom: Math.max(
            16,
            window.innerHeight - workspaceRect.bottom + 18,
          ),
          visible: true,
        }
      : HIDDEN_AI_CONTROL;
    if (writeComposerOpen && writeCursorRef.current && editorVisible) {
      try {
        const caret = editor.view.coordsAtPos(writeCursorRef.current.position);
        const toolbarBottom = shell.querySelector(".editor-formatting-dock")?.getBoundingClientRect().bottom ?? workspaceRect.top;
        const width = Math.min(330, window.innerWidth - 32);
        const height = shell.querySelector(".ai-writing-write-composer")?.getBoundingClientRect().height || 232;
        const below = Math.max(toolbarBottom + 8, caret.bottom + 9);
        const top = below + height < workspaceRect.bottom - 12 ? below : caret.top - height - 9;
        nextDock = {
          left: clampNumber(caret.left + width / 2, Math.max(16, workspaceRect.left) + width / 2, Math.min(window.innerWidth - 16, workspaceRect.right) - width / 2),
          top: clampNumber(top, Math.max(12, toolbarBottom + 8), workspaceRect.bottom - height - 12),
          visible: true,
        };
      } catch { /* The visible viewport dock remains available during layout. */ }
    }
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
      const start = editor.view.coordsAtPos(firstSelectedTextPosition(editor.state.doc, aiSelection.from, aiSelection.to));
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
  }, [editor, writeComposerOpen]);

  useEffect(() => {
    if (!editor) return undefined;
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
  }, [editor, updateAIControlPositions]);

  useEffect(() => {
    if (!editor || !editorShellRef.current) {
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
  }, [editor, updateAIControlPositions]);

  useEffect(
    () => () => {
      aiRequestIdRef.current += 1;
      aiWritingAbortRef.current?.abort();
      aiWritingAbortRef.current = null;
      aiImageAbortRef.current?.abort();
      aiImageAbortRef.current = null;
      const operation = aiOperationRef.current;
      if (operation?.external && !operation.external.applied) emitExternalAction(operation.external, "stale", "The editor closed.");
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
    if (command === "write") {
      editor.chain().focus().deleteRange(range).run();
      openWriteComposer();
      return;
    }
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

  function emitExternalAction(external: ExternalEditorOperation, phase: EditorActionPhase, error?: string) {
    if (external.terminal) return;
    if (["accepted", "discarded", "cancelled", "stale", "error"].includes(phase)) external.terminal = true;
    external.options?.onState({ captureId: external.metadata.captureId, phase, ...(error ? { error } : {}) });
  }

  function isExternalCaptureCurrent(id: string) {
    const external = externalActionRef.current;
    if (!external || external.metadata.captureId !== id || external.invalidated || external.terminal) return false;
    if (external.options) return !external.applied && !editor.isDestroyed && editor.state.doc.eq(external.capture.originalDoc) &&
      lastEmittedMarkdownRef.current === external.metadata.markdown;
    if (!reviewReadyRef.current() || editor.isDestroyed || !editor.state.doc.eq(external.capture.originalDoc) ||
      lastEmittedMarkdownRef.current !== external.metadata.markdown || external.metadata.documentVersion !== actionDocumentVersion.current || external.metadata.selectionVersion !== actionSelectionVersion.current) {
      external.invalidated = true; return false;
    }
    return true;
  }

  function captureExternalAction(action: EditorActionSpec): EditorActionCapture {
    if (!reviewReadyRef.current()) throw new Error("Finish the current writing operation before capturing an editor action.");
    if (!action || !["write", "rewrite", "image"].includes(action.kind) ||
      (action.instruction !== undefined && (typeof action.instruction !== "string" || [...action.instruction].length > 1_250)) ||
      (action.kind === "write" && !["sentence", "paragraph", "section"].includes(action.amount)) ||
      (action.kind === "rewrite" && !["rewrite", "clarify", "tighten", "simplify", "expand", "enrich"].includes(action.preset)) ||
      (action.kind === "image" && (!["fast", "detailed"].includes(action.quality) || !["selection", "space"].includes(action.context)))) {
      throw new Error("This editor action is invalid.");
    }
    if (action.kind === "image" ? !aiImageGenerationEnabled || !onGenerateAIImage : !aiArticleWritingEnabled || !onGenerateAIWriting) {
      throw new Error(action.kind === "image" ? aiImageUnavailableReason ?? "Image generation is unavailable." : aiWritingUnavailableReason ?? "AI writing is unavailable.");
    }
    // Match Tiptap setTextSelection used by the local Write composer, including
    // its text-boundary clamp for AllSelection. Do not dispatch this capture.
    const writePosition = Math.max(TextSelection.atStart(editor.state.doc).from,
      Math.min(editor.state.selection.to, TextSelection.atEnd(editor.state.doc).to));
    const captureState = action.kind === "write"
      ? editor.state.apply(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, writePosition)))
      : editor.state;
    const capture = captureAIWritingSelection(editor, action.kind === "write" ? action.amount : "paragraph", captureState);
    if (action.kind !== "write" && capture.empty) throw new Error("Select the passage for this editor action first.");
    const { from, to, empty } = editor.state.selection;
    const metadata: EditorActionCapture = Object.freeze({
      captureId: `editor-capture_${nanoid(20)}`, noteId, markdown: lastEmittedMarkdownRef.current,
      selection: Object.freeze({ from, to, empty }), action: Object.freeze({ ...action }),
      effectiveTarget: Object.freeze({ from: capture.from, to: capture.to, mode: capture.mode }),
      documentVersion: actionDocumentVersion.current, selectionVersion: actionSelectionVersion.current,
    });
    externalActionRef.current = { metadata, capture, invalidated: false, applied: false, terminal: false };
    return metadata;
  }

  function startExternalAction(id: string, options: EditorActionStartOptions) {
    if (!isExternalCaptureCurrent(id) || externalActionRef.current?.options) throw new Error("The captured note or selection changed or is already in use. Capture the passage again.");
    if (!options.grant.actionId || !options.grant.sessionId) throw new Error("A current native editor-action grant is required.");
    const external = externalActionRef.current!;
    const { action } = external.metadata;
    if (action.kind === "image" ? !aiImageGenerationEnabled || !onGenerateAIImage : !aiArticleWritingEnabled || !onGenerateAIWriting) {
      throw new Error(action.kind === "image" ? aiImageUnavailableReason ?? "Image generation is unavailable. Configure its provider and capture the passage again."
        : aiWritingUnavailableReason ?? "AI writing is unavailable. Configure its provider and capture the passage again.");
    }
    external.options = options;
    if (action.kind === "image") {
      void runAIImageRequest({ instruction: action.instruction ?? "", capture: external.capture,
        assetId: `image_${nanoid(18)}`, quality: action.quality, contextMode: action.context,
        session: new ImageGenerationSession(), external });
    } else {
      void runAIWritingRequest({ action: action.kind === "write" ? "continue" : action.preset,
        length: action.kind === "write" ? action.amount : "paragraph", instruction: action.instruction ?? "",
        capture: external.capture, external });
    }
  }

  function cancelExternalAction(id: string) {
    const external = externalActionRef.current;
    if (!external || external.metadata.captureId !== id || external.applied || external.terminal) return false;
    external.invalidated = true;
    if (aiOperationRef.current?.external === external) discardAIWriting(false, "cancelled");
    else emitExternalAction(external, "cancelled");
    return true;
  }

  async function acknowledgeExternalAcceptance(external: ExternalEditorOperation | undefined) {
    if (!external) return;
    const body = lastEmittedMarkdownRef.current;
    try {
      await external.options!.afterAccept(body);
      emitExternalAction(external, "accepted");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitExternalAction(external, "accepted", message);
      setAnnouncement(`The change was applied, but its save confirmation failed. ${message}`);
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
    if (externalActionRef.current && !externalActionRef.current.options) externalActionRef.current.invalidated = true;
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

  function openWriteComposer() {
    if (!editor.isEditable || aiOperationRef.current || getInlineFlow(editor)) return;
    const position = editor.state.selection.to;
    writeCursorRef.current = { position, document: editor.state.doc };
    setLinkDraft(null);
    setCitationDraft(null);
    setWriteComposerOpen(true);
    setAnnouncement("Choose how much to write, with optional instructions. Nothing is generated until you choose Write.");
    window.requestAnimationFrame(updateAIControlPositions);
  }

  function closeWriteComposer(restoreFocus = true) {
    const captured = writeCursorRef.current;
    writeCursorRef.current = null;
    setWriteComposerOpen(false);
    if (restoreFocus && !editor.isDestroyed && editor.isEditable) {
      if (captured && editor.state.doc.eq(captured.document)) editor.commands.setTextSelection(captured.position);
      editor.commands.focus(undefined, { scrollIntoView: false });
    }
  }

  function requestAIWriting(
    action: AIWritingAction,
    length: AIWritingLength,
    instruction: string,
  ) {
    if (aiOperationRef.current) return;
    if (!aiArticleWritingEnabled || !onGenerateAIWriting) {
      setAnnouncement(aiWritingUnavailableReason ?? `Add an ${aiProviderName ?? "AI provider"} key in Settings to write with AI.`);
      return;
    }
    if (action === "continue" && writeCursorRef.current) {
      const captured = writeCursorRef.current;
      if (!editor.state.doc.eq(captured.document)) {
        closeWriteComposer(false);
        setAnnouncement("This note changed. Open Write again at your cursor.");
        return;
      }
      editor.commands.setTextSelection(captured.position);
    }
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
    external?: ExternalEditorOperation;
  }) {
    if (!onGenerateAIWriting || !aiArticleWritingEnabled) return;
    aiWritingAbortRef.current?.abort();
    const controller = new AbortController();
    aiWritingAbortRef.current = controller;
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
    if (input.external) emitExternalAction(input.external, "generating");
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
        workingContext: input.capture.workingContext,
        editorActionGrant: input.external?.options?.grant,
        caretContext: {
          beforeMarkdown: input.capture.beforeMarkdown,
          afterMarkdown: input.capture.afterMarkdown,
        },
      }, controller.signal);
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
      const proposal = parseAIWritingProposal(editor, input.capture, markdown);
      await input.external?.options?.beforeReview();
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed || input.external?.terminal || !isAIWritingCaptureCurrent(editor, input.capture)) return;
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
      if (input.external) emitExternalAction(input.external, "preview");
      window.requestAnimationFrame(updateAIControlPositions);
    } catch (error) {
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      setCurrentAIOperation({
        ...generating,
        phase: "error",
        error: message,
      });
      if (input.external) emitExternalAction(input.external, "error", message);
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
    external?: ExternalEditorOperation;
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
    if (input.external) emitExternalAction(input.external, "generating");
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
          workingContext: input.capture.workingContext,
          editorActionGrant: input.external?.options?.grant,
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
      await input.external?.options?.beforeReview();
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed || input.external?.terminal || !isAIWritingCaptureCurrent(editor, input.capture)) return;
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
      if (input.external) emitExternalAction(input.external, "preview");
      window.requestAnimationFrame(updateAIControlPositions);
    } catch (error) {
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      setCurrentAIOperation({ ...generating, phase: "error", error: message, progress, contextPartial });
      if (input.external) emitExternalAction(input.external, "error", message);
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
    if (current.external) {
      setAnnouncement("Ask your assistant to capture this passage again and start a new request.");
      return;
    }
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
        external: current.external,
      });
      return;
    }
    void runAIWritingRequest({
      action: current.action,
      length: current.length,
      instruction: current.instruction,
      capture: current.capture,
      external: current.external,
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
    if (current.external) {
      if (current.external.terminal || current.external.invalidated) return;
      setCurrentAIOperation({ ...current, phase: "saving" });
      emitExternalAction(current.external, "accepting");
      try {
        await current.external.options!.beforeAccept();
        if (current.requestId !== aiRequestIdRef.current || editor.isDestroyed || current.external.terminal ||
          current.external.invalidated || !isAIWritingCaptureCurrent(editor, current.capture)) return;
      } catch (error) {
        if (current.requestId !== aiRequestIdRef.current || editor.isDestroyed || current.external.terminal) return;
        const message = error instanceof Error ? error.message : String(error);
        emitExternalAction(current.external, "error", message);
        discardAIWriting(false);
        setAnnouncement(`This proposal could not be accepted. ${message}`);
        return;
      }
    }
    if (current.kind === "image") {
      if (!current.image) return;
      setCurrentAIOperation({ ...current, phase: "saving" });
      try {
        const attachment = await persistGeneratedNoteImage(
          current.image,
          current.assetId,
          current.external?.options?.grant,
        );
        if (
          current.requestId !== aiRequestIdRef.current ||
          editor.isDestroyed ||
          !isAIWritingCaptureCurrent(editor, current.capture)
        ) {
          return;
        }
        if (current.external) current.external.applied = true;
        const applied = acceptAIImagePreview(
          editor,
          current.capture,
          attachment,
          current.image.alt,
        );
        if (!applied) {
          if (current.external) current.external.applied = false;
          throw new Error("This image could not be inserted safely.");
        }
        current.session.clear();
        aiRequestIdRef.current += 1;
        editor.setEditable(true, false);
        setCurrentAIOperation(null);
        setAnnouncement(
          "Image inserted after the selected passage. Undo once to remove it.",
        );
        window.requestAnimationFrame(updateAIControlPositions);
        await acknowledgeExternalAcceptance(current.external);
      } catch (error) {
        if (current.requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
        const message = error instanceof Error ? error.message : String(error);
        setCurrentAIOperation({ ...current, phase: "error", error: message });
        if (current.external) emitExternalAction(current.external, "error", message);
        setAnnouncement(`Image insertion paused. ${message}`);
      }
      return;
    }
    if (current.external) current.external.applied = true;
    const applied = acceptAIWritingPreview(editor, current.capture, current.proposal);
    if (!applied) {
      if (current.external) { current.external.applied = false; emitExternalAction(current.external, "error", "This proposal could not be inserted safely."); }
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
    await acknowledgeExternalAcceptance(current.external);
  }

  function discardAIWriting(restoreSelection = true, externalPhase: "discarded" | "cancelled" | "stale" = "discarded") {
    const current = aiOperationRef.current;
    if (current?.external?.applied) return;
    if (current?.external) emitExternalAction(current.external, externalPhase);
    aiRequestIdRef.current += 1;
    aiWritingAbortRef.current?.abort();
    aiWritingAbortRef.current = null;
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
    if (!editor.isEditable || aiOperationRef.current || getInlineFlow(editor)) return;
    closeWriteComposer(false);
    const initialHref = String(editor.getAttributes("link").href ?? "");
    if (editor.state.selection.empty && initialHref) editor.commands.extendMarkRange("link");
    const selection = captureConceptLinkSelection(editor);
    const { selectedText } = selection;
    let aiContext: EditorAILinkContext | undefined;
    try {
      const capture = captureAIWritingSelection(editor, "paragraph");
      // Link naming uses the exact link selection, rather than the normalized
      // whole-block replacement scope used by multi-paragraph writing actions.
      const workingContext = captureAIWorkingContext(editor, capture, selection);
      aiContext = { documentMarkdown: capture.documentMarkdown, workingContext };
    } catch { /* A failed AI capture must not prevent adding a manual link. */ }
    const existingConcept =
      selection.mode === "inline" && selectedText
        ? findConceptByPhrase(concepts, selectedText)
        : undefined;
    setCitationDraft(null);
    setLinkDraft({
      ...selection,
      aiContext,
      selectionJSON: editor.state.selection.toJSON(),
      anchorPosition: firstSelectedTextPosition(editor.state.doc, selection.from, selection.to),
      initialHref: normalizeExternalLink(initialHref) ?? undefined,
      initialNoteId: initialHref.startsWith("orion-note://") ? initialHref.slice("orion-note://".length) : undefined,
      initialPhrase: selection.mode === "context" ? "" : selectedText,
      initialDestinationIds:
        existingConcept?.noteIds.length && !existingConcept.canonicalNoteId
          ? [...existingConcept.noteIds]
          : [],
      documentMarkdown: editor.getMarkdown(),
    });
    setAnnouncement(
      "Search notes or paste a URL. You can also create a linked article.",
    );
  }

  function applyDestinationLink(href: string, fallbackText: string) {
    if (!linkDraft) return;
    if (!isConceptLinkDocumentCurrent(editor, linkDraft.documentMarkdown)) {
      setLinkDraft(null);
      setAnnouncement("This note changed. Select the words and open Link again.");
      return;
    }
    const { from, to } = linkDraft;
    const applied = from !== to
      ? editor.chain().focus().command(({ tr }) => { tr.setSelection(Selection.fromJSON(tr.doc, linkDraft.selectionJSON)); return true; }).setLink({ href, target: null, rel: null }).run()
      : editor.chain().focus().insertContentAt(from, { type: "text", text: fallbackText, marks: [{ type: "link", attrs: { href, target: null, rel: null } }] }).run();
    setLinkDraft(null);
    setAnnouncement(applied ? "Link added. The selected words are unchanged. Undo is available." : "A link cannot be added to this selection.");
  }

  function applyExternalLink(value: string) {
    const url = normalizeExternalLink(value);
    if (!url) { setAnnouncement("Enter a valid http or https web address."); return; }
    applyDestinationLink(url, url);
  }

  function applyNoteLink(targetId: string) {
    const target = notes.find(note => note.id === targetId);
    if (!target) { setAnnouncement("That note is no longer available in this Space."); return; }
    applyDestinationLink(`orion-note://${target.id}`, target.title);
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
    const linkedDocument: { body?: string } = {};
    const conceptId = onRegisterConcept({
      phrase,
      destinationNoteIds: destinationIds,
      articleMode: options.articleMode,
      articleInstructions: options.articleInstructions,
      editorContext: linkDraft.aiContext,
      linkedDocument,
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
    // onUpdate synchronously publishes the normal full authored Markdown,
    // including frontmatter and preserved references. Share only that exact
    // successful insertion with the deferred article job's freshness check.
    if (applied) linkedDocument.body = lastEmittedMarkdownRef.current;
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
        writeComposerOpen || aiOperation ? " is-ai-writing-active" : ""
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
      {chatReview ? <div className="chat-note-review" role="region" aria-label="Review note changes">
        <div className="chat-note-review__description"><strong>{chatReview.mode === "rewrite" ? "Full rewrite" : "Focused edits"}</strong>
          <span>{chatReview.count} {chatReview.count === 1 ? "change" : "changes"} · <mark>Replacing</mark> <span className="chat-note-review__legend">Adding</span> · Not saved</span></div>
        <button type="button" className="button secondary" disabled={chatAccepting} onClick={() => finishChatReview(false)}>Discard</button>
        <button type="button" className="button primary chat-note-review__accept" disabled={chatAccepting} onClick={() => finishChatReview(true)}>{chatAccepting ? "Accepting…" : "Accept changes"}</button>
      </div> : <NativeFormattingDock>
      <div className="editor-toolbar-shell">
        <EditorToolbar
          writingSessionDisabled={Boolean(pendingInsert || linkDraft || citationDraft || linkTitleBusy || writeComposerOpen || aiOperation || imageBusy || voiceMemoInsertionRef.current)}
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
          aiWritingUnavailableReason={aiWritingUnavailableReason}
          aiWritingBusy={Boolean(aiOperation)}
          onOpenAIWriting={openWriteComposer}
          onAnnounce={setAnnouncement}
        />
      </div>
      {marginsVisible && <MarginsControl editor={editor} disabled={Boolean(aiOperation) || imageBusy || linkTitleBusy} onClose={closeMargins}/>}
      </NativeFormattingDock>}
      <SlashMenu editor={editor} suspended={Boolean(chatReview || pendingInsert || linkDraft || citationDraft || writeComposerOpen || aiOperation || imageBusy || flowActive)} onCommand={runSlashCommand}/>
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
        data-voice-note-body="editor"
        className="note-prose editor-prose"
        onKeyDown={(event) => {
          if (chatReview) { if (event.key === "Escape") { event.preventDefault(); finishChatReview(false); } return; }
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
        suspended={Boolean(chatReview || pendingInsert || linkDraft || citationDraft || writeComposerOpen || aiOperation || imageBusy || flowActive)}
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
        onComposerActiveChange={onAIComposerActiveChange}
        active
        writeComposerOpen={writeComposerOpen}
        onCloseWriteComposer={closeWriteComposer}
        onOpenLink={openLinkComposer}
        writingUnavailableReason={aiWritingUnavailableReason ?? `Add an ${aiProviderName ?? "AI provider"} key in Settings to write and rewrite.`}
        imageUnavailableReason={aiImageUnavailableReason}
        suspended={Boolean(chatReview || flowActive || pendingInsert || linkDraft || citationDraft || linkTitleBusy || editor.isActive("image") || (editor.isActive("table") && editor.state.selection.empty))}
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
        retryAvailable={!aiOperation?.external}
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
        <EditorInsertLayer editor={editor} position={linkDraft.anchorPosition}>
        <ConceptLinkPopover
          initialHref={linkDraft.initialHref}
          initialNoteId={linkDraft.initialNoteId}
          onExternalLink={applyExternalLink}
          onNoteLink={applyNoteLink}
          onOpenExternalLink={(url) => { void openEditorExternalLink(url).catch(() => setAnnouncement("The link could not be opened.")); }}
          initialPhrase={linkDraft.initialPhrase}
          selectedText={linkDraft.selectedText}
          selectionMode={linkDraft.mode}
          initialDestinationIds={linkDraft.initialDestinationIds}
          currentNoteId={noteId}
          notes={notes}
          concepts={concepts}
          aiArticleWritingEnabled={aiArticleWritingEnabled}
          aiProviderName={aiProviderName}
          onGenerateTitle={onGenerateLinkTitle ? (selectedContext, signal) => {
            if (!linkDraft.aiContext || !isConceptLinkDocumentCurrent(editor, linkDraft.documentMarkdown)) {
              return Promise.reject(new Error("This note changed or its selection is unavailable. Open Link again at the intended passage."));
            }
            return onGenerateLinkTitle(selectedContext, signal, linkDraft.aiContext);
          } : undefined}
          onGeneratingChange={setLinkTitleBusy}
          onCancel={() => {
            setLinkDraft(null);
            setAnnouncement("Link creation cancelled.");
            if (isConceptLinkDocumentCurrent(editor, linkDraft.documentMarkdown)) editor.view.dispatch(editor.state.tr.setSelection(Selection.fromJSON(editor.state.doc, linkDraft.selectionJSON)));
            editor.commands.focus(undefined, { scrollIntoView: false });
          }}
          onSubmit={applyConceptLink}
        />
        </EditorInsertLayer>
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

// A selection starting at a paragraph's trailing boundary can include its
// newline. Anchor the UI to the first selected glyph, not the preceding line.
function firstSelectedTextPosition(doc: ProseMirrorNode, from: number, to: number): number {
  let position = from;
  let found = false;
  if (from === to) return from;
  doc.nodesBetween(from, to, (node, pos) => {
    if (found) return false;
    if (node.isText && pos + node.nodeSize > from) {
      const start = Math.max(from, pos);
      const text = (node.text ?? "").slice(start - pos, Math.min(to, pos + node.nodeSize) - pos);
      const offset = text.search(/\S/);
      if (offset >= 0) { position = start + offset; found = true; }
    }
    return !found;
  });
  return position;
}
