import { useContext, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Settings } from "../types";
import { isSelectedAIConfigured, selectedAIProviderName } from "../lib/ai";
import { drawingModelPolicyLabel } from "../lib/illustrationModel";
import { X } from "../lib/icons";
import { artifactFormatNames, ARTIFACT_PRESETS, MAX_ARTIFACT_GUIDANCE, type ArtifactFormat, type VisualArtifact } from "../lib/visualArtifacts";
import { asksForIllustration, generatePassageIllustration, generateVisualArtifact } from "../lib/visualArtifactGeneration";
import { ArtworkReviewNoticeContext } from "./ArtifactPartChatContext";
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
  const [format, setFormat] = useState<ArtifactFormat | "auto" | "illustration">("auto");
  const [guidance, setGuidance] = useState("");
  const [typedSource, setTypedSource] = useState("");
  const notifyReviewFallback = useContext(ArtworkReviewNoticeContext);
  const [review, setReview] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [drawingModel, setDrawingModel] = useState("");
  const [sourceProgress, setSourceProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState(false);
  const titleId = useId();
  const configured = isSelectedAIConfigured(settings);
  const passage = source || typedSource;
  const wantsDrawing = format === "illustration" || ((format === "auto" || format === "explainer") && asksForIllustration(guidance));
  const hasPassage = useMemo(() => /\S/u.test(passage), [passage]);
  const enabled = configured && hasPassage && !busy && !stale;
  // Only two lines are visible in the composer. Keep the full selection in
  // passage for generation without making the browser lay it out a second time.
  const preview = source.length > 320 ? source.slice(0, 320).replace(/[\uD800-\uDBFF]$/u, "") + "…" : source;

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
    setReviewing(false);
    setDrawingModel("");
    setSourceProgress("");
    setBusy(true);
    let fallbackMessage: string | undefined;
    try {
      const onModelSelected = (label: string) => { if (!controller.signal.aborted) setDrawingModel(label); };
      const onSourceProgress = (message: string) => { if (!controller.signal.aborted) setSourceProgress(message); };
      const result = wantsDrawing
        ? await generatePassageIllustration(passage, guidance.trim(), settings, controller.signal, { review,
          onModelSelected, onSourceProgress,
          onReviewStart: () => { if (!controller.signal.aborted) setReviewing(true); },
          onReviewFallback: (message: string) => { fallbackMessage = message; },
        })
        : await generateVisualArtifact(passage, format, guidance.trim(), settings, controller.signal, undefined, undefined, onModelSelected, onSourceProgress);
      if (controller.signal.aborted || request.current !== controller) return;
      if (onInsert(result)) {
        if (fallbackMessage) notifyReviewFallback?.(fallbackMessage);
        close();
      }
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
      {source ? <blockquote aria-label="Selected passage">{preview}</blockquote> : <label>Passage
        <textarea data-initial-focus value={typedSource} rows={3} readOnly={busy || stale}
          onChange={e => setTypedSource(e.target.value)} placeholder="Enter the text to visualise…" /></label>}
      <details className="visualise-formats">
        <summary>{format === "auto" ? "Choose a starting format" : format === "illustration" ? "Draw illustration" : artifactFormatNames[format]}</summary>
        <label>Format
          <select value={format} disabled={busy || stale} onChange={e => { setFormat(e.target.value as typeof format); guidanceInput.current?.focus(); }}>
            <option value="auto">Design for this passage</option>
            <option value="illustration">Draw illustration</option>
            {ARTIFACT_PRESETS.map(value => <option key={value} value={value}>{artifactFormatNames[value]}</option>)}
          </select>
        </label>
      </details>
      <label>Guidance <span>(optional)</span>
        <textarea ref={guidanceInput} data-initial-focus={source ? true : undefined} value={guidance} rows={2} readOnly={busy || stale} maxLength={MAX_ARTIFACT_GUIDANCE}
          placeholder="What should the visual help you see?" onChange={e => setGuidance(e.target.value)} />
      </label>
      {(wantsDrawing || (busy && drawingModel)) && <p className="visualise-model" role="status">Drawing model · {busy && drawingModel ? drawingModel : drawingModelPolicyLabel(settings)}</p>}
      {wantsDrawing && <label className="visualise-review"><input type="checkbox" checked={review} disabled={busy || stale} onChange={event => setReview(event.target.checked)} />
        Have AI review the drawing <span>Sends a rendered preview for a second look.</span></label>}
      {!configured && <p role="status">Connect {selectedAIProviderName(settings)} in Settings to generate an artifact.</p>}
      {busy && sourceProgress && <p role="status">{sourceProgress}</p>}
      {error && <p role="alert">{error}</p>}
      <footer><button className="text-button" type="button" onClick={close}>Cancel</button>
        <button className="visualise-submit" type="submit" disabled={!enabled}>
          {busy ? reviewing ? "Reviewing drawing…" : "Generating…" : format === "auto" && !guidance.trim() ? "Generate for me" : "Generate"}
        </button></footer>
    </form>
  </dialog>;
}
