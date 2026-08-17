import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import type {
  AIWritingAction,
  AIWritingLength,
} from "../lib/aiWriting";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Image,
  LoaderCircle,
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
  active: boolean;
  suspended: boolean;
  phase: AIWritingPhase;
  hasSelection: boolean;
  selectionPosition: AIWritingControlPosition;
  dockPosition: AIWritingControlPosition;
  error?: string;
  writingAvailable?: boolean;
  imageGenerationAvailable?: boolean;
  operationKind?: "writing" | "image";
  onRequest: (
    action: AIWritingAction,
    length: AIWritingLength,
    instruction: string,
  ) => void;
  onAccept: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  onRequestImage?: (instruction: string) => void;
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
  active,
  suspended,
  phase,
  hasSelection,
  selectionPosition,
  dockPosition,
  error,
  writingAvailable = true,
  imageGenerationAvailable = false,
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
  const [continuePanelOpen, setContinuePanelOpen] = useState(false);
  const [continueLength, setContinueLength] =
    useState<AIWritingLength>("paragraph");
  const [continueInstruction, setContinueInstruction] = useState("");
  const [rewriteInstruction, setRewriteInstruction] = useState("");
  const [imageInstruction, setImageInstruction] = useState("");
  const rewriteInputRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLTextAreaElement>(null);
  const continueAmountRef = useRef<HTMLInputElement>(null);
  const rewriteMainRef = useRef<HTMLButtonElement>(null);
  const rewriteToggleRef = useRef<HTMLButtonElement>(null);
  const imageButtonRef = useRef<HTMLButtonElement>(null);
  const continueToggleRef = useRef<HTMLButtonElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!active || suspended || phase !== "idle") {
      setSelectionPanel(null);
      setContinuePanelOpen(false);
    }
    if (!active) {
      setContinueLength("paragraph");
      setContinueInstruction("");
      setRewriteInstruction("");
      setImageInstruction("");
    }
  }, [active, phase, suspended]);

  useEffect(() => {
    setSelectionPanel(null);
    setContinuePanelOpen(false);
  }, [hasSelection]);

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
    if (!continuePanelOpen) return;
    const frame = window.requestAnimationFrame(() =>
      continueAmountRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [continuePanelOpen]);

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

  const selectionStyle = positionStyle(selectionPosition);
  const dockStyle = positionStyle(dockPosition);
  const showSelectionControl =
    phase === "idle" && hasSelection && selectionPosition.visible;
  const showDock =
    dockPosition.visible &&
    (phase !== "idle" || (!hasSelection && writingAvailable));
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
    setSelectionPanel(null);
    setContinuePanelOpen(false);
    setContinueInstruction("");
    setRewriteInstruction("");
    onRequest(action, length, instruction.trim());
  }

  function startImageRequest() {
    const instruction = imageInstruction.trim();
    setSelectionPanel(null);
    setImageInstruction("");
    onRequestImage?.(instruction);
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

  function closeContinuePanel() {
    setContinuePanelOpen(false);
    window.requestAnimationFrame(() =>
      continueToggleRef.current?.focus({ preventScroll: true }),
    );
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
              className="ai-writing-selection-composer"
              role="dialog"
              aria-label="Generate image from selected text"
              onSubmit={(event) => {
                event.preventDefault();
                startImageRequest();
              }}
            >
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
              {writingAvailable ? (
                <div className="ai-writing-split-button">
                  <button
                    ref={rewriteMainRef}
                    type="button"
                    className="ai-writing-split-button__main"
                    aria-haspopup="dialog"
                    onMouseDown={preserveEditorSelection}
                    onClick={() => setSelectionPanel("rewrite")}
                  >
                    Rewrite
                  </button>
                  <button
                    ref={rewriteToggleRef}
                    type="button"
                    className="ai-writing-split-button__toggle"
                    aria-label="Choose rewrite action"
                    aria-haspopup="menu"
                    aria-expanded={false}
                    onMouseDown={preserveEditorSelection}
                    onClick={() => setSelectionPanel("menu")}
                  >
                    <ChevronDown size={13} />
                  </button>
                </div>
              ) : null}
              {imageGenerationAvailable ? (
                <button
                  ref={imageButtonRef}
                  type="button"
                  className="ai-writing-image-button"
                  aria-label="Generate image from selected text"
                  title="Generate image"
                  onMouseDown={preserveEditorSelection}
                  onClick={() => setSelectionPanel("image")}
                >
                  <Image size={13} />
                  <span>Generate image</span>
                </button>
              ) : null}
            </div>
          )}
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
            <>
              {continuePanelOpen ? (
                <div
                  className="ai-writing-continue-composer"
                  role="dialog"
                  aria-label="Continue writing options"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeContinuePanel();
                  }}
                >
                  <div className="ai-writing-amount-control">
                    <div className="ai-writing-amount-control__heading">
                      <label htmlFor="ai-writing-continue-amount">
                        Amount of text
                      </label>
                      <output htmlFor="ai-writing-continue-amount">
                        {continueAmountLabel}
                      </output>
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
                        const amount =
                          CONTINUE_AMOUNTS[Number(event.target.value)];
                        if (amount) setContinueLength(amount.value);
                      }}
                    />
                    <div
                      className="ai-writing-amount-control__scale"
                      aria-hidden="true"
                    >
                      <span>Less</span>
                      <span>More</span>
                    </div>
                  </div>
                  <label htmlFor="ai-writing-continue-instruction">
                    <span>Custom instructions</span>
                    <small>Optional</small>
                  </label>
                  <textarea
                    id="ai-writing-continue-instruction"
                    value={continueInstruction}
                    maxLength={1_250}
                    rows={2}
                    placeholder="Add a direction for what comes next…"
                    onChange={(event) =>
                      setContinueInstruction(event.target.value)
                    }
                  />
                </div>
              ) : null}
              <div className="ai-writing-split-button">
                <button
                  type="button"
                  className="ai-writing-split-button__main"
                  onMouseDown={preserveEditorSelection}
                  onClick={() =>
                    startRequest(
                      "continue",
                      continueLength,
                      continueInstruction,
                    )
                  }
                >
                  Continue
                </button>
                <button
                  ref={continueToggleRef}
                  type="button"
                  className="ai-writing-split-button__toggle"
                  aria-label="Continue writing options"
                  aria-haspopup="dialog"
                  aria-expanded={continuePanelOpen}
                  onMouseDown={preserveEditorSelection}
                  onClick={() => {
                    if (continuePanelOpen) {
                      closeContinuePanel();
                    } else {
                      setContinuePanelOpen(true);
                    }
                  }}
                >
                  <ChevronUp size={13} />
                </button>
              </div>
            </>
          ) : phase === "generating" || phase === "saving" ? (
            <div className="ai-writing-dock__state">
              <LoaderCircle className="ai-writing-spinner" size={14} />
              <span>
                {phase === "saving"
                  ? "Adding image…"
                  : operationKind === "image"
                    ? "Creating image…"
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
              <button
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
              </button>
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
          ) : (
            <>
              <p className="ai-writing-dock__error">{error}</p>
              <div
                className="ai-writing-dock__state ai-writing-dock__preview-actions"
                role="group"
                aria-label="AI writing error"
              >
                <button
                  type="button"
                  aria-label={
                  operationKind === "image" ? "Generate image again" : "Try AI writing again"
                }
                  title="Try again"
                  onClick={onRetry}
                >
                  <RefreshCw size={14} />
                </button>
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
