import {
  ArrowUpRight,
  FileText,
  Link2,
  ListTree,
  Network,
  PanelRightClose,
  Quote,
} from "lucide-react";
import { markdownToPlainText } from "../lib/wiki";
import type { AppSnapshot, Note } from "../types";

interface ContextPanelProps {
  note: Note | null;
  snapshot: AppSnapshot;
  onOpenNote: (noteId: string) => void;
  onClose: () => void;
}

function plainBody(body: string) {
  return markdownToPlainText(body);
}

function headingAnchor(heading: string) {
  const slug = heading
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `heading-${slug || "section"}`;
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

export function ContextPanel({
  note,
  snapshot,
  onOpenNote,
  onClose,
}: ContextPanelProps) {
  if (!note) {
    return (
      <aside className="context-panel context-empty">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close context"
        >
          <PanelRightClose size={16} />
        </button>
        <Network size={28} />
        <strong>Context follows your reading</strong>
        <p>Open a note to see its outline, sources, and incoming references.</p>
      </aside>
    );
  }

  const headings = note.body
    .split("\n")
    .filter((line) => /^#{2,3}\s/.test(line))
    .map((line) => line.replace(/^#{2,3}\s+/, ""));
  const concepts = snapshot.concepts.filter((concept) =>
    note.conceptIds.includes(concept.id),
  );
  const terms = [note.title, ...note.aliases, ...concepts.map((item) => item.label)];
  const backlinks = snapshot.notes
    .filter(
      (candidate) =>
        candidate.id !== note.id &&
        terms.some((term) =>
          candidate.body.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
        ),
    )
    .slice(0, 4);
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
    .slice(0, 4);

  return (
    <aside className="context-panel">
      <header className="context-header">
        <span>Context</span>
        <button
          type="button"
          className="icon-button subtle"
          onClick={onClose}
          aria-label="Close context"
        >
          <PanelRightClose size={16} />
        </button>
      </header>

      {headings.length > 0 && (
        <section className="context-section">
          <h3>
            <ListTree size={14} />
            On this page
          </h3>
          <div className="outline-list">
            {headings.map((heading, index) => (
              <button
                type="button"
                key={`${heading}-${index}`}
                onClick={() =>
                  document
                    .getElementById(headingAnchor(heading))
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
              >
                <i />
                {heading}
              </button>
            ))}
          </div>
        </section>
      )}

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
              <span key={source.id}>
                <FileText size={12} />
                {source.title}
              </span>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}
