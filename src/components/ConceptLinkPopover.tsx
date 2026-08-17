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
import type { ConceptLinkSelectionMode } from "./editor/conceptLinkSelection";

interface ConceptLinkPopoverProps {
  initialPhrase: string;
  selectedText?: string;
  selectionMode?: ConceptLinkSelectionMode;
  initialDestinationIds: readonly string[];
  currentNoteId: string;
  notes: readonly Note[];
  aiArticleWritingEnabled?: boolean;
  aiProviderName?: string;
  onGenerateTitle?: (selectedContext: string) => Promise<string>;
  onGeneratingChange?: (generating: boolean) => void;
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
  selectedText = "",
  selectionMode = "none",
  initialDestinationIds,
  currentNoteId,
  notes,
  aiArticleWritingEnabled = false,
  aiProviderName = "AI provider",
  onGenerateTitle,
  onGeneratingChange,
  onCancel,
  onSubmit,
}: ConceptLinkPopoverProps) {
  const phraseId = useId();
  const phraseInputRef = useRef<HTMLInputElement>(null);
  const titleRequestRef = useRef(0);
  const titlePendingRef = useRef(false);
  const [phrase, setPhrase] = useState(initialPhrase);
  const [query, setQuery] = useState("");
  const [destinationIds, setDestinationIds] = useState(
    () => new Set(initialDestinationIds),
  );
  const [articleMode, setArticleMode] = useState<"ai" | "blank">(
    aiArticleWritingEnabled ? "ai" : "blank",
  );
  const [articleInstructions, setArticleInstructions] = useState("");
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [titleError, setTitleError] = useState("");
  const normalizedSelectedText = selectedText.trim().replace(/\s+/g, " ");
  const selectedTextPreview =
    selectedText.length > 520
      ? `${selectedText.slice(0, 520).trimEnd()}…`
      : selectedText;
  const resolvedPhrase =
    phrase.trim() ||
    (selectionMode === "inline" ? normalizedSelectedText : "");
  const validPhrase = isLinkablePhrase(resolvedPhrase);
  const canGenerateTitle = Boolean(
    selectionMode === "context" &&
      !phrase.trim() &&
      normalizedSelectedText &&
      destinationIds.size === 0 &&
      aiArticleWritingEnabled &&
      onGenerateTitle,
  );
  const submitLabel = generatingTitle
    ? "Naming page…"
    : canGenerateTitle
      ? articleMode === "ai"
        ? "Name & generate article"
        : "Name & create blank page"
      : destinationIds.size > 0
        ? "Create branched link"
        : articleMode === "ai"
          ? "Generate article"
          : "Create blank article";
  const titleGuidanceId = `${phraseId}-guidance`;
  const titleErrorId = `${phraseId}-error`;
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

  useEffect(
    () => () => {
      titleRequestRef.current += 1;
      titlePendingRef.current = false;
      onGeneratingChange?.(false);
    },
    [onGeneratingChange],
  );

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

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalizedPhrase = resolvedPhrase.replace(/\s+/g, " ");
    if (isLinkablePhrase(normalizedPhrase)) {
      completeSubmit(normalizedPhrase);
      return;
    }

    if (!canGenerateTitle || !onGenerateTitle || titlePendingRef.current) {
      return;
    }
    const requestId = titleRequestRef.current + 1;
    titleRequestRef.current = requestId;
    titlePendingRef.current = true;
    setTitleError("");
    setGeneratingTitle(true);
    onGeneratingChange?.(true);
    try {
      const generatedTitle = (await onGenerateTitle(selectedText))
        .trim()
        .replace(/\s+/g, " ");
      if (titleRequestRef.current !== requestId) return;
      if (
        !isLinkablePhrase(generatedTitle) ||
        [...generatedTitle].length > 120
      ) {
        throw new Error(
          "Orion could not find a usable page title. Try again or enter one yourself.",
        );
      }
      setPhrase(generatedTitle);
      titlePendingRef.current = false;
      setGeneratingTitle(false);
      onGeneratingChange?.(false);
      completeSubmit(generatedTitle);
    } catch (error) {
      if (titleRequestRef.current !== requestId) return;
      setTitleError(
        error instanceof Error
          ? error.message
          : "Orion could not name this page. Try again or enter a title.",
      );
      titlePendingRef.current = false;
      setGeneratingTitle(false);
      onGeneratingChange?.(false);
    }
  }

  function completeSubmit(normalizedPhrase: string) {
    onSubmit(normalizedPhrase, [...destinationIds], {
      articleMode: destinationIds.size > 0 ? "blank" : articleMode,
      ...(articleMode === "ai" && articleInstructions.trim()
        ? { articleInstructions: articleInstructions.trim() }
        : {}),
    });
  }

  function cancel() {
    titleRequestRef.current += 1;
    titlePendingRef.current = false;
    setGeneratingTitle(false);
    onGeneratingChange?.(false);
    onCancel();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  }

  return (
    <form
      className={`concept-link-popover${
        selectionMode === "context" ? " context-selection" : ""
      }`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${phraseId}-title`}
      aria-busy={generatingTitle}
      onSubmit={submit}
      onKeyDown={handleKeyDown}
    >
      <div className="concept-link-popover__head">
        <span className="concept-link-popover__icon">
          <Link2 size={15} />
        </span>
        <span>
          <strong id={`${phraseId}-title`}>
            {selectionMode === "context"
              ? "Link selected context"
              : "Teach Orion a link"}
          </strong>
          <small>
            {selectionMode === "context"
              ? "The selection stays untouched; only its page title becomes a link."
              : "Create its named page, then Orion will recognize this phrase everywhere it appears."}
          </small>
        </span>
        <button
          type="button"
          onClick={cancel}
          aria-label="Close link composer"
        >
          <X size={14} />
        </button>
      </div>

      <label className="concept-link-field" htmlFor={phraseId}>
        <span>
          Page title
          {selectionMode === "inline" ? (
            <em>optional</em>
          ) : selectionMode === "context" ? (
            <em>
              {aiArticleWritingEnabled && destinationIds.size === 0
                ? "optional with AI"
                : "required"}
            </em>
          ) : null}
        </span>
        <input
          ref={phraseInputRef}
          id={phraseId}
          value={phrase}
          onChange={(event) => {
            setPhrase(event.target.value);
            setTitleError("");
          }}
          placeholder={
            selectionMode === "context"
              ? aiArticleWritingEnabled && destinationIds.size === 0
                ? "Leave blank and Orion will name it…"
                : "Name the page this selection belongs to…"
              : selectionMode === "inline"
                ? "Use the selected words"
                : "Type the words to recognize…"
          }
          autoComplete="off"
          maxLength={120}
          aria-label="Page title"
          disabled={generatingTitle}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={
            selectionMode === "context"
              ? `${titleGuidanceId}${titleError ? ` ${titleErrorId}` : ""}`
              : titleError
                ? titleErrorId
                : undefined
          }
        />
        {resolvedPhrase && !validPhrase && (
          <small className="concept-link-field__hint">
            Use at least three characters, or a two-letter uppercase acronym.
          </small>
        )}
        {selectionMode === "context" && !resolvedPhrase ? (
          <small
            className="concept-link-field__guidance"
            id={titleGuidanceId}
          >
            {aiArticleWritingEnabled && destinationIds.size === 0
              ? "Orion can name this page from the selected passage and this Space."
              : `Enter a title, or add an ${aiProviderName} key in Settings to let Orion name it.`}
          </small>
        ) : null}
        {titleError ? (
          <small
            className="concept-link-field__error"
            id={titleErrorId}
            role="alert"
          >
            {titleError}
          </small>
        ) : null}
      </label>

      {selectionMode !== "none" ? (
        <div className="concept-link-selection-context">
          <div>
            <span>Selected context</span>
            <em>
              {selectionMode === "context"
                ? "kept unchanged"
                : "used as the title by default"}
            </em>
          </div>
          <p>{selectedTextPreview}</p>
          {selectionMode === "context" ? (
            <small>
              Orion adds the linked title immediately above this content. Code,
              formatting, and the selected words are not altered.
            </small>
          ) : null}
        </div>
      ) : null}

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
              disabled={!aiArticleWritingEnabled || generatingTitle}
              onClick={() => setArticleMode("ai")}
            >
              <FileText size={15} />
              <span>
                <strong>Write with AI</strong>
                <small>
                  {aiArticleWritingEnabled
                    ? "Write from this note and Space"
                    : `Add an ${aiProviderName} key in Settings`}
                </small>
              </span>
            </button>
            <button
              type="button"
              className={articleMode === "blank" ? "selected" : ""}
              role="radio"
              aria-checked={articleMode === "blank"}
              disabled={generatingTitle}
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
                disabled={generatingTitle}
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
                disabled={generatingTitle}
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
                  disabled={generatingTitle}
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
        <button type="button" className="button compact" onClick={cancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="button primary compact"
          disabled={generatingTitle || (!validPhrase && !canGenerateTitle)}
        >
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
