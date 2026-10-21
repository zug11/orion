import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { getSlashMatch, matchingSlashItems } from "./slashCommands";

/** Remove only the command and select its paragraph for the ordinary comment capture. */
export function selectSlashCommentPassage(editor: Editor, range: { from: number; to: number }): boolean | "note" {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const match = getSlashMatch(editor.state);
  if (!match || match.from !== range.from || match.to !== range.to || !matchingSlashItems(match).some(item => item.id === "comment")) return false;
  const tr = closeHistory(editor.state.tr).delete(range.from, range.to);
  const cursor = tr.doc.resolve(range.from);
  let target: { from: number; to: number } | undefined;
  if (cursor.parent.textContent.trim()) target = { from: cursor.start(), to: cursor.end() };
  else tr.doc.nodesBetween(0, cursor.before(), (node, position) => {
    if (node.isTextblock) {
      target = !node.type.spec.code && node.textContent.trim() ? { from: position + 1, to: position + 1 + node.content.size } : undefined;
      return false;
    }
  });
  if (!target) {
    editor.view.dispatch(tr);
    editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
    editor.view.focus();
    return "note";
  }
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, target.from, target.to)));
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false));
  editor.view.focus();
  return true;
}
