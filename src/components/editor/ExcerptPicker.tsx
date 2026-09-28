import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, Link2, Plus, Search, X } from "../../lib/icons";
import type { Note } from "../../types";
import {
  createNoteExcerptSelection, excerptRangeFromSelection, excerptSearchMatches,
  getNoteExcerptDocument, normalizeExcerptRanges, searchExcerptNotes,
  type ExcerptRange, type ExcerptSearchResult, type NoteExcerptSelection,
} from "../../lib/noteExcerpts";
import "./excerpt.css";

export interface ExcerptPickerProps {
  /** Pass only the current Space's notes. The picker has no library access. */
  notes: readonly Note[];
  currentNoteId: string;
  mode?: "excerpt" | "link";
  portalTarget?: Element | null;
  onInsertExcerpt: (selection: NoteExcerptSelection) => void;
  onInsertLink?: (note: Note) => void;
  onClose: () => void;
}

function highlighted(text: string, query: string, offset = 0, selected: readonly ExcerptRange[] = []): ReactNode {
  const matches = excerptSearchMatches(text, query).map((range) => ({ ...range, selected: false }));
  const saved = selected.flatMap(({ from, to }) => {
    const start = Math.max(0, from - offset);
    const end = Math.min(text.length, to - offset);
    return end > start ? [{ from: start, to: end, selected: true }] : [];
  });
  const all = [...matches, ...saved];
  const positions = [...new Set([0, text.length, ...all.flatMap(({ from, to }) => [from, to])])].sort((a, b) => a - b);
  return positions.slice(0, -1).map((from, index) => {
    const to = positions[index + 1];
    const match = all.find((range) => range.selected && range.from <= from && range.to >= to) ?? all.find((range) => range.from <= from && range.to >= to);
    return match ? <mark key={from} className={match.selected ? "excerpt-saved-highlight" : "excerpt-search-highlight"}>{text.slice(from, to)}</mark> : <span key={from}>{text.slice(from, to)}</span>;
  });
}

function trapFocus(event: KeyboardEvent, container: HTMLElement | null) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
    event.preventDefault(); last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first?.focus();
  }
}

