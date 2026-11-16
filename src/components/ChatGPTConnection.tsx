import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { Settings } from "../types";
import { chatGPTCommand, isChatGPTModel, manageChatGPTUsage, type ChatGPTModel, type ChatGPTStatus } from "../lib/chatgpt";

export function ChatGPTConnection({ settings, onChange, onModels, credentialsRevision = 0 }: {
  settings: Settings; onChange: (settings: Settings) => void; onModels: (models: ChatGPTModel[]) => void;
  credentialsRevision?: number;
}) {
  const [status, setStatus] = useState<ChatGPTStatus>();
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [message, setMessage] = useState("");
  const [welcome, setWelcome] = useState(false);
  const current = useRef({ settings, onChange, onModels }); current.current = { settings, onChange, onModels };
  const mounted = useRef(true);
  const sequence = useRef(0);
  const statusRef = useRef<ChatGPTStatus | undefined>(undefined);
  const operation = useRef<{ id: number; signIn: boolean } | null>(null);
  const operationSequence = useRef(0);
  function applyStatus(next: ChatGPTStatus) {
    statusRef.current = next;
    setStatus(next);
    if (!next.configured) setWelcome(false);
    const { settings: s, onChange: change } = current.current;
    if (s.chatgptConfigured !== next.configured || s.chatgptAccountId !== (next.activeId ?? "")) change({ ...s, chatgptConfigured: next.configured, chatgptAccountId: next.activeId ?? "" });
  }
  async function refresh(state?: ChatGPTStatus, selectFromModel?: string) {
    const seq = ++sequence.current;
    let statusLoaded = false;
    try {
      const next = state ?? await chatGPTCommand<ChatGPTStatus>("chatgpt_status");
      if (!mounted.current || seq !== sequence.current) return;
      statusLoaded = true;
      applyStatus(next);
      current.current.onModels([]);
      if (!next.configured) return;
      const models = await chatGPTCommand<ChatGPTModel[]>("chatgpt_models");
      if (!mounted.current || seq !== sequence.current) return;
      current.current.onModels(models);
      const latest = current.current.settings;
      const enterPlan = selectFromModel !== undefined && latest.model === selectFromModel && !isChatGPTModel(latest.model);
      if (enterPlan || (isChatGPTModel(latest.model) && !models.some(m => m.id === latest.model))) {
        if (models[0]) current.current.onChange({ ...latest, chatgptConfigured: next.configured, chatgptAccountId: next.activeId ?? "", model: models[0].id });
      }
      if (!models.length) setMessage("This account returned no available ChatGPT plan models. Check access in ChatGPT settings.");
    } catch (error) {
      if (!mounted.current || seq !== sequence.current) return;
      setMessage(error instanceof Error ? error.message : String(error));
      // The credential layer may have cleared a revoked token during the catalog
      // request. Recheck local status without starting another model request.
      if (statusLoaded) {
        try {
          const latest = await chatGPTCommand<ChatGPTStatus>("chatgpt_status");
          if (mounted.current && seq === sequence.current) applyStatus(latest);
        } catch { /* Preserve the actionable catalog error if status is also unavailable. */ }
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    if (isTauri()) void refresh();
    return () => {
      mounted.current = false; sequence.current++;
      if (operation.current?.signIn) void chatGPTCommand("chatgpt_cancel_sign_in").catch(() => undefined);
      operation.current = null;
    };
  }, []);
  useEffect(() => {
    if (credentialsRevision && isTauri()) void refresh();
  }, [credentialsRevision]);
  useEffect(() => {
    if (isTauri() && statusRef.current && ((settings.chatgptAccountId ?? "") !== (statusRef.current.activeId ?? "") || settings.chatgptConfigured !== statusRef.current.configured)) {
      void refresh();
    }
  }, [settings.chatgptAccountId, settings.chatgptConfigured]);
  async function run(work: (active: () => boolean) => Promise<void>, signIn = false) {
    if (operation.current) return;
    const id = ++operationSequence.current;
    operation.current = { id, signIn };
    const active = () => mounted.current && operation.current?.id === id;
    sequence.current++;
    setSigningIn(signIn);
    setBusy(true); setMessage("");
    try { await work(active); } catch (e) { if (active()) setMessage(e instanceof Error ? e.message : String(e)); }
    finally { if (active()) { operation.current = null; setBusy(false); setSigningIn(false); } }
  }
  async function signIn(accountId?: string) {
    const model = current.current.settings.model;
    await run(async active => {
      const next = await chatGPTCommand<ChatGPTStatus>("chatgpt_sign_in", { accountId: accountId ?? null });
      if (!active()) return;
      if (operation.current) operation.current.signIn = false;
      setSigningIn(false);
      setWelcome(next.firstConnection);
      await refresh(next, model);
    }, true);
  }
  async function cancelSignIn() {
    if (!operation.current?.signIn) return;
    const id = ++operationSequence.current;
    operation.current = { id, signIn: false };
    sequence.current++; setSigningIn(false);
    try { await chatGPTCommand("chatgpt_cancel_sign_in"); }
    catch (error) { if (mounted.current && operation.current?.id === id) setMessage(String(error)); }
    finally { if (mounted.current && operation.current?.id === id) { operation.current = null; setBusy(false); await refresh(); } }
  }
  return <div className="setting-card chatgpt-connection">
    <div className="setting-row"><span><strong>Use your ChatGPT plan</strong>
      <small>Connect an eligible ChatGPT account for AI organisation, writing, Chat and dictation cleanup.</small>
    </span><span className={`status-pill${status?.configured ? " success" : ""}`}>{status?.configured ? "Connected" : "Not connected"}</span></div>
    <p className="saved-voice-hint">Uses your available ChatGPT plan allowance or credits. Live voice, narration and image generation use their separate connections.</p>
    {!!status?.accounts.length && <label className="setting-row vertical"><span>ChatGPT account</span><select aria-label="ChatGPT account" disabled={busy} value={status.activeId ?? ""} onChange={e => {
      const accountId = e.target.value;
      const account = status.accounts.find(a => a.id === accountId);
      if (!account?.connected) { void signIn(accountId); return; }
      const model = current.current.settings.model;
      void run(async active => { const next = await chatGPTCommand<ChatGPTStatus>("chatgpt_select_account", { accountId }); if (active()) await refresh(next, model); });
    }}><option value="" disabled>Choose an account</option>{status.accounts.map(a => <option key={a.id} value={a.id}>{a.email}{a.connected ? "" : " · sign in again"}</option>)}</select></label>}
    <div className="saved-voice-actions">
      <button type="button" className="button small chatgpt-sign-in" data-oai-siwc-button disabled={busy || !isTauri()} onClick={() => void signIn(status?.activeId ?? undefined)}>{signingIn ? "Connecting…" : "Continue with ChatGPT"}</button>
      {signingIn && <button type="button" className="button ghost small" onClick={() => void cancelSignIn()}>Cancel sign-in</button>}
      {!!status?.accounts.length && !busy && <button type="button" className="button ghost small" onClick={() => void signIn()}>Add another account</button>}
      {status?.configured && <><button type="button" className="button ghost small" disabled={busy} onClick={() => void run(() => refresh())}>Refresh models</button><button type="button" className="button ghost small" disabled={busy} onClick={() => void run(async active => { const result = await chatGPTCommand<string>("chatgpt_sign_out"); if (!active()) return; await refresh(); if (active()) setMessage(result); })}>Sign out</button></>}
      <button type="button" className="button ghost small" disabled={busy} onClick={() => void run(manageChatGPTUsage)}>Manage usage</button>
    </div>
    {message && <p className="setting-message" role="status">{message}</p>}
    {welcome && <div className="chatgpt-welcome" role="dialog" aria-modal="true" aria-labelledby="chatgpt-welcome-title" onKeyDown={e => { if (e.key === "Tab") { e.preventDefault(); e.currentTarget.querySelector<HTMLButtonElement>("button")?.focus(); } if (e.key === "Escape") { e.preventDefault(); setWelcome(false); } }}><div className="setting-card"><h3 id="chatgpt-welcome-title">You’re using your ChatGPT plan</h3><p>Eligible AI requests in Orion use your ChatGPT plan allowance or available credits. Manage usage and access in ChatGPT settings.</p><button type="button" autoFocus className="button primary small" onClick={() => setWelcome(false)}>Got it</button></div></div>}
  </div>;
}
