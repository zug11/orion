import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { isNoteExcerptNode } from "./NoteExcerpt";

/** An immutable snapshot of one document child, including an explicit frame. */
export interface NoteBlock {
  readonly from: number;
  readonly to: number;
  readonly node: ProseMirrorNode;
  readonly label: string;
}

function blockLabel(node: ProseMirrorNode): string {
  switch (node.type.name) {
    case "noteBlock": return node.childCount === 1
      ? node.firstChild?.type.name === "paragraph" ? "Text" : blockLabel(node.firstChild!)
      : "Block";
    case "paragraph": return "Paragraph";
    case "heading": return `Heading ${node.attrs.level}`;
    case "bulletList": return "Bullet list";
    case "orderedList": return "Numbered list";
    case "taskList": return "To-do list";
    case "table": return "Table";
    case "blockquote": return isNoteExcerptNode(node) ? "Excerpt" : "Quote";
    case "image": return "Image";
    case "codeBlock": return "Code block";
    case "horizontalRule": return "Divider";
    default: return "Block";
  }
}

/** Lists, tables and quotations stay whole; their nested children are not handles. */
export function listNoteBlocks(doc: ProseMirrorNode): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  doc.forEach((node, from) => {
    blocks.push({ from, to: from + node.nodeSize, node, label: blockLabel(node) });
  });
  return blocks;
}

function isTopLevelBoundary(doc: ProseMirrorNode, position: number): boolean {
  return Number.isSafeInteger(position) && position >= 0 && position <= doc.content.size
    && doc.resolve(position).depth === 0;
}

function isCurrentBlock(doc: ProseMirrorNode, block: NoteBlock): boolean {
  return isTopLevelBoundary(doc, block.from)
    && block.to === block.from + block.node.nodeSize
    && doc.nodeAt(block.from) === block.node;
}

/** Keep text, node and table-cell bookmarks attached to their original content. */
function preserveSelection(tr: Transaction, selection: Selection, map: (position: number, assoc?: number) => number) {
  const bookmark = selection.getBookmark().map({
    map,
    mapResult: (position, assoc) => ({
      pos: map(position, assoc), deleted: false, deletedBefore: false, deletedAfter: false, deletedAcross: false,
    }),
  });
  tr.setSelection(bookmark.resolve(tr.doc));
}

function dispatchBlockEdit(editor: Editor, tr: Transaction) {
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
}

/** Consume a slash token and frame its content in one undoable edit. */
export function wrapSlashNoteBlock(editor: Editor, range: { from: number; to: number }): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state } = editor;
  const type = state.schema.nodes.noteBlock;
  if (!type || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)
    || range.from < 0 || range.to > state.doc.content.size || range.from >= range.to) return false;
  const from = state.doc.resolve(range.from), to = state.doc.resolve(range.to);
  if (!from.sameParent(to) || !from.parent.isTextblock || from.parent.type.spec.code
    || !/^\/[a-z-]{0,24}\d?$/i.test(state.doc.textBetween(range.from, range.to))) return false;
  const tr = closeHistory(state.tr).delete(range.from, range.to);
  const block = listNoteBlocks(tr.doc).find(item => range.from > item.from && range.from < item.to);
  if (!block) return false;
  let cursor = range.from;
  if (block.node.type !== type) {
    let containsFrame = false;
    block.node.descendants(node => { if (node.type === type) containsFrame = true; });
    const index = tr.doc.resolve(block.from).index();
    if (containsFrame || !type.validContent(Fragment.from(block.node)) || !tr.doc.canReplaceWith(index, index + 1, type)) return false;
    tr.replaceWith(block.from, block.to, type.create(null, block.node));
    cursor += 1;
  }
  tr.setSelection(TextSelection.create(tr.doc, cursor));
  dispatchBlockEdit(editor, tr);
  editor.view.focus();
  return true;
}

/** Frame whole document children; selected text is never cut out of its paragraph. */
export function wrapNoteBlock(editor: Editor): NoteBlock | null {
  if (editor.isDestroyed || !editor.isEditable) return null;
  const { state } = editor;
  const type = state.schema.nodes.noteBlock;
  if (!type) return null;
  const blocks = listNoteBlocks(state.doc);
  const selection = state.selection;
  const firstIndex = blocks.findIndex(block => selection.from >= block.from && selection.from < block.to);
  const startIndex = firstIndex < 0 && selection.from === state.doc.content.size ? blocks.length - 1 : firstIndex;
  if (startIndex < 0) return null;
  const first = blocks[startIndex];
  if (first.node.type === type && selection.to <= first.to) {
    editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, first.from))
      .setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
    return first;
  }
  let endIndex = startIndex + 1;
  while (endIndex < blocks.length && blocks[endIndex].from < selection.to) endIndex += 1;
  const selected = blocks.slice(startIndex, endIndex);
  let containsFrame = false;
  for (const block of selected) {
    if (block.node.type === type) containsFrame = true;
    block.node.descendants(node => { if (node.type === type) containsFrame = true; });
  }
  if (containsFrame || !state.doc.canReplaceWith(startIndex, endIndex, type)) return null;
  const node = type.create(null, Fragment.fromArray(selected.map(block => block.node)));
  if (!type.validContent(node.content)) return null;
  const tr = closeHistory(state.tr).replaceWith(first.from, selected[selected.length - 1].to, node);
  tr.setSelection(NodeSelection.create(tr.doc, first.from));
  dispatchBlockEdit(editor, tr);
  const saved = editor.state.doc.nodeAt(first.from);
  return saved?.type === type ? { from: first.from, to: first.from + saved.nodeSize, node: saved, label: blockLabel(saved) } : null;
}

