import type { Editor } from "@tiptap/core";
import { normalizeNoteMargin } from "../../lib/noteMargins";
import { getNoteMargins, marginReferenceParagraph, type MarginScope, type MarginTarget } from "./NoteMargins";

export interface MarginRulerGeometry {
  /** Viewport coordinate and width of the full, unindented writing surface. */
  left: number;
  width: number;
  /** Zero-margin text boundaries, relative to left. */
  start: number;
  end: number;
  /** The actual CSS containing-block width used by percentage margins. */
  basis: number;
  leftValue: number;
  rightValue: number;
  scope: MarginScope;
}

export interface RulerContentBox { left: number; width: number }

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

/** Borders and padding are not part of a child's percentage-margin basis. */
export function rulerContentBox(element: HTMLElement): RulerContentBox | null {
  const bounds = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.width) || bounds.width <= 0) return null;
  const before = pixels(style.borderLeftWidth) + pixels(style.paddingLeft);
  const after = pixels(style.borderRightWidth) + pixels(style.paddingRight);
  const width = bounds.width - before - after;
  return width > 0 ? { left: bounds.left + before, width } : null;
}

/** Measure existing layout; no guessed character width or fixed page dimensions. */
export function measureMarginRuler(editor: Editor, target?: MarginTarget): MarginRulerGeometry | null {
  if (editor.isDestroyed) return null;
  const state = getNoteMargins(editor, target);
  if (!state.available) return null;
  const root = editor.view.dom;
  const surface = root.closest<HTMLElement>(".editor-prose") ?? root.parentElement;
  if (!surface) return null;
  const full = rulerContentBox(surface);
  if (!full) return null;

  if (state.scope === "document") {
    const style = root.ownerDocument.defaultView?.getComputedStyle(root);
    if (!style) return null;
    return {
      left: full.left,
      width: full.width,
      start: pixels(style.borderLeftWidth) + pixels(style.paddingLeft),
      end: full.width - pixels(style.borderRightWidth) - pixels(style.paddingRight),
      basis: full.width,
      leftValue: state.left ?? 0,
      rightValue: state.right ?? 0,
      scope: "document",
    };
  }

  const reference = marginReferenceParagraph(editor, target);
  if (!reference) return null;
  const paragraph = editor.view.nodeDOM(reference.position);
  if (!(paragraph instanceof HTMLElement) || !paragraph.parentElement) return null;
  const parent = rulerContentBox(paragraph.parentElement);
  if (!parent) return null;
  return {
    left: full.left,
    width: full.width,
    start: parent.left - full.left,
    end: parent.left + parent.width - full.left,
    basis: parent.width,
    leftValue: normalizeNoteMargin(reference.node.attrs.marginLeft),
    rightValue: normalizeNoteMargin(reference.node.attrs.marginRight),
    scope: "paragraphs",
  };
}

/** A side's marker follows the text edge, including pre-existing list/quote inset. */
export function marginRulerPosition(geometry: MarginRulerGeometry, side: "left" | "right", value?: number): number {
  const percent = normalizeNoteMargin(value ?? (side === "left" ? geometry.leftValue : geometry.rightValue));
  const inset = geometry.basis * percent / 100;
  return side === "left" ? geometry.start + inset : geometry.end - inset;
}

/** Dragging the right edge inward increases its margin, opposite to the left edge. */
export function marginFromRulerPointer(geometry: MarginRulerGeometry, side: "left" | "right", clientX: number): number {
  if (!Number.isFinite(clientX) || !Number.isFinite(geometry.basis) || geometry.basis <= 0) return side === "left" ? geometry.leftValue : geometry.rightValue;
  const x = clientX - geometry.left;
  const distance = side === "left" ? x - geometry.start : geometry.end - x;
  return normalizeNoteMargin(distance / geometry.basis * 100);
}
