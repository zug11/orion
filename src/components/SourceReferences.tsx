import { useId } from "react";
import type { SourceCitationReference } from "../lib/sourceCitations";

interface SourceReferencesProps {
  references: readonly SourceCitationReference[];
  onOpenSource?: (sourceId: string) => void;
}

export function SourceReferences({
  references,
  onOpenSource,
}: SourceReferencesProps) {
  const headingId = useId();
  if (references.length === 0) return null;

  return (
    <section className="source-references" aria-labelledby={headingId}>
      <h2 id={headingId}>References</h2>
      <ol>
        {references.map((reference) => {
          const canOpen = reference.available && Boolean(onOpenSource);
          return (
            <li key={reference.sourceId}>
              <span aria-hidden="true">{reference.number}</span>
              {canOpen ? (
                <button
                  type="button"
                  onClick={() => onOpenSource?.(reference.sourceId)}
                  aria-label={`Open source ${reference.title}`}
                >
                  {reference.title}
                </button>
              ) : reference.available ? (
                <span>{reference.title}</span>
              ) : (
                <span
                  className="source-reference-missing"
                  title="This source is no longer available"
                >
                  {reference.title}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
