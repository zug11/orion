import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { NoteImage, moveNoteImage, noteImageDragKey } from "./NoteImage";

const src = "orion-image://localhost/image_Abc-123456789";
function createEditor() {
  return new Editor({
    extensions: [StarterKit, NoteImage, Markdown],
    content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "Before." }] },
      { type: "image", attrs: { src, alt: "First", widthPercent: 36, caption: "First caption", showCaption: true } },
      { type: "paragraph", content: [{ type: "text", text: "Between." }] },
      { type: "image", attrs: { src, alt: "Second", widthPercent: 20, caption: "Second caption" } },
      { type: "paragraph", content: [{ type: "text", text: "After." }] },
    ] },
  });
}

describe("free image movement", () => {
  it("keeps live wrapping out of the document, Markdown, updates, and undo history", () => {
    const editor = createEditor();
    try {
      const before = editor.state.doc;
      const markdown = editor.getMarkdown();
      let updates = 0;
      editor.on("update", () => { updates += 1; });
      const element = document.createElement("div");
      const source = before.firstChild!.nodeSize;
      for (const position of [0, source, source + 1]) {
        editor.view.dispatch(editor.state.tr.setMeta(noteImageDragKey, { position, element, key: "test-drag" })
          .setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
        expect(editor.state.doc).toBe(before);
        expect(editor.getMarkdown()).toBe(markdown);
        expect(noteImageDragKey.getState(editor.state)?.position).toBe(position);
      }
      editor.view.dispatch(editor.state.tr.setMeta(noteImageDragKey, null).setMeta("addToHistory", false));
      expect(noteImageDragKey.getState(editor.state)).toBeNull();
      expect(updates).toBe(0);
      expect(editor.commands.undo()).toBe(false);
      expect(moveNoteImage(editor, source, source, { xPercent: 21.42, offsetY: 75, placement: "wrap" })).toBe(true);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.eq(before)).toBe(true);
    } finally { editor.destroy(); }
  });

  it("clears transient wrapping immediately when another edit changes the document", () => {
    const editor = createEditor();
    try {
      editor.view.dispatch(editor.state.tr.setMeta(noteImageDragKey, {
        position: 0, element: document.createElement("div"), key: "test-drag",
      }).setMeta("addToHistory", false));
      editor.commands.insertContentAt(1, "New ");
      expect(noteImageDragKey.getState(editor.state)).toBeNull();
      expect(editor.state.doc.firstChild?.textContent).toBe("New Before.");
    } finally { editor.destroy(); }
  });

  it("keeps continuous coordinates, the exact image, and one-step history across an anchor change", () => {
    const editor = createEditor();
    try {
      const before = editor.state.doc.toJSON();
      const source = editor.state.doc.firstChild!.nodeSize;
      const target = source + 1 + editor.state.doc.child(2).nodeSize + 1;
      expect(moveNoteImage(editor, source, target, { xPercent: 23.47, offsetY: 71, placement: "wrap" })).toBe(true);
      const moved: JSONContent = editor.state.doc.toJSON();
      expect(moved.content!.find((node) => node.attrs?.alt === "First")?.attrs).toMatchObject({
        src, xPercent: 23.47, offsetY: 71, widthPercent: 36, caption: "First caption", showCaption: true, placement: "wrap",
      });
      expect(moved.content!.find((node) => node.attrs?.alt === "Second")?.attrs).toMatchObject({
        src, xPercent: null, offsetY: 0, widthPercent: 20, caption: "Second caption",
      });
      expect(editor.state.doc.textContent).toBe("Before.Between.After.");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(before);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(moved);
    } finally { editor.destroy(); }
  });

  it("keeps a centred free image wrapped and restores it from ordinary Markdown metadata", () => {
    const editor = createEditor();
    const reopened = createEditor();
    try {
      const source = editor.state.doc.firstChild!.nodeSize;
      expect(moveNoteImage(editor, source, source, { xPercent: 32, offsetY: 137, placement: "wrap" })).toBe(true);
      expect(editor.state.doc.nodeAt(source)?.attrs).toMatchObject({ alignment: "center", xPercent: 32, offsetY: 137, placement: "wrap" });
      reopened.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
      expect(reopened.state.doc.nodeAt(source)?.attrs).toMatchObject({ xPercent: 32, offsetY: 137, placement: "wrap", caption: "First caption" });
      expect(moveNoteImage(editor, source, source, "left")).toBe(true);
      expect(editor.state.doc.nodeAt(source)?.attrs).toMatchObject({ alignment: "left", xPercent: null, offsetY: 0 });
    } finally { editor.destroy(); reopened.destroy(); }
  });
});
