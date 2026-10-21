import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import type {
  AIWritingAction,
  AIWritingLength,
} from "../lib/aiWriting";
import type { AIImageContextMode, AIImageQuality, ImageGenerationProgress } from "../lib/aiImages";
import {
  Check,
  ChevronDown,
  Image,
  LoaderCircle,
  Link2,
  MessageCircle,
  RefreshCw,
  X,
} from "../lib/icons";

export type AIWritingPhase = "idle" | "generating" | "saving" | "preview" | "error";

export interface AIWritingControlPosition {
  left: number;
  top?: number;
  bottom?: number;
  visible: boolean;
  placement?: "above" | "below";
}

interface AIWritingControlsProps {
  active?: boolean;
  writeComposerOpen?: boolean;
  onCloseWriteComposer?: (restoreFocus?: boolean) => void;
  onComposerActiveChange?: (active: boolean) => void;
  onOpenLink?: () => void;
  onAddComment?: () => void;
  writingUnavailableReason?: string;
  imageUnavailableReason?: string;
  suspended: boolean;
  phase: AIWritingPhase;
  hasSelection: boolean;
  selectionPosition: AIWritingControlPosition;
  dockPosition: AIWritingControlPosition;
  error?: string;
  writingAvailable?: boolean;
  imageGenerationAvailable?: boolean;
  imageContextEnabled?: boolean;
  imageProgress?: ImageGenerationProgress;
  imageContextPartial?: boolean;
  imageContextNotice?: string;
  imageInsertionRetry?: boolean;
  retryAvailable?: boolean;
  operationKind?: "writing" | "image";
  onRequest: (
    action: AIWritingAction,
    length: AIWritingLength,
    instruction: string,
  ) => void;
  onAccept: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  onRequestImage?: (instruction: string, options?: {
    quality: AIImageQuality;
    contextMode: AIImageContextMode;
  }) => void;
}

const REWRITE_ACTIONS: readonly {
  action: Exclude<AIWritingAction, "continue" | "rewrite">;
  label: string;
  description: string;
}[] = [
  {
    action: "clarify",
    label: "Clarify",
    description: "Improve logic and structure without reducing complexity",
  },
  {
    action: "tighten",
    label: "Tighten",
    description: "Make it shorter while preserving meaning",
  },
  {
    action: "simplify",
    label: "Simplify",
    description: "Use easier language and sentence construction",
  },
  {
    action: "expand",
    label: "Expand",
    description: "Develop the thought with relevant explanatory detail",
  },
  {
    action: "enrich",
    label: "Enrich",
    description: "Integrate relevant knowledge from this Space",
  },
];

const CONTINUE_AMOUNTS: readonly {
  value: AIWritingLength;
  label: string;
}[] = [
  { value: "sentence", label: "Sentence" },
  { value: "paragraph", label: "Paragraph" },
  { value: "section", label: "Section" },
];

