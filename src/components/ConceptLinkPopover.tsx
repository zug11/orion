import { Check, FileText, Link2, PenLine, Search, X } from "../lib/icons";
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
  aiArticleDraftingEnabled?: boolean;
  aiProviderName?: string;
  onCancel: () => void;
  onSubmit: (
    phrase: string,
    destinationIds: string[],
    options: {
      articleMode: "ai" | "blank";
      articleInstructions?: string;
    },
  ) => void;
}

export function ConceptLinkPopover({
  initialPhrase,
  initialDestinationIds,
  currentNoteId,
  notes,
  aiArticleDraftingEnabled = false,
  aiProviderName = "AI provider",
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
  const [articleMode, setArticleMode] = useState<"ai" | "blank">(
    aiArticleDraftingEnabled ? "ai" : "blank",
  );
  const [articleInstructions, setArticleInstructions] = useState("");
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
    onSubmit(normalizedPhrase, [...destinationIds], {
      articleMode: destinationIds.size > 0 ? "blank" : articleMode,
      ...(articleMode === "ai" && articleInstructions.trim()
        ? { articleInstructions: articleInstructions.trim() }
        : {}),
    });
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
            Create its named page, then Orion will recognize this phrase
            everywhere it appears.
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

      {destinationIds.size === 0 && (
        <div className="concept-link-page-choice">
          <div className="concept-link-destinations__label">
            <span>New page</span>
            <em>Choose how it starts</em>
          </div>
          <div
            className="concept-link-mode-options"
            role="radiogroup"
            aria-label="New page type"
          >
            <button
              type="button"
              className={articleMode === "ai" ? "selected" : ""}
              role="radio"
              aria-checked={articleMode === "ai"}
              disabled={!aiArticleDraftingEnabled}
              onClick={() => setArticleMode("ai")}
            >
              <FileText size={15} />
              <span>
                <strong>Write with AI</strong>
                <small>
                  {aiArticleDraftingEnabled
                    ? "Draft from this note and Space"
                    : `Add an ${aiProviderName} key in Settings`}
                </small>
              </span>
            </button>
            <button
              type="button"
              className={articleMode === "blank" ? "selected" : ""}
              role="radio"
              aria-checked={articleMode === "blank"}
              onClick={() => setArticleMode("blank")}
            >
              <PenLine size={15} />
              <span>
                <strong>Blank page</strong>
                <small>Open an empty page to write yourself</small>
              </span>
            </button>
          </div>
          {articleMode === "ai" && (
            <label className="concept-link-ai-instructions">
              <span>Guide Orion <em>optional</em></span>
              <textarea
                value={articleInstructions}
                onChange={(event) =>
                  setArticleInstructions(event.target.value.slice(0, 1_250))
                }
                rows={3}
                placeholder="What should this page explain or emphasize?"
              />
              <small>{articleInstructions.length}/1,250</small>
            </label>
          )}
        </div>
      )}

      <details
        className="concept-link-destinations"
        open={destinationIds.size > 0 ? true : undefined}
      >
        <summary className="concept-link-destinations__label">
          <span>
            {destinationIds.size === 0
              ? "Use an existing note instead"
              : "Existing-note destination"}
          </span>
          <em>
            {destinationIds.size === 0
              ? "Advanced"
              : `${destinationIds.size} ${
                  destinationIds.size === 1
                    ? "destination"
                    : "destinations"
                }`}
          </em>
        </summary>
        <div className="concept-link-destinations__content">
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
      </details>

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
            ? articleMode === "ai"
              ? "Generate article"
              : "Create blank article"
            : "Create branched link"}
        </button>
      </div>
    </form>
  );
}
