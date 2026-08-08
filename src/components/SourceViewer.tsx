import {
  ArrowUpRight,
  ExternalLink,
  FileText,
  Image,
  Link2,
  Trash2,
  X,
} from "../lib/icons";
import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import type { Note, Source } from "../types";

interface SourceViewerProps {
  source: Source;
  notes: readonly Note[];
  onOpenNote: (noteId: string) => void;
  onDeleteSource: (sourceId: string) => void;
  onClose: () => void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function readableSize(bytes: number | undefined): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function SourceViewer({
  source,
  notes,
  onOpenNote,
  onDeleteSource,
  onClose,
}: SourceViewerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const connectedNotes = useMemo(
    () =>
      source.noteIds
        .map((noteId) => notes.find((note) => note.id === noteId))
        .filter((note): note is Note => Boolean(note)),
    [notes, source.noteIds],
  );
  const sourceUrl = safeExternalUrl(source.sourceUrl);
  const size = readableSize(source.byteSize);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="source-viewer-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="source-viewer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="source-viewer-title"
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="source-viewer__header">
          <div className="source-viewer__identity">
            <span className="source-viewer__icon">
              {source.kind === "image" ? (
                <Image size={18} aria-hidden="true" />
              ) : (
                <FileText size={18} aria-hidden="true" />
              )}
            </span>
            <div>
              <span>{source.kind === "youtube" ? "Transcript" : "Source"}</span>
              <h2 id="source-viewer-title">{source.title}</h2>
            </div>
          </div>
          <div className="source-viewer__actions">
            <button
              type="button"
              className="icon-button danger subtle"
              aria-label={`Delete source ${source.title}`}
              title={`Delete source ${source.title}`}
              onClick={() => onDeleteSource(source.id)}
            >
              <Trash2 size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button subtle"
              aria-label="Close source"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className="source-viewer__meta">
          <span>{source.kind.toUpperCase()}</span>
          {source.fileName ? <span>{source.fileName}</span> : null}
          {size ? <span>{size}</span> : null}
          <span>
            Imported{" "}
            {new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            }).format(new Date(source.importedAt))}
          </span>
          {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noreferrer">
              Open original <ExternalLink size={11} />
            </a>
          ) : null}
        </div>

        {source.importGuidance ? (
          <section className="source-viewer__guidance">
            <span>Import focus</span>
            <p>{source.importGuidance}</p>
          </section>
        ) : null}

        <section className="source-viewer__content" aria-label="Source content">
          <div className="source-viewer__section-heading">
            <FileText size={13} aria-hidden="true" />
            <span>
              {source.kind === "audio" ||
              source.kind === "video" ||
              source.kind === "youtube"
                ? "Transcript"
                : source.kind === "image"
                  ? "Recognized text"
                : "Preserved text"}
            </span>
          </div>
          <pre>{source.text || "This source does not contain extracted text."}</pre>
        </section>

        {connectedNotes.length > 0 ? (
          <section className="source-viewer__connections">
            <div className="source-viewer__section-heading">
              <Link2 size={13} aria-hidden="true" />
              <span>Shaped these notes</span>
              <em>{connectedNotes.length}</em>
            </div>
            <div>
              {connectedNotes.map((note) => (
                <button
                  type="button"
                  key={note.id}
                  onClick={() => onOpenNote(note.id)}
                >
                  <span>
                    <strong>{note.title}</strong>
                    <small>{note.summary}</small>
                  </span>
                  <ArrowUpRight size={14} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
