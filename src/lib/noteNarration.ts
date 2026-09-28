interface TextPosition { node: Text; from: number; to: number; startChar: number; endChar: number }
export interface NarrationDocument {
  text: string;
  positions: TextPosition[];
  words: { from: number; to: number }[];
}

const SKIP = "script,style,textarea,pre,[aria-hidden='true'],[hidden],.source-citation-marker,.chat-citation,.source-references,.chat-evidence,sup";

/** Build the audio script from the displayed words, preserving their DOM positions.
 * Formatting, source markers and hidden Markdown metadata never become narration. */
export function buildNarrationDocument(root: HTMLElement): NarrationDocument {
  let text = "";
  const positions: NarrationDocument["positions"] = [];
  const append = (character: string, position: { node: Text; from: number; to: number } | null) => {
    const startChar = text.length;
    text += character;
    if (!position) return;
    const previous = positions[positions.length - 1];
    if (previous?.node === position.node && previous.to === position.from && previous.endChar === startChar) {
      previous.to = position.to;
      previous.endChar = text.length;
    } else positions.push({ ...position, startChar, endChar: text.length });
  };
  const space = (position: { node: Text; from: number; to: number } | null = null) => { if (text && !text.endsWith(" ")) append(" ", position); };
  for (const scope of root.querySelectorAll<HTMLElement>("[data-narration-text]")) {
    if (text) {
      if (!/[.!?。！？][ ]?$/.test(text)) append(".", null);
      space();
    }
    let previousBlock: Element | null | undefined;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      if (walker.currentNode.nodeType !== Node.TEXT_NODE) {
        const element = walker.currentNode as Element;
        if (element.tagName === "BR" && !element.closest(SKIP)) space();
        continue;
      }
      const node = walker.currentNode as Text, parent = node.parentElement;
      if (!parent || parent.closest(SKIP)) continue;
      const block = parent.closest("p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote");
      if (previousBlock !== undefined && previousBlock !== block) space();
      previousBlock = block;
      let offset = 0;
      for (const character of node.data) {
        if (/\s/u.test(character)) space({ node, from: offset, to: offset + character.length });
        else append(character, { node, from: offset, to: offset + character.length });
        offset += character.length;
      }
    }
  }
  text = text.trimEnd();
  const words = [...text.matchAll(/\S+/gu)].map((match) => ({ from: match.index!, to: match.index! + match[0].length }));
  return { text, positions, words };
}

export function narrationWordAt(document: NarrationDocument, index: number) {
  return document.words.find((word) => word.to > Math.max(0, index)) ?? document.words[document.words.length - 1];
}

/** A native caret hit test avoids adding thousands of buttons or changing prose layout. */
export function narrationCharacterAtPoint(script: NarrationDocument, x: number, y: number): number | null {
  const native = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const caret = native.caretPositionFromPoint?.(x, y);
  const range = !caret ? native.caretRangeFromPoint?.(x, y) : undefined;
  const node = caret?.offsetNode ?? range?.startContainer;
  const offset = caret?.offset ?? range?.startOffset;
  if (!node || offset === undefined) return null;
  const matches = script.positions.filter((position) => position.node === node);
  const position = matches.find((item) => item.from <= offset && item.to > offset)
    ?? matches.find((item) => item.from >= offset) ?? matches[matches.length - 1];
  if (!position) return null;
  const index = position.startChar + Math.max(0, Math.min(position.to - position.from - 1, offset - position.from));
  // caretFromPoint may return the nearest line when clicking blank page space.
  // A caret on the trailing half of a word's last glyph can point *after* it.
  // Check both neighboring words against their actual glyph rectangles.
  for (const word of [narrationWordAt(script, index), narrationWordAt(script, index - 1)]) {
    if (!word) continue;
    const hitRanges = narrationRanges(script, word.from, word.to);
    if (hitRanges.some((item) => [...item.getClientRects()].some((rect) =>
      x >= rect.left - 3 && x <= rect.right + 3 && y >= rect.top - 3 && y <= rect.bottom + 3))) return word.from;
  }
  return null;
}

export function narrationRanges(script: NarrationDocument, from: number, to: number): Range[] {
  const ranges: Range[] = [];
  for (const position of script.positions) {
    if (position.endChar <= from || position.startChar >= to || !position.node.isConnected) continue;
    const range = document.createRange();
    range.setStart(position.node, position.from + Math.max(0, from - position.startChar));
    range.setEnd(position.node, position.to - Math.max(0, position.endChar - to));
    ranges.push(range);
  }
  return ranges;
}

const UNREAD = "orion-narration-unread", CURRENT = "orion-narration-current";
type Registry = { set(name: string, value: unknown): void; delete(name: string): void };
function highlightApi() {
  return {
    registry: (globalThis.CSS as typeof CSS & { highlights?: Registry } | undefined)?.highlights,
    Highlight: (globalThis as typeof globalThis & { Highlight?: new (...ranges: Range[]) => unknown }).Highlight,
  };
}
export function clearNarrationHighlight() {
  const { registry } = highlightApi();
  registry?.delete(UNREAD); registry?.delete(CURRENT);
}
export function highlightNarration(script: NarrationDocument, from: number, length: number): boolean {
  const { registry, Highlight } = highlightApi();
  if (!registry || !Highlight) return false;
  const end = Math.min(script.text.length, Math.max(0, from) + Math.max(0, length));
  registry.set(UNREAD, new Highlight(...narrationRanges(script, end, script.text.length)));
  registry.set(CURRENT, new Highlight(...narrationRanges(script, from, end)));
  return true;
}
