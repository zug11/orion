import {
  Check,
  CircleDot,
  Edit3,
  Link2,
  Quote,
  Star,
  Trash2,
} from "../lib/icons";
import {
  Children,
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useEffect,
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
import { decorateAutoLinks } from "../lib/wiki";
import type { Concept, Note } from "../types";

const RichNoteEditor = lazy(() =>
  import("./RichNoteEditor").then((module) => ({
    default: module.RichNoteEditor,
  })),
);

interface NoteViewProps {
  note: Note;
  notes: Note[];
  concepts: Concept[];
  onOpenNote: (noteId: string) => void;
  onOpenConcept: (conceptId: string) => void;
  onUpdateNote: (note: Note) => void;
  onDeleteNote: (noteId: string) => void;
  onFinishEditing?: (noteId: string) => void;
  onRegisterConcept: (input: RegisterWikiLinkInput) => string;
  onDisableConceptAutoLink: (conceptId: string) => void;
  aiArticleDraftingEnabled?: boolean;
  aiProviderName?: string;
}

function headingAnchor(children: ReactNode): string {
  const text = Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }
      if (isValidElement(child)) {
        return headingAnchor(
          (child as ReactElement<{ children?: ReactNode }>).props.children,
        ).replace(/^heading-/, "");
      }
      return "";
    })
    .join(" ");
  const slug = text
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `heading-${slug || "section"}`;
}

function safeUrl(url: string) {
  if (
    url.startsWith("orion-note://") ||
    url.startsWith("orion-concept://") ||
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
  onOpenNote,
  onOpenConcept,
  onUpdateNote,
  onDeleteNote,
  onFinishEditing,
  onRegisterConcept,
  onDisableConceptAutoLink,
  aiArticleDraftingEnabled = false,
  aiProviderName,
}: NoteViewProps) {
  const [editing, setEditing] = useState(note.title === "Untitled note");
  const [savedPulse, setSavedPulse] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
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
  const visibleMarkdown = useMemo(
    () => splitMarkdownFrontmatter(markdown).content,
    [markdown],
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

  useEffect(() => {
    setEditing(note.title === "Untitled note");
  }, [note.id]);

  useEffect(
    () => () => {
      if (savedPulseTimerRef.current !== null) {
        window.clearTimeout(savedPulseTimerRef.current);
      }
    },
    [],
  );

  function update(patch: Partial<Note>) {
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

  function renderLinkedChildren(children: ReactNode): ReactNode {
    return Children.map(children, (child) => {
      if (typeof child === "string") {
        return decorateAutoLinks(
          child,
          linkableConcepts,
        ).map((segment, index) => {
          if (segment.type === "text") {
            return segment.text;
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
              {segment.text}
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
          return child;
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
    h2: ({ children }: { children?: ReactNode }) => (
      <h2 id={headingAnchor(children)}>{renderLinkedChildren(children)}</h2>
    ),
    h3: ({ children }: { children?: ReactNode }) => (
      <h3 id={headingAnchor(children)}>{renderLinkedChildren(children)}</h3>
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
            {children}
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
            {children}
            {concept && concept.noteIds.length > 1 && (
              <sup>{concept.noteIds.length}</sup>
            )}
          </button>
        );
      }
      return (
        <a href={safeUrl(href ?? "#")} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };

  return (
    <article className={editing ? "note-view is-editing" : "note-view"}>
      <header className="note-header">
        <div className="note-kicker">
          <span
            className="note-color"
            style={{ background: note.color ?? "#8798ff" }}
          />
          <span>{note.kind === "wiki" ? "Wiki article" : note.kind}</span>
          <i />
          <span>{note.status === "draft" ? "Review draft" : "Knowledge note"}</span>
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
            <h1>{note.title}</h1>
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
              ref={editButtonRef}
              type="button"
              className={
                editing ? "note-edit-toggle active" : "note-edit-toggle"
              }
              aria-pressed={editing}
              onClick={() => {
                if (editing) {
                  setEditing(false);
                  onFinishEditing?.(note.id);
                  window.requestAnimationFrame(() =>
                    editButtonRef.current?.focus(),
                  );
                } else {
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
          <p className="note-summary">{note.summary}</p>
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
            onChange={(body) => update({ body })}
            onRegisterConcept={onRegisterConcept}
            onDisableConceptAutoLink={onDisableConceptAutoLink}
            aiArticleDraftingEnabled={aiArticleDraftingEnabled}
            aiProviderName={aiProviderName}
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
        </div>
      )}

      <footer className="note-footer">
        <div className="tag-row">
          {note.tags.map((tag) => (
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

    </article>
  );
}
