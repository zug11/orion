import { BookOpen, FileText, X } from "../lib/icons";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
} from "react";
import type { EntityId, Source } from "../types";

interface SourceCitationPopoverProps {
  sources: readonly Source[];
  attachedSourceIds: readonly EntityId[];
  onCancel: () => void;
  onSelect: (source: Source) => void;
}

export function SourceCitationPopover({
  sources,
  attachedSourceIds,
  onCancel,
  onSelect,
}: SourceCitationPopoverProps) {
  const titleId = useId();
  const firstSourceRef = useRef<HTMLButtonElement>(null);
  const attachedIds = useMemo(
    () => new Set(attachedSourceIds),
    [attachedSourceIds],
  );
  const orderedSources = useMemo(
    () =>
      [...sources].sort((left, right) => {
        const attachmentDifference =
          Number(attachedIds.has(right.id)) - Number(attachedIds.has(left.id));
        return attachmentDifference || left.title.localeCompare(right.title);
      }),
    [attachedIds, sources],
  );

  useEffect(() => {
    firstSourceRef.current?.focus({ preventScroll: true });
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onCancel();
  }

  return (
    <div
      className="source-citation-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={handleKeyDown}
    >
      <div className="source-citation-popover__head">
        <span className="source-citation-popover__icon">
          <BookOpen size={15} aria-hidden="true" />
        </span>
        <span>
          <strong id={titleId}>Cite a source</strong>
          <small>
            Attached sources appear first. Choosing another Space source also
            attaches it to this note.
          </small>
        </span>
        <button
          type="button"
          aria-label="Close source citation picker"
          onClick={onCancel}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="source-citation-popover__list">
        {orderedSources.map((source, index) => {
          const attached = attachedIds.has(source.id);
          return (
            <button
              ref={index === 0 ? firstSourceRef : undefined}
              type="button"
              key={source.id}
              onClick={() => onSelect(source)}
            >
              <FileText size={14} aria-hidden="true" />
              <span>
                <strong>{source.title}</strong>
                <small>
                  {attached ? "Attached to this note" : "From this Space"}
                  {` · ${source.kind.toLocaleUpperCase()}`}
                </small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
