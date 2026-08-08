import {
  BookOpen,
  Check,
  Download,
  FileCode2,
  Files,
  Link2,
  LoaderCircle,
  ShieldCheck,
  X,
} from "../lib/icons";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { notesForExportScope, type ExportScope } from "../lib/webExport";
import type { AppSnapshot, Note } from "../types";

export type ExportFormat = "web" | "markdown";

export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
}

interface ExportDialogProps {
  open: boolean;
  snapshot: AppSnapshot;
  activeNote: Note | null;
  onClose: () => void;
  onExport: (request: ExportRequest) => Promise<boolean>;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(
  event: KeyboardEvent<HTMLDivElement>,
  container: HTMLDivElement | null,
) {
  if (event.key !== "Tab" || !container) return;
  const focusable = [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];
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
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("web");
  const [scope, setScope] = useState<ExportScope>(activeNote ? "note" : "space");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const activeNoteId = activeNote?.id ?? null;

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    setFormat("web");
    setScope(activeNoteId ? "note" : "space");
    setBusy(false);
    const timer = window.setTimeout(() => closeButtonRef.current?.focus(), 35);
    return () => {
      window.clearTimeout(timer);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [activeNoteId, open]);

  const selectedNotes = useMemo(
    () => notesForExportScope(snapshot, scope, activeNoteId),
    [activeNoteId, scope, snapshot],
  );

  if (!open) return null;

  const noteCount = selectedNotes.length;
  const selectionLabel = `${noteCount} ${noteCount === 1 ? "note" : "notes"} selected`;

  async function submit() {
    if (busy || noteCount === 0) return;
    setBusy(true);
    try {
      const shouldClose = await onExport({ format, scope });
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
            <span className="export-dialog__eyebrow">A portable Orion snapshot</span>
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
              <span>{format === "web" ? "One offline file" : "Portable source files"}</span>
            </div>
            <div className="export-format-options" role="radiogroup" aria-label="Export format">
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
            <div className="export-scope-options" role="radiogroup" aria-label="Export scope">
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
                  <small>{activeNote?.title ?? "Open a note to use this scope"}</small>
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
            </div>
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
          <span>{format === "web" ? "Opens offline in any modern browser" : "One .md file per selected note"}</span>
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
                : "Export Markdown"}
          </button>
        </footer>
      </div>
    </div>
  );
}
