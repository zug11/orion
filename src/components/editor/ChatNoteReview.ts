import { skipTrailingNodeMeta } from "@tiptap/extensions";
import { Extension, type Editor } from "@tiptap/core";
import { DOMSerializer, Fragment, type Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { PreparedChatChange } from "./chatEditTransaction";

export interface ChatChangeMark { from: number; to: number; addition: Fragment; inline: boolean }
interface Review { id: string; changes: ChatChangeMark[] }
export const chatNoteReviewKey = new PluginKey<Review | null>("chatNoteReview");

/** Review decorations never enter the document, history, autosave or export. */
export const ChatNoteReview = Extension.create({
  name: "chatNoteReview",
  addProseMirrorPlugins() {
    return [new Plugin<Review | null>({
      key: chatNoteReviewKey,
      // Node-view checkboxes and history shortcuts can dispatch even when the
      // contenteditable surface is read-only. Only a cleared review may write.
      filterTransaction: (transaction, state) => !chatNoteReviewKey.getState(state) || !transaction.docChanged,
      state: { init: () => null, apply(transaction, current) {
        const explicit = transaction.getMeta(chatNoteReviewKey) as Review | null | undefined;
        return explicit !== undefined ? explicit : transaction.docChanged ? null : current;
      } },
      props: { decorations(state) {
        const review = chatNoteReviewKey.getState(state);
        if (!review) return null;
        const decorations: Decoration[] = [];
        review.changes.forEach((change, index) => {
          if (change.to > change.from) {
            decorations.push(Decoration.inline(change.from, change.to, { class: "chat-note-removed", "data-chat-removal": "true" }));
            state.doc.nodesBetween(change.from, change.to, (node, position) => {
              if (node.isBlock && position >= change.from && position + node.nodeSize <= change.to) {
                decorations.push(Decoration.node(position, position + node.nodeSize, { class: "chat-note-removed-block" }));
                return false;
              }
              return true;
            });
          }
          if (change.addition.size) decorations.push(Decoration.widget(change.to, () => {
            const element = document.createElement(change.inline ? "span" : "div");
            element.className = `chat-note-addition${change.inline ? "" : " chat-note-addition--block"}`;
            element.contentEditable = "false";
            element.setAttribute("data-chat-addition", "true");
            element.setAttribute("aria-label", "Proposed addition, not saved");
            element.append(DOMSerializer.fromSchema(state.schema).serializeFragment(change.addition));
            // Review is inert, including links and task checkboxes in the added text.
            element.addEventListener("click", event => event.preventDefault());
            for (const control of element.querySelectorAll("a,button,input,textarea,select")) {
              control.setAttribute("tabindex", "-1");
              if (control instanceof HTMLInputElement || control instanceof HTMLButtonElement) control.disabled = true;
            }
            return element;
          }, { side: 1, key: `chat-review:${review.id}:${index}`, ignoreSelection: true }));
        });
        return DecorationSet.create(state.doc, decorations);
      } },
    })];
  },
});

export function showChatNoteReview(editor: Editor, id: string, change: PreparedChatChange): number {
  if (!editor.state.doc.eq(change.original)) throw new Error("The note changed before its preview was ready.");
  const changes = diffChatDocument(change.original, change.replacement);
  if (!changes.length) throw new Error("The proposal contains no visible changes.");
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false).setMeta(skipTrailingNodeMeta, true).setMeta(chatNoteReviewKey, { id, changes }));
  return changes.length;
}
export function clearChatNoteReview(editor: Editor): void {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false).setMeta(skipTrailingNodeMeta, true).setMeta(chatNoteReviewKey, null));
}

