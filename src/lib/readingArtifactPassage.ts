import type { Node as DocumentNode } from "@tiptap/pm/model";

const blockTypes: Record<string, string> = {
  P: "paragraph", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading", H6: "heading",
  UL: "bulletList", OL: "orderedList", BLOCKQUOTE: "blockquote", PRE: "codeBlock",
};
const excluded = "[data-passage-thread], [data-visual-artifact], [data-narration-ignore], .note-ticket-card, .chat-citation, .source-citation-marker";
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();

export interface ReadingArtifactPassage {
  source: string;
  anchor: { left: number; top: number; bottom: number };
  /** The endpoint block's type, displayed prose and occurrence among equal blocks. */
  block: { type: string; text: string; occurrence: number; count: number };
}

function readingBlockType(element: Element) {
  if (element.matches(".note-table-reading")) return "table";
  if (element.matches("ul.contains-task-list")) return "taskList";
  return blockTypes[element.tagName];
}

function readingBlockText(element: Element): string {
  if (element.matches(".note-table-reading")) {
    return Array.from(element.querySelectorAll("th,td"), cell => normalize(cell.textContent ?? "")).filter(Boolean).join(" ");
  }
  if (element.matches("ul, ol, blockquote")) {
    // Reading Markdown adds whitespace between list items and paragraphs.
    return Array.from(element.children, readingBlockText).join(" ");
  }
  return normalize(element.textContent ?? "");
}

/** Capture while the native highlight exists, before moving focus to a button. */
export function captureReadingArtifactPassage(body: HTMLElement, selection: Selection): ReadingArtifactPassage | undefined {
  if (selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return;
  const pieces: string[] = [];
  let last: Element | undefined;
  for (const element of body.children) {
    if (!range.intersectsNode(element)) continue;
    if (!readingBlockType(element) || element.matches(excluded) || element.querySelector(excluded)) return;
    // Only the two selection boundaries need a DOM range. For a whole
    // chapter, the intervening paragraphs are already included in full.
    let text: string;
    if (element.contains(range.startContainer) || element.contains(range.endContainer)) {
      const part = range.cloneRange();
      if (!element.contains(part.startContainer)) part.setStart(element, 0);
      if (!element.contains(part.endContainer)) part.setEnd(element, element.childNodes.length);
      text = part.toString();
    } else {
      text = element.textContent ?? "";
    }
    if (/\S/u.test(text)) { pieces.push(text); last = element; }
  }
  if (!last) return;
  const type = readingBlockType(last);
  const text = readingBlockText(last);
  let occurrence = 0, count = 0;
  for (const child of body.children) {
    if (readingBlockType(child) !== type || readingBlockText(child) !== text) continue;
    if (child === last) occurrence = count;
    count++;
  }
  const { left, top, bottom } = range.getBoundingClientRect();
  return { source: pieces.join("\n\n"), anchor: { left, top, bottom }, block: { type, text, occurrence, count } };
}

/** Both views must agree about duplicate paragraphs before a position can be used. */
export function resolveReadingArtifactEnd(doc: DocumentNode, block: ReadingArtifactPassage["block"]): number | undefined {
  const matches: number[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === block.type && normalize(node.textBetween(0, node.content.size, " ")) === block.text) {
      matches.push(offset + node.nodeSize);
    }
  });
  return matches.length === block.count ? matches[block.occurrence] : undefined;
}
