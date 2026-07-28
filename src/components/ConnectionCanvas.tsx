import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import {
  ArrowRight,
  CornerUpLeft,
  Link2,
  Sparkles,
  X,
} from "lucide-react";
import clsx from "clsx";
import type {
  Concept,
  ConceptReference,
  EntityId,
  Note,
} from "../types";

export interface ConnectionCanvasProps {
  concept: Concept;
  notes: Note[];
  references?: ConceptReference[];
  originNote?: Note | null;
  selectedNoteId?: EntityId | null;
  onSelectNote: (noteId: EntityId) => void;
  onClose: () => void;
  className?: string;
}

interface RankedTarget {
  note: Note;
  excerpt: string;
  matchedText: string;
  score: number;
  referenceCount: number;
  canonical: boolean;
  exactTitle: boolean;
  aliasMatch: boolean;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function highlightExcerpt(
  excerpt: string,
  matchedText: string,
): { before: string; match: string; after: string } | null {
  const needle = matchedText.trim();
  if (!needle) return null;

  const index = excerpt.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return null;

  return {
    before: excerpt.slice(0, index),
    match: excerpt.slice(index, index + needle.length),
    after: excerpt.slice(index + needle.length),
  };
}

function Excerpt({
  excerpt,
  matchedText,
}: {
  excerpt: string;
  matchedText: string;
}) {
  const highlighted = highlightExcerpt(excerpt, matchedText);
  if (!highlighted) return <>{excerpt}</>;

  return (
    <>
      {highlighted.before}
      <mark>{highlighted.match}</mark>
      {highlighted.after}
    </>
  );
}

export function ConnectionCanvas({
  concept,
  notes,
  references = [],
  originNote = null,
  selectedNoteId = null,
  onSelectNote,
  onClose,
  className,
}: ConnectionCanvasProps) {
  const headingId = `connections-${useId().replace(/:/g, "")}`;
  const destinationsId = `${headingId}-destinations`;
  const canvasRef = useRef<HTMLElement>(null);

  const rankedTargets = useMemo<RankedTarget[]>(() => {
    const noteById = new Map(notes.map((note) => [note.id, note]));
    const referencesByNote = new Map<EntityId, ConceptReference[]>();

    references.forEach((reference) => {
      const existing = referencesByNote.get(reference.noteId) ?? [];
      existing.push(reference);
      referencesByNote.set(reference.noteId, existing);
    });

    const candidateIds = new Set<EntityId>(concept.noteIds);
    references.forEach((reference) => {
      if (reference.isTarget) candidateIds.add(reference.noteId);
    });
    notes.forEach((note) => {
      if (note.conceptIds.includes(concept.id)) candidateIds.add(note.id);
    });

    const conceptLabel = normalize(concept.label);

    return [...candidateIds]
      .filter((noteId) => noteId !== originNote?.id)
      .map((noteId): RankedTarget | null => {
        const note = noteById.get(noteId);
        if (!note) return null;

        const noteReferences = referencesByNote.get(noteId) ?? [];
        const bestReference =
          noteReferences.find(
            (reference) =>
              reference.excerpt.trim() && reference.matchedText.trim(),
          ) ??
          noteReferences.find((reference) => reference.excerpt.trim()) ??
          null;
        const exactTitle = normalize(note.title) === conceptLabel;
        const aliasMatch = note.aliases.some(
          (alias) => normalize(alias) === conceptLabel,
        );
        const canonical = concept.canonicalNoteId === note.id;
        const score =
          (canonical ? 100 : 0) +
          (exactTitle ? 52 : 0) +
          (aliasMatch ? 28 : 0) +
          (note.pinned ? 12 : 0) +
          (note.status === "ready" ? 4 : 0) +
          Math.min(noteReferences.length * 6, 24);

        return {
          note,
          excerpt:
            bestReference?.excerpt.trim() ||
            note.summary.trim() ||
            "Open this note to explore the connection.",
          matchedText: bestReference?.matchedText.trim() || concept.label,
          score,
          referenceCount: noteReferences.length,
          canonical,
          exactTitle,
          aliasMatch,
        };
      })
      .filter((target): target is RankedTarget => target !== null)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.note.updatedAt.localeCompare(left.note.updatedAt) ||
          left.note.title.localeCompare(right.note.title),
      );
  }, [concept, notes, originNote?.id, references]);

