import { parseNoteExcerptTitle } from "../lib/noteExcerpts";
import { requestNoteExcerptNavigation, consumeNoteExcerptNavigation, revealNoteExcerptPassage, clearNoteExcerptHighlight, NOTE_PASSAGE_NAVIGATION_EVENT } from "../lib/noteExcerptNavigation";
import { noteTableHeaderInfo, noteTableLayoutAtLine, remarkNoteTableMetadata } from "../lib/noteTables";
import { remarkNoteBlocks } from "../lib/noteBlocks";
import { remarkNoteTextAlignment } from "../lib/noteTextAlignment";
import { splitDocumentMargins, noteMarginsStyle, remarkNoteMargins } from "../lib/noteMargins";
import "./editor/excerpt.css";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Edit3,
  Download,
  LoaderCircle,
  Pause,
  Play,
  Quote,
  Search,
  Trash2,
  X,
} from "../lib/icons";
import {
  Children,
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import type { Element as MarkdownElement } from "hast";
import remarkGfm from "remark-gfm";
import { isSafeNoteImageUrl } from "../lib/noteImages";
import { parseNoteImageTitle, noteImageLayoutStyle, noteImageContentStyle } from "../lib/noteImageLayout";
import "./editor/EditorExperience.css";
import type { RegisterWikiLinkInput } from "../lib/concepts";
import type { AIWritingRequestInput } from "../lib/aiWriting";
import type { AIImageProposal, AIImageRequestInput } from "../lib/aiImages";
import type { AIImageGenerationCallbacks } from "./RichNoteEditor";
import {
  expandOrionWikiLinks,
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
  stripDuplicateTitleHeading,
  stripOrionNoteMarkers,
} from "../lib/markdown";
import { collectTasksFromNote, setTaskChecked } from "../lib/tasks";
import { findTextMatches, wrapMatchIndex } from "../lib/noteFind";
import { visibleNoteTags } from "../lib/noteMetadata";
import {
  extractNoteOutline,
  resolveActiveOutlineHeading,
} from "../lib/noteOutline";
import {
  dwellSpeech,
  formatSpeechClock,
  type SpeechPlaybackProgress,
  type SpeechPlaybackOptions,
} from "../lib/speech";
import { buildNarrationDocument, clearNarrationHighlight, highlightNarration, narrationCharacterAtPoint, narrationWordAt, type NarrationDocument } from "../lib/noteNarration";
import "./NoteNarration.css";
import { canonicalizeSourceCitations } from "../lib/sourceCitations";
import { savedChatEvidence } from "../lib/chatCitations";
import { CitedPassage } from "./CitedPassage";
import { decorateAutoLinks } from "../lib/wiki";
import type { Concept, Note, NoteTypeface, Source } from "../types";
import { isGeneratePlaceholder } from "../lib/generate";
import {
  buildDeckPlaybackCues,
  cueIndexAtElapsed,
  deckPlaybackDuration,
  isSlideDeckNote,
  parseDeckSlides,
  upcomingDeckSpeechTexts,
} from "../lib/slideDeck";
import { FavoriteMark } from "./icons/FavoriteMark";
import { NoteOutline } from "./NoteOutline";
import { SlideDeckView } from "./SlideDeckView";
import { SourceReferences } from "./SourceReferences";

const RichNoteEditor = lazy(() =>
  import("./RichNoteEditor").then((module) => ({
    default: module.RichNoteEditor,
  })),
);

const EMPTY_SOURCES: readonly Source[] = [];

/** Loose GFM lists nest their marker in a paragraph. Nested lists keep their
 * own markers so each list-item renderer can replace exactly one checkbox. */
function withoutTaskMarker(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (!isValidElement<{ children?: ReactNode; type?: string }>(child)) return child;
    if (child.type === "input" && child.props.type === "checkbox") return null;
    if (child.type === "ul" || child.type === "ol") return child;
    return child.props.children === undefined ? child : cloneElement(child, {
      children: withoutTaskMarker(child.props.children),
    });
  });
}

interface NoteViewProps {
  initialEditing?: boolean;
  /** Window-local modes for this Space; these are navigation state, not note data. */
  editingModes?: Map<string, boolean>;
  noteTypeface?: NoteTypeface;
  onNoteTypefaceChange?: (typeface: NoteTypeface) => void;
  note: Note;
  notes: Note[];
  concepts: Concept[];
  sources?: readonly Source[];
  onOpenNote: (noteId: string) => void;
  onOpenConcept: (conceptId: string) => void;
  onOpenSource?: (sourceId: string) => void;
  onAttachSource?: (noteId: string, sourceId: string) => void;
  onUpdateNote: (note: Note) => void;
  onDeleteNote: (noteId: string) => void;
  onFinishEditing?: (noteId: string) => void;
  onRegisterConcept: (input: RegisterWikiLinkInput) => string;
  onGenerateLinkTitle?: (selectedContext: string, signal?: AbortSignal) => Promise<string>;
  onGenerateAIWriting?: (
    input: Omit<AIWritingRequestInput, "originNoteId">,
  ) => Promise<string>;
  onGenerateAIImage?: (
    input: Omit<AIImageRequestInput, "originNoteId">,
    signal: AbortSignal,
    callbacks?: AIImageGenerationCallbacks,
  ) => Promise<AIImageProposal>;
  onSpeakNote?: (
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: SpeechPlaybackProgress) => void,
    options?: SpeechPlaybackOptions,
  ) => Promise<void>;
  onPrepareSpeech?: (text: string, signal?: AbortSignal) => Promise<void>;
  onDownloadNarration?: (text: string, title: string, signal: AbortSignal,
    onProgress: (completed: number, total: number) => void) => Promise<void>;
  onPrepareVoiceMemoSession?: (sessionId: string) => Promise<void>;
  onTranscribeVoiceMemo?: (audio: Blob, sessionId: string) => Promise<string>;
  onFinishVoiceMemoSession?: (sessionId: string) => Promise<void>;
  onDisableConceptAutoLink: (conceptId: string) => void;
  aiArticleWritingEnabled?: boolean;
  aiImageGenerationEnabled?: boolean;
  imageContextEnabled?: boolean;
  aiProviderName?: string;
}

function safeUrl(url: string) {
  if (
    isSafeNoteImageUrl(url) ||
    url.startsWith("orion-note://") ||
    url.startsWith("orion-concept://") ||
    url.startsWith("orion-source://") ||
    /^#orion-passage-e[1-9]\d{0,3}$/.test(url) ||
    /^https?:\/\//i.test(url) ||
    /^mailto:/i.test(url)
  ) {
    return url;
  }
  return "#";
}

