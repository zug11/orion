import type { NoteOutlineHeading } from "../lib/noteOutline";

interface NoteOutlineProps {
  headings: readonly NoteOutlineHeading[];
  activeHeadingId: string | null;
  onSelect: (headingId: string) => void;
}

export function NoteOutline({
  headings,
  activeHeadingId,
  onSelect,
}: NoteOutlineProps) {
  if (headings.length === 0) return null;

  return (
    <aside className="note-outline" aria-label="On this page">
      <div className="note-outline__heading">
        <span>Contents</span>
        <i aria-hidden="true" />
      </div>
      <nav className="note-outline__list" aria-label="Note outline">
        {headings.map((heading) => {
          const active = heading.id === activeHeadingId;
          return (
            <button
              type="button"
              key={heading.id}
              className={active ? "is-active" : undefined}
              aria-current={active ? "location" : undefined}
              data-level={heading.level}
              onClick={() => onSelect(heading.id)}
            >
              {heading.text}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
