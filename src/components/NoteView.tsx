import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleDot,
  Edit3,
  Link2,
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
import remarkGfm from "remark-gfm";
import { isSafeNoteImageUrl } from "../lib/noteImages";
import type { RegisterWikiLinkInput } from "../lib/concepts";
import type { AIWritingRequestInput } from "../lib/aiWriting";
import type { AIImageProposal, AIImageRequestInput } from "../lib/aiImages";
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
  speakableNoteText,
  type SpeechPlaybackProgress,
} from "../lib/speech";
import { canonicalizeSourceCitations } from "../lib/sourceCitations";
import { decorateAutoLinks } from "../lib/wiki";
import type { Concept, Note, Source } from "../types";
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

interface NoteViewProps {
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
  onGenerateLinkTitle?: (selectedContext: string) => Promise<string>;
  onGenerateAIWriting?: (
    input: Omit<AIWritingRequestInput, "originNoteId">,
  ) => Promise<string>;
  onGenerateAIImage?: (
    input: Omit<AIImageRequestInput, "originNoteId">,
    signal: AbortSignal,
  ) => Promise<AIImageProposal>;
  onSpeakNote?: (
    text: string,
    signal?: AbortSignal,
    onProgress?: (progress: SpeechPlaybackProgress) => void,
  ) => Promise<void>;
  onPrepareSpeech?: (text: string, signal?: AbortSignal) => Promise<void>;
  onDisableConceptAutoLink: (conceptId: string) => void;
  aiArticleWritingEnabled?: boolean;
  aiImageGenerationEnabled?: boolean;
  aiProviderName?: string;
}

function safeUrl(url: string) {
  if (
    isSafeNoteImageUrl(url) ||
    url.startsWith("orion-note://") ||
    url.startsWith("orion-concept://") ||
    url.startsWith("orion-source://") ||
    /^https?:\/\//i.test(url) ||
    /^mailto:/i.test(url)
  ) {
    return url;
  }
  return "#";
}

