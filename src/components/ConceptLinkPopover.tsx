import { Check, Link2, Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { isLinkablePhrase } from "../lib/concepts";
import type { Note } from "../types";

interface ConceptLinkPopoverProps {
  initialPhrase: string;
  initialDestinationIds: readonly string[];
  currentNoteId: string;
  notes: readonly Note[];
  onCancel: () => void;
  onSubmit: (phrase: string, destinationIds: string[]) => void;
}

export function ConceptLinkPopover({
  initialPhrase,
  initialDestinationIds,
  currentNoteId,
  notes,
  onCancel,
  onSubmit,
}: ConceptLinkPopoverProps) {
  const phraseId = useId();
  const phraseInputRef = useRef<HTMLInputElement>(null);
  const [phrase, setPhrase] = useState(initialPhrase);
  const [query, setQuery] = useState("");
  const [destinationIds, setDestinationIds] = useState(
    () => new Set(initialDestinationIds),
  );
  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...notes]
      .sort((left, right) => {
        if (left.id === currentNoteId) return -1;
        if (right.id === currentNoteId) return 1;
        return left.title.localeCompare(right.title);
      })
      .filter((note) =>
        needle
          ? `${note.title} ${note.summary}`
              .toLocaleLowerCase()
              .includes(needle)
          : true,
      )
      .slice(0, 7);
  }, [currentNoteId, notes, query]);

  useEffect(() => {
    phraseInputRef.current?.focus();
    if (initialPhrase) {
      phraseInputRef.current?.select();
    }
  }, [initialPhrase]);

  function toggleDestination(noteId: string) {
    setDestinationIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedPhrase = phrase.trim().replace(/\s+/g, " ");
    if (!isLinkablePhrase(normalizedPhrase)) {
      return;
    }
    onSubmit(normalizedPhrase, [...destinationIds]);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  return (
    <form
      className="concept-link-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${phraseId}-title`}
      onSubmit={submit}
      onKeyDown={handleKeyDown}
    >
      <div className="concept-link-popover__head">
        <span className="concept-link-popover__icon">
          <Link2 size={15} />
        </span>
        <span>
          <strong id={`${phraseId}-title`}>Teach Orion a link</strong>
          <small>
            This phrase will open its named article everywhere it appears.
          </small>
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close link composer"
        >
          <X size={14} />
        </button>
      </div>

      <label className="concept-link-field" htmlFor={phraseId}>
        <span>Link phrase</span>
        <input
          ref={phraseInputRef}
          id={phraseId}
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          placeholder="Type the words to recognize…"
          autoComplete="off"
        />
        {phrase.trim() && !isLinkablePhrase(phrase) && (
          <small className="concept-link-field__hint">
            Use at least three characters, or a two-letter uppercase acronym.
          </small>
        )}
      </label>

      <div className="concept-link-destinations">
        <div className="concept-link-destinations__label">
          <span>
            {destinationIds.size === 0 ? "Default destination" : "Legacy branch"}
          </span>
          <em>
            {destinationIds.size === 0
              ? "Create or reuse wiki article"
              : `${destinationIds.size} ${
                  destinationIds.size === 1
                    ? "destination"
                    : "destinations"
                }`}
          </em>
        </div>
        {notes.length > 1 && (
          <label className="concept-link-search">
            <Search size={13} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find a note…"
              aria-label="Find a destination note"
            />
          </label>
        )}
        <div className="concept-link-note-list">
          {visibleNotes.map((note) => {
            const selected = destinationIds.has(note.id);
            return (
              <button
                type="button"
                key={note.id}
                className={selected ? "selected" : ""}
                onClick={() => toggleDestination(note.id)}
                aria-pressed={selected}
              >
                <i style={{ background: note.color ?? "#8798ff" }} />
                <span>
                  <strong>
                    {note.id === currentNoteId ? "This note" : note.title}
                  </strong>
                  <small>
                    {note.id === currentNoteId ? note.title : note.summary}
                  </small>
                </span>
                <b aria-hidden="true">
                  {selected && <Check size={12} />}
                </b>
              </button>
            );
          })}
        </div>
      </div>

      <div className="concept-link-popover__actions">
        <button type="button" className="button compact" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="button primary compact"
          disabled={!isLinkablePhrase(phrase)}
        >
          {destinationIds.size === 0
            ? "Create article link"
            : "Create branched link"}
        </button>
      </div>
    </form>
  );
}
