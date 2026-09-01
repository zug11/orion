import {
  ArrowUpRight,
  FileText,
  Link2,
  Network,
  PanelRightClose,
  Quote,
} from "../lib/icons";
import { markdownToPlainText } from "../lib/wiki";
import type { AppSnapshot, Note, Relationship } from "../types";
import { useEffect, useRef } from "react";

interface ContextPanelProps {
  note: Note | null;
  snapshot: AppSnapshot;
  onOpenNote: (noteId: string) => void;
  onOpenSource: (sourceId: string) => void;
  onClose: () => void;
}

function plainBody(body: string) {
  return markdownToPlainText(body);
}

function excerptAround(body: string, term: string) {
  const plain = plainBody(body);
  const index = plain.toLocaleLowerCase().indexOf(term.toLocaleLowerCase());
  if (index < 0) return plain.slice(0, 140);
  const start = Math.max(0, index - 48);
  const end = Math.min(plain.length, index + term.length + 88);
  return `${start > 0 ? "…" : ""}${plain.slice(start, end)}${
    end < plain.length ? "…" : ""
  }`;
}

function argumentConnectionText(relationship: Relationship, noteId: string): string | undefined {
  const outward = relationship.fromNoteId === noteId;
  let label: string;
  switch (relationship.kind) {
    case "supports": label = outward ? "This note supports it" : "Supports this note"; break;
    case "qualifies": label = outward ? "This note qualifies it" : "Qualifies this note"; break;
    case "conflicts": label = "Conflicts with this note"; break;
    default: return undefined;
  }
  return `${label}${relationship.context?.trim() ? ` — ${relationship.context.trim()}` : ""}`;
}

export function ContextPanel({
  note,
  snapshot,
  onOpenNote,
  onOpenSource,
  onClose,
}: ContextPanelProps) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused?.isConnected) {
        previouslyFocused.focus();
      } else {
        document
          .querySelector<HTMLElement>("[data-right-panel-toggle]")
          ?.focus();
      }
    };
  }, []);

  if (!note) {
    return (
      <aside
        id="note-details-panel"
        ref={panelRef}
        className="context-panel context-empty"
        role="region"
        aria-label="Note connections and sources"
        tabIndex={-1}
      >
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close connections and sources"
        >
          <PanelRightClose size={16} />
        </button>
        <Network size={28} />
        <strong>Details follow your reading</strong>
        <p>Open a note to see its sources and connections.</p>
      </aside>
    );
  }

  const concepts = snapshot.concepts.filter((concept) =>
    note.conceptIds.includes(concept.id),
  );
  const terms = [note.title, ...note.aliases, ...concepts.flatMap((item) => [item.label, ...item.aliases])];
  const argumentConnections = new Map<string, Set<string>>();
  for (const relationship of snapshot.relationships) {
    const otherId = relationship.fromNoteId === note.id ? relationship.toNoteId
      : relationship.toNoteId === note.id ? relationship.fromNoteId : undefined;
    if (!otherId) continue;
    const text = argumentConnectionText(relationship, note.id);
    if (!text) continue;
    const descriptions = argumentConnections.get(otherId) ?? new Set<string>();
    descriptions.add(text);
    argumentConnections.set(otherId, descriptions);
  }
  const backlinks = snapshot.notes
    .filter(
      (candidate) =>
        candidate.id !== note.id &&
        terms.some((term) =>
          candidate.body.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
        ),
    )
    .slice(0, 12);
  const sources = snapshot.sources.filter((source) =>
    note.sourceIds.includes(source.id),
  );
  const relatedIds = snapshot.relationships
    .filter(
      (relationship) =>
        relationship.fromNoteId === note.id ||
        relationship.toNoteId === note.id,
    )
    .map((relationship) =>
      relationship.fromNoteId === note.id
        ? relationship.toNoteId
        : relationship.fromNoteId,
    );
  const related = snapshot.notes
    .filter((candidate) => relatedIds.includes(candidate.id))
    .filter((candidate) => !backlinks.some((backlink) => backlink.id === candidate.id))
    .slice(0, 12);

  return (
    <aside
      id="note-details-panel"
      ref={panelRef}
      className="context-panel"
      role="region"
      aria-label={`Connections and sources for ${note.title}`}
      tabIndex={-1}
    >
      <header className="context-header">
        <span>Connections</span>
        <button
          type="button"
          className="icon-button subtle"
          onClick={onClose}
          aria-label="Close connections and sources"
        >
          <PanelRightClose size={16} />
        </button>
      </header>

      <section className="context-section">
        <h3>
          <Link2 size={14} />
          Referenced by
          <span>{backlinks.length}</span>
        </h3>
        <div className="backlink-list">
          {backlinks.length ? (
            backlinks.map((backlink) => {
              const term =
                terms.find((candidate) =>
                  backlink.body
                    .toLocaleLowerCase()
                    .includes(candidate.toLocaleLowerCase()),
                ) ?? note.title;
              return (
                <button
                  type="button"
                  key={backlink.id}
                  onClick={() => onOpenNote(backlink.id)}
                >
                  <span>
                    <strong>{backlink.title}</strong>
                    <ArrowUpRight size={12} />
                  </span>
                  <small>
                    <Quote size={10} />
                    {excerptAround(backlink.body, term)}
                  </small>
                  {[...(argumentConnections.get(backlink.id) ?? [])].map((connection) => (
                    <small className="context-argument-reason" key={connection}>{connection}</small>
                  ))}
                </button>
              );
            })
          ) : (
            <p className="context-placeholder">
              No other note points here yet.
            </p>
          )}
        </div>
      </section>

      {related.length > 0 && (
        <section className="context-section">
          <h3>
            <Network size={14} />
            Nearby
          </h3>
          <div className="nearby-list">
            {related.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => onOpenNote(item.id)}
              >
                <i style={{ background: item.color ?? "#8798ff" }} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.summary}</small>
                  {[...(argumentConnections.get(item.id) ?? [])].map((connection) => (
                    <small className="context-argument-reason" key={connection}>{connection}</small>
                  ))}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {sources.length > 0 && (
        <section className="context-section">
          <h3>
            <FileText size={14} />
            Sources
          </h3>
          <div className="source-chip-list">
            {sources.map((source) => (
              <button
                type="button"
                key={source.id}
                onClick={() => onOpenSource(source.id)}
              >
                <FileText size={12} />
                {source.title}
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
