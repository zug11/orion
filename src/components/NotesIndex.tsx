import { ArrowUpRight, BookOpen, Grid2X2, List, Search } from "../lib/icons";
import { useMemo, useState, type CSSProperties } from "react";
import type { Note } from "../types";
import BorderGlow from "./BorderGlow";

interface NotesIndexProps {
  notes: Note[];
  onOpenNote: (noteId: string) => void;
}

export function NotesIndex({ notes, onOpenNote }: NotesIndexProps) {
  const [query, setQuery] = useState("");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return notes;
    return notes.filter((note) =>
      [note.title, note.summary, ...note.tags, ...note.aliases]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle),
    );
  }, [notes, query]);

  return (
    <div className="view index-view">
      <div className="view-title-row">
        <div>
          <span className="eyebrow neutral">Your atlas</span>
          <h1>Notes</h1>
          <p>{notes.length} living documents, linked by what they share.</p>
        </div>
        <div className="segmented-control" aria-label="Layout">
          <button
            type="button"
            className={layout === "grid" ? "active" : ""}
            onClick={() => setLayout("grid")}
            aria-label="Grid"
          >
            <Grid2X2 size={15} />
          </button>
          <button
            type="button"
            className={layout === "list" ? "active" : ""}
            onClick={() => setLayout("list")}
            aria-label="List"
          >
            <List size={15} />
          </button>
        </div>
      </div>

      <div className="index-toolbar">
        <label className="inline-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter notes…"
            aria-label="Filter notes"
          />
        </label>
        <span>{filtered.length} shown</span>
      </div>

      <div className={`notes-collection ${layout}`}>
        {filtered.map((note) => (
          <BorderGlow
            as="button"
            key={note.id}
            type="button"
            className="note-index-card"
            glowColor={note.color ?? "#a8b3ff"}
            onClick={() => onOpenNote(note.id)}
            style={
              {
                "--note-color": note.color ?? "#8798ff",
              } as CSSProperties
            }
          >
            <div className="note-card-top">
              <span>
                <BookOpen size={14} />
                {note.kind}
              </span>
              <ArrowUpRight size={15} />
            </div>
            <strong>{note.title}</strong>
            <p>{note.summary}</p>
            <div className="tag-row">
              {note.tags.slice(0, 3).map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
            <div className="note-card-bottom">
              <span>{note.conceptIds.length} concepts</span>
              <span>
                {new Intl.DateTimeFormat(undefined, {
                  month: "short",
                  day: "numeric",
                }).format(new Date(note.updatedAt))}
              </span>
            </div>
          </BorderGlow>
        ))}
        {filtered.length === 0 && (
          <div className="collection-empty">
            <BookOpen size={24} />
            <strong>{query ? "No notes match that search" : "A clear sky"}</strong>
            <span>
              {query
                ? "Try a title, alias, or tag."
                : "Create a note or import material to begin your atlas."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
