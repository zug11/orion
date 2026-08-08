import {
  ArrowUp,
  Check,
  ChevronDown,
  CircleDot,
  Edit3,
  Link2,
  Quote,
  Search,
  Star,
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
import type { RegisterWikiLinkInput } from "../lib/concepts";
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
import { canonicalizeSourceCitations } from "../lib/sourceCitations";
import { decorateAutoLinks } from "../lib/wiki";
import type { Concept, Note, Source } from "../types";
import { NoteOutline } from "./NoteOutline";
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
  onDisableConceptAutoLink: (conceptId: string) => void;
  aiArticleWritingEnabled?: boolean;
  aiProviderName?: string;
}

function safeUrl(url: string) {
  if (
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
  onDisableConceptAutoLink,
  aiArticleWritingEnabled = false,
  aiProviderName,
}: NoteViewProps) {
  const [editing, setEditing] = useState(note.title === "Untitled note");
  const [savedPulse, setSavedPulse] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findResultCount, setFindResultCount] = useState(0);
  const [activeFindIndex, setActiveFindIndex] = useState(0);
  const [findRevision, setFindRevision] = useState(0);
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
  const showOutline = !editing && outlineHeadings.length > 0;
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
    },
    [],
  );

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
      const taskChildren = task
        ? Children.map(renderedChildren, (child) =>
            isValidElement(child) && child.type === "input" ? (
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
            ) : (
              child
            ),
          )
        : renderedChildren;
      return <li className={className}>{taskChildren}</li>;
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
      className={`note-view${editing ? " is-editing" : ""}${showOutline ? " has-outline" : ""}${findOpen ? " has-find" : ""}`}
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
              <Star size={17} fill={note.pinned ? "currentColor" : "none"} />
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
              onDisableConceptAutoLink={onDisableConceptAutoLink}
              aiArticleWritingEnabled={aiArticleWritingEnabled}
              aiProviderName={aiProviderName}
              findQuery={findQuery}
              onFindDecorationsChanged={() =>
                setFindRevision((current) => current + 1)
              }
            />
          </Suspense>
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
    </article>
  );
}
