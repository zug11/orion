import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { parseNoteExcerptTitle } from "../../lib/noteExcerpts";

export function isNoteExcerptNode(node: ProseMirrorNode | null | undefined): boolean {
  if (node?.type.name !== "blockquote" || node.childCount < 2) return false;
  const footer = node.lastChild;
  if (footer?.type.name !== "paragraph" || footer.childCount !== 1 || !footer.firstChild?.isText) return false;
  const link = footer.firstChild.marks.find((mark) => mark.type.name === "link");
  return Boolean(link && parseNoteExcerptTitle(link.attrs.title, link.attrs.href));
}

/** Backspace at the following paragraph removes only this excerpt, as one undoable edit. */
export function deleteNoteExcerptBeforeCaret(editor: Editor): boolean {
  const { state, view } = editor;
  const { selection } = state;
  if (selection instanceof NodeSelection && isNoteExcerptNode(selection.node)) {
    view.dispatch(closeHistory(state.tr).deleteSelection().scrollIntoView());
    return true;
  }
  if (!selection.empty || selection.$from.parentOffset !== 0 || selection.$from.depth !== 1) return false;
  const paragraphStart = selection.$from.before(1);
  const preceding = state.doc.resolve(paragraphStart).nodeBefore;
  if (!isNoteExcerptNode(preceding)) return false;
  const tr = closeHistory(state.tr).delete(paragraphStart - preceding!.nodeSize, paragraphStart);
  tr.setSelection(TextSelection.near(tr.doc.resolve(tr.mapping.map(selection.from))));
  view.dispatch(tr.scrollIntoView());
  return true;
}

/** Decoration and deletion behaviour only: the persisted node is an ordinary blockquote. */
export const NoteExcerpt = Extension.create({
  name: "noteExcerpt",
  priority: 1100,
  addKeyboardShortcuts() { return { Backspace: () => deleteNoteExcerptBeforeCaret(this.editor) }; },
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("orionNoteExcerpts"),
      props: {
        decorations(state) {
          const decorations: Decoration[] = [];
          state.doc.descendants((node, position) => {
            if (!isNoteExcerptNode(node)) return;
            decorations.push(Decoration.node(position, position + node.nodeSize, { class: "note-excerpt" }));
            const footer = node.lastChild!;
            const footerStart = position + node.nodeSize - 1 - footer.nodeSize;
            decorations.push(Decoration.node(footerStart, footerStart + footer.nodeSize, { class: "note-excerpt-source" }));
            return false;
          });
          return DecorationSet.create(state.doc, decorations);
        },
      },
    })];
  },
});
