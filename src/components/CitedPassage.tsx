import type { ChatEvidence, Note, Source } from "../types";
import { spaceNoteVersion, stableKnowledgeHash } from "../lib/spaceKnowledge";
import { sourceEvidenceVersion } from "../lib/evidenceVersions";

interface CitedPassageProps {
  evidence: ChatEvidence;
  notes: readonly Note[];
  sources: readonly Source[];
  panelId: string;
  savedWith: "reply" | "note";
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onOpenSource?: (id: string) => void;
}

export function citedPassageStatus(evidence: ChatEvidence, notes: readonly Note[], sources: readonly Source[], savedWith: "reply" | "note") {
  const note = evidence.kind === "note" ? notes.find((item) => item.id === evidence.entityId) : undefined;
  const source = evidence.kind === "source" ? sources.find((item) => item.id === evidence.entityId) : undefined;
  const currentVersion = note ? spaceNoteVersion(note) : source ? sourceEvidenceVersion(source) : undefined;
  const legacyVersionMatches = source && stableKnowledgeHash(JSON.stringify(source)) === evidence.version;
  const changed = Boolean(currentVersion && ((!legacyVersionMatches && currentVersion !== evidence.version) ||
    (note?.body ?? source?.text ?? "").slice(evidence.start, evidence.end) !== evidence.text));
  return { available: Boolean(currentVersion), description: !currentVersion
    ? `This item is no longer in this Space. The passage shown was saved with this ${savedWith}.`
    : changed ? `This item has changed since the ${savedWith === "reply" ? "reply" : "passage was saved"}. This is the passage Chat read then.`
      : `Exact passage read for this ${savedWith === "reply" ? "reply" : "saved note"}.` };
}

/** Always display the retained quote, even when its original changes or vanishes. */
export function CitedPassage({ evidence, notes, sources, panelId, savedWith, onClose, onOpenNote, onOpenSource }: CitedPassageProps) {
  const status = citedPassageStatus(evidence, notes, sources, savedWith);
  return <aside className="chat-evidence" id={panelId} aria-label="Cited passage"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="chat-evidence__heading"><strong>{evidence.title}</strong>
      <button type="button" onClick={onClose} aria-label="Close cited passage">Close</button>
    </div>
    <blockquote>{evidence.text}</blockquote>
    <p>{status.description}</p>
    <button type="button" disabled={!status.available || (evidence.kind === "source" && !onOpenSource)}
      onClick={() => evidence.kind === "note" ? onOpenNote(evidence.entityId) : onOpenSource?.(evidence.entityId)}>
      {evidence.kind === "note" ? "Open note" : "Open source"}
    </button>
  </aside>;
}