export function NoteView({
  initialEditing = false,
  editingModes,
  noteTypeface = "sans",
  onNoteTypefaceChange,
  note,
  notes,
  concepts,
  sources = EMPTY_SOURCES,
  onOpenNote,
  onOpenConcept,
  onOpenSource,
  onAttachSource,
  onUpdateNote,
  onDeleteNote,
  onFinishEditing,
  onRegisterConcept,
  onGenerateLinkTitle,
  onGenerateAIWriting,
  onGenerateAIImage,
  onSpeakNote,
  onPrepareSpeech,
  onDownloadNarration,
  onPrepareVoiceMemoSession,
  onTranscribeVoiceMemo,
  onFinishVoiceMemoSession,
  onDisableConceptAutoLink,
  aiArticleWritingEnabled = false,
  aiImageGenerationEnabled = false,
  imageContextEnabled = false,
  aiProviderName,
}: NoteViewProps) {
  const localEditingModes = useRef(new Map<string, boolean>());
  const modes = editingModes ?? localEditingModes.current;
  const [editing, setEditingState] = useState(() => modes.get(note.id) ?? (initialEditing || note.title === "Untitled note"));
  const setEditing = useCallback((value: boolean) => {
    modes.set(note.id, value);
    setEditingState(value);
  }, [modes, note.id]);
  const [savedPulse, setSavedPulse] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResultCount, setFindResultCount] = useState(0);
  const [activeFindIndex, setActiveFindIndex] = useState(0);
  const [findRevision, setFindRevision] = useState(0);
  const [listening, setListening] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);
  const [narrationDownload, setNarrationDownload] = useState<{ completed: number; total: number } | null>(null);
  const narrationDownloadRef = useRef<AbortController | null>(null);
  useEffect(() => {
    narrationDownloadRef.current?.abort();
    narrationDownloadRef.current = null;
    setNarrationDownload(null);
    return () => { narrationDownloadRef.current?.abort(); };
  }, [note.id, note.title, note.summary, note.body, editing]);
  const [listenProgress, setListenProgress] =
    useState<SpeechPlaybackProgress | null>(null);
  const [narrationActive, setNarrationActive] = useState(false);
  const [followNarration, setFollowNarration] = useState(true);
  const narrationRef = useRef<NarrationDocument | null>(null);
  const narrationPreparationRef = useRef<AbortController | null>(null);
  const narrationSourceRef = useRef<Pick<Note, "id" | "title" | "summary" | "body"> | null>(null);
  const narrationPositionRef = useRef({ charIndex: 0, charLength: 0 });
  const progressPaintRef = useRef(0);
  const [deckIndex, setDeckIndex] = useState(0);
  const listenAbortRef = useRef<AbortController | null>(null);
  const playGenerationRef = useRef(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findScopeRef = useRef<HTMLElement>(null);
  const currentNoteRef = useRef(note);
  currentNoteRef.current = note;
  const dirtyEditingRef = useRef(false);
  const [selectedPassageId, setSelectedPassageId] = useState<string | null>(null);
  const passageTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restorePassageFocusRef = useRef<string | null>(null);
  const retainedPassages = useMemo(() => savedChatEvidence(note.body), [note.body]);
  const selectedPassage = retainedPassages.find((item) => item.id === selectedPassageId);
  const passagePanelId = `note-evidence-${note.id}`;
  useEffect(() => setSelectedPassageId(null), [note.id]);
  useLayoutEffect(() => {
    const id = restorePassageFocusRef.current;
    if (!id || selectedPassageId !== null) return;
    restorePassageFocusRef.current = null;
    findScopeRef.current?.querySelector<HTMLButtonElement>(`[data-saved-passage="${id}"]`)?.focus({ preventScroll: true });
  }, [selectedPassageId]);
  const closePassage = () => {
    restorePassageFocusRef.current = selectedPassageId;
    setSelectedPassageId(null);
    passageTriggerRef.current?.focus({ preventScroll: true });
  };
  const savedPulseTimerRef = useRef<number | null>(null);
  const markdown = useMemo(
    () => {
      const document = splitMarkdownFrontmatter(note.body);
      const content = expandOrionWikiLinks(
        stripDuplicateTitleHeading(
          stripOrionNoteMarkers(document.content),
          note.title,
        ),
        notes,
        concepts,
      );
      return restoreMarkdownFrontmatter(document.prefix, content);
    },
    [concepts, note.body, note.title, notes],
  );
  const citationDocument = useMemo(
    () =>
      canonicalizeSourceCitations(
        splitMarkdownFrontmatter(markdown).content,
        sources,
      ),
    [markdown, sources],
  );
  const marginDocument = useMemo(() => splitDocumentMargins(citationDocument.body), [citationDocument.body]);
  const visibleMarkdown = marginDocument.body;
  const outlineHeadings = useMemo(
    () => extractNoteOutline(visibleMarkdown),
    [visibleMarkdown],
  );
  const deckSlides = useMemo(
    () => parseDeckSlides(visibleMarkdown),
    [visibleMarkdown],
  );
  const deckCues = useMemo(
    () => buildDeckPlaybackCues(deckSlides),
    [deckSlides],
  );
  const showSlideshow =
    !editing &&
    isSlideDeckNote(note) &&
    !isGeneratePlaceholder(note) &&
    deckSlides.length > 0;
  const showPlayhead = listening || narrationActive || (showSlideshow && Boolean(onSpeakNote));
  const idleDeckProgress = useMemo((): SpeechPlaybackProgress | null => {
    if (!showSlideshow || listening) return null;
    const durationSeconds = deckPlaybackDuration(deckCues);
    const startSeconds = deckCues[deckIndex]?.startSeconds ?? 0;
    return {
      elapsedSeconds: startSeconds,
      durationSeconds,
      ratio: durationSeconds > 0 ? startSeconds / durationSeconds : 0,
      loading: false,
    };
  }, [deckCues, deckIndex, listening, showSlideshow]);
  const playheadProgress = listening || narrationActive ? listenProgress : idleDeckProgress;
  const showOutline =
    !editing && !showSlideshow && outlineHeadings.length > 0;
  const headingIdByLine = useMemo(
    () => new Map(outlineHeadings.map((heading) => [heading.line, heading.id])),
    [outlineHeadings],
  );
  const readTaskByVisibleLine = useMemo(() => {
    const storedTasks = collectTasksFromNote(note, concepts);
    const visibleTasks = collectTasksFromNote(
      { ...note, body: visibleMarkdown },
      concepts,
    );
    return new Map(
      visibleTasks.map((task, index) => [
        task.lineIndex,
        storedTasks[index] ?? task,
      ]),
    );
  }, [concepts, note, visibleMarkdown]);
  const linkableConcepts = useMemo(
    () =>
      concepts
        .filter((concept) => concept.canonicalNoteId !== note.id)
        .map((concept) => ({
          ...concept,
          noteIds: concept.noteIds.filter((noteId) => noteId !== note.id),
        }))
        .filter((concept) => concept.noteIds.length > 0),
    [concepts, note.id],
  );

  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const citationBySourceId = useMemo(
    () =>
      new Map(
        citationDocument.references.map((reference) => [
          reference.sourceId,
          reference,
        ]),
      ),
    [citationDocument.references],
  );

  useEffect(() => {
    dirtyEditingRef.current = false;
    setEditing(modes.get(note.id) ?? (initialEditing || note.title === "Untitled note"));
    setFindOpen(false);
    setFindQuery("");
    setFindResultCount(0);
    setActiveFindIndex(0);
    setActiveHeadingId(null);
  }, [note.id, modes]);

  useEffect(() => {
    // Consume only after StrictMode's setup/cleanup replay. Consuming during
    // setup loses the one-shot request when that first animation frame is cancelled.
    let frame = 0;
    const reveal = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const request = consumeNoteExcerptNavigation(note.id);
        if (request) {
          setEditing(false);
          frame = window.requestAnimationFrame(() => {
            const prose = findScopeRef.current?.querySelector<HTMLElement>(".note-prose");
            if (prose) revealNoteExcerptPassage(prose, currentNoteRef.current, request);
          });
        }
      });
    };
    const receive = (event: Event) => { if ((event as CustomEvent<{ noteId: string }>).detail?.noteId === note.id) reveal(); };
    window.addEventListener(NOTE_PASSAGE_NAVIGATION_EVENT, receive);
    reveal();
    return () => { window.removeEventListener(NOTE_PASSAGE_NAVIGATION_EVENT, receive); window.cancelAnimationFrame(frame); clearNoteExcerptHighlight(); };
  }, [note.id]);

  const openFind = useCallback(() => {
    setFindOpen(true);
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);

  const closeFind = useCallback(() => {
    const scrollContainer = findScopeRef.current?.closest(
      ".workspace-content",
    ) as HTMLElement | null;
    const scrollPosition = scrollContainer
      ? {
          left: scrollContainer.scrollLeft,
          top: scrollContainer.scrollTop,
        }
      : null;
    setFindOpen(false);
    setFindQuery("");
    setFindResultCount(0);
    setActiveFindIndex(0);
    window.requestAnimationFrame(() => {
      if (scrollContainer && scrollPosition) {
        scrollContainer.scrollLeft = scrollPosition.left;
        scrollContainer.scrollTop = scrollPosition.top;
      }
      findButtonRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const flushDirtyEditing = useCallback(() => {
    if (!dirtyEditingRef.current) return;
    dirtyEditingRef.current = false;
    onFinishEditing?.(note.id);
  }, [note.id, onFinishEditing]);

  useEffect(
    () => () => {
      flushDirtyEditing();
    },
    [flushDirtyEditing],
  );

  useEffect(() => {
    const handleFindShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && event.key.toLocaleLowerCase() === "f") {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        openFind();
        return;
      }
      if (event.key === "Escape" && findOpen) {
        event.preventDefault();
        closeFind();
      }
    };
    window.addEventListener("keydown", handleFindShortcut, true);
    return () => window.removeEventListener("keydown", handleFindShortcut, true);
  }, [closeFind, findOpen, openFind]);

  useEffect(
    () => () => {
      if (savedPulseTimerRef.current !== null) {
        window.clearTimeout(savedPulseTimerRef.current);
      }
      playGenerationRef.current += 1;
      listenAbortRef.current?.abort();
      narrationPreparationRef.current?.abort();
      globalThis.speechSynthesis?.cancel();
      clearNarrationHighlight();
    },
    [],
  );

  useEffect(() => {
    playGenerationRef.current += 1;
    listenAbortRef.current?.abort();
    listenAbortRef.current = null;
    narrationPreparationRef.current?.abort();
    narrationPreparationRef.current = null;
    globalThis.speechSynthesis?.cancel();
    setListening(false);
    setListenProgress(null);
    setListenError(null);
    setDeckIndex(0);
    narrationRef.current = null;
    setNarrationActive(false);
    clearNarrationHighlight();
  }, [note.id]);

  useEffect(() => {
    // Recorded offsets belong to this exact displayed wording, never a later edit.
    const source = narrationSourceRef.current;
    if (narrationRef.current && (editing || !source || source.id !== note.id || source.body !== note.body
      || source.title !== note.title || source.summary !== note.summary)) stopPlayback();
  }, [note.body, note.title, note.summary, editing]);

  function stopPlayback(options?: { keepProgress?: boolean }) {
    playGenerationRef.current += 1;
    listenAbortRef.current?.abort();
    listenAbortRef.current = null;
    globalThis.speechSynthesis?.cancel();
    setListening(false);
    if (!options?.keepProgress) {
      narrationPreparationRef.current?.abort();
      narrationPreparationRef.current = null;
      setListenProgress(null);
      narrationRef.current = null;
      setNarrationActive(false);
      narrationPositionRef.current = { charIndex: 0, charLength: 0 };
      clearNarrationHighlight();
    }
  }

  function startDeckPlayback(from: number) {
    if (!onSpeakNote) return;
    const cues = buildDeckPlaybackCues(deckSlides);
    if (cues.length === 0) {
      setListenError("This deck has nothing to play yet.");
      return;
    }
    stopPlayback({ keepProgress: true });
    const generation = playGenerationRef.current;
    const controller = new AbortController();
    listenAbortRef.current = controller;
    const startAt = Math.min(Math.max(0, from), cues.length - 1);
    setListenError(null);
    setListening(true);
    setDeckIndex(startAt);
    const total = deckPlaybackDuration(cues);
    setListenProgress({
      elapsedSeconds: cues[startAt]?.startSeconds ?? 0,
      durationSeconds: total,
      ratio: total > 0 ? (cues[startAt]?.startSeconds ?? 0) / total : 0,
      loading: true,
    });
    const prefetchUpcoming = (fromIndex: number) => {
      if (!onPrepareSpeech) return;
      for (const text of upcomingDeckSpeechTexts(cues, fromIndex)) {
        void onPrepareSpeech(text, controller.signal).catch(() => undefined);
      }
    };
    prefetchUpcoming(startAt);
    void (async () => {
      try {
        for (let index = startAt; index < cues.length; index += 1) {
          if (
            controller.signal.aborted ||
            playGenerationRef.current !== generation
          ) {
            return;
          }
          setDeckIndex(index);
          prefetchUpcoming(index + 1);
          const cue = cues[index];
          const reportProgress = (progress: SpeechPlaybackProgress) => {
            if (playGenerationRef.current !== generation) return;
            const durationSeconds =
              cue.startSeconds +
              (progress.durationSeconds || cue.durationSeconds) +
              cues
                .slice(index + 1)
                .reduce((sum, item) => sum + item.durationSeconds, 0);
            const elapsedSeconds = cue.startSeconds + progress.elapsedSeconds;
            setListenProgress({
              elapsedSeconds,
              durationSeconds,
              ratio:
                durationSeconds > 0
                  ? Math.min(1, elapsedSeconds / durationSeconds)
                  : 0,
              loading: progress.loading,
            });
          };
          if (!cue.text.trim()) {
            await dwellSpeech(
              cue.durationSeconds,
              controller.signal,
              reportProgress,
            );
            continue;
          }
          await onSpeakNote(cue.text, controller.signal, reportProgress);
        }
        if (playGenerationRef.current !== generation) return;
        listenAbortRef.current = null;
        setListening(false);
        setListenProgress({
          elapsedSeconds: total,
          durationSeconds: total,
          ratio: 1,
          loading: false,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          playGenerationRef.current !== generation
        ) {
          return;
        }
        listenAbortRef.current = null;
        setListening(false);
        setListenError(
          error instanceof Error ? error.message : String(error),
        );
      }
    })();
  }

  function changeDeckIndex(next: number) {
    const clamped = Math.min(
      Math.max(0, next),
      Math.max(0, deckSlides.length - 1),
    );
    setDeckIndex(clamped);
    if (listening) startDeckPlayback(clamped);
  }

  function seekDeckPlayback(ratio: number) {
    const duration = deckPlaybackDuration(deckCues);
    if (duration <= 0 || deckCues.length === 0) return;
    const next = cueIndexAtElapsed(
      deckCues,
      Math.min(1, Math.max(0, ratio)) * duration,
    );
    if (listening) startDeckPlayback(next);
    else setDeckIndex(next);
  }

  async function togglePlayback() {
    if (listening) {
      stopPlayback({ keepProgress: true });
      return;
    }
    if (!onSpeakNote) return;
    if (showSlideshow) {
      const atEnd =
        deckIndex >= deckSlides.length - 1 &&
        (listenProgress?.ratio ?? idleDeckProgress?.ratio ?? 0) >= 0.98;
      startDeckPlayback(atEnd ? 0 : deckIndex);
      return;
    }
    if (editing) {
      flushDirtyEditing();
      setEditing(false);
      const noteId = note.id;
      window.requestAnimationFrame(() => {
        if (currentNoteRef.current.id === noteId) void startNotePlayback(0);
      });
      return;
    }
    await startNotePlayback(narrationRef.current ? narrationPositionRef.current.charIndex : 0);
  }

  async function startNotePlayback(requestedCharacter: number) {
    if (!onSpeakNote || !findScopeRef.current) return;
    const script = buildNarrationDocument(findScopeRef.current);
    if (!script.text) {
      setListenError("This note has nothing to play.");
      return;
    }
    const word = narrationWordAt(script, requestedCharacter);
    const start = word?.from ?? 0;
    stopPlayback({ keepProgress: true });
    narrationRef.current = script;
    narrationPreparationRef.current ??= new AbortController();
    const preparationSignal = narrationPreparationRef.current.signal;
    narrationSourceRef.current = note;
    const seekPosition = { charIndex: start, charLength: word ? word.to - word.from : 0 };
    narrationPositionRef.current = seekPosition;
    // Seeking changes the reading position immediately, even if repeated seeks
    // share the same pending audio request and React batches loading updates.
    if (followNarration) highlightNarration(script, seekPosition.charIndex, seekPosition.charLength);
    setNarrationActive(true);
    const generation = playGenerationRef.current;
    const controller = new AbortController();
    listenAbortRef.current = controller;
    setListenError(null);
    setListening(true);
    setListenProgress({
      elapsedSeconds: 0,
      durationSeconds: 0,
      ratio: start / Math.max(1, script.text.length),
      loading: true,
      charIndex: start,
      charLength: seekPosition.charLength,
    });
    try {
      await onSpeakNote(script.text, controller.signal, (progress) => {
        if (controller.signal.aborted || playGenerationRef.current !== generation) return;
        const previous = narrationPositionRef.current;
        const position = typeof progress.charIndex === "number"
          ? { charIndex: progress.charIndex, charLength: progress.charLength ?? 0 }
          : previous;
        narrationPositionRef.current = position;
        const now = performance.now();
        if (now - progressPaintRef.current >= 80 || position.charIndex !== previous.charIndex || progress.loading || progress.ratio >= 1) {
          progressPaintRef.current = now;
          setListenProgress({ ...progress, ...position });
        }
      }, { startCharIndex: start, trackWords: true, preparationSignal });
    } catch (error) {
      if (!controller.signal.aborted) {
        setListenError(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      if (
        listenAbortRef.current === controller &&
        playGenerationRef.current === generation
      ) {
        listenAbortRef.current = null;
        setListening(false);
        setListenProgress(null);
        narrationPreparationRef.current?.abort();
        narrationPreparationRef.current = null;
        narrationRef.current = null;
        setNarrationActive(false);
        clearNarrationHighlight();
      }
    }
  }

  async function saveNarration() {
    if (narrationDownloadRef.current) {
      narrationDownloadRef.current.abort();
      narrationDownloadRef.current = null;
      setNarrationDownload(null);
      return;
    }
    if (!onDownloadNarration || !findScopeRef.current || editing) return;
    const script = buildNarrationDocument(findScopeRef.current);
    const controller = new AbortController();
    narrationDownloadRef.current = controller;
    setNarrationDownload({ completed: 0, total: 0 });
    setListenError(null);
    try {
      await onDownloadNarration(script.text, note.title, controller.signal, (completed, total) => {
        if (!controller.signal.aborted) setNarrationDownload({ completed, total });
      });
    } catch (error) {
      if (!controller.signal.aborted) setListenError(error instanceof Error ? error.message : String(error));
    } finally {
      if (narrationDownloadRef.current === controller) {
        narrationDownloadRef.current = null;
        setNarrationDownload(null);
      }
    }
  }

  const downloadControl = onDownloadNarration && !editing && !showSlideshow ? <button
    type="button" className="icon-button" aria-label={narrationDownload ? "Cancel narration download" : "Download narration"}
    title={narrationDownload ? `Cancel narration download${narrationDownload.total ? ` (${narrationDownload.completed}/${narrationDownload.total})` : ""}` : "Download narration"}
    onClick={() => { void saveNarration(); }}>
    {narrationDownload ? <LoaderCircle size={15} className="narration-download-spinner"/> : <Download size={15}/>}
  </button> : null;

  function update(patch: Partial<Note>) {
    if (editing) {
      dirtyEditingRef.current = true;
    }
    onUpdateNote({
      ...note,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    setSavedPulse(true);
    if (savedPulseTimerRef.current !== null) {
      window.clearTimeout(savedPulseTimerRef.current);
    }
    savedPulseTimerRef.current = window.setTimeout(() => {
      setSavedPulse(false);
      savedPulseTimerRef.current = null;
    }, 950);
  }

  const syncFindMatches = useCallback(() => {
    const matches = [
      ...(findScopeRef.current?.querySelectorAll<HTMLElement>(
        "[data-note-find-match]",
      ) ?? []),
    ];
    const count = findQuery.trim() ? matches.length : 0;
    setFindResultCount((current) => (current === count ? current : count));
    const normalizedIndex = wrapMatchIndex(activeFindIndex, count);
    if (normalizedIndex !== activeFindIndex) {
      setActiveFindIndex(normalizedIndex);
    }
    matches.forEach((match, index) => {
      const active = index === normalizedIndex && count > 0;
      match.classList.toggle("is-current", active);
      if (active) {
        match.setAttribute("aria-current", "true");
      } else {
        match.removeAttribute("aria-current");
      }
    });
  }, [activeFindIndex, findQuery]);

  useLayoutEffect(() => {
    syncFindMatches();
  }, [
    editing,
    findRevision,
    note.summary,
    note.title,
    syncFindMatches,
    visibleMarkdown,
  ]);

  useEffect(() => {
    if (!findOpen || !findQuery.trim() || findResultCount === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const current = findScopeRef.current?.querySelector<HTMLElement>(
        '[data-note-find-match].is-current',
      );
      current?.scrollIntoView?.({
        behavior: typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFindIndex, editing, findOpen, findQuery, findResultCount, findRevision]);

  useEffect(() => {
    if (editing || outlineHeadings.length === 0) {
      setActiveHeadingId(null);
      return undefined;
    }

    const scrollContainer = findScopeRef.current?.closest<HTMLElement>(
      ".workspace-content",
    );
    if (!scrollContainer) return undefined;
    let frame = 0;

    const syncActiveHeading = () => {
      frame = 0;
      const threshold = scrollContainer.getBoundingClientRect().top + 112;
      const positions = outlineHeadings.flatMap((heading) => {
        const element = document.getElementById(heading.id);
        return element
          ? [{ id: heading.id, top: element.getBoundingClientRect().top }]
          : [];
      });
      const atScrollEnd =
        scrollContainer.scrollHeight > scrollContainer.clientHeight &&
        scrollContainer.scrollTop + scrollContainer.clientHeight >=
          scrollContainer.scrollHeight - 2;
      const active = resolveActiveOutlineHeading(
        positions,
        threshold,
        atScrollEnd,
      );
      setActiveHeadingId((current) => (current === active ? current : active));
    };
    const scheduleSync = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(syncActiveHeading);
    };

    scheduleSync();
    scrollContainer.addEventListener("scroll", scheduleSync, { passive: true });
    window.addEventListener("resize", scheduleSync);
    return () => {
      scrollContainer.removeEventListener("scroll", scheduleSync);
      window.removeEventListener("resize", scheduleSync);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [editing, outlineHeadings]);

  const selectOutlineHeading = useCallback((headingId: string) => {
    setActiveHeadingId(headingId);
    document.getElementById(headingId)?.scrollIntoView({
      behavior:
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
      block: "start",
    });
  }, []);

  function highlightFindText(text: string, keyPrefix: string): ReactNode {
    const matches = findTextMatches(text, findQuery);
    if (matches.length === 0) return text;
    const children: ReactNode[] = [];
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.from > cursor) children.push(text.slice(cursor, match.from));
      children.push(
        <mark
          className="note-find-match"
          data-note-find-match="true"
          key={`${keyPrefix}-${index}-${match.from}`}
        >
          {text.slice(match.from, match.to)}
        </mark>,
      );
      cursor = match.to;
    });
    if (cursor < text.length) children.push(text.slice(cursor));
    return children;
  }

  function renderFindChildren(children: ReactNode, keyPrefix: string): ReactNode {
    return Children.map(children, (child, index) => {
      if (typeof child === "string") {
        return highlightFindText(child, `${keyPrefix}-${index}`);
      }
      if (isValidElement(child)) {
        const element = child as ReactElement<{ children?: ReactNode }>;
        if (element.props.children === undefined) return child;
        return cloneElement(element, {
          ...element.props,
          children: renderFindChildren(
            element.props.children,
            `${keyPrefix}-${index}`,
          ),
        });
      }
      return child;
    });
  }

  function renderLinkedChildren(children: ReactNode): ReactNode {
    return Children.map(children, (child) => {
      if (typeof child === "string") {
        return decorateAutoLinks(
          child,
          linkableConcepts,
        ).map((segment, index) => {
          if (segment.type === "text") {
            return highlightFindText(segment.text, `plain-${index}`);
          }
          const concept = linkableConcepts.find(
            (candidate) => candidate.id === segment.conceptId,
          );
          if (!concept || segment.targetNoteIds.length === 0) {
            return segment.text;
          }
          return (
            <button
              type="button"
              key={`${concept.id}-${index}`}
              className={
                segment.ambiguous
                  ? "wiki-link ambiguous"
                  : "wiki-link"
              }
              aria-label={
                segment.ambiguous
                  ? `${segment.text}, choose a connected note`
                  : `${segment.text}, open wiki article`
              }
              onClick={() => onOpenConcept(concept.id)}
            >
              {highlightFindText(segment.text, `concept-${concept.id}-${index}`)}
              {segment.targetNoteIds.length > 1 && (
                <sup>{segment.targetNoteIds.length}</sup>
              )}
            </button>
          );
        });
      }
      if (isValidElement(child)) {
        const element = child as ReactElement<{
          children?: ReactNode;
          href?: string;
          className?: string;
        }>;
        const isProtectedInline =
          child.type === "code" ||
          child.type === "a" ||
          typeof element.props.href === "string" ||
          element.props.className?.split(" ").includes("wiki-link");

        if (isProtectedInline) {
          return cloneElement(element, {
            ...element.props,
            children: renderFindChildren(
              element.props.children,
              `protected-${String(element.key ?? "inline")}`,
            ),
          });
        }

        return cloneElement(element, {
          ...element.props,
          children: renderLinkedChildren(element.props.children),
        });
      }
      return child;
    });
  }

  const paragraphMarginStyle = (node?: { properties?: Record<string, unknown> }) => {
    const left = node?.properties?.["data-orion-margin-left"];
    const right = node?.properties?.["data-orion-margin-right"];
    if (left === undefined && right === undefined) return undefined;
    return noteMarginsStyle({ left: Number(left ?? 0), right: Number(right ?? 0) });
  };

  const markdownComponents = {
    table: ({ children, node }: { children?: ReactNode; node?: MarkdownElement }) => {
      const layout = noteTableLayoutAtLine(visibleMarkdown, node?.position?.start.line ?? 0);
      const header = noteTableHeaderInfo(node);
      const syntheticHeader = layout?.header === false && header.empty;
      const columns = header.columns || layout?.columns.length || 1;
      const minWidth = Array.from({ length: columns }, (_, index) => layout?.columns[index] ?? 96).reduce((sum, width) => sum + width, 0);
      const content = syntheticHeader ? Children.toArray(children).filter((child) => !isValidElement(child) || child.type !== "thead") : children;
      return (
        <div className="note-table-reading" data-header={!syntheticHeader} data-banded={layout?.banded !== false} style={{ width: `${layout?.width ?? 100}%` }}>
          <table style={{ minWidth }}>
            {layout?.columns.length ? <colgroup>{layout.columns.map((width, index) => <col key={index} style={width ? { width: `${width}px` } : undefined}/>)}</colgroup> : null}
            {content}
          </table>
        </div>
      );
    },

    img: ({src,alt,title}:{src?:string;alt?:string;title?:string}) => {
      if(!src || !isSafeNoteImageUrl(src)) return <span>{alt || "Image unavailable"}</span>;
      const parsed=parseNoteImageTitle(title);
      const content = <>
        <img src={src} alt={alt??""} title={parsed.title??undefined}/>
        {parsed.layout.showCaption && parsed.layout.caption && <span className="note-image-caption-reading">{parsed.layout.caption}</span>}
      </>;
      return <span className="note-image-reading" style={noteImageLayoutStyle(parsed.layout)}>
        {parsed.layout.xPercent === null ? content : <span className="note-image-free-content" style={noteImageContentStyle(parsed.layout)}>{content}</span>}
      </span>;
    },

    p: ({ children, node, ...props }: { children?: ReactNode; node?: MarkdownElement }) => (
      <p {...props} style={paragraphMarginStyle(node)}>{renderLinkedChildren(children)}</p>
    ),
    li: ({
      children,
      className,
      node,
    }: {
      children?: ReactNode;
      className?: string;
      node?: { position?: { start?: { line?: number } } };
    }) => {
      const visibleLine = (node?.position?.start?.line ?? 0) - 1;
      const task = className?.includes("task-list-item")
        ? readTaskByVisibleLine.get(visibleLine)
        : undefined;
      const renderedChildren = renderLinkedChildren(children);
      if (!task) {
        return <li className={className}>{renderedChildren}</li>;
      }
      const taskBody = withoutTaskMarker(renderedChildren);
      return (
        <li className={className}>
          <input
            type="checkbox"
            checked={task.checked}
            aria-label={`${task.checked ? "Mark incomplete" : "Complete"} ${task.text}`}
            onChange={(event) =>
              update({
                body: setTaskChecked(
                  note.body,
                  task.lineIndex,
                  event.currentTarget.checked,
                ),
              })
            }
          />
          <div className="task-list-content">{taskBody}</div>
        </li>
      );
    },
    h1: ({ children, node, ...props }: {children?:ReactNode;node?:{position?:{start?:{line?:number}};properties?:Record<string, unknown>}}) => (
      <h1 {...props} style={paragraphMarginStyle(node)} id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>{renderLinkedChildren(children)}</h1>
    ),
    h2: ({ children, node, ...props }: {children?:ReactNode;node?:{position?:{start?:{line?:number}};properties?:Record<string, unknown>}}) => (
      <h2 {...props} style={paragraphMarginStyle(node)} id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>{renderLinkedChildren(children)}</h2>
    ),
    h3: ({ children, node, ...props }: {children?:ReactNode;node?:{position?:{start?:{line?:number}};properties?:Record<string, unknown>}}) => (
      <h3 {...props} style={paragraphMarginStyle(node)} id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>{renderLinkedChildren(children)}</h3>
    ),
    h4: ({ children, node, ...props }: {children?:ReactNode;node?:{position?:{start?:{line?:number}};properties?:Record<string, unknown>}}) => (
      <h4 {...props} style={paragraphMarginStyle(node)} id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>{renderLinkedChildren(children)}</h4>
    ),
    h5: ({ children, node, ...props }: {children?:ReactNode;node?:{position?:{start?:{line?:number}};properties?:Record<string, unknown>}}) => (
      <h5 {...props} style={paragraphMarginStyle(node)} id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>{renderLinkedChildren(children)}</h5>
    ),
    h6: ({ children, node, ...props }: {children?:ReactNode;node?:{position?:{start?:{line?:number}};properties?:Record<string, unknown>}}) => (
      <h6 {...props} style={paragraphMarginStyle(node)} id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>{renderLinkedChildren(children)}</h6>
    ),
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote>
        <Quote size={16} />
        {renderLinkedChildren(children)}
      </blockquote>
    ),
    a: ({ href, title, children }: { href?: string; title?:string; children?: ReactNode }) => {
      if (href?.startsWith("#orion-passage-")) {
        const passage = retainedPassages.find((item) => href === `#orion-passage-${item.id}`);
        if (!passage) return <span>{children}</span>;
        return <button type="button" className="chat-citation" data-saved-passage={passage.id} aria-label={`Read citation: ${passage.title}`}
          aria-expanded={selectedPassageId === passage.id} aria-controls={passagePanelId}
          onClick={(event) => {
            passageTriggerRef.current = event.currentTarget;
            setSelectedPassageId(selectedPassageId === passage.id ? null : passage.id);
          }}>{children}</button>;
      }
      if (href?.startsWith("orion-note://")) {
        const noteId = href.slice("orion-note://".length);
        const excerpt=parseNoteExcerptTitle(title,href);
        if(!notes.some(candidate=>candidate.id===noteId))return <span>{children}</span>;
        return (
          <button
            type="button"
            className={`wiki-link explicit${excerpt?" note-excerpt-source-link":""}`}
            onClick={() => {
              if(excerpt)requestNoteExcerptNavigation(noteId,excerpt.passages);
              onOpenNote(noteId);
            }}
          >
            {renderFindChildren(children, `note-link-${noteId}`)}
          </button>
        );
      }
      if (href?.startsWith("orion-concept://")) {
        const conceptId = href.slice("orion-concept://".length);
        const concept = concepts.find((item) => item.id === conceptId);
        return (
          <button
            type="button"
            className="wiki-link explicit"
            aria-label={
              concept && !concept.canonicalNoteId && concept.noteIds.length > 1
                ? `${concept.label}, choose a connected note`
                : `${concept?.label ?? "Concept"}, open wiki article`
            }
            onClick={() => concept && onOpenConcept(conceptId)}
          >
            {renderFindChildren(children, `concept-link-${conceptId}`)}
            {concept && concept.noteIds.length > 1 && (
              <sup>{concept.noteIds.length}</sup>
            )}
          </button>
        );
      }
      if (href?.startsWith("orion-source://")) {
        const sourceId = href.slice("orion-source://".length);
        const source = sourceById.get(sourceId);
        const reference = citationBySourceId.get(sourceId);
        const number = reference?.number ?? children;
        if (!source || !onOpenSource) {
          return (
            <span
              className="source-citation-marker is-missing"
              title="This source is no longer available"
            >
              [{number}]
            </span>
          );
        }
        return (
          <button
            type="button"
            className="source-citation-marker"
            aria-label={`Citation ${reference?.number ?? ""}, open source ${source.title}`}
            onClick={() => onOpenSource(sourceId)}
          >
            [{number}]
          </button>
        );
      }
      return (
        <a href={safeUrl(href ?? "#")} target="_blank" rel="noreferrer">
          {renderFindChildren(children, `external-link-${href ?? "unknown"}`)}
        </a>
      );
    },
  };

  // Playback ticks must not remount the reading text: its native ranges also
  // anchor Find, selection, excerpts and narration highlighting.
  const renderedMarkdown = useMemo(() => (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkNoteTableMetadata, remarkNoteBlocks, remarkNoteMargins, remarkNoteTextAlignment]} components={markdownComponents} urlTransform={safeUrl}>
      {visibleMarkdown}
    </ReactMarkdown>
  ), [visibleMarkdown, note, notes, concepts, sources, findQuery, selectedPassageId,
    onOpenNote, onOpenConcept, onOpenSource, onUpdateNote]);

  useLayoutEffect(() => {
    const active = narrationRef.current;
    if (!narrationActive || !active || !findScopeRef.current) { clearNarrationHighlight(); return; }
    const current = buildNarrationDocument(findScopeRef.current);
    if (current.text !== active.text) { stopPlayback(); return; }
    narrationRef.current = current;
    if (followNarration) highlightNarration(current, narrationPositionRef.current.charIndex, narrationPositionRef.current.charLength);
  }, [narrationActive, renderedMarkdown, note.title, note.summary]);

  useLayoutEffect(() => {
    if (!narrationActive || !followNarration || !narrationRef.current) { clearNarrationHighlight(); return; }
    highlightNarration(narrationRef.current, narrationPositionRef.current.charIndex, narrationPositionRef.current.charLength);
  }, [narrationActive, followNarration, listenProgress?.charIndex, listenProgress?.charLength]);


  return (
    <article
      ref={findScopeRef}
      className={`note-view${editing ? " is-editing" : ""}${showOutline ? " has-outline" : ""}${findOpen ? " has-find" : ""}${showPlayhead ? " is-listening" : ""}${narrationActive ? " has-narration" : ""}`}
      onClickCapture={(event) => {
        if (!narrationActive || !narrationRef.current || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.detail === 0) return;
        const target = event.target as HTMLElement;
        if (!target.closest("[data-narration-text]") || target.closest("input,textarea,.source-citation-marker,.chat-citation")) return;
        if (window.getSelection()?.isCollapsed === false) return;
        const index = narrationCharacterAtPoint(narrationRef.current, event.clientX, event.clientY);
        if (index === null) return;
        event.preventDefault(); event.stopPropagation();
        void startNotePlayback(index);
      }}
    >
      {showOutline && (
        <NoteOutline
          headings={outlineHeadings}
          activeHeadingId={activeHeadingId}
          onSelect={selectOutlineHeading}
        />
      )}
      <div className="note-document">
        <header className="note-header">
          <div className="note-actions">
            <span
              className={savedPulse ? "save-state pulse" : "save-state"}
              role="status"
              aria-live="polite"
            >
              <Check size={12} />
              {savedPulse ? "Queued" : "Autosave"}
            </span>
            {onSpeakNote ? (
              <button
                type="button"
                className={listening ? "icon-button active" : "icon-button"}
                aria-label={
                  listening
                    ? showSlideshow
                      ? "Pause slideshow"
                      : "Pause"
                    : showSlideshow
                      ? "Play slideshow"
                      : "Play note"
                }
                aria-pressed={listening}
                title={
                  listening
                    ? showSlideshow
                      ? "Pause slideshow"
                      : "Pause"
                    : showSlideshow
                      ? "Play slideshow"
                      : "Play this note"
                }
                onClick={() => {
                  void togglePlayback();
                }}
              >
                {listening ? <Pause size={16} /> : <Play size={16} fill="currentColor" />}
              </button>
            ) : null}
            {!narrationActive && downloadControl}
            <button
              ref={findButtonRef}
              type="button"
              className={findOpen ? "icon-button active" : "icon-button"}
              aria-label="Find in note"
              aria-pressed={findOpen}
              title="Find in note (⌘F)"
              onClick={findOpen ? closeFind : openFind}
            >
              <Search size={16} />
            </button>
            <button
              ref={editButtonRef}
              type="button"
              className={
                editing ? "note-edit-toggle active" : "note-edit-toggle"
              }
              aria-pressed={editing}
              onClick={() => {
                if (editing) {
                  flushDirtyEditing();
                  setEditing(false);
                  window.requestAnimationFrame(() =>
                    editButtonRef.current?.focus(),
                  );
                } else {
                  stopPlayback();
                  dirtyEditingRef.current = false;
                  setEditing(true);
                }
              }}
            >
              {editing ? <Check size={14} /> : <Edit3 size={14} />}
              <span>{editing ? "Done" : "Edit"}</span>
            </button>
            <button
              type="button"
              className={note.pinned ? "icon-button active" : "icon-button"}
              aria-label={note.pinned ? "Unfavorite" : "Favorite"}
              onClick={() => update({ pinned: !note.pinned })}
            >
              <FavoriteMark size={17} />
            </button>
            <button
              type="button"
              className="icon-button danger"
              aria-label="Delete note"
              title="Delete note"
              onClick={() => onDeleteNote(note.id)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        <div className="note-title-line">
          {editing ? (
            <input
              className="note-title-input"
              value={note.title}
              onChange={(event) => update({ title: event.target.value })}
              aria-label="Note title"
            />
          ) : (
            <h1 data-narration-text="title">{highlightFindText(note.title, "note-title")}</h1>
          )}
        </div>
        {editing ? (
          <textarea
            className="note-summary-input"
            value={note.summary}
            onChange={(event) => update({ summary: event.target.value })}
            rows={2}
            aria-label="Note summary"
          />
        ) : (
          <p className="note-summary" data-narration-text="summary">
            {highlightFindText(note.summary, "note-summary")}
          </p>
        )}
        {listenError ? <p className="note-listen-error" role="status">{listenError}</p> : null}
        </header>

      {findOpen && (
        <div className="note-find-bar" role="search" aria-label="Find in note">
          <Search size={15} aria-hidden="true" />
          <input
            ref={findInputRef}
            value={findQuery}
            aria-label="Find text in note"
            placeholder="Find in note…"
            onChange={(event) => {
              setFindQuery(event.target.value);
              setActiveFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (findResultCount > 0) {
                setActiveFindIndex((current) =>
                  wrapMatchIndex(
                    current + (event.shiftKey ? -1 : 1),
                    findResultCount,
                  ),
                );
              }
            }}
          />
          <span className="note-find-count" role="status" aria-live="polite">
            {findQuery.trim()
              ? findResultCount > 0
                ? `${activeFindIndex + 1} of ${findResultCount}`
                : "No results"
              : "0 results"}
          </span>
          <button
            type="button"
            className="icon-button subtle"
            aria-label="Previous match"
            disabled={findResultCount === 0}
            onClick={() =>
              setActiveFindIndex((current) =>
                wrapMatchIndex(current - 1, findResultCount),
              )
            }
          >
            <ArrowUp size={15} />
          </button>
          <button
            type="button"
            className="icon-button subtle"
            aria-label="Next match"
            disabled={findResultCount === 0}
            onClick={() =>
              setActiveFindIndex((current) =>
                wrapMatchIndex(current + 1, findResultCount),
              )
            }
          >
            <ChevronDown size={15} />
          </button>
          <button
            type="button"
            className="icon-button subtle"
            aria-label="Close find"
            onClick={closeFind}
          >
            <X size={15} />
          </button>
        </div>
      )}

      <div className="note-find-scope">
        {editing ? (
          <Suspense
            fallback={
              <div className="editor-loading-surface" role="status">
                Preparing writing tools…
              </div>
            }
          >
            <RichNoteEditor
              noteTypeface={noteTypeface}
              onNoteTypefaceChange={onNoteTypefaceChange}
              key={note.id}
              noteId={note.id}
              markdown={markdown}
              notes={notes}
              concepts={concepts}
              sources={sources}
              attachedSourceIds={note.sourceIds}
              onChange={(body) => update({ body })}
              onAttachSource={(sourceId) =>
                onAttachSource?.(note.id, sourceId)
              }
              onOpenSource={onOpenSource}
              onOpenNote={onOpenNote}
              onRegisterConcept={onRegisterConcept}
              onGenerateLinkTitle={onGenerateLinkTitle}
              onGenerateAIWriting={onGenerateAIWriting}
              onGenerateAIImage={onGenerateAIImage}
              onDisableConceptAutoLink={onDisableConceptAutoLink}
              onPrepareVoiceMemoSession={onPrepareVoiceMemoSession}
              onTranscribeVoiceMemo={onTranscribeVoiceMemo}
              onFinishVoiceMemoSession={onFinishVoiceMemoSession}
              aiArticleWritingEnabled={aiArticleWritingEnabled}
              aiImageGenerationEnabled={aiImageGenerationEnabled}
              imageContextEnabled={imageContextEnabled}
              aiProviderName={aiProviderName}
              findQuery={findQuery}
              onFindDecorationsChanged={() =>
                setFindRevision((current) => current + 1)
              }
            />
          </Suspense>
        ) : showSlideshow ? (
          <SlideDeckView
            title={note.title}
            slides={deckSlides}
            index={deckIndex}
            onIndexChange={changeDeckIndex}
            playing={listening}
            onTogglePlay={onSpeakNote ? () => void togglePlayback() : undefined}
          />
        ) : (
          <div className="note-prose" data-narration-text="body">
            <div className="note-prose-content" style={noteMarginsStyle(marginDocument.margins)}>
              {renderedMarkdown}
            </div>
            {selectedPassage && <CitedPassage evidence={selectedPassage} notes={notes} sources={sources}
              panelId={passagePanelId} savedWith="note" onClose={closePassage} onOpenNote={onOpenNote} onOpenSource={onOpenSource} />}
            <SourceReferences
              references={citationDocument.references}
              onOpenSource={onOpenSource}
            />
          </div>
        )}
      </div>

        <footer className="note-footer">
          <div className="tag-row">
            {visibleNoteTags(note).map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
          <span>
            Updated{" "}
            {new Intl.DateTimeFormat(undefined, {
              month: "long",
              day: "numeric",
              year: "numeric",
            }).format(new Date(note.updatedAt))}
          </span>
        </footer>
      </div>
      {showPlayhead ? (
        <div
          className="note-listen-playhead"
          role="region"
          aria-label="Playback playhead"
          data-testid="note-listen-playhead"
        >
          <button
            type="button"
            className="icon-button"
            aria-label={listening ? "Pause" : "Play"}
            title={listening ? "Pause" : "Play"}
            onClick={() => {
              void togglePlayback();
            }}
          >
            {listening ? <Pause size={13} /> : <Play size={13} fill="currentColor" />}
          </button>
          <span className="note-listen-playhead__time">
            {formatSpeechClock(playheadProgress?.elapsedSeconds ?? 0)}
          </span>
          <div
            className="note-listen-playhead__track"
            role={narrationActive ? "slider" : "progressbar"}
            aria-label="Playback progress"
            tabIndex={narrationActive ? 0 : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((playheadProgress?.ratio ?? 0) * 100)}
            data-loading={playheadProgress?.loading ? "true" : "false"}
            data-seekable={showSlideshow || narrationActive ? "true" : "false"}
            aria-valuetext={narrationActive && narrationRef.current ? narrationRef.current.text.slice(narrationPositionRef.current.charIndex, narrationPositionRef.current.charIndex + Math.max(1, narrationPositionRef.current.charLength)) : undefined}
            onKeyDown={(event) => {
              if (!narrationActive || !narrationRef.current || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const words = narrationRef.current.words;
              const current = Math.max(0, words.findIndex((word) => word.to > narrationPositionRef.current.charIndex));
              const next = event.key === "Home" ? 0 : event.key === "End" ? words.length - 1 : current + (event.key === "ArrowRight" ? 1 : -1);
              void startNotePlayback(words[Math.max(0, Math.min(words.length - 1, next))]?.from ?? 0);
            }}
            onClick={
              showSlideshow
                ? (event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0) return;
                    seekDeckPlayback(
                      (event.clientX - rect.left) / rect.width,
                    );
                  }
                : narrationActive ? (event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  if (rect.width > 0 && narrationRef.current) void startNotePlayback(
                    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * narrationRef.current.text.length);
                } : undefined
            }
          >
            <i
              style={{
                width: `${Math.min(100, Math.max(0, (playheadProgress?.ratio ?? 0) * 100))}%`,
              }}
            />
            {showSlideshow
              ? deckCues.slice(1).map((cue) => {
                  const duration = deckPlaybackDuration(deckCues);
                  if (duration <= 0) return null;
                  return (
                    <span
                      key={cue.index}
                      className="note-listen-playhead__marker"
                      style={{
                        left: `${(cue.startSeconds / duration) * 100}%`,
                      }}
                    />
                  );
                })
              : null}
            <b
              style={{
                left: `${Math.min(100, Math.max(0, (playheadProgress?.ratio ?? 0) * 100))}%`,
              }}
            />
          </div>
          <span className="note-listen-playhead__time">
            {playheadProgress?.loading
              ? "…"
              : formatSpeechClock(playheadProgress?.durationSeconds ?? 0)}
          </span>
          {narrationActive && <>
            {downloadControl}
            <label className="note-listen-playhead__follow"><input type="checkbox" checked={followNarration} onChange={(event) => setFollowNarration(event.target.checked)} />Follow text</label>
            {listenProgress?.timingGranularity === "chunk" && <span className="note-listen-playhead__hint">Passage timing</span>}
            <button type="button" className="icon-button" aria-label="Stop narration" title="Stop narration" onClick={() => stopPlayback()}><X size={14}/></button>
          </>}
        </div>
      ) : null}
      {narrationDownload && <span className="sr-only" role="status">Preparing narration download{narrationDownload.total ? `: ${narrationDownload.completed} of ${narrationDownload.total} passages` : ""}.</span>}
    </article>
  );
}