/** Remove only the explicit frame, preserving every child and its attributes. */
export function unwrapNoteBlock(editor: Editor, block: NoteBlock): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state } = editor;
  if (block.node.type.name !== "noteBlock" || !isCurrentBlock(state.doc, block)) return false;
  const index = state.doc.resolve(block.from).index();
  if (!state.doc.canReplace(index, index + 1, block.node.content)) return false;
  const tr = closeHistory(state.tr).replaceWith(block.from, block.to, block.node.content);
  if (state.selection instanceof NodeSelection && state.selection.from === block.from) {
    tr.setSelection(Selection.near(tr.doc.resolve(block.from)));
  } else {
    preserveSelection(tr, state.selection, (position, assoc) => position > block.from && position < block.to
      ? position - 1 : tr.mapping.map(position, assoc));
  }
  dispatchBlockEdit(editor, tr);
  return true;
}

/** Move a captured frame before an original document boundary, never into itself. */
export function moveNoteBlockTo(editor: Editor, block: NoteBlock, position: number): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state } = editor;
  if (block.node.type.name !== "noteBlock" || !isCurrentBlock(state.doc, block)
    || !isTopLevelBoundary(state.doc, position) || (position >= block.from && position <= block.to)) return false;
  const sourceIndex = state.doc.resolve(block.from).index();
  if (!state.doc.canReplace(sourceIndex, sourceIndex + 1)) return false;
  const tr = closeHistory(state.tr).delete(block.from, block.to);
  const destination = position > block.to ? position - block.node.nodeSize : position;
  const index = tr.doc.resolve(destination).index();
  const content = Fragment.from(block.node);
  if (!tr.doc.canReplace(index, index, content)) return false;
  tr.insert(destination, content);
  preserveSelection(tr, state.selection, (original, assoc) => original >= block.from && original < block.to
    ? destination + original - block.from : tr.mapping.map(original, assoc));
  dispatchBlockEdit(editor, tr);
  return true;
}

/** Swap only the framed block with its immediately adjacent document sibling. */
export function moveNoteBlock(editor: Editor, block: NoteBlock, direction: "up" | "down"): boolean {
  if (editor.isDestroyed || !editor.isEditable || !isCurrentBlock(editor.state.doc, block)) return false;
  const blocks = listNoteBlocks(editor.state.doc);
  const index = blocks.findIndex(candidate => candidate.from === block.from);
  const adjacent = blocks[index + (direction === "up" ? -1 : 1)];
  return Boolean(adjacent) && moveNoteBlockTo(editor, block, direction === "up" ? adjacent.from : adjacent.to);
}

/**
 * Reject a stale menu target instead of deleting whichever block moved into its
 * old position. ProseMirror nodes are immutable and unchanged siblings retain
 * their identity, so unrelated edits after this block remain safe.
 */
export function deleteNoteBlock(editor: Editor, block: NoteBlock): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state, view } = editor;
  if (!isCurrentBlock(state.doc, block)) return false;

  const tr = closeHistory(state.tr);
  if (state.doc.childCount === 1) {
    const paragraph = state.schema.nodes.paragraph;
    if (!paragraph || !state.doc.canReplaceWith(0, 1, paragraph)) return false;
    tr.replaceWith(block.from, block.to, paragraph.create());
    tr.setSelection(TextSelection.create(tr.doc, 1));
  } else {
    const index = state.doc.resolve(block.from).index();
    if (!state.doc.canReplace(index, index + 1)) return false;
    tr.delete(block.from, block.to);
    tr.setSelection(Selection.near(tr.doc.resolve(Math.min(block.from, tr.doc.content.size))));
  }
  if (tr.doc.eq(state.doc)) return false;
  view.dispatch(tr.scrollIntoView());
  // Keep immediately following typing out of this one undo step too.
  view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
  return true;
}

/**
 * Insert only at a document boundary. Adjacent inline nodes (for example a note
 * link) receive one ordinary paragraph; existing document nodes are never parsed
 * or rewritten. Deferred callers must separately validate their captured doc.
 */
export function insertNoteBlockContent(editor: Editor, position: number, content: JSONContent | JSONContent[]): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state, view } = editor;
  const paragraph = state.schema.nodes.paragraph;
  if (!isTopLevelBoundary(state.doc, position)) return false;
  const nodes: ProseMirrorNode[] = [];
  let inline: ProseMirrorNode[] = [];
  const flushInline = () => {
    if (!inline.length) return;
    if (!paragraph) throw new Error("Inline block insertion needs a paragraph.");
    const wrapper = paragraph.create(null, Fragment.fromArray(inline));
    wrapper.check();
    nodes.push(wrapper);
    inline = [];
  };
  try {
    for (const json of Array.isArray(content) ? content : [content]) {
      const node = state.schema.nodeFromJSON(json);
      node.check();
      if (node.isInline) inline.push(node);
      else { flushInline(); nodes.push(node); }
    }
    flushInline();
  } catch { return false; }
  if (!nodes.length) return false;
  const fragment = Fragment.fromArray(nodes);
  const index = state.doc.resolve(position).index();
  if (!state.doc.canReplace(index, index, fragment)) return false;

  const tr = closeHistory(state.tr).insert(position, fragment);
  const inside = Selection.findFrom(tr.doc.resolve(position), 1, true);
  if (inside && inside.from < position + fragment.size) tr.setSelection(inside);
  else if (NodeSelection.isSelectable(nodes[0])) tr.setSelection(NodeSelection.create(tr.doc, position));
  else tr.setSelection(Selection.near(tr.doc.resolve(position)));
  view.dispatch(tr.scrollIntoView());
  view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
  return true;
}

export function insertNoteBlockParagraph(editor: Editor, position: number): { from: number; to: number } | null {
  return insertNoteBlockContent(editor, position, { type: "paragraph" })
    ? { from: position + 1, to: position + 1 } : null;
}
