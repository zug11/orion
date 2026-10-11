import { ArrowLeft, Check, ExternalLink, FileText, Link2, PenLine, Search, X } from "../lib/icons";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  isLinkablePhrase,
  createCanonicalArticleResolver,
} from "../lib/concepts";
import { linkTitleConflict } from "../lib/linkTitle";
import { isLinkedArticlePlaceholder } from "../lib/linkedArticle";
import { isPotentialExternalLink, normalizeExternalLink } from "../lib/externalLinks";
import type { Concept, Note } from "../types";
import type { ConceptLinkSelectionMode } from "./editor/conceptLinkSelection";

interface ConceptLinkPopoverProps {
  initialPhrase: string;
  initialHref?: string;
  initialNoteId?: string;
  selectedText?: string;
  selectionMode?: ConceptLinkSelectionMode;
  initialDestinationIds: readonly string[];
  currentNoteId: string;
  notes: readonly Note[];
  concepts?: readonly Concept[];
  aiArticleWritingEnabled?: boolean;
  aiProviderName?: string;
  onGenerateTitle?: (selectedContext: string, signal?: AbortSignal) => Promise<string>;
  onGeneratingChange?: (generating: boolean) => void;
  onCancel: () => void;
  onExternalLink?: (url: string) => void;
  onOpenExternalLink?: (url: string) => void;
  onNoteLink?: (noteId: string) => void;
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
  initialHref = "",
  initialNoteId,
  selectedText = "",
  selectionMode = "none",
  initialDestinationIds,
  currentNoteId,
  notes,
  concepts = [],
  aiArticleWritingEnabled = false,
  aiProviderName = "AI provider",
  onGenerateTitle,
  onGeneratingChange,
  onCancel,
  onExternalLink,
  onOpenExternalLink,
  onNoteLink,
  onSubmit,
}: ConceptLinkPopoverProps) {
  const phraseId = useId();
  const phraseInputRef = useRef<HTMLInputElement>(null);
  const destinationInputRef = useRef<HTMLInputElement>(null);
  const destinationListRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const titleRequestRef = useRef(0);
  const titlePendingRef = useRef(false);
  const titleAbortRef = useRef<AbortController | null>(null);
  const [phrase, setPhrase] = useState(initialPhrase);
  const [query, setQuery] = useState(initialHref);
  const [view, setView] = useState<"destination" | "article">("destination");
  const [destinationError, setDestinationError] = useState("");
  const [destinationIds, setDestinationIds] = useState(
    () => new Set(initialDestinationIds),
  );
  const [articleMode, setArticleMode] = useState<"ai" | "blank">(
    aiArticleWritingEnabled ? "ai" : "blank",
  );
  const [articleInstructions, setArticleInstructions] = useState("");
  const [generateInlineTitle, setGenerateInlineTitle] = useState(false);
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [titleError, setTitleError] = useState("");
  const normalizedSelectedText = selectedText.trim().replace(/\s+/g, " ");
  const selectedTextPreview =
    selectedText.length > 520
      ? `${selectedText.slice(0, 520).trimEnd()}…`
      : selectedText;
  const namingInlineSelection = selectionMode === "inline" &&
    generateInlineTitle && destinationIds.size === 0 && aiArticleWritingEnabled && Boolean(onGenerateTitle);
  const resolvedPhrase = namingInlineSelection ? "" :
    phrase.trim() ||
    (selectionMode === "inline" ? normalizedSelectedText : "");
  const validPhrase = isLinkablePhrase(resolvedPhrase);
  const resolveArticle = useMemo(
    () => createCanonicalArticleResolver(notes, concepts),
    [notes, concepts],
  );
  const articleTarget = resolveArticle(resolvedPhrase);
  const existingArticle = articleTarget.kind === "existing" &&
    articleTarget.note.id !== currentNoteId ? articleTarget.note : undefined;
  const reusesWrittenArticle = Boolean(existingArticle &&
    !isLinkedArticlePlaceholder(existingArticle, existingArticle.title));
  const canGenerateTitle = Boolean(
    (namingInlineSelection || (selectionMode === "context" && !phrase.trim())) &&
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
        : reusesWrittenArticle
          ? "Link existing article"
        : articleMode === "ai"
          ? "Generate article"
          : "Create blank article";
  const titleGuidanceId = `${phraseId}-guidance`;
  const titleErrorId = `${phraseId}-error`;
  const externalHref = normalizeExternalLink(query);
  const initialExternalHref = normalizeExternalLink(initialHref);
  const looksLikeUrl = isPotentialExternalLink(query);
  const visibleNotes = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [...notes]
      .sort((left, right) => {
        if (left.id === initialNoteId) return -1;
        if (right.id === initialNoteId) return 1;
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
  }, [currentNoteId, initialNoteId, notes, query]);

  useEffect(() => {
    if (view === "destination") {
      destinationInputRef.current?.focus();
      if (initialHref) destinationInputRef.current?.select();
      return;
    }
    phraseInputRef.current?.focus();
    if (initialPhrase) {
      phraseInputRef.current?.select();
    }
  }, [initialPhrase, initialHref, view]);

  useEffect(
    () => () => {
      titleRequestRef.current += 1;
      titlePendingRef.current = false;
      titleAbortRef.current?.abort();
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
    if (view === "destination") {
      if (externalHref && onExternalLink) {
        try {
          onExternalLink(externalHref);
        } catch (error) {
          setDestinationError(error instanceof Error ? error.message : String(error));
        }
      } else if (looksLikeUrl) {
        setDestinationError("Enter a valid http:// or https:// web address.");
      }
      return;
    }
    const normalizedPhrase = resolvedPhrase.replace(/\s+/g, " ");
    if (isLinkablePhrase(normalizedPhrase)) {
      try {
        completeSubmit(normalizedPhrase);
      } catch (error) {
        setTitleError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (!canGenerateTitle || !onGenerateTitle || titlePendingRef.current) {
      return;
    }
    const requestId = titleRequestRef.current + 1;
    titleRequestRef.current = requestId;
    titlePendingRef.current = true;
    const controller = new AbortController();
    titleAbortRef.current = controller;
    setTitleError("");
    setGeneratingTitle(true);
    cancelButtonRef.current?.focus();
    onGeneratingChange?.(true);
    try {
      const generatedTitle = (await onGenerateTitle(selectedText, controller.signal))
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
    const conflict = linkTitleConflict(
      { notes, concepts }, currentNoteId, normalizedPhrase,
    );
    if (destinationIds.size === 0 && conflict) {
      setTitleError(
        conflict === "self"
          ? `“${normalizedPhrase}” already names this note. Choose a more specific page title so Orion can create a separate article.`
          : `“${normalizedPhrase}” has several destinations. Choose a more specific title or select an existing note.`,
      );
      return;
    }
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
    titleAbortRef.current?.abort();
    setGeneratingTitle(false);
    onGeneratingChange?.(false);
    onCancel();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if (view === "destination" && !looksLikeUrl && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const buttons = [...(destinationListRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
      if (!buttons.length) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (document.activeElement !== destinationInputRef.current && current === -1) return;
      event.preventDefault();
      const next = current === -1
        ? event.key === "ArrowDown" ? 0 : buttons.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  }

  function linkNote(note: Note) {
    try {
      if (onNoteLink) {
        onNoteLink(note.id);
      } else {
        onSubmit(isLinkablePhrase(resolvedPhrase) ? resolvedPhrase : note.title, [note.id], { articleMode: "blank" });
      }
    } catch (error) {
      setDestinationError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <form
      className={`concept-link-popover${
        selectionMode === "context" ? " context-selection" : ""
      }${view === "destination" ? " concept-link-popover--destination" : ""}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${phraseId}-title`}
      aria-busy={generatingTitle}
      onSubmit={submit}
      onKeyDown={handleKeyDown}
    >
      <div className="concept-link-popover__head">
        {view === "article" ? <button
          type="button"
          onClick={() => {
            setQuery(initialHref);
            setView("destination");
          }}
          disabled={generatingTitle}
          aria-label="Back to link destinations"
        ><ArrowLeft size={15} /></button> : <span className="concept-link-popover__icon">
          <Link2 size={15} />
        </span>}
        <span>
          <strong id={`${phraseId}-title`}>
            {view === "destination" ? "Link" : selectionMode === "context"
              ? "Link selected context"
              : "Create a linked article"}
          </strong>
          {view === "article" ? <small>
            {selectionMode === "context"
              ? "The selection stays untouched; only its page title becomes a link."
              : "Create its named page, then Orion will recognize this phrase everywhere it appears."}
          </small> : null}
        </span>
        <button
          type="button"
          onClick={cancel}
          aria-label="Close link composer"
        >
          <X size={14} />
        </button>
      </div>

      {view === "destination" ? <>
        <label className="concept-link-search concept-link-search--destination">
          <Search size={14} />
          <input
            ref={destinationInputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setDestinationError("");
            }}
            placeholder="Search notes or paste a URL"
            aria-label="Search notes or paste a URL"
            aria-invalid={destinationError ? true : undefined}
            aria-describedby={destinationError ? `${phraseId}-destination-error` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        {destinationError ? <p className="concept-link-field__error" id={`${phraseId}-destination-error`} role="alert">
          {destinationError}
        </p> : null}
        {looksLikeUrl ? <div className="concept-link-web-destination">
          {externalHref ? <small>{externalHref}</small> : <small>Use a complete http:// or https:// web address.</small>}
          <div className="concept-link-popover__actions">
            {initialExternalHref && onOpenExternalLink ? <button
              type="button"
              className="button compact"
              aria-label="Open link in browser"
              title="Open link in browser"
              onClick={() => onOpenExternalLink(initialExternalHref)}
            ><ExternalLink size={13} /> Open</button> : null}
            <button type="submit" className="button primary compact" disabled={!externalHref || !onExternalLink}>
              {initialExternalHref ? "Update link" : "Add web link"}
            </button>
          </div>
        </div> : <>
          <div ref={destinationListRef} className="concept-link-note-list" aria-label="Notes in this Space">
            {visibleNotes.map((note) => <button
              type="button"
              key={note.id}
              aria-label={`Link to ${note.title}`}
              className={destinationIds.has(note.id) || initialNoteId === note.id ? "selected" : ""}
              aria-current={initialNoteId === note.id ? "true" : undefined}
              onClick={() => linkNote(note)}
            >
              <i style={{ background: note.color ?? "#8798ff" }} />
              <span><strong>{note.title}</strong><small>{note.id === currentNoteId ? "This note" : note.summary}</small></span>
              {destinationIds.has(note.id) || initialNoteId === note.id ? <b aria-hidden="true"><Check size={12} /></b> : null}
            </button>)}
            {visibleNotes.length === 0 ? <p className="concept-link-empty">No matching notes in this Space.</p> : null}
          </div>
          <button type="button" className="concept-link-create-article" onClick={() => {
            if (isLinkablePhrase(query.trim())) setPhrase(query.trim());
            setQuery("");
            setView("article");
          }}>
            <FileText size={15} />
            {destinationIds.size > 0 ? "Edit linked article or destinations" : "Create a linked article"}
          </button>
        </>}
      </> : <>
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
          disabled={generatingTitle || namingInlineSelection}
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
        {destinationIds.size === 0 && existingArticle ? (
          <small className="concept-link-field__guidance" role="status">
            {reusesWrittenArticle
              ? `“${existingArticle.title}” already exists in this Space. This link will use that article.`
              : `Continue the existing empty article “${existingArticle.title}”.`}
          </small>
        ) : null}
      </label>

      {selectionMode === "inline" && destinationIds.size === 0 && aiArticleWritingEnabled && onGenerateTitle ? (
        <label className="concept-link-title-toggle">
          <input
            type="checkbox"
            checked={generateInlineTitle}
            disabled={generatingTitle}
            onChange={(event) => {
              setGenerateInlineTitle(event.target.checked);
              setTitleError("");
            }}
          />
          <span>Generate title with AI</span>
        </label>
      ) : null}

      {selectionMode !== "none" ? (
        <div className="concept-link-selection-context">
          <div>
            <span>Selected context</span>
            <em>
              {selectionMode === "context" || namingInlineSelection
                ? "kept unchanged"
                : "used as the title by default"}
            </em>
          </div>
          <p>{selectedTextPreview}</p>
          {selectionMode === "context" || namingInlineSelection ? (
            <small>
              Orion adds the linked title immediately above this content. Code,
              formatting, and the selected words are not altered.
            </small>
          ) : null}
        </div>
      ) : null}

      {destinationIds.size === 0 && !reusesWrittenArticle && (
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
        <button
          ref={cancelButtonRef}
          type="button"
          className="button compact"
          onClick={cancel}
        >
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
      </>}
    </form>
  );
}
