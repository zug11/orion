import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Settings } from "../types";
import { isSelectedAIConfigured, selectedAIProviderName } from "../lib/ai";
import { X } from "../lib/icons";
import { ARTIFACT_FORMATS, MAX_ARTIFACT_SOURCE, MAX_ARTIFACT_GUIDANCE, type ArtifactFormat, type VisualArtifact } from "../lib/visualArtifacts";
import { generateVisualArtifact } from "../lib/visualArtifactGeneration";
import "./VisualiseComposer.css";

export interface VisualiseAnchor { left: number; top: number; bottom: number }
interface Props {
  source: string;
  settings: Settings;
  anchor?: VisualiseAnchor;
  onInsert: (artifact: VisualArtifact) => boolean;
  onClose: () => void;
}

export function VisualiseComposer({ source, settings, anchor, onInsert, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const guidanceInput = useRef<HTMLTextAreaElement>(null);
  const request = useRef<AbortController | null>(null);
  const [format, setFormat] = useState<ArtifactFormat | "auto">("auto");
  const [guidance, setGuidance] = useState("");
  const [typedSource, setTypedSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const titleId = useId();
  const configured = isSelectedAIConfigured(settings);
  const passage = source || typedSource;
  const tooLong = passage.length > MAX_ARTIFACT_SOURCE;
  const enabled = configured && !!passage.trim() && !tooLong && !busy && !stale;

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    element.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
    return () => { element.close(); };
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element || !anchor) return;
    const place = () => {
      const edge = 12;
      const maxLeft = window.innerWidth - element.offsetWidth - edge;
      const maxTop = window.innerHeight - element.offsetHeight - edge;
      const below = anchor.bottom + 8;
      const top = below <= maxTop ? below : anchor.top - element.offsetHeight - 8;
      element.style.left = Math.max(edge, Math.min(anchor.left, maxLeft)) + "px";
      element.style.top = Math.max(edge, Math.min(top, maxTop)) + "px";
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [anchor]);

  useLayoutEffect(() => {
    setBusy(false);
    return () => { request.current?.abort(); request.current = null; };
  }, [source, settings.model, settings.chatgptAccountId, configured]);

  function close() {
    request.current?.abort();
    request.current = null;
    onClose();
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!enabled || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setError("");
    setBusy(true);
    try {
      const result = await generateVisualArtifact(passage, format, guidance.trim(), settings, controller.signal);
      if (controller.signal.aborted || request.current !== controller) return;
      if (onInsert(result)) close();
      else {
        setStale(true);
        setError("The note changed. Close this window and select the passage again.");
      }
    } catch (cause) {
      if (!controller.signal.aborted && request.current === controller) {
        setError(cause instanceof Error ? cause.message : "Generation failed. Try again.");
      }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }

  return <dialog ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} className="visualise-composer"
    data-anchored={anchor ? true : undefined} onCancel={event => { event.preventDefault(); close(); }}>
    <form onSubmit={submit} onKeyDown={event => {
      if (event.key !== "Enter" || event.nativeEvent.isComposing || event.shiftKey) return;
      if (!event.metaKey && !event.ctrlKey && event.target !== guidanceInput.current) return;
      event.preventDefault();
      if (!event.repeat && enabled) event.currentTarget.requestSubmit();
    }}>
      <header><h2 id={titleId}>Visualise</h2><button type="button" className="icon-button" aria-label="Close Visualise" onClick={close}><X size={16} /></button></header>
      {source ? <blockquote aria-label="Selected passage">{source}</blockquote> : <label>Passage
        <textarea data-initial-focus value={typedSource} rows={3} readOnly={busy || stale} maxLength={MAX_ARTIFACT_SOURCE}
          onChange={e => setTypedSource(e.target.value)} placeholder="Enter the text to visualise…" /></label>}
      <label>Format
        <select value={format} data-initial-focus={source ? true : undefined} disabled={busy || stale} onChange={e => { setFormat(e.target.value as typeof format); guidanceInput.current?.focus(); }}>
          <option value="auto">Let Orion choose</option>
          {ARTIFACT_FORMATS.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}
        </select>
      </label>
      <label>Guidance <span>(optional)</span>
        <textarea ref={guidanceInput} value={guidance} rows={2} readOnly={busy || stale} maxLength={MAX_ARTIFACT_GUIDANCE}
          placeholder="What should the visual help you see?" onChange={e => setGuidance(e.target.value)} />
      </label>
      {!configured && <p role="status">Connect {selectedAIProviderName(settings)} in Settings to generate an artifact.</p>}
      {tooLong && <p role="alert">Select a passage of 12,000 characters or fewer.</p>}
      {error && <p role="alert">{error}</p>}
      <footer><button className="text-button" type="button" onClick={close}>Cancel</button>
        <button className="visualise-submit" type="submit" disabled={!enabled}>
          {busy ? "Generating…" : format === "auto" && !guidance.trim() ? "Generate for me" : "Generate"}
        </button></footer>
    </form>
  </dialog>;
}
