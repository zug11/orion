import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { RotateCcw } from "../../lib/icons";
import { applyNoteMargins, captureMarginTarget, finishMarginAdjustment, getNoteMargins, restoreMarginSelection, type MarginTarget } from "./NoteMargins";
import { marginFromRulerPointer, marginRulerPosition, measureMarginRuler, type MarginRulerGeometry } from "./marginRulerGeometry";
import "./MarginsControl.css";

type MarginSide = "left" | "right";
interface MarginGesture {
  target: MarginTarget;
  geometry: MarginRulerGeometry;
  side: MarginSide;
  kind: "pointer" | "keyboard";
  stop?: () => void;
}
const adjustmentKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);
const ticks = Array.from({ length: 51 }, (_, index) => index * 2);

/** A persistent ruler follows selection, but each gesture keeps its own target. */
export function MarginsControl({ editor, disabled = false, onClose }: {
  editor: Editor;
  disabled?: boolean;
  onClose: () => void;
}) {
  const rulerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const scopeId = useId();
  const gestureRef = useRef<MarginGesture | null>(null);
  const [margins, setMargins] = useState(() => getNoteMargins(editor));
  const [geometry, setGeometry] = useState<MarginRulerGeometry | null>(null);
  const [offset, setOffset] = useState(0);
  const [activeSide, setActiveSide] = useState<MarginSide | null>(null);
  const [hoveredSide, setHoveredSide] = useState<MarginSide | null>(null);
  const [focusedSide, setFocusedSide] = useState<MarginSide | null>(null);

  const refresh = useCallback(() => {
    if (editor.isDestroyed) return;
    const gesture = gestureRef.current;
    setMargins(getNoteMargins(editor, gesture?.target));
    const next = gesture?.geometry ?? measureMarginRuler(editor);
    setGeometry(next);
    setOffset(next && rulerRef.current ? next.left - rulerRef.current.getBoundingClientRect().left : 0);
  }, [editor]);

  const finish = useCallback((restore: boolean) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.stop?.();
    if (restore) restoreMarginSelection(editor, gesture.target);
    finishMarginAdjustment(editor, gesture.target);
    setActiveSide(null);
    refresh();
  }, [editor, refresh]);

  useLayoutEffect(() => {
    refresh();
    editor.on("transaction", refresh);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    resize?.observe(editor.view.dom);
    if (rulerRef.current) resize?.observe(rulerRef.current);
    // Vertical scrolling changes only the native glass's viewport position.
    // Avoid reparsing the selection and rerendering every tick on that path;
    // horizontal scrolling still needs fresh text-edge coordinates.
    const scrollOffsets = new WeakMap<EventTarget, number>();
    const refreshHorizontalScroll = (event: Event) => {
      const target = event.target ?? window;
      const scrollLeft = target instanceof Element ? target.scrollLeft : window.scrollX;
      if (scrollOffsets.get(target) === scrollLeft) return;
      scrollOffsets.set(target, scrollLeft);
      refresh();
    };
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refreshHorizontalScroll, true);
    return () => {
      editor.off("transaction", refresh);
      resize?.disconnect();
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refreshHorizontalScroll, true);
      const gesture = gestureRef.current;
      gestureRef.current = null;
      gesture?.stop?.();
      if (gesture) finishMarginAdjustment(editor, gesture.target);
    };
  }, [editor, refresh]);

  useEffect(() => { if (disabled) finish(false); }, [disabled, finish]);

  const begin = (side: MarginSide, kind: MarginGesture["kind"]) => {
    if (disabled || editor.isDestroyed || !editor.isEditable) return null;
    finish(false);
    const target = captureMarginTarget(editor);
    const bounds = measureMarginRuler(editor, target);
    if (!target.available || !bounds) { finishMarginAdjustment(editor, target); return null; }
    const gesture: MarginGesture = { target, geometry: bounds, side, kind };
    gestureRef.current = gesture;
    setActiveSide(side);
    refresh();
    return gesture;
  };

  const startDrag = (event: ReactPointerEvent<HTMLButtonElement>, side: MarginSide) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const gesture = begin(side, "pointer");
    if (!gesture) return;
    const pointerId = event.pointerId;
    const handle = event.currentTarget;
    const current = getNoteMargins(editor, gesture.target)[side] ?? undefined;
    const grabOffset = event.clientX - gesture.geometry.left - marginRulerPosition(gesture.geometry, side, current);
    const move = (pointer: PointerEvent) => {
      if (pointer.pointerId !== pointerId || gestureRef.current !== gesture) return;
      pointer.preventDefault();
      const value = marginFromRulerPointer(gesture.geometry, side, pointer.clientX - grabOffset);
      if (!applyNoteMargins(editor, gesture.target, { [side]: value })) finish(false);
    };
    const end = (pointer: PointerEvent) => { if (pointer.pointerId === pointerId) finish(true); };
    const cancel = () => finish(false);
    const key = (keyboard: globalThis.KeyboardEvent) => {
      if (keyboard.key !== "Escape") return;
      keyboard.preventDefault(); keyboard.stopPropagation(); finish(true);
    };
    gesture.stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
      handle.removeEventListener("lostpointercapture", cancel);
      try { if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId); } catch { /* Native capture may already have ended. */ }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    handle.addEventListener("lostpointercapture", cancel);
    try { handle.setPointerCapture?.(pointerId); } catch { /* Window listeners also support WebViews without pointer capture. */ }
  };

  const adjustWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, side: MarginSide) => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      if (gestureRef.current) finish(true);
      else { editor.commands.focus(); onClose(); }
      return;
    }
    if (!adjustmentKeys.has(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    let gesture = gestureRef.current;
    if (gesture?.kind !== "keyboard" || gesture.side !== side) gesture = begin(side, "keyboard");
    if (!gesture) return;
    const current = getNoteMargins(editor, gesture.target)[side] ?? (side === "left" ? gesture.geometry.leftValue : gesture.geometry.rightValue);
    const direction = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1
      : (event.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
    const value = event.key === "Home" ? 0 : event.key === "End" ? 25 : current + direction * (event.shiftKey ? 5 : 1);
    if (!applyNoteMargins(editor, gesture.target, { [side]: value })) finish(false);
  };

  const reset = () => {
    if (disabled) return;
    finish(false);
    const target = captureMarginTarget(editor);
    applyNoteMargins(editor, target, { left: 0, right: 0 });
    restoreMarginSelection(editor, target);
    finishMarginAdjustment(editor, target);
    refresh();
  };

  const left = geometry ? marginRulerPosition(geometry, "left", margins.left ?? undefined) : 0;
  const right = geometry ? marginRulerPosition(geometry, "right", margins.right ?? undefined) : 0;
  const unavailable = disabled || !margins.available || !geometry;
  const marker = (side: MarginSide) => {
    const value = margins[side];
    const label = side === "left" ? "Left" : "Right";
    return <button type="button" role="slider" aria-label={`${label} margin`} aria-orientation="horizontal"
      aria-valuemin={0} aria-valuemax={25} aria-valuenow={value ?? undefined} aria-valuetext={value === null ? "Mixed" : `${value}%`}
      title={`${label} margin: ${value === null ? "Mixed" : `${value}%`}. Drag to adjust.`}
      className={`editor-ruler-marker is-${side}${activeSide === side ? " is-dragging" : ""}${value === null ? " is-mixed" : ""}`}
      style={{ left: geometry ? side === "left" ? left : right : side === "left" ? "0%" : "100%" }} disabled={unavailable}
      onPointerDown={event => startDrag(event, side)}
      onPointerEnter={() => setHoveredSide(side)}
      onPointerLeave={() => setHoveredSide(null)}
      onFocus={event => setFocusedSide(event.currentTarget.matches(":focus-visible") ? side : null)}
      onKeyDown={event => adjustWithKeyboard(event, side)}
      onKeyUp={event => { if (adjustmentKeys.has(event.key) && gestureRef.current?.kind === "keyboard") finish(false); }}
      onBlur={() => { setFocusedSide(null); if (gestureRef.current?.kind === "keyboard") finish(false); }}>
      <span className="editor-ruler-marker-shape" aria-hidden="true"/>
      <span className="editor-ruler-value" aria-hidden="true">{value === null ? "Mixed" : `${value}%`}</span>
    </button>;
  };

  return <div ref={rulerRef} className={`editor-margins-ruler${unavailable ? " is-unavailable" : ""}`} role="group" aria-label="Margins ruler" aria-describedby={scopeId}>
    <span id={scopeId} className="sr-only">{margins.scope === "document" ? "Document" : "Selected paragraphs"}</span>
    <div ref={trackRef} className="editor-margins-track" aria-label="Margins in percent of text width"
      data-ready={Boolean(geometry)} data-left={margins.left ?? "mixed"} data-right={margins.right ?? "mixed"}
      data-left-position={left} data-right-position={right} data-active-side={activeSide ?? hoveredSide ?? undefined}
      data-focused-side={focusedSide ?? undefined} data-disabled={unavailable}
      style={{ ...(geometry ? { width: geometry.width, marginLeft: offset } : {}),
        "--ruler-left": `${left}px`, "--ruler-right": geometry ? `${right}px` : "100%",
      } as CSSProperties}>
      <div className="editor-ruler-shading" aria-hidden="true"/>
      <div className="editor-ruler-ticks" aria-hidden="true">
        {ticks.map(value => <span key={value} className={`editor-ruler-tick${value % 10 === 0 ? " is-major" : ""}`} style={{ left: `${value}%` }}>
          {value % 10 === 0 && <span>{value === 0 || value === 100 ? `${value}%` : value}</span>}
        </span>)}
      </div>
      {marker("left")}{marker("right")}
    </div>
    <div className="editor-ruler-footer">
      <button type="button" className="editor-ruler-reset" aria-label="Reset margins" title="Reset margins"
        disabled={unavailable || (margins.left === 0 && margins.right === 0)}
        onMouseDown={event => event.preventDefault()} onClick={reset}><RotateCcw size={14} aria-hidden="true"/></button>
    </div>
  </div>;
}
