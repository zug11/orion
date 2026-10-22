import { useRef, useState } from "react";
import { Eye, EyeOff, Globe, KeyRound, LoaderCircle, LockKeyhole } from "../lib/icons";
import { deletePerplexityKey, savePerplexityKey, testPerplexityKey } from "../lib/perplexity";

export function PerplexitySettings({ configured, onConfiguredChange }: { configured: boolean; onConfiguredChange: (configured: boolean) => void }) {
  const [key, setKey] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const latestChange = useRef(onConfiguredChange);
  latestChange.current = onConfiguredChange;
  async function perform(action: "save" | "test" | "remove") {
    if (busy) return;
    setBusy(true); setMessage(""); setFailed(false);
    try {
      if (action === "save") {
        await savePerplexityKey(key.trim());
        setKey(""); setReveal(false); latestChange.current(true);
        setMessage("Key saved securely. Voice can research automatically; select Web in Chat to include online sources.");
      } else if (action === "remove") {
        await deletePerplexityKey();
        setKey(""); setReveal(false); latestChange.current(false);
        setMessage("Perplexity key removed. New requests will use Space context only.");
      } else setMessage(await testPerplexityKey());
    } catch (error) { setFailed(true); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <section className="settings-section" id="web-research" aria-labelledby="web-research-title">
    <div className="settings-section-title"><span className="settings-icon violet"><Globe size={18} /></span>
      <span><h2 id="web-research-title">Web research</h2><p>Bring online sources into your conversation.</p></span></div>
    <div className="setting-card api-key-card">
      <div className="setting-row"><span><strong>Perplexity API key</strong>
        <small>Automatic when useful in voice. In text Chat, you choose when to use Web.</small></span>
        <span className={configured ? "status-pill success" : "status-pill"}>{configured ? "Key saved" : "Not configured"}</span></div>
      <div className="api-key-input-row"><label><KeyRound size={15} /><input type={reveal ? "text" : "password"}
        aria-label="Perplexity API key" placeholder={configured ? "Replace saved key…" : "pplx-…"} value={key}
        onChange={event => setKey(event.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={1024} disabled={busy} />
        <button type="button" aria-label={reveal ? "Hide Perplexity API key" : "Show Perplexity API key"} onClick={() => setReveal(value => !value)}>
          {reveal ? <EyeOff size={15} /> : <Eye size={15} />}</button></label>
        <button className="button primary compact" type="button" disabled={busy || !key.trim()} onClick={() => void perform("save")}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <LockKeyhole size={14} />}Save key</button></div>
      <div className="api-key-actions"><span>Stored in macOS Keychain. Research questions go to Perplexity; API usage applies.</span>
        {configured && <span><button type="button" disabled={busy} onClick={() => void perform("test")}>Test connection</button>
          <button type="button" className="danger-text" disabled={busy} onClick={() => void perform("remove")}>Remove key</button></span>}</div>
      <p className="setting-message">Your selected OpenAI or Anthropic model still handles the conversation. Perplexity supplies cited web research.</p>
      {message && <p className="setting-message" role={failed ? "alert" : "status"}>{message}</p>}
    </div>
  </section>;
}