export function NoteView({
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
  onDisableConceptAutoLink,
  aiArticleWritingEnabled = false,
  aiImageGenerationEnabled = false,
  aiProviderName,
}: NoteViewProps) {
  const [editing, setEditing] = useState(note.title === "Untitled note");
  const [savedPulse, setSavedPulse] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResultCount, setFindResultCount] = useState(0);
  const [activeFindIndex, setActiveFindIndex] = useState(0);
  const [findRevision, setFindRevision] = useState(0);
  const [listening, setListening] = useState(false);
  const [listenError, setListenError] = useState<string | null>(null);
  const [listenProgress, setListenProgress] =
    useState<SpeechPlaybackProgress | null>(null);
  const [deckIndex, setDeckIndex] = useState(0);
  const listenAbortRef = useRef<AbortController | null>(null);
  const playGenerationRef = useRef(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findScopeRef = useRef<HTMLElement>(null);
  const dirtyEditingRef = useRef(false);
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
  const visibleMarkdown = citationDocument.body;
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
  const showPlayhead = listening || (showSlideshow && Boolean(onSpeakNote));
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
  const playheadProgress = listening ? listenProgress : idleDeckProgress;
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
  const noteConcepts = concepts.filter((concept) =>
    note.conceptIds.includes(concept.id),
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
    setEditing(note.title === "Untitled note");
    setFindOpen(false);
    setFindQuery("");
    setFindResultCount(0);
    setActiveFindIndex(0);
    setActiveHeadingId(null);
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
      globalThis.speechSynthesis?.cancel();
    },
    [],
  );

  useEffect(() => {
    playGenerationRef.current += 1;
    listenAbortRef.current?.abort();
    listenAbortRef.current = null;
    globalThis.speechSynthesis?.cancel();
    setListening(false);
    setListenProgress(null);
    setListenError(null);
    setDeckIndex(0);
  }, [note.id]);

  function stopPlayback(options?: { keepProgress?: boolean }) {
    playGenerationRef.current += 1;
    listenAbortRef.current?.abort();
    listenAbortRef.current = null;
    globalThis.speechSynthesis?.cancel();
    setListening(false);
    if (!options?.keepProgress) {
      setListenProgress(null);
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
      stopPlayback({ keepProgress: showSlideshow });
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
    const spoken = speakableNoteText(note);
    if (!spoken) {
      setListenError("This note has nothing to play.");
      return;
    }
    stopPlayback();
    const generation = playGenerationRef.current;
    const controller = new AbortController();
    listenAbortRef.current = controller;
    setListenError(null);
    setListening(true);
    setListenProgress({
      elapsedSeconds: 0,
      durationSeconds: 0,
      ratio: 0,
      loading: true,
    });
    try {
      await onSpeakNote(spoken, controller.signal, setListenProgress);
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
      }
    }
  }

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

  const markdownComponents = {
    p: ({ children }: { children?: ReactNode }) => (
      <p>{renderLinkedChildren(children)}</p>
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
      const taskBody = Children.toArray(renderedChildren).filter(
        (child) => !(isValidElement(child) && child.type === "input"),
      );
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
    h1: ({ children }: { children?: ReactNode }) => (
      <h1>{renderLinkedChildren(children)}</h1>
    ),
    h2: ({
      children,
      node,
    }: {
      children?: ReactNode;
      node?: { position?: { start?: { line?: number } } };
    }) => (
      <h2 id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>
        {renderLinkedChildren(children)}
      </h2>
    ),
    h3: ({
      children,
      node,
    }: {
      children?: ReactNode;
      node?: { position?: { start?: { line?: number } } };
    }) => (
      <h3 id={headingIdByLine.get(node?.position?.start?.line ?? -1)}>
        {renderLinkedChildren(children)}
      </h3>
    ),
    blockquote: ({ children }: { children?: ReactNode }) => (
      <blockquote>
        <Quote size={16} />
        {renderLinkedChildren(children)}
      </blockquote>
    ),
    a: ({ href, children }: { href?: string; children?: ReactNode }) => {
      if (href?.startsWith("orion-note://")) {
        const noteId = href.slice("orion-note://".length);
        return (
          <button
            type="button"
            className="wiki-link explicit"
            onClick={() => onOpenNote(noteId)}
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

  return (
    <article
      ref={findScopeRef}
      className={`note-view${editing ? " is-editing" : ""}${showOutline ? " has-outline" : ""}${findOpen ? " has-find" : ""}${showPlayhead ? " is-listening" : ""}`}
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
        <div className="note-title-line">
          {editing ? (
            <input
              className="note-title-input"
              value={note.title}
              onChange={(event) => update({ title: event.target.value })}
              aria-label="Note title"
            />
          ) : (
            <h1>{highlightFindText(note.title, "note-title")}</h1>
          )}
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
          <p className="note-summary">
            {highlightFindText(note.summary, "note-summary")}
          </p>
        )}
        <div className="note-header-meta-row">
          <div className="note-meta">
            <span>
              <CircleDot size={12} />
              {noteConcepts.length} concepts
            </span>
            <span>
              <Link2 size={12} />
              {note.sourceIds.length} sources
            </span>
            {listenError ? (
              <span role="status">{listenError}</span>
            ) : null}
          </div>
        </div>
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
              onRegisterConcept={onRegisterConcept}
              onGenerateLinkTitle={onGenerateLinkTitle}
              onGenerateAIWriting={onGenerateAIWriting}
              onGenerateAIImage={onGenerateAIImage}
              onDisableConceptAutoLink={onDisableConceptAutoLink}
              aiArticleWritingEnabled={aiArticleWritingEnabled}
              aiImageGenerationEnabled={aiImageGenerationEnabled}
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
          <div className="note-prose">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={markdownComponents}
              urlTransform={safeUrl}
            >
              {visibleMarkdown}
            </ReactMarkdown>
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
          role="status"
          aria-live="polite"
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
            role="progressbar"
            aria-label="Playback progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((playheadProgress?.ratio ?? 0) * 100)}
            data-loading={playheadProgress?.loading ? "true" : "false"}
            data-seekable={showSlideshow ? "true" : "false"}
            onClick={
              showSlideshow
                ? (event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    if (rect.width <= 0) return;
                    seekDeckPlayback(
                      (event.clientX - rect.left) / rect.width,
                    );
                  }
                : undefined
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
        </div>
      ) : null}
    </article>
  );
}
