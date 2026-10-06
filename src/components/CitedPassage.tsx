import type { ChatEvidence, Note, Source } from "../types";
import { spaceNoteVersion, stableKnowledgeHash } from "../lib/spaceKnowledge";
import { sourceEvidenceVersion } from "../lib/evidenceVersions";
import { getNoteExcerptText } from "../lib/noteExcerpts";
import { requestNoteExcerptNavigation } from "../lib/noteExcerptNavigation";
import { requestSourcePassageNavigation } from "../lib/sourcePassageNavigation";

interface CitedPassageProps {
  evidence: ChatEvidence;
  notes: readonly Note[];
  sources: readonly Source[];
  panelId: string;
  savedWith: "reply" | "note" | "answer";
  onClose: () => void;
  onOpenNote: (id: string) => void;
  onOpenSource?: (id: string) => void;
}

export function citedPassageStatus(evidence: ChatEvidence, notes: readonly Note[], sources: readonly Source[], savedWith: "reply" | "note" | "answer") {
  const note = evidence.kind === "note" ? notes.find((item) => item.id === evidence.entityId) : undefined;
  const source = evidence.kind === "source" ? sources.find((item) => item.id === evidence.entityId) : undefined;
  const currentVersion = note ? spaceNoteVersion(note) : source ? sourceEvidenceVersion(source) : undefined;
  const legacyVersionMatches = source && stableKnowledgeHash(JSON.stringify(source)) === evidence.version;
  const changed = Boolean(currentVersion && ((!legacyVersionMatches && currentVersion !== evidence.version) ||
    (note?.body ?? source?.text ?? "").slice(evidence.start, evidence.end) !== evidence.text));
  if (savedWith === "answer") {
    return { available: Boolean(currentVersion), description: !currentVersion
      ? "This item is no longer in this Space. The passage shown was used for this answer."
      : changed ? "This item has changed since this answer. The passage shown was used for this answer."
        : "Exact passage used for this answer." };
  }
  return { available: Boolean(currentVersion), description: !currentVersion
    ? `This item is no longer in this Space. The passage shown was saved with this ${savedWith}.`
    : changed ? `This item has changed since the ${savedWith === "reply" ? "reply" : "passage was saved"}. This is the passage Chat read then.`
      : `Exact passage read for this ${savedWith === "reply" ? "reply" : "saved note"}.` };
}

/** Always display the retained quote, even when its original changes or vanishes. */
export function CitedPassage({ evidence, notes, sources, panelId, savedWith, onClose, onOpenNote, onOpenSource }: CitedPassageProps) {
  const status = citedPassageStatus(evidence, notes, sources, savedWith);
  function openOriginal() {
    if (evidence.kind === "source") {
      const source = sources.find((item) => item.id === evidence.entityId);
      if (source && sourceEvidenceVersion(source) === evidence.version) requestSourcePassageNavigation(source, { from: evidence.start, to: evidence.end, text: evidence.text });
      onOpenSource?.(evidence.entityId);
      return;
    }
    const note = notes.find((item) => item.id === evidence.entityId);
    if (note && spaceNoteVersion(note) === evidence.version && note.body.slice(evidence.start, evidence.end) === evidence.text) {
      const text = getNoteExcerptText(note);
      const wanted = getNoteExcerptText({ ...note, body: evidence.text });
      const from = text.indexOf(wanted);
      if (wanted && from >= 0 && text.indexOf(wanted, from + 1) < 0) requestNoteExcerptNavigation(note.id, [{ from, to: from + wanted.length, text: wanted }]);
    }
    onOpenNote(evidence.entityId);
  }
  return <aside className="chat-evidence" id={panelId} aria-label="Cited passage"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <div className="chat-evidence__heading"><strong>{evidence.title}</strong>
      <button type="button" onClick={onClose} aria-label="Close cited passage">Close</button>
    </div>
    <blockquote>{evidence.text}</blockquote>
    <p>{status.description}</p>
    <button type="button" disabled={!status.available || (evidence.kind === "source" && !onOpenSource)}
      onClick={openOriginal}>
      {evidence.kind === "note" ? "Open note" : "Open source"}
    </button>
  </aside>;
}
