import { useMemo, useState } from "react";
import type { AppSnapshot, ChatEditProposal } from "../types";
import { validateChatEditTarget } from "../lib/chatEdits";

export function ChatEditPreview({ proposal, snapshot, busy, onReview, onDiscard }: {
  proposal: ChatEditProposal;
  snapshot: AppSnapshot;
  busy: boolean;
  onReview: (proposal: ChatEditProposal) => Promise<boolean>;
  onDiscard: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState("");
  const stale = useMemo(() => {
    try { validateChatEditTarget(snapshot, proposal); return ""; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  }, [snapshot, proposal]);
  if (applied) return <p className="chat-edit__status" role="status">Changes accepted in {proposal.title}. Undo in the editor restores the previous text.</p>;
  return <section className="chat-edit" aria-label={`Proposed edits to ${proposal.title}`}>
    <header><strong>{proposal.title}</strong><span>{proposal.mode === "rewrite" ? "Full rewrite" : `${proposal.edits.length} focused ${proposal.edits.length === 1 ? "edit" : "edits"}`} · Not saved yet</span></header>
    <p>Review highlighted changes and gray additions directly in your note.</p>
    {(!reviewing && (stale || error)) && <p role="alert">{stale || error}</p>}
    <footer>
      <button type="button" className="button primary" disabled={busy || reviewing || Boolean(stale)} onClick={async () => {
        setReviewing(true); setError("");
        try { if (await onReview(proposal)) setApplied(true); else onDiscard(); }
        catch (error) { setError(error instanceof Error ? error.message : String(error)); }
        finally { setReviewing(false); }
      }}>{reviewing ? "Reviewing in note…" : "Review in note"}</button>
      <button type="button" className="button secondary" disabled={reviewing} onClick={onDiscard}>Discard</button>
    </footer>
  </section>;
}