  const originReference = useMemo(
    () =>
      references.find(
        (reference) =>
          reference.noteId === originNote?.id && reference.excerpt.trim(),
      ) ?? null,
    [originNote?.id, references],
  );

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    canvasRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
        return;
      }
      document
        .querySelector<HTMLElement>(
          "[data-right-panel-toggle], .search-trigger",
        )
        ?.focus();
    };
  }, []);

  return (
    <aside
      ref={canvasRef}
      className={clsx("connections-canvas", className)}
      role="region"
      aria-labelledby={headingId}
      tabIndex={-1}
    >
      <header className="connections-canvas__header">
        <div className="connections-canvas__identity">
          <span
            className="connections-canvas__concept-mark"
            style={{ "--connection-accent": concept.color } as CSSProperties}
            aria-hidden="true"
          >
            <Sparkles size={15} strokeWidth={1.8} />
          </span>
          <div>
            <span className="connections-canvas__eyebrow">Connected by</span>
            <h2 className="connections-canvas__title" id={headingId}>
              {concept.label}
            </h2>
          </div>
        </div>
        <button
          className="connections-canvas__close"
          type="button"
          aria-label={`Close connections for ${concept.label}`}
          onClick={onClose}
        >
          <X aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
      </header>

      {concept.description && (
        <p className="connections-canvas__description">
          {concept.description}
        </p>
      )}

      {originNote && (
        <section className="connections-canvas__origin">
          <span className="connections-canvas__section-label">Your trail</span>
          <button type="button" onClick={() => onSelectNote(originNote.id)}>
            <span className="connections-canvas__origin-icon" aria-hidden="true">
              <CornerUpLeft size={14} strokeWidth={1.8} />
            </span>
            <span>
              <small>From</small>
              <strong>{originNote.title}</strong>
              <em>
                {originReference?.excerpt.trim() ||
                  originNote.summary ||
                  "Return to the note where this connection began."}
              </em>
            </span>
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </section>
      )}

      <div className="connections-canvas__meta">
        <span>
          {rankedTargets.length}{" "}
          {rankedTargets.length === 1 ? "connected note" : "connected notes"}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {references.length}{" "}
          {references.length === 1 ? "reference" : "references"}
        </span>
      </div>

      {rankedTargets.length > 0 ? (
        <section
          className="connections-canvas__destinations"
          aria-labelledby={destinationsId}
        >
          <h3 id={destinationsId}>Choose where to go</h3>
          <div className="connections-canvas__targets">
            {rankedTargets.map((target, index) => {
              const selected = target.note.id === selectedNoteId;
              return (
                <button
                  className={clsx(
                    "connections-canvas__target",
                    selected && "connections-canvas__target--selected",
                  )}
                  type="button"
                  key={target.note.id}
                  aria-label={`Open ${target.note.title}`}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => onSelectNote(target.note.id)}
                >
                  <span className="connections-canvas__target-rank">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="connections-canvas__target-copy">
                    <span className="connections-canvas__target-heading">
                      <span className="connections-canvas__target-title">
                        {target.note.title}
                      </span>
                      <span className="connections-canvas__badges">
                        {selected && (
                          <span className="connections-canvas__badge active">
                            Reading
                          </span>
                        )}
                        {!selected && target.canonical && (
                          <span className="connections-canvas__badge">
                            Canonical
                          </span>
                        )}
                        {!selected &&
                          !target.canonical &&
                          target.exactTitle && (
                            <span className="connections-canvas__badge">
                              Exact title
                            </span>
                          )}
                        {!selected &&
                          !target.canonical &&
                          !target.exactTitle &&
                          target.aliasMatch && (
                            <span className="connections-canvas__badge">
                              Alias
                            </span>
                          )}
                      </span>
                    </span>
                    {target.note.summary && (
                      <span className="connections-canvas__target-summary">
                        {target.note.summary}
                      </span>
                    )}
                    <span className="connections-canvas__target-excerpt">
                      <span aria-hidden="true">“</span>
                      <Excerpt
                        excerpt={target.excerpt}
                        matchedText={target.matchedText}
                      />
                      <span aria-hidden="true">”</span>
                    </span>
                    <span className="connections-canvas__target-footer">
                      <span>{target.note.kind}</span>
                      {target.referenceCount > 0 && (
                        <span>
                          {target.referenceCount}{" "}
                          {target.referenceCount === 1 ? "match" : "matches"}
                        </span>
                      )}
                      {target.note.tags.slice(0, 2).map((tag) => (
                        <span className="connections-canvas__tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </span>
                  </span>
                  <ArrowRight
                    className="connections-canvas__target-arrow"
                    aria-hidden="true"
                    size={16}
                    strokeWidth={1.7}
                  />
                </button>
              );
            })}
          </div>
        </section>
      ) : (
        <div className="connections-canvas__empty">
          <Link2 size={19} aria-hidden="true" />
          <strong>No other note is connected yet</strong>
          <span>
            Keep the link in place. Orion will surface a destination when one
            appears.
          </span>
        </div>
      )}

      <footer className="connections-canvas__footer">
        <Link2 size={13} aria-hidden="true" />
        <span>
          The source stays here while the note view moves through each
          connection.
        </span>
      </footer>
    </aside>
  );
}