export function ExcerptPicker({ notes, currentNoteId, mode = "excerpt", portalTarget, onInsertExcerpt, onInsertLink, onClose }: ExcerptPickerProps) {
  const titleId = useId();
  const helpId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const articleRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceBody, setSourceBody] = useState("");
  const [jump, setJump] = useState<ExcerptRange | undefined>();
  const [ranges, setRanges] = useState<ExcerptRange[]>([]);
  const [pending, setPending] = useState<ExcerptRange | null>(null);
  const [error, setError] = useState("");
  const results = useMemo(() => searchExcerptNotes(notes, query, currentNoteId), [notes, query, currentNoteId]);
  const selectedNote = notes.find((note) => note.id === selectedId && note.id !== currentNoteId);
  const article = useMemo(() => selectedNote ? getNoteExcerptDocument(selectedNote) : null, [selectedNote]);
  const combined = article ? normalizeExcerptRanges(article.text, [...ranges, ...(pending ? [pending] : [])]) : [];
  const selectionChanged = Boolean(selectedNote && selectedNote.body !== sourceBody);
  let excerpt: NoteExcerptSelection | undefined;
  let selectionError = "";
  if (selectedNote && combined.length && !selectionChanged) {
    try { excerpt = createNoteExcerptSelection(selectedNote, combined); }
    catch (reason) { selectionError = reason instanceof Error ? reason.message : "Choose a shorter excerpt."; }
  }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    backRef.current?.focus({ preventScroll: true });
    const articleElement = articleRef.current;
    const target = jump && article?.blocks.find((block) => block.to >= jump.from);
    const element = target ? articleElement?.querySelector<HTMLElement>(`[data-excerpt-from="${target.from}"]`) : undefined;
    const scrollArea = articleElement?.closest(".excerpt-reader-scroll");
    if (scrollArea) {
      const top = element ? element.getBoundingClientRect().top - scrollArea.getBoundingClientRect().top + scrollArea.scrollTop - 28 : 0;
      scrollArea.scrollTop = Math.max(0, top);
    }
  }, [selectedId, article, jump]);

  useEffect(() => {
    if (!selectedId) return;
    function capture() {
      if (!articleRef.current) return;
      const range = excerptRangeFromSelection(articleRef.current, window.getSelection());
      // Clicking an action may collapse the native selection; retain its last valid range.
      if (range) { setPending(range); setError(""); }
    }
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [selectedId]);

  function openResult(result: ExcerptSearchResult) {
    const current = notes.find((note) => note.id === result.note.id && note.id !== currentNoteId);
    if (!current) return;
    if (mode === "link") { onInsertLink?.(current); return; }
    setSelectedId(current.id); setSourceBody(current.body); setJump(result.bodyMatch);
    setRanges([]); setPending(null); setError("");
  }

  function back() {
    setSelectedId(null); setRanges([]); setPending(null); setError("");
    window.getSelection()?.removeAllRanges();
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }

  function capturePointerSelection() {
    if (!articleRef.current) return;
    const range = excerptRangeFromSelection(articleRef.current, window.getSelection());
    if (range) { setPending(range); setError(""); }
  }

  return createPortal(<div className="excerpt-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={helpId}
      className={`excerpt-picker ${selectedId ? "excerpt-picker-reading" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        trapFocus(event, dialogRef.current);
      }}>
      <header className="excerpt-picker-header">
        <div className="excerpt-picker-heading">
          {selectedId ? <button ref={backRef} type="button" className="excerpt-icon-button" onClick={back} aria-label="Back to note search"><ArrowLeft size={18}/></button> : mode === "link" ? <Link2 size={19}/> : <BookOpen size={19}/>}
          <h2 id={titleId}>{selectedId ? "Choose a passage" : mode === "link" ? "Link a note" : "Excerpt from a note"}</h2>
        </div>
        <button type="button" className="excerpt-icon-button" onClick={onClose} aria-label="Close note picker"><X size={18}/></button>
      </header>
      {!selectedId ? <>
        <div className="excerpt-search-field"><Search size={17}/><input ref={searchRef} aria-label="Search notes and their contents" placeholder="Search notes and their contents…" value={query} maxLength={256}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); dialogRef.current?.querySelector<HTMLButtonElement>(".excerpt-result")?.focus(); }
            if (event.key === "Enter" && results.length === 1) { event.preventDefault(); openResult(results[0]); }
          }}/></div>
        <p className="excerpt-picker-help" id={helpId}>{mode === "link" ? "Choose a note in this Space to link at your cursor." : "Find a note, then highlight exactly the words you want to quote."}</p>
        <div className="excerpt-search-results" aria-label="Matching notes" onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".excerpt-result")];
          const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
          if (current < 0) return;
          event.preventDefault();
          buttons[Math.max(0, Math.min(buttons.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
        }}>
          {results.slice(0, 100).map((result) => <button key={result.note.id} type="button" className="excerpt-result" onClick={() => openResult(result)}>
            <div className="excerpt-result-title"><span>{highlighted(result.note.title || "Untitled note", query)}</span><ArrowUpRight size={15}/></div>
            <p>{highlighted(result.snippet || "This note is empty.", query)}</p>
          </button>)}
          {!results.length && <p className="excerpt-empty">{query ? "No matching notes in this Space." : "Other notes in this Space will appear here."}</p>}
          {results.length > 100 && <p className="excerpt-empty">Showing 100 of {results.length} notes. Narrow your search to find another.</p>}
        </div>
      </> : selectedNote && article ? <>
        <div className="excerpt-source-heading"><h3>{selectedNote.title || "Untitled note"}</h3><p id={helpId}>Highlight a sentence or passage. You can add another passage before inserting.</p></div>
        <div className="excerpt-reader-scroll">
          {article.text ? <div ref={articleRef} className="excerpt-reader-article" aria-label={`Source note: ${selectedNote.title || "Untitled note"}`} tabIndex={0} onMouseUp={capturePointerSelection} onKeyUp={capturePointerSelection}>
            {article.blocks.map((block, index) => <span key={`${block.from}-${block.kind}`} className={`excerpt-article-${block.kind}`} data-excerpt-from={block.from}
              role={block.kind === "heading" ? "heading" : undefined} aria-level={block.kind === "heading" ? block.level : undefined}>
              {highlighted(block.text, query, block.from, ranges)}{index < article.blocks.length - 1 ? "\n\n" : ""}
            </span>)}
          </div> : <p className="excerpt-empty">This note has no text to quote.</p>}
        </div>
        <div className="excerpt-selection-preview" aria-live="polite">
          {selectionChanged ? <p role="alert">This source note changed while you were selecting. Go back and open it again to choose a current passage.</p> : excerpt ? <>
            <div className="excerpt-preview-label"><Check size={14}/>{excerpt.passages.length === 1 ? "Selected passage" : `${excerpt.passages.length} passages · source order`}</div>
            <p>{excerpt.text}</p>
          </> : <p className="excerpt-preview-empty">Your selected words will appear here.</p>}
          {(error || selectionError) && <p role="alert">{error || selectionError}</p>}
        </div>
        <footer className="excerpt-picker-footer">
          <button type="button" className="excerpt-secondary-button" disabled={!pending || !excerpt || selectionChanged} onMouseDown={(event) => event.preventDefault()} onClick={() => {
            setRanges(combined); setPending(null); window.getSelection()?.removeAllRanges(); articleRef.current?.focus({ preventScroll: true });
          }}><Plus size={15}/>Add another passage</button>
          <button type="button" className="excerpt-primary-button" disabled={!excerpt || selectionChanged} onMouseDown={(event) => event.preventDefault()} onClick={() => {
            if (!excerpt || !notes.some((note) => note.id === excerpt.noteId && note.body === sourceBody)) return;
            try { onInsertExcerpt(excerpt); } catch (reason) { setError(reason instanceof Error ? reason.message : "The excerpt could not be inserted."); }
          }}>Insert excerpt<ArrowUpRight size={15}/></button>
        </footer>
      </> : <p className="excerpt-empty" role="alert">This note is no longer available in this Space. <button type="button" onClick={back}>Back to search</button></p>}
    </div>
  </div>, portalTarget ?? document.body);
}