/** Exact matching anchors keep untouched paragraphs and words unmarked. Work is bounded. */
function anchors<T>(old: T[], next: T[], equal: (a: T, b: T) => boolean): [number, number][] {
  let head = 0, tail = 0;
  while (head < Math.min(old.length, next.length) && equal(old[head], next[head])) head++;
  while (tail < Math.min(old.length, next.length) - head && equal(old[old.length - 1 - tail], next[next.length - 1 - tail])) tail++;
  const matches: [number, number][] = Array.from({ length: head }, (_, i) => [i, i]);
  const n = old.length - head - tail, m = next.length - head - tail;
  if (n && m && (n + 1) * (m + 1) <= 250_000) {
    const columns = m + 1, table = new Uint16Array((n + 1) * columns);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      table[i * columns + j] = equal(old[head + i], next[head + j]) ? 1 + table[(i + 1) * columns + j + 1]
        : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (equal(old[head + i], next[head + j])) { matches.push([head + i++, head + j++]); }
      else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) i++;
      else j++;
    }
  }
  for (let i = tail; i > 0; i--) matches.push([old.length - i, next.length - i]);
  return matches;
}

function children(node: Node): { node: Node; offset: number }[] {
  const result: { node: Node; offset: number }[] = [];
  node.forEach((child, offset) => result.push({ node: child, offset }));
  return result;
}
function tokens(node: Node): { key: string; from: number; to: number }[] {
  const result: { key: string; from: number; to: number }[] = [];
  node.forEach((child, offset) => {
    if (!child.isText) { result.push({ key: JSON.stringify(child.toJSON()), from: offset, to: offset + child.nodeSize }); return; }
    const marks = JSON.stringify(child.marks.map(mark => mark.toJSON()));
    for (const match of child.text!.matchAll(/\s+|[\p{L}\p{N}_]+|[^\s]/gu)) {
      result.push({ key: marks + ":" + match[0], from: offset + match.index, to: offset + match.index + match[0].length });
    }
  });
  return result;
}

export function diffChatDocument(original: Node, replacement: Node): ChatChangeMark[] {
  const changes: ChatChangeMark[] = [];
  const inline = (old: Node, next: Node, position: number) => {
    const start = changes.length;
    const a = tokens(old), b = tokens(next);
    let from = 0, to = 0;
    for (const [i, j] of [...anchors(a, b, (x, y) => x.key === y.key), [a.length, b.length]]) {
      if (i > from || j > to) changes.push({
        from: position + (a[from]?.from ?? old.content.size),
        to: position + (i > from ? a[i - 1].to : a[from]?.from ?? old.content.size),
        addition: next.content.cut(b[to]?.from ?? next.content.size, j > to ? b[j - 1].to : b[to]?.from ?? next.content.size), inline: true,
      });
      from = i + 1; to = j + 1;
    }
    const edits = changes.slice(start);
    const altered = edits.reduce((sum, edit) => sum + edit.to - edit.from + edit.addition.size, 0);
    // A heavily rewritten paragraph reads better as two whole passages than
    // alternating isolated common words and spaces. Untouched blocks stay exact.
    if (edits.length >= 4 && altered > (old.content.size + next.content.size) * .5) {
      changes.splice(start, edits.length, { from: position - 1, to: position + old.content.size + 1,
        addition: Fragment.from(next), inline: false });
    }
  };
  const walk = (old: Node, next: Node, position: number) => {
    const a = children(old), b = children(next);
    let from = 0, to = 0;
    for (const [i, j] of [...anchors(a, b, (x, y) => x.node.eq(y.node)), [a.length, b.length]]) {
      const pairs = Math.min(i - from, j - to);
      for (let k = 0; k < pairs; k++) {
        const left = a[from + k], right = b[to + k], pos = position + left.offset;
        if (left.node.sameMarkup(right.node) && !left.node.isLeaf) {
          if (left.node.isTextblock && right.node.isTextblock) inline(left.node, right.node, pos + 1);
          else walk(left.node, right.node, pos + 1);
        } else changes.push({ from: pos, to: pos + left.node.nodeSize, addition: Fragment.from(right.node), inline: false });
      }
      const oldStart = position + (a[from + pairs]?.offset ?? old.content.size);
      const oldEnd = position + (a[i]?.offset ?? old.content.size);
      if (from + pairs < i || to + pairs < j) changes.push({ from: oldStart, to: oldEnd,
        addition: Fragment.fromArray(b.slice(to + pairs, j).map(item => item.node)), inline: false });
      from = i + 1; to = j + 1;
    }
  };
  walk(original, replacement, 0);
  return changes;
}
