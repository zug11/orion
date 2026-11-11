import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

// Keep the renderer's ES2020 type baseline; older runtimes retain a fallback.
const Segmenter = (Intl as typeof Intl & { Segmenter?: new(locales: undefined, options: { granularity: "word" }) => {
  segment(text: string): Iterable<{ isWordLike?: boolean }>;
} }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: "word" }) : null;

/** Count written words, not Markdown syntax, punctuation or image URLs. */
export function countWords(text: string): number {
  if (!segmenter) return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  let count = 0;
  for (const part of segmenter.segment(text)) if (part.isWordLike) count++;
  return count;
}

/** ProseMirror nodes are immutable: a keystroke only recounts changed textblocks. */
export function createDocumentWordCounter(count = countWords) {
  const cache = new WeakMap<ProseMirrorNode, number>();
  const words = (node: ProseMirrorNode): number => {
    const known = cache.get(node);
    if (known !== undefined) return known;
    let total = 0;
    if (node.isTextblock) total = count(node.textBetween(0, node.content.size, "\n", " "));
    else node.forEach(child => { total += words(child); });
    cache.set(node, total);
    return total;
  };
  return words;
}

const blocks = new Set(["P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "TR", "TD", "TH"]);
const excluded = "script,style,svg,[hidden],[aria-hidden='true'],.source-citation-marker,.chat-citation,[data-saved-passage]";

/** Preserve block boundaries and inline words from the actual reading surface. */
export function countableText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof Element) {
    if (node.matches(excluded)) return "";
    // Images (including their separate caption field) are not note prose.
    if (node.tagName === "BR" || node.tagName === "IMG" || node.matches(".note-image-reading")) return "\n";
  }
  const text = Array.from(node.childNodes, countableText).join("");
  return node instanceof Element && blocks.has(node.tagName) ? `\n${text}\n` : text;
}

export function selectedCountableText(range: Range, root: Element): string {
  if (!range.intersectsNode(root)) return "";
  const ancestor = range.commonAncestorContainer instanceof Element ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (ancestor?.closest(`${excluded},.note-image-reading`)) return "";
  const clipped = root.ownerDocument.createRange();
  clipped.selectNodeContents(root);
  if (range.compareBoundaryPoints(Range.START_TO_START, clipped) > 0) clipped.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, clipped) < 0) clipped.setEnd(range.endContainer, range.endOffset);
  return countableText(clipped.cloneContents());
}
