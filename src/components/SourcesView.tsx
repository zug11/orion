import {
  Braces,
  CirclePlay,
  File,
  FileCode2,
  FileText,
  Image,
  Mic2,
  Search,
  Sheet,
  Trash2,
  Video,
} from "../lib/icons";
import { useMemo, useState } from "react";
import type { Source } from "../types";

interface SourcesViewProps {
  sources: Source[];
  onOpenSource: (sourceId: string) => void;
  onDeleteSource: (sourceId: string) => void;
}

const sourceIcons = {
  text: FileText,
  markdown: FileCode2,
  json: Braces,
  csv: Sheet,
  html: FileCode2,
  pdf: FileText,
  docx: FileText,
  image: Image,
  manual: File,
  audio: Mic2,
  video: Video,
  youtube: CirclePlay,
} as const;

export function SourcesView({
  sources,
  onOpenSource,
  onDeleteSource,
}: SourcesViewProps) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.toLocaleLowerCase().trim();
    return sources.filter((source) =>
      needle
        ? `${source.title} ${source.fileName ?? ""}`
            .toLocaleLowerCase()
            .includes(needle)
        : true,
    );
  }, [query, sources]);

  return (
    <div className="view index-view">
      <div className="view-title-row">
        <div>
          <span className="eyebrow neutral">Provenance</span>
          <h1>Sources</h1>
          <p>Every imported thread, kept close to the notes it shaped.</p>
        </div>
      </div>
      <div className="index-toolbar">
        <label className="inline-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a source…"
            aria-label="Find a source"
          />
        </label>
        <span>{visible.length} sources</span>
      </div>
      <div className="source-table">
        <div className="source-table-head">
          <span>Source</span>
          <span>Format</span>
          <span>Connected notes</span>
          <span>Imported</span>
          <span className="sr-only">Actions</span>
        </div>
        {visible.map((source) => {
          const Icon = sourceIcons[source.kind] ?? File;
          return (
            <div className="source-table-row" key={source.id}>
              <button
                type="button"
                className="source-table-open"
                aria-label={`Open source ${source.title}`}
                onClick={() => onOpenSource(source.id)}
              />
              <span className="source-title-cell">
                <i>
                  <Icon size={16} />
                </i>
                <span>
                  <strong>{source.title}</strong>
                  <small>{source.fileName ?? "Written in Orion"}</small>
                </span>
              </span>
              <span>
                <em>{source.kind.toUpperCase()}</em>
              </span>
              <span>{source.noteIds.length}</span>
              <span>
                {new Intl.DateTimeFormat(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                }).format(new Date(source.importedAt))}
              </span>
              <button
                type="button"
                className="icon-button danger source-table-delete"
                aria-label={`Delete source ${source.title}`}
                title={`Delete source ${source.title}`}
                onClick={() => onDeleteSource(source.id)}
              >
                <Trash2 size={14} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        {visible.length === 0 && (
          <div className="collection-empty source-empty">
            <FileText size={24} />
            <strong>{query ? "No sources match" : "No sources yet"}</strong>
            <span>
              {query
                ? "Try a different source name."
                : "Imported material and provenance will appear here."}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
