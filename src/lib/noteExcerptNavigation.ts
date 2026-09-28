import type { Note } from "../types";
import { getNoteExcerptText, type ExcerptPassage } from "./noteExcerpts";

export interface NoteExcerptNavigation {
  noteId: string;
  passages: ExcerptPassage[];
  requestedAt: number;
}

let pending: NoteExcerptNavigation | undefined;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;
const HIGHLIGHT_NAME = "orion-excerpt-target";

type HighlightRegistry = { set: (name: string, highlight: unknown) => void; delete: (name: string) => void };
function registry(): HighlightRegistry | undefined {
  return (globalThis.CSS as typeof CSS & { highlights?: HighlightRegistry } | undefined)?.highlights;
}

/** A one-shot in-window navigation intent; it never reads or chooses another Space. */
export function requestNoteExcerptNavigation(noteId: string, passages: readonly ExcerptPassage[]): void {
  pending = { noteId, passages: passages.map((passage) => ({ ...passage })), requestedAt: Date.now() };
}

export function consumeNoteExcerptNavigation(noteId: string): NoteExcerptNavigation | undefined {
  const request = pending;
  pending = undefined;
  return request?.noteId === noteId && Date.now() - request.requestedAt < 10_000 ? request : undefined;
}

export function clearNoteExcerptHighlight(): void {
  if (highlightTimer) clearTimeout(highlightTimer);
  highlightTimer = undefined;
  registry()?.delete(HIGHLIGHT_NAME);
}

function normalize(text: string): string { return text.replace(/\s+/gu, " ").trim(); }

interface TextPosition { node: Text; from: number; to: number }

function readingText(root: HTMLElement): { text: string; positions: TextPosition[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const positions: TextPosition[] = [];
  let text = "";
  let previousBlock: Element | null | undefined;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const parent = node.parentElement;
    // Orion renders in-document concept/note links as buttons. Their visible
    // words remain part of the passage; the caller supplies only the prose root.
    if (!parent || parent.closest("script, style, textarea, [aria-hidden='true']")) continue;
    const block = parent.closest("p, li, h1, h2, h3, h4, h5, h6, pre, td, th, blockquote");
    if (previousBlock !== undefined && previousBlock !== block && text && !text.endsWith(" ")) {
      text += " "; positions.push({ node, from: 0, to: 0 });
    }
    previousBlock = block;
    const content = node.textContent ?? "";
    for (let index = 0; index < content.length; index += 1) {
      const character = /\s/u.test(content[index]) ? " " : content[index];
      if (character === " " && (!text || text.endsWith(" "))) continue;
      text += character;
      positions.push({ node, from: index, to: index + 1 });
    }
  }
  return { text, positions };
}

function uniqueIndex(text: string, value: string): number {
  const index = text.indexOf(value);
  return index >= 0 && text.indexOf(value, index + 1) < 0 ? index : -1;
}

function readingScroller(root: HTMLElement): HTMLElement | null {
  let ancestor = root.parentElement;
  while (ancestor) {
    if (/(auto|scroll)/.test(getComputedStyle(ancestor).overflowY) && ancestor.scrollHeight > ancestor.clientHeight) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return document.scrollingElement as HTMLElement | null;
}

/** Highlights current exact wording only. Changed/deleted or ambiguous passages stay unhighlighted. */
export function revealNoteExcerptPassage(root: HTMLElement, note: Note, request: NoteExcerptNavigation): boolean {
  clearNoteExcerptHighlight();
  if (note.id !== request.noteId || !root.isConnected) return false;
  const passage = request.passages[0];
  if (!passage?.text.trim()) return false;
  const source = getNoteExcerptText(note);
  let sourceIndex = passage.from;
  if (source.slice(passage.from, passage.to) !== passage.text) sourceIndex = uniqueIndex(source, passage.text);
  if (sourceIndex < 0) return false;
  const wanted = normalize(passage.text);
  const body = readingText(root);
  let position = uniqueIndex(body.text, wanted);
  if (position < 0) {
    // A repeated quotation is safe to locate by occurrence only when the complete
    // rendered text agrees with the canonical current note representation.
    const canonical = normalize(source);
    if (body.text.trim() !== canonical) return false;
    const prefix = normalize(source.slice(0, sourceIndex));
    position = prefix.length + (prefix && /\s/u.test(source[sourceIndex - 1] ?? "") ? 1 : 0);
    if (body.text.slice(position, position + wanted.length) !== wanted) return false;
  }
  const start = body.positions[position];
  const end = body.positions[position + wanted.length - 1];
  if (!start || !end) return false;
  const range = document.createRange();
  range.setStart(start.node, start.from);
  range.setEnd(end.node, end.to);
  const scroller = readingScroller(root);
  const rangeRect = range.getBoundingClientRect?.();
  if (scroller && rangeRect) {
    const top = rangeRect.top - scroller.getBoundingClientRect().top + scroller.scrollTop - 80;
    scroller.scrollTo?.({ top: Math.max(0, top), behavior: "instant" });
  } else start.node.parentElement?.scrollIntoView?.({ block: "center", behavior: "instant" });

  const Highlight = (globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const highlights = registry();
  if (Highlight && highlights) {
    highlights.set(HIGHLIGHT_NAME, new Highlight(range));
    highlightTimer = setTimeout(clearNoteExcerptHighlight, 8000);
  } else {
    // Older WebKit can still show the ordinary browser text-selection highlight.
    const selection = window.getSelection();
    selection?.removeAllRanges(); selection?.addRange(range);
  }
  return true;
}
