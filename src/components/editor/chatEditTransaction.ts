import type { Editor } from "@tiptap/core";
import { Fragment, Node } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";

/** Apply through the live document, keeping native rich content and one Undo. */
export interface PreparedChatChange { original: Node; replacement: Node }

export function prepareChatEditorChange(editor: Editor, base: string, next: string): PreparedChatChange {
  if (editor.isDestroyed || !editor.isEditable || !editor.markdown) throw new Error("Finish the current editor operation before applying these changes.");
  const original = editor.state.doc;
  let parsedBase = Node.fromJSON(editor.schema, editor.markdown.parse(base));
  let replacement = Node.fromJSON(editor.schema, editor.markdown.parse(next));
  // Tiptap adds a caret paragraph after a terminal list/table/image on mount.
  // It is not authored text, but must stay in this transaction and its Undo.
  const trailing = original.lastChild;
  if (!original.eq(parsedBase) && parsedBase.lastChild?.type.name !== "paragraph" &&
    trailing?.type.name === "paragraph" && trailing.content.size === 0 &&
    original.childCount === parsedBase.childCount + 1) {
    const extended = parsedBase.copy(parsedBase.content.append(Fragment.from(trailing)));
    if (original.eq(extended)) {
      parsedBase = extended;
      replacement = replacement.copy(replacement.content.append(Fragment.from(trailing)));
    }
  }
  parsedBase.check();
  replacement.check();
  // Also catches unsaved typing and rich attributes that cannot round-trip.
  if (!original.eq(parsedBase)) throw new Error("The editor has changed. Ask Chat to regenerate the edits.");
  if (original.eq(replacement)) throw new Error("The proposed edit does not change the visible note.");
  return { original, replacement };
}

export function applyPreparedChatChange(editor: Editor, { original, replacement }: PreparedChatChange): void {
  if (editor.isDestroyed || !editor.state.doc.eq(original)) throw new Error("The note changed while reviewing. Regenerate the edits.");
  const start = original.content.findDiffStart(replacement.content);
  if (start === null) throw new Error("The proposed edit does not change the visible note.");
  const end = original.content.findDiffEnd(replacement.content)!;
  const overlap = start - Math.min(end.a, end.b);
  const oldEnd = end.a + Math.max(0, overlap);
  const newEnd = end.b + Math.max(0, overlap);
  const transaction = closeHistory(editor.state.tr).replace(start, oldEnd, replacement.slice(start, newEnd));
  transaction.doc.check();
  if (!transaction.doc.eq(replacement)) throw new Error("This change could not preserve the note's formatting.");
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeHistory(editor.state.tr));
}

export function applyChatEditorChange(editor: Editor, base: string, next: string): void {
  applyPreparedChatChange(editor, prepareChatEditorChange(editor, base, next));
}
