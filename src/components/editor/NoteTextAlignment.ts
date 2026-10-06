import { Extension, type Editor } from "@tiptap/core";

/** Formatting shortcuts; NoteStarterKit owns the portable Markdown attribute. */
export const NoteTextAlignment = Extension.create({
  name: "noteTextAlignment",
  addKeyboardShortcuts() {
    return { "Mod-Shift-j": () => toggleNoteJustification(this.editor) };
  },
});

/** Selected paragraphs change together and Undo restores them in one step. */
export function toggleNoteJustification(editor: Editor): boolean {
  if (!editor.isEditable || editor.isDestroyed) return false;
  const { state } = editor;
  const selected: { position: number; attrs: Record<string, unknown> }[] = [];
  state.doc.nodesBetween(state.selection.from, state.selection.to, (node, position) => {
    if (node.type.name === "table") return false;
    if (!["paragraph", "heading"].includes(node.type.name)) return;
    if (!node.content.size && !state.selection.empty) return;
    // Cell paragraphs use GFM table alignment, not paragraph metadata.
    const path = state.doc.resolve(position);
    for (let depth = path.depth; depth > 0; depth--) if (path.node(depth).type.name === "table") return false;
    selected.push({ position, attrs: node.attrs });
  });
  if (!selected.length) return false;
  const textAlign = selected.every(({ attrs }) => attrs.textAlign === "justify") ? "left" : "justify";
  const tr = state.tr;
  selected.forEach(({ position, attrs }) => tr.setNodeMarkup(position, undefined, { ...attrs, textAlign }));
  editor.view.dispatch(tr);
  editor.commands.focus();
  return true;
}
