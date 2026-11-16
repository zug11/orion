import { useRef, useState } from "react";
import { LockKeyhole } from "../lib/icons";
import { retrySavedConnections } from "../lib/storage";

export function SavedConnectionsAccess({ onUnlocked }: { onUnlocked: () => void }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function unlock() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage("");
    try {
      await retrySavedConnections();
      onUnlocked();
      setMessage("Ready to retry your saved connections.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { pending.current = false; setBusy(false); }
  }
  return <div className="setting-card">
    <div className="setting-row"><span><strong>Saved connections</strong>
      <small>If you dismissed the system prompt, unlock your saved connections to try again.</small>
    </span><button type="button" className="button secondary" disabled={busy} onClick={() => void unlock()}>
      <LockKeyhole size={14} />{busy ? "Unlocking…" : "Unlock saved connections"}
    </button></div>
    {message && <p className="saved-voice-hint" role="status">{message}</p>}
  </div>;
}