export function AIWritingControls({
  active = true,
  writeComposerOpen = false,
  onCloseWriteComposer,
  onComposerActiveChange,
  onOpenLink,
  onAddComment,
  writingUnavailableReason = "Add a key for the selected writing provider in Settings to write and rewrite.",
  imageUnavailableReason = "Add an OpenAI key and configure the selected planning provider in Settings to generate images.",
  suspended,
  phase,
  hasSelection,
  selectionPosition,
  dockPosition,
  error,
  writingAvailable = true,
  imageGenerationAvailable = false,
  imageContextEnabled = false,
  imageProgress,
  imageContextPartial = false,
  imageContextNotice,
  imageInsertionRetry = false,
  retryAvailable = true,
  operationKind = "writing",
  onRequest,
  onAccept,
  onRetry,
  onDiscard,
  onRequestImage,
}: AIWritingControlsProps) {
  const [selectionPanel, setSelectionPanel] = useState<
    "rewrite" | "image" | "menu" | null
  >(null);
  useEffect(() => {
    onComposerActiveChange?.(selectionPanel !== null);
    return () => onComposerActiveChange?.(false);
  }, [selectionPanel, onComposerActiveChange]);
  const [unavailableNotice, setUnavailableNotice] = useState<string>();
  const [continueLength, setContinueLength] =
    useState<AIWritingLength>("paragraph");
  const [continueInstruction, setContinueInstruction] = useState("");
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [imageInstruction, setImageInstruction] = useState("");
  const [imageQuality, setImageQuality] = useState<AIImageQuality>("detailed");
  const [imageContextMode, setImageContextMode] = useState<AIImageContextMode>(
    imageContextEnabled ? "space" : "selection",
  );
  const imageOptionsId = useId();
  const imageComposerRef = useRef<HTMLFormElement>(null);
  const [imagePanelTop, setImagePanelTop] = useState<number>();
  const rewriteInputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLTextAreaElement>(null);
  const continueAmountRef = useRef<HTMLInputElement>(null);
  const writeComposerRef = useRef<HTMLFormElement>(null);
  const rewriteMainRef = useRef<HTMLButtonElement>(null);
  const rewriteToggleRef = useRef<HTMLButtonElement>(null);
  const imageButtonRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setImageContextMode(imageContextEnabled ? "space" : "selection");
  }, [imageContextEnabled]);

  useLayoutEffect(() => {
    if (selectionPanel !== "image" || !imageComposerRef.current) {
      setImagePanelTop(undefined);
      return;
    }
    const position = () => {
      const height = imageComposerRef.current?.getBoundingClientRect().height ?? 0;
      const anchor = selectionPosition.top ?? 16;
      const desired = selectionPosition.placement === "below" ? anchor : anchor - height;
      setImagePanelTop(Math.max(16, Math.min(desired, window.innerHeight - height - 16)));
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [selectionPanel, selectionPosition.top, selectionPosition.placement]);

  useEffect(() => {
    if (!active || suspended || phase !== "idle") {
      setSelectionPanel(null);
      setUnavailableNotice(undefined);
    }
    if (!active) {
      setContinueLength("paragraph");
      setContinueInstruction("");
      setRewriteInstruction("");
      setImageInstruction("");
      setImageQuality("detailed");
      setImageContextMode(imageContextEnabled ? "space" : "selection");
    }
  }, [active, phase, suspended, imageContextEnabled]);

  useEffect(() => {
    setSelectionPanel(null);
    setUnavailableNotice(undefined);
  }, [hasSelection]);

  useEffect(() => {
    if (!writeComposerOpen) return;
    setSelectionPanel(null);
    setUnavailableNotice(undefined);
  }, [writeComposerOpen]);

  useEffect(() => {
    if (selectionPanel !== "rewrite") return;
    const frame = window.requestAnimationFrame(() =>
      rewriteInputRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [selectionPanel]);

  useEffect(() => {
    if (selectionPanel !== "image") return;
    const frame = window.requestAnimationFrame(() =>
      imageInputRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [selectionPanel]);

  useEffect(() => {
    if (!writeComposerOpen || suspended || phase !== "idle") return;
    const frame = window.requestAnimationFrame(() =>
      continueAmountRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [writeComposerOpen, suspended, phase]);

  useEffect(() => {
    if (!writeComposerOpen || suspended || phase !== "idle") return;
    const dismiss = (event: PointerEvent) => {
      if (!writeComposerRef.current?.contains(event.target as Node)) {
        onCloseWriteComposer?.(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [writeComposerOpen, suspended, phase, onCloseWriteComposer]);

  useEffect(() => {
    if (selectionPanel !== "menu") return;
    const frame = window.requestAnimationFrame(() =>
      actionMenuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [selectionPanel]);

  useEffect(() => {
    if (!active || suspended || phase === "idle") return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onDiscard();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [active, onDiscard, phase, suspended]);

  if (!active || suspended) return null;

  const selectionStyle: CSSProperties = {
    ...positionStyle(selectionPosition),
    ...(selectionPanel === "image" && imagePanelTop !== undefined
      ? { top: imagePanelTop, bottom: undefined, transform: "translate(-50%, 0)" } : {}),
  };
  const dockStyle = positionStyle(dockPosition);
  const showSelectionControl =
    phase === "idle" && !writeComposerOpen && hasSelection && selectionPosition.visible;
  const showDock =
    dockPosition.visible &&
    (phase !== "idle" || writeComposerOpen);
  const continueAmountIndex = Math.max(
    0,
    CONTINUE_AMOUNTS.findIndex((item) => item.value === continueLength),
  );
  const continueAmountLabel = CONTINUE_AMOUNTS[continueAmountIndex].label;

  function preserveEditorSelection(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
  }

  function startRequest(
    action: AIWritingAction,
    length: AIWritingLength,
    instruction: string,
  ) {
    if (!writingAvailable) {
      setUnavailableNotice(writingUnavailableReason);
      return;
    }
    setSelectionPanel(null);
    setUnavailableNotice(undefined);
    setContinueInstruction("");
    setRewriteInstruction("");
    onRequest(action, length, instruction.trim());
    if (writeComposerOpen) onCloseWriteComposer?.(false);
  }

  function startImageRequest() {
    if (!imageGenerationAvailable) {
      setUnavailableNotice(imageUnavailableReason);
      return;
    }
    const instruction = imageInstruction.trim();
    setSelectionPanel(null);
    setImageInstruction("");
    onRequestImage?.(instruction, { quality: imageQuality, contextMode: imageContextMode });
  }

  function closeSelectionPanel(returnFocus: "main" | "toggle") {
    setSelectionPanel(null);
    window.requestAnimationFrame(() =>
      (returnFocus === "main"
        ? rewriteMainRef.current
        : rewriteToggleRef.current
      )?.focus({ preventScroll: true }),
    );
  }

  function closeImagePanel() {
    setSelectionPanel(null);
    window.requestAnimationFrame(() =>
      imageButtonRef.current?.focus({ preventScroll: true }),
    );
  }

  function closeWriteComposer() {
    setUnavailableNotice(undefined);
    onCloseWriteComposer?.(true);
  }

  return (
    <>
      {showSelectionControl ? (
        <div
          className={`ai-writing-selection${
            selectionPosition.placement === "below" ? " is-below" : ""
          }${selectionPanel ? " is-open" : ""}`}
          style={selectionStyle}
          data-testid="ai-writing-selection-control"
          role="group"
          aria-label="Actions for selected text"
        >
          {selectionPanel === "rewrite" ? (
            <form
              className="ai-writing-selection-composer"
              role="dialog"
              aria-label="Rewrite selected text"
              onSubmit={(event) => {
                event.preventDefault();
                startRequest("rewrite", "paragraph", rewriteInstruction);
              }}
            >
              <label htmlFor="ai-writing-rewrite-instruction">
                <span>Rewrite direction</span>
                <small>Optional</small>
              </label>
              <textarea
                ref={rewriteInputRef}
                id="ai-writing-rewrite-instruction"
                value={rewriteInstruction}
                maxLength={1_250}
                rows={2}
                placeholder="Leave blank for Orion’s best rewrite…"
                onChange={(event) => setRewriteInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeSelectionPanel("main");
                  }
                }}
              />
              <div>
                <button
                  type="button"
                  className="ai-writing-text-button"
                  onClick={() => closeSelectionPanel("main")}
                >
                  Cancel
                </button>
                <button type="submit" className="ai-writing-primary-button">
                  Rewrite
                </button>
              </div>
            </form>
          ) : selectionPanel === "image" ? (
            <form
              ref={imageComposerRef}
              className="ai-writing-selection-composer ai-image-composer"
              role="dialog"
              aria-label="Generate image from selected text"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  closeImagePanel();
                }
              }}
              onSubmit={(event) => {
                event.preventDefault();
                startImageRequest();
              }}
            >
              <fieldset className="ai-image-options">
                <legend>Generation</legend>
                <div className="ai-image-options__segments">
                  {([ ["fast", "Fast"], ["detailed", "Detailed"] ] as const).map(([value, label]) => (
                    <label key={value}>
                      <input type="radio" name={`${imageOptionsId}-quality`} value={value}
                        checked={imageQuality === value} onChange={() => setImageQuality(value)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="ai-image-options">
                <legend>Context</legend>
                <div className="ai-image-options__segments">
                  {([ ["selection", "Selection only"], ["space", "Related Space"] ] as const).map(([value, label]) => (
                    <label key={value}>
                      <input type="radio" name={`${imageOptionsId}-context`} value={value}
                        checked={imageContextMode === value} onChange={() => setImageContextMode(value)} />
                      <span>{label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <p className="ai-image-composer__scope">
                {imageContextMode === "space"
                  ? "Use this passage and relevant notes and sources from this Space for this image."
                  : "Use only the highlighted text and your image direction."}
              </p>
              <label htmlFor="ai-writing-image-instruction">
                <span>Image direction</span>
                <small>Optional</small>
              </label>
              <textarea
                ref={imageInputRef}
                id="ai-writing-image-instruction"
                value={imageInstruction}
                maxLength={1_250}
                rows={2}
                placeholder="Leave blank for Orion’s visual interpretation…"
                onChange={(event) => setImageInstruction(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeImagePanel();
                  }
                }}
              />
              <p className="ai-image-composer__help">Fast prioritizes speed; Detailed prioritizes image quality.</p>
              <div>
                <button
                  type="button"
                  className="ai-writing-text-button"
                  onClick={closeImagePanel}
                >
                  Cancel
                </button>
                <button type="submit" className="ai-writing-primary-button">
                  Generate
                </button>
              </div>
            </form>
          ) : selectionPanel === "menu" ? (
            <div
              ref={actionMenuRef}
              className="ai-writing-action-menu"
              role="menu"
              aria-label="Rewrite actions"
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeSelectionPanel("toggle");
                  return;
                }
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                    event.key,
                  )
                ) return;
                const items = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    '[role="menuitem"]',
                  ),
                ];
                if (items.length === 0) return;
                const currentIndex = Math.max(
                  0,
                  items.indexOf(document.activeElement as HTMLButtonElement),
                );
                const nextIndex =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : event.key === "ArrowUp"
                        ? (currentIndex - 1 + items.length) % items.length
                        : (currentIndex + 1) % items.length;
                event.preventDefault();
                items[nextIndex].focus({ preventScroll: true });
              }}
            >
              {REWRITE_ACTIONS.map((item) => (
                <button
                  key={item.action}
                  type="button"
                  role="menuitem"
                  onMouseDown={preserveEditorSelection}
                  onClick={() =>
                    startRequest(item.action, "paragraph", "")
                  }
                >
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
          ) : (
            <div className="ai-writing-selection-actions">
              <div className="ai-writing-split-button">
                <button
                  ref={rewriteMainRef}
                  type="button"
                  className="ai-writing-split-button__main"
                  aria-haspopup={writingAvailable ? "dialog" : undefined}
                  aria-disabled={!writingAvailable}
                  title={writingAvailable ? "Rewrite selected text" : writingUnavailableReason}
                  onMouseDown={preserveEditorSelection}
                  onClick={() => {
                    if (!writingAvailable) setUnavailableNotice(writingUnavailableReason);
                    else { setUnavailableNotice(undefined); setSelectionPanel("rewrite"); }
                  }}
                >
                  Rewrite
                </button>
                {writingAvailable ? <button
                  ref={rewriteToggleRef}
                  type="button"
                  className="ai-writing-split-button__toggle"
                  aria-label="Choose rewrite action"
                  aria-haspopup="menu"
                  aria-expanded={false}
                  onMouseDown={preserveEditorSelection}
                  onClick={() => { setUnavailableNotice(undefined); setSelectionPanel("menu"); }}
                >
                  <ChevronDown size={13} />
                </button> : null}
              </div>
              <button
                ref={imageButtonRef}
                type="button"
                className="ai-writing-image-button"
                aria-label="Generate image from selected text"
                aria-disabled={!imageGenerationAvailable}
                title={imageGenerationAvailable ? "Generate an image from this passage and its Space context" : imageUnavailableReason}
                onMouseDown={preserveEditorSelection}
                onClick={() => {
                  if (!imageGenerationAvailable) setUnavailableNotice(imageUnavailableReason);
                  else { setUnavailableNotice(undefined); setSelectionPanel("image"); }
                }}
              >
                <Image size={13} />
                <span>Generate image</span>
              </button>
              <button type="button" className="ai-writing-link-button" title="Link selected text"
                aria-label="Link selected text" onMouseDown={preserveEditorSelection}
                onClick={() => { setUnavailableNotice(undefined); onOpenLink?.(); }}>
                <Link2 size={13} /><span>Link</span>
              </button>
              {onAddComment && <button type="button" className="ai-writing-link-button" aria-label="Comment on selected text"
                onMouseDown={preserveEditorSelection} onClick={() => { setUnavailableNotice(undefined); onAddComment(); }}>
                <MessageCircle size={13} /><span>Comment</span>
              </button>}
            </div>
          )}
          {unavailableNotice ? <p className="ai-writing-unavailable-notice" role="status">{unavailableNotice}</p> : null}
        </div>
      ) : null}

      {showDock ? (
        <div
          className={`ai-writing-dock is-${phase}`}
          style={dockStyle}
          role={
            phase === "generating" || phase === "saving" ? "status" : undefined
          }
          aria-live={phase === "error" ? "assertive" : "polite"}
          data-testid="ai-writing-dock"
        >
          {phase === "idle" ? (
            <form
              ref={writeComposerRef}
              className="ai-writing-continue-composer ai-writing-write-composer"
              role="dialog"
              aria-label="Write with AI"
              onSubmit={(event) => {
                event.preventDefault();
                startRequest("continue", continueLength, continueInstruction);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                closeWriteComposer();
              }}
            >
              <div className="ai-writing-amount-control">
                <div className="ai-writing-amount-control__heading">
                  <label htmlFor="ai-writing-continue-amount">Amount of text</label>
                  <output htmlFor="ai-writing-continue-amount">{continueAmountLabel}</output>
                </div>
                <input
                  ref={continueAmountRef}
                  id="ai-writing-continue-amount"
                  type="range"
                  min={0}
                  max={CONTINUE_AMOUNTS.length - 1}
                  step={1}
                  value={continueAmountIndex}
                  aria-valuetext={continueAmountLabel}
                  onChange={(event) => {
                    const amount = CONTINUE_AMOUNTS[Number(event.target.value)];
                    if (amount) setContinueLength(amount.value);
                  }}
                />
                <div className="ai-writing-amount-control__scale" aria-hidden="true">
                  <span>Less</span><span>More</span>
                </div>
              </div>
              <label htmlFor="ai-writing-continue-instruction">
                <span>Custom instructions</span><small>Optional</small>
              </label>
              <textarea
                id="ai-writing-continue-instruction"
                value={continueInstruction}
                maxLength={1_250}
                rows={2}
                placeholder="Leave blank to write from your cursor…"
                onChange={(event) => setContinueInstruction(event.target.value)}
              />
              {!writingAvailable ? <p className="ai-writing-unavailable-notice" role="status">{writingUnavailableReason}</p> : null}
              <div className="ai-writing-write-composer__actions">
                <button type="button" className="ai-writing-text-button" onClick={closeWriteComposer}>Cancel</button>
                <button type="submit" className="ai-writing-primary-button" disabled={!writingAvailable}>Write</button>
              </div>
            </form>
          ) : phase === "generating" || phase === "saving" ? (
            <div className="ai-writing-dock__state">
              <LoaderCircle className="ai-writing-spinner" size={14} />
              <span className="ai-writing-dock__progress">
                {phase === "saving"
                  ? operationKind === "image" ? "Adding image…" : "Accepting…"
                  : operationKind === "image"
                    ? <>{imageProgress?.message ?? "Preparing image…"}{imageProgress?.stage === "read" && imageProgress.totalBranches
                      ? ` · ${imageProgress.completedBranches ?? 0} of ${imageProgress.totalBranches}` : ""}</>
                    : "Writing…"}
              </span>
              {phase === "generating" ? (
                <button
                  type="button"
                  aria-label={
                    operationKind === "image"
                      ? "Cancel image generation"
                      : "Cancel AI writing"
                  }
                  title="Cancel"
                  onClick={onDiscard}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          ) : phase === "preview" ? (
            <>
            {operationKind === "image" && (imageContextPartial || imageContextNotice) ? (
              <p className="ai-writing-dock__notice">{imageContextNotice ?? "Some context could not be read. This image uses the available passages."}</p>
            ) : null}
            <div
              className="ai-writing-dock__state ai-writing-dock__preview-actions"
              role="group"
              aria-label={
                operationKind === "image"
                  ? "Review generated image"
                  : "Review AI writing"
              }
            >
              <button
                type="button"
                className="accept"
                aria-label={
                  operationKind === "image"
                    ? "Insert generated image"
                    : "Accept AI writing"
                }
                title="Accept"
                onClick={onAccept}
              >
                <Check size={15} />
              </button>
              {retryAvailable ? <button
                type="button"
                aria-label={
                  operationKind === "image"
                    ? "Generate image again"
                    : "Try AI writing again"
                }
                title="Try again"
                onClick={onRetry}
              >
                <RefreshCw size={14} />
              </button> : null}
              <button
                type="button"
                className="discard"
                aria-label={
                  operationKind === "image"
                    ? "Discard generated image"
                    : "Discard AI writing"
                }
                title="Discard"
                onClick={onDiscard}
              >
                <X size={14} />
              </button>
            </div>
            </>
          ) : (
            <>
              <p className="ai-writing-dock__error">{error}{!retryAvailable ? " Ask your assistant to capture this passage again and start a new request." : ""}</p>
              <div
                className="ai-writing-dock__state ai-writing-dock__preview-actions"
                role="group"
                aria-label="AI writing error"
              >
                {retryAvailable ? <button
                  type="button"
                  aria-label={
                  operationKind === "image"
                    ? imageInsertionRetry ? "Restore generated image preview" : "Retry image generation"
                    : "Try AI writing again"
                }
                  title="Try again"
                  onClick={onRetry}
                >
                  <RefreshCw size={14} />
                </button> : null}
                <button
                  type="button"
                  className="discard"
                  aria-label={
                  operationKind === "image"
                    ? "Dismiss image generation error"
                    : "Dismiss AI writing error"
                }
                  title="Dismiss"
                  onClick={onDiscard}
                >
                  <X size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

function positionStyle(position: AIWritingControlPosition): CSSProperties {
  return {
    left: `${position.left}px`,
    ...(typeof position.top === "number" ? { top: `${position.top}px` } : {}),
    ...(typeof position.bottom === "number"
      ? { bottom: `${position.bottom}px` }
      : {}),
  };
}
