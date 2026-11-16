import {
  BookOpen,
  Check,
  Download,
  FileCode2,
  FileText,
  Files,
  Link2,
  LoaderCircle,
  ShieldCheck,
  X,
} from "../lib/icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { notesForExportScope, type ExportScope } from "../lib/webExport";
import type { AppSnapshot, Note } from "../types";
import { displayNoteTitle } from "../lib/noteMetadata";
import './PortableOrion.css';

export type ExportFormat = "web" | "word" | "markdown" | "orion";

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
  noteIds?: string[];
}

interface ExportDialogProps {
  open: boolean;
  snapshot: AppSnapshot;
  activeNote: Note | null;
  onClose: () => void;
  onExport: (request: ExportRequest) => Promise<boolean>;
  onOpenCollection?: (file?:File) => Promise<boolean>;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(
  event: KeyboardEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(element => {
    const style = getComputedStyle(element);
    return element.tabIndex >= 0 && !element.matches(':disabled')
      && !element.closest('[hidden], [aria-hidden="true"]')
      && style.display !== 'none' && style.visibility !== 'hidden';
  });
  if (focusable.length === 0) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function ExportDialog({
  open,
  snapshot,
  activeNote,
  onClose,
  onExport,
  onOpenCollection,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("web");
  const [scope, setScope] = useState<ExportScope>(activeNote ? "note" : "space");
  const [busy, setBusy] = useState(false);
  const [chosenIds,setChosenIds]=useState<string[]>([]);
  const fileInput=useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeNoteId = activeNote?.id ?? null;

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setFormat("web");
    setScope(activeNoteId ? "note" : "space");
    setBusy(false);
    setChosenIds(activeNoteId?[activeNoteId]:[]);
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 35);
    return () => {
      window.clearTimeout(timer);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [activeNoteId, open]);

  const selectedNotes = useMemo(
    () => format==='orion'?snapshot.notes.filter(n=>chosenIds.includes(n.id)):notesForExportScope(snapshot, scope, activeNoteId),
    [activeNoteId, scope, snapshot,format,chosenIds],
  );

  if (!open) return null;

  const noteCount = selectedNotes.length;
  const selectionLabel = `${noteCount} ${noteCount === 1 ? "note" : "notes"} selected`;

  async function submit() {
    if (busy || noteCount === 0) return;
    setBusy(true);
    try {
      const shouldClose = await onExport({ format, scope, ...(format==='orion'?{noteIds:chosenIds}:{}) });
      if (shouldClose) onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="export-dialog-backdrop"
      onMouseDown={() => {
        if (!busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-dialog-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
            return;
          }
          trapFocus(event, dialogRef.current);
        }}
      >
        <header className="export-dialog__header">
          <div>
            <h2 id="export-dialog-title">Share or export</h2>
            <p>Choose what leaves this Space and how it should travel.</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="icon-button subtle"
            aria-label="Close export"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="export-dialog__body">
          <section className="export-dialog__section">
            <div className="export-dialog__section-heading">
              <strong>Format</strong>
              <span>{format === "web" ? "One offline file" : format === "word" ? "One editable document" : "Portable source files"}</span>
            </div>
            <div className="export-format-options" role="radiogroup" aria-label="Export format">
              <button type="button" role="radio" aria-label="Orion collection" aria-checked={format==='orion'} className={format==='orion'?'active':''} onClick={()=>setFormat('orion')}>
                <span className="export-option-icon"><BookOpen size={17}/></span><span><strong>Orion collection</strong><small>Editable .orion files with the selected notes, links, boards and images.</small></span><i>{format==='orion'?<Check size={12}/>:null}</i>
              </button>
              <button
                type="button"
                role="radio"
                aria-label="Interactive web article"
                aria-checked={format === "web"}
                className={format === "web" ? "active" : ""}
                onClick={() => setFormat("web")}
              >
                <span className="export-option-icon"><FileCode2 size={17} /></span>
                <span>
                  <strong>Interactive web article</strong>
                  <small>A beautiful self-contained HTML file with working Orion links.</small>
                </span>
                <i>{format === "web" ? <Check size={12} /> : null}</i>
              </button>
              <button
                type="button"
                role="radio"
                aria-label="Word document"
                aria-checked={format === "word"}
                className={format === "word" ? "active" : ""}
                onClick={() => setFormat("word")}
              >
                <span className="export-option-icon"><FileText size={17} /></span>
                <span>
                  <strong>Word document</strong>
                  <small>Editable text, tables, images and citations in one .docx file.</small>
                </span>
                <i>{format === "word" ? <Check size={12} /> : null}</i>
              </button>
              <button
                type="button"
                role="radio"
                aria-label="Markdown files"
                aria-checked={format === "markdown"}
                className={format === "markdown" ? "active" : ""}
                onClick={() => setFormat("markdown")}
              >
                <span className="export-option-icon"><Files size={17} /></span>
                <span>
                  <strong>Markdown files</strong>
                  <small>Editable, portable notes saved into a folder.</small>
                </span>
                <i>{format === "markdown" ? <Check size={12} /> : null}</i>
              </button>
            </div>
          </section>

          <section className="export-dialog__section">
            <div className="export-dialog__section-heading">
              <strong>Include</strong>
              <span>{selectionLabel}</span>
            </div>
            {format==='orion'?<div className="portable-note-selection">
              <p>Choose exactly what to share. Each file contains this same selection and opens a different note.</p>
              <div className="portable-selection-actions"><button type="button" className="text-button" onClick={()=>setChosenIds(snapshot.notes.map(n=>n.id))}>Select all</button><button type="button" className="text-button" onClick={()=>setChosenIds([])}>Clear selection</button></div>
              <div className="portable-note-options" role="group" aria-label="Notes to include">{snapshot.notes.map(note=><label key={note.id}><input type="checkbox" checked={chosenIds.includes(note.id)} onChange={event=>setChosenIds(ids=>event.target.checked?[...ids,note.id]:ids.filter(id=>id!==note.id))}/><span>{displayNoteTitle(note)}</span></label>)}</div>
            </div>:<div className="export-scope-options" role="radiogroup" aria-label="Export scope">
              <button
                type="button"
                role="radio"
                aria-label="This note"
                aria-checked={scope === "note"}
                disabled={!activeNote}
                className={scope === "note" ? "active" : ""}
                onClick={() => setScope("note")}
              >
                <BookOpen size={15} />
                <span>
                  <strong>This note</strong>
                  <small>{activeNote ? displayNoteTitle(activeNote) : "Open a note to use this scope"}</small>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-label="This note and linked pages"
                aria-checked={scope === "linked"}
                disabled={!activeNote}
                className={scope === "linked" ? "active" : ""}
                onClick={() => setScope("linked")}
              >
                <Link2 size={15} />
                <span>
                  <strong>This note and linked pages</strong>
                  <small>One deliberate hop through visible Orion links.</small>
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-label="Entire Space"
                aria-checked={scope === "space"}
                className={scope === "space" ? "active" : ""}
                onClick={() => setScope("space")}
              >
                <Files size={15} />
                <span>
                  <strong>Entire Space</strong>
                  <small>{snapshot.workspace.name} · {snapshot.notes.length} {snapshot.notes.length === 1 ? "note" : "notes"}</small>
                </span>
              </button>
            </div>}
          </section>

          <div className="export-privacy-note">
            <ShieldCheck size={15} />
            <span>
              <strong>Only the selected notes leave Orion.</strong>
              <small>Citation titles and original web URLs are preserved. Raw source text, settings, Chat, API keys, and other Spaces are never included.</small>
            </span>
          </div>
        </div>

        <footer className="export-dialog__footer">
          <span>{format==='orion'?`${noteCount} .orion ${noteCount===1?'file':'files'} · Reopening preserves local edits`:format === "web" ? "Opens offline in any modern browser" : format === "word" ? "Each note starts a new page; free layouts flow with the text" : "One .md file per selected note"}</span>
          <button
            type="button"
            className="button primary export-dialog__submit"
            disabled={busy || noteCount === 0}
            onClick={() => void submit()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}
            {busy
              ? "Preparing export…"
              : format === "web"
                ? "Export web article"
                : format === "word" ? "Export Word document" : format==='orion'?'Export Orion files':"Export Markdown"}
          </button>
        </footer>
        {onOpenCollection&&<div className="portable-open-file"><input ref={fileInput} type="file" accept=".orion" className="sr-only" tabIndex={-1} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void onOpenCollection(file).then(done=>{if(done)onClose();});}}/><button type="button" className="text-button" disabled={busy} onClick={()=>{if('__TAURI_INTERNALS__' in window)void onOpenCollection().then(done=>{if(done)onClose();});else fileInput.current?.click();}}>Open an .orion file…</button></div>}
      </div>
    </div>
  );
}
