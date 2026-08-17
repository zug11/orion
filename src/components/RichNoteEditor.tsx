import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
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
  AIImageProposal,
  AIImageRequestInput,
} from "../lib/aiImages";
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
} from "../lib/noteImages";
import { persistGeneratedNoteImage, saveNoteImage } from "../lib/storage";
import {
  canonicalizeSourceCitations,
  type SourceCitationReference,
} from "../lib/sourceCitations";
import type { Concept, EntityId, Note, Source } from "../types";
import {
  AIWritingControls,
  type AIWritingControlPosition,
  type AIWritingPhase,
} from "./AIWritingControls";
import { ConceptLinkPopover } from "./ConceptLinkPopover";
import { EditorToolbar } from "./EditorToolbar";
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

interface RichNoteEditorProps {
  noteId: EntityId;
  markdown: string;
  notes: readonly Note[];
  concepts: readonly Concept[];
  sources: readonly Source[];
  attachedSourceIds: readonly EntityId[];
  onChange: (markdown: string) => void;
  onAttachSource: (sourceId: EntityId) => void;
  onOpenSource?: (sourceId: EntityId) => void;
  onRegisterConcept: (input: RegisterWikiLinkInput) => EntityId;
  onGenerateLinkTitle?: (selectedContext: string) => Promise<string>;
  onGenerateAIWriting?: (
    input: Omit<AIWritingRequestInput, "originNoteId">,
  ) => Promise<string>;
  onGenerateAIImage?: (
    input: Omit<AIImageRequestInput, "originNoteId">,
    signal: AbortSignal,
  ) => Promise<AIImageProposal>;
  onDisableConceptAutoLink: (conceptId: EntityId) => void;
  aiArticleWritingEnabled?: boolean;
  aiImageGenerationEnabled?: boolean;
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
  noteId,
  markdown,
  notes,
  concepts,
  sources,
  attachedSourceIds,
  onChange,
  onAttachSource,
  onOpenSource,
  onRegisterConcept,
  onGenerateLinkTitle,
  onGenerateAIWriting,
  onGenerateAIImage,
  onDisableConceptAutoLink,
  aiArticleWritingEnabled = false,
  aiImageGenerationEnabled = false,
  aiProviderName,
  findQuery = "",
  onFindDecorationsChanged,
}: RichNoteEditorProps) {
  const [initialDocument] = useState(() => {
    const document = splitMarkdownFrontmatter(markdown);
    const citations = canonicalizeSourceCitations(document.content, sources);
    return {
      content: citations.body,
      prefix: document.prefix,
      references: citations.references,
    };
  });
  const conceptsRef = useRef(concepts);
  const sourcesRef = useRef(sources);
  const onChangeRef = useRef(onChange);
  const frontmatterRef = useRef(initialDocument.prefix);
  const lastEmittedMarkdownRef = useRef(markdown);
  const findQueryRef = useRef(findQuery);
  const onFindDecorationsChangedRef = useRef(onFindDecorationsChanged);
  const editorShellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const imageUploadActiveRef = useRef(false);
  const aiRequestIdRef = useRef(0);
  const aiOperationRef = useRef<AIOperation | null>(null);
  const aiImageAbortRef = useRef<AbortController | null>(null);
  const aiSelectionRef = useRef({ from: 0, to: 0, empty: true });
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [linkTitleBusy, setLinkTitleBusy] = useState(false);
  const [citationDraft, setCitationDraft] = useState<CitationDraft | null>(null);
  const [citationReferences, setCitationReferences] = useState<
    SourceCitationReference[]
  >(initialDocument.references);
  const [imageBusy, setImageBusy] = useState(false);
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
  sourcesRef.current = sources;
  onChangeRef.current = onChange;
  findQueryRef.current = findQuery;
  onFindDecorationsChangedRef.current = onFindDecorationsChanged;
  aiOperationRef.current = aiOperation;

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
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
      TableKit.configure({
        table: {
          resizable: false,
          renderWrapper: true,
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: "Start writing…",
        emptyEditorClass: "is-editor-empty",
      }),
      Image.configure({
        allowBase64: true,
        HTMLAttributes: {
          class: "note-embedded-image",
        },
      }),
      Markdown.configure({
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
          current.getMarkdown(),
          sourcesRef.current,
        );
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
        onChangeRef.current(nextMarkdown);
      },
    },
    [noteId],
  );
  editorRef.current = editor;

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
      editor.commands.focus("start");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editor]);

  useEffect(() => {
    if (!editor || markdown === lastEmittedMarkdownRef.current) {
      return;
    }
    const pendingAIWriting = aiOperationRef.current;
    if (pendingAIWriting) {
      aiRequestIdRef.current += 1;
      aiImageAbortRef.current?.abort();
      aiImageAbortRef.current = null;
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
    editor.commands.setContent(citations.body, {
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
          .querySelector<HTMLElement>(".editor-toolbar-shell")
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

  function setCurrentAIOperation(operation: AIOperation | null) {
    aiOperationRef.current = operation;
    setAIOperation(operation);
  }

  async function insertNoteImages(
    files: readonly File[],
    requestedPosition?: number,
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
        const position = Math.min(
          requestedPosition ?? currentEditor.state.selection.to,
          currentEditor.state.doc.content.size,
        );
        currentEditor
          .chain()
          .focus()
          .setTextSelection(position)
          .insertContent(images)
          .run();
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
      imageUploadActiveRef.current = false;
      setImageBusy(false);
    }
  }

  function toggleAIWriting() {
    const writingAvailable = aiArticleWritingEnabled && Boolean(onGenerateAIWriting);
    const imageAvailable = aiImageGenerationEnabled && Boolean(onGenerateAIImage);
    if (!writingAvailable && !imageAvailable) {
      setAnnouncement(
        `Add an ${aiProviderName ?? "AI provider"} key in Settings to use AI writing.`,
      );
      return;
    }
    if (aiWritingActive) {
      discardAIWriting(false);
      setAIWritingActive(false);
      setAISelectionPosition(HIDDEN_AI_CONTROL);
      setAIDockPosition(HIDDEN_AI_CONTROL);
      setAnnouncement("AI writing mode off.");
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
          ? "AI writing mode on. Continue is available at the bottom of the note."
          : "AI mode on. Select a passage to generate an image."
        : imageAvailable
          ? "AI mode on. Rewrite and image generation are available for the selection."
          : "AI writing mode on. Rewrite is available for the selected text.",
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

  function requestAIImage(instruction: string) {
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
    void runAIImageRequest({ instruction, capture, assetId: `image_${nanoid(18)}` });
  }

  async function runAIImageRequest(input: {
    instruction: string;
    capture: AIWritingCapture;
    assetId: string;
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
    try {
      const image = await onGenerateAIImage(
        {
          instruction: input.instruction,
          selectedMarkdown: input.capture.selectedMarkdown,
          selectedText: input.capture.selectedText,
        },
        controller.signal,
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
      });
      setAnnouncement("Generated image ready. Insert it, try again, or discard it.");
      window.requestAnimationFrame(updateAIControlPositions);
    } catch (error) {
      if (requestId !== aiRequestIdRef.current || editor.isDestroyed) return;
      const message = error instanceof Error ? error.message : String(error);
      setCurrentAIOperation({ ...generating, phase: "error", error: message });
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
      void runAIImageRequest({
        instruction: current.instruction,
        capture: current.capture,
        assetId: `image_${nanoid(18)}`,
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
      <div className="editor-toolbar-shell">
        <EditorToolbar
          editor={editor}
          concepts={concepts}
          onOpenLink={openLinkComposer}
          onUnlink={unlinkSelection}
          citationAvailable={sources.length > 0}
          onOpenCitation={openCitationPicker}
          onInsertImages={(files) => void insertNoteImages(files)}
          imageBusy={imageBusy}
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
      <SourceReferences
        references={citationReferences}
        onOpenSource={onOpenSource}
      />
      <AIWritingControls
        active={aiWritingActive}
        suspended={Boolean(linkDraft || citationDraft || linkTitleBusy)}
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
        operationKind={aiOperation?.kind ?? "writing"}
        onRequest={requestAIWriting}
        onRequestImage={requestAIImage}
        onAccept={() => void acceptAIWriting()}
        onRetry={retryAIWriting}
        onDiscard={() => discardAIWriting(true)}
      />
      {linkDraft && (
        <ConceptLinkPopover
          initialPhrase={linkDraft.initialPhrase}
          selectedText={linkDraft.selectedText}
          selectionMode={linkDraft.mode}
          initialDestinationIds={linkDraft.initialDestinationIds}
          currentNoteId={noteId}
          notes={notes}
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
