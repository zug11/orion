import { describe, expect, it } from "vitest";
import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { NoteImage, moveNoteImage, noteImageDragKey } from "./NoteImage";
import { NoteBlock } from "./NoteBlock";

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

function framedEditor(children: JSONContent[], surroundings = true) {
  return new Editor({
    // Isolate the bare sole-frame case from the ordinary editor plugin that
    // adds an editable trailing paragraph after terminal atoms and frames.
    extensions: [StarterKit.configure({ trailingNode: surroundings ? {} : false }), NoteImage, NoteBlock.extend({
      addAttributes: () => ({ frameId: { default: null } }),
    }), Markdown],
    content: { type: "doc", content: [
      ...(surroundings ? [{ type: "paragraph", content: [{ type: "text", text: "Outside before." }] }] : []),
      { type: "noteBlock", attrs: { frameId: "keep-frame" }, content: children },
      ...(surroundings ? [{ type: "paragraph", content: [{ type: "text", text: "Outside after." }] }] : []),
    ] },
  });
}

const framedImage: JSONContent = { type: "image", attrs: {
  src, alt: "Framed image", widthPercent: 36, caption: "Keep this caption", showCaption: true,
} };

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

  it("hides the source frame through decorations without DOM reparsing or losing image selection", async () => {
    const editor = framedEditor([framedImage]);
    try {
      const from = editor.state.doc.firstChild!.nodeSize;
      const frame = editor.state.doc.child(1);
      editor.commands.setNodeSelection(from + 1);
      const before = editor.state.doc;
      const markdown = editor.getMarkdown();
      const selection = editor.state.selection.toJSON();
      const sourceDOM = editor.view.nodeDOM(from) as HTMLElement;
      let updates = 0;
      editor.on("update", () => { updates += 1; });
      const element = document.createElement("div");
      element.className = "note-block-node";
      element.setAttribute("data-note-block", "true");
      element.contentEditable = "false";
      const exclusion = document.createElement("div");
      exclusion.className = "note-image-drag-exclusion";
      element.append(exclusion);
      editor.view.dispatch(editor.state.tr.setMeta(noteImageDragKey, {
        position: from, element, key: "framed-drag", hiddenFrame: { from, to: from + frame.nodeSize },
      }).setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
      expect(sourceDOM.style.display).toBe("none");
      // Same-anchor pointer movement changes only the owned widget's styles.
      exclusion.style.width = "100%";
      exclusion.style.paddingTop = "95px";
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(editor.state.doc).toBe(before);
      expect(editor.state.selection.toJSON()).toEqual(selection);
      expect(editor.getMarkdown()).toBe(markdown);
      expect(updates).toBe(0);
      editor.view.dispatch(editor.state.tr.setMeta(noteImageDragKey, null).setMeta("addToHistory", false));
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(sourceDOM.style.display).toBe("");
      expect(editor.state.doc).toBe(before);
      expect(editor.state.selection.toJSON()).toEqual(selection);
      expect(editor.commands.undo()).toBe(false);
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

  it("carries an image-only frame across an anchor change without leaving an empty frame", () => {
    const editor = framedEditor([framedImage]);
    try {
      const before = editor.state.doc.toJSON();
      const frameFrom = editor.state.doc.firstChild!.nodeSize;
      const target = editor.state.doc.content.size;
      expect(moveNoteImage(editor, frameFrom + 1, target, { xPercent: 23.47, offsetY: 71, placement: "wrap" })).toBe(true);
      expect(editor.state.doc.childCount).toBe(4);
      const frame = editor.state.doc.child(2);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      expect(editor.state.doc.lastChild?.content.size).toBe(0);
      expect(frame.type.name).toBe("noteBlock");
      expect(frame.attrs.frameId).toBe("keep-frame");
      expect(frame.childCount).toBe(1);
      expect(frame.firstChild?.attrs).toMatchObject({
        src, alt: "Framed image", xPercent: 23.47, offsetY: 71, widthPercent: 36,
        caption: "Keep this caption", showCaption: true,
      });
      expect(editor.state.doc.textContent).toBe("Outside before.Outside after.");
      expect(editor.state.selection.from).toBe(editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize - frame.nodeSize + 1);
      const after = editor.state.doc.toJSON();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(before);
      expect(editor.commands.undo()).toBe(false);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(after);
    } finally { editor.destroy(); }
  });

  it("moves a framed image earlier and retains its frame after Markdown reopen", () => {
    const editor = framedEditor([framedImage]);
    const reopened = framedEditor([framedImage]);
    try {
      const frameFrom = editor.state.doc.firstChild!.nodeSize;
      expect(moveNoteImage(editor, frameFrom + 1, 0, { xPercent: 12.5, offsetY: 20, placement: "wrap" })).toBe(true);
      expect(editor.state.doc.firstChild?.type.name).toBe("noteBlock");
      reopened.commands.setContent(editor.getMarkdown(), { contentType: "markdown" });
      expect(reopened.state.doc.firstChild?.type.name).toBe("noteBlock");
      expect(reopened.state.doc.firstChild?.firstChild?.attrs).toMatchObject({
        src, xPercent: 12.5, offsetY: 20, placement: "wrap", caption: "Keep this caption",
      });
    } finally { editor.destroy(); reopened.destroy(); }
  });

  it("updates a sole image-only frame without creating an orphan paragraph", () => {
    const editor = framedEditor([framedImage], false);
    try {
      const before = editor.state.doc.toJSON();
      expect(moveNoteImage(editor, 1, 0, { xPercent: 150, offsetY: 20_000, placement: "wrap" })).toBe(true);
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.childCount).toBe(1);
      expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject({ xPercent: 64, offsetY: 10_000 });
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(before);
    } finally { editor.destroy(); }
  });

  it("reanchors within a mixed frame while retaining every sibling and the frame", () => {
    const editor = framedEditor([
      { type: "paragraph", content: [{ type: "text", text: "Inside before." }] },
      framedImage,
      { type: "paragraph", content: [{ type: "text", text: "Inside after." }] },
    ]);
    try {
      const before = editor.state.doc.toJSON();
      const frameFrom = editor.state.doc.firstChild!.nodeSize;
      const frame = editor.state.doc.child(1);
      const imagePosition = frameFrom + 1 + frame.firstChild!.nodeSize;
      expect(moveNoteImage(editor, imagePosition, frameFrom + 1, { xPercent: 18, offsetY: 95, placement: "wrap" })).toBe(true);
      const movedFrame = editor.state.doc.child(1);
      expect(movedFrame.attrs.frameId).toBe("keep-frame");
      expect(movedFrame.childCount).toBe(3);
      expect(movedFrame.firstChild?.type.name).toBe("image");
      expect(movedFrame.firstChild?.attrs).toMatchObject({ src, xPercent: 18, offsetY: 95, caption: "Keep this caption" });
      expect(movedFrame.child(1).textContent).toBe("Inside before.");
      expect(movedFrame.child(2).textContent).toBe("Inside after.");
      expect(editor.state.doc.childCount).toBe(3);
      expect(editor.state.doc.firstChild?.textContent).toBe("Outside before.");
      expect(editor.state.doc.lastChild?.textContent).toBe("Outside after.");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(before);
    } finally { editor.destroy(); }
  });

  it("rejects extracting an image from mixed content or placing it inside another frame", () => {
    const editor = framedEditor([framedImage, { type: "paragraph", content: [{ type: "text", text: "Keep me grouped." }] }]);
    try {
      const before = editor.state.doc;
      const frameFrom = before.firstChild!.nodeSize;
      const source = frameFrom + 1;
      for (const target of [0, frameFrom, before.content.size, source + 3]) {
        expect(moveNoteImage(editor, source, target, { xPercent: 20, offsetY: 30, placement: "wrap" })).toBe(false);
        expect(editor.state.doc).toBe(before);
      }
      expect(editor.commands.undo()).toBe(false);
    } finally { editor.destroy(); }
  });
});
