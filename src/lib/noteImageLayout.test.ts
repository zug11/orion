import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { NoteImage, moveNoteImage, updateSelectedNoteImage } from "../components/editor/NoteImage";
import {
  defaultNoteImageLayout,
  normalizeNoteImageLayout,
  noteImageLayoutStyle,
  noteImageContentStyle,
  noteImageContentCss,
  parseNoteImageTitle,
  serializeNoteImageTitle,
} from "./noteImageLayout";

const src = "orion-image://localhost/image_Abc-123456789";
function createEditor(markdown: string) {
  return new Editor({
    extensions: [StarterKit, NoteImage.configure({ allowBase64: true }), Markdown],
    content: markdown,
    contentType: "markdown",
  });
}

describe("portable note image layout", () => {
  it("leaves ordinary image titles intact and encodes optional layout safely", () => {
    expect(serializeNoteImageTitle(defaultNoteImageLayout, "Original title")).toBe("Original title");
    const layout = { ...defaultNoteImageLayout, placement: "wrap" as const, alignment: "right" as const,
      widthPercent: 47, gap: 24, showCaption: true, caption: 'A caption with "quotes", [brackets] and 日本語.' };
    const title = serializeNoteImageTitle(layout, "Original title");
    expect(title).not.toContain('"');
    expect(parseNoteImageTitle(title)).toEqual({ layout, title: "Original title" });
    expect(parseNoteImageTitle("An ordinary title").title).toBe("An ordinary title");
  });

  it("bounds metadata and never admits raw CSS or invalid numbers", () => {
    const layout = normalizeNoteImageLayout({ placement: "absolute", alignment: "url(javascript:bad)",
      widthPercent: Infinity, gap: -1000, caption: "x".repeat(600), showCaption: "yes" });
    expect(layout).toEqual({ ...defaultNoteImageLayout, gap: 8, caption: "x".repeat(500) });
    expect(noteImageLayoutStyle({ ...layout, widthPercent: 9000 }).width).toBe("100%");
    expect(parseNoteImageTitle("orion-image-layout:v1:%broken").layout).toEqual(defaultNoteImageLayout);
    expect(parseNoteImageTitle("orion-image-layout:v1:" + "x".repeat(9000)).layout).toEqual(defaultNoteImageLayout);
  });

  it("round-trips captions, original title and layout through Markdown without HTML", () => {
    const title = serializeNoteImageTitle({ placement: "wrap", alignment: "left", widthPercent: 45, gap: 20,
      xPercent: 17.25, offsetY: 140, caption: "<script>alert('x')</script> & a caption", showCaption: true }, "A title");
    const input = `Before.\n\n![A landscape](${src} "${title}")\n\nAfter.`;
    const first = createEditor(input);
    const second = createEditor(first.getMarkdown());
    try {
      const firstImage = first.state.doc.child(1);
      const secondImage = second.state.doc.child(1);
      expect(secondImage.attrs).toEqual(firstImage.attrs);
      expect(secondImage.attrs).toMatchObject({ src, alt: "A landscape", title: "A title", widthPercent: 45, gap: 20,
        xPercent: 17.25, offsetY: 140, placement: "wrap", alignment: "left", caption: "<script>alert('x')</script> & a caption", showCaption: true });
      expect(first.getMarkdown()).not.toContain("<script>");
      expect(second.state.doc.textContent).toBe("Before.After.");
    } finally { first.destroy(); second.destroy(); }
  });

  it("bounds free coordinates to the document and preserves fractional horizontal placement", () => {
    expect(normalizeNoteImageLayout({ widthPercent: 40, xPercent: 17.256, offsetY: 125.8 }))
      .toMatchObject({ widthPercent: 40, xPercent: 17.26, offsetY: 126 });
    expect(normalizeNoteImageLayout({ widthPercent: 85, xPercent: 95, offsetY: 100_000 }))
      .toMatchObject({ xPercent: 15, offsetY: 10_000 });
    expect(normalizeNoteImageLayout({ xPercent: 100, offsetY: -4 }))
      .toMatchObject({ xPercent: 0, offsetY: 0 });
    expect(normalizeNoteImageLayout({ xPercent: '10%;color:red', offsetY: 500 }))
      .toMatchObject({ xPercent: null, offsetY: 0 });
    expect(normalizeNoteImageLayout({ xPercent: NaN, offsetY: Infinity }))
      .toMatchObject({ xPercent: null, offsetY: 0 });
    expect(parseNoteImageTitle('orion-image-layout:v1:' + encodeURIComponent('{"widthPercent":40,"placement":"wrap","alignment":"right"}')).layout)
      .toMatchObject({ xPercent: null, offsetY: 0, widthPercent: 40 });
  });

  it("reserves the image band and wraps on the larger available side without absolute positioning", () => {
    const left = { widthPercent: 40, xPercent: 12.5, offsetY: 80, gap: 18, placement: "wrap" };
    expect(noteImageLayoutStyle(left)).toMatchObject({ width: "100%", float: "left", clear: "both", paddingTop: "98px",
      paddingBottom: "18px", shapeOutside: "inset(80px max(0px, calc(47.5% - 18px)) 0 0)", pointerEvents: "none" });
    expect(noteImageLayoutStyle({ ...left, xPercent: 50 })).toMatchObject({ float: "right",
      shapeOutside: "inset(80px 0 0 max(0px, calc(50% - 18px)))" });
    expect(noteImageLayoutStyle({ ...left, placement: "break" })).toMatchObject({ float: "left", shapeOutside: "inset(80px 0 0 0)" });
    expect(noteImageContentStyle(left)).toMatchObject({ width: "40%", marginLeft: "12.5%", pointerEvents: "auto" });
    expect(noteImageContentCss(left)).toContain("margin-left:12.5%");
    expect(noteImageLayoutStyle(left).position).toBeUndefined();
    expect(noteImageContentStyle(left).position).toBeUndefined();
  });

  it("keeps the legacy aligned-image style path unchanged", () => {
    expect(noteImageLayoutStyle({ widthPercent: 45, alignment: "right", placement: "wrap", gap: 22 })).toEqual({
      display: "block", width: "45%", maxWidth: "100%", float: "right", clear: "right",
      marginTop: "22px", marginBottom: "22px", marginLeft: "22px", marginRight: "0",
    });
    expect(noteImageContentStyle(defaultNoteImageLayout)).toEqual({});
  });

  it("restores a single resize or placement action with one Undo", () => {
    const editor = createEditor(`Before.\n\n![Landscape](${src})\n\nAfter.`);
    try {
      const position = editor.state.doc.child(0).nodeSize;
      editor.commands.setNodeSelection(position);
      expect(updateSelectedNoteImage(editor, { widthPercent: 45, placement: "wrap", alignment: "right" })).toBe(true);
      expect(editor.state.doc.nodeAt(position)?.attrs).toMatchObject({ widthPercent: 45, placement: "wrap", alignment: "right" });
      // Enter followed by input blur can submit identical attributes twice.
      updateSelectedNoteImage(editor, { widthPercent: 45 });
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.nodeAt(position)?.attrs).toMatchObject(defaultNoteImageLayout);
      expect(editor.state.doc.textContent).toBe("Before.After.");
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.nodeAt(position)?.attrs.widthPercent).toBe(45);
    } finally { editor.destroy(); }
  });

  it("preserves layout through safe HTML clipboard serialization", () => {
    const editor = createEditor(`![Landscape](${src})`);
    const copy = createEditor("");
    try {
      editor.commands.setNodeSelection(0);
      updateSelectedNoteImage(editor, { widthPercent: 60, xPercent: 24.75, offsetY: 90, placement: "break", alignment: "right", caption: "Hello", showCaption: true });
      copy.commands.setContent(editor.getHTML(), { contentType: "html" });
      expect(copy.state.doc.firstChild?.attrs).toMatchObject({ src, widthPercent: 60, xPercent: 24.75, offsetY: 90, placement: "break", alignment: "right", caption: "Hello", showCaption: true });
    } finally { editor.destroy(); copy.destroy(); }
  });

  it("moves the exact image between paragraphs with one Undo and preserves duplicate-image attributes", () => {
    const title = serializeNoteImageTitle({ placement: "wrap", alignment: "left", widthPercent: 38, gap: 26,
      caption: "The image being moved", showCaption: true }, "Original title");
    const editor = createEditor(`Before.\n\n![First](${src} "${title}")\n\nMiddle.\n\n![Other copy](${src})\n\nAfter.`);
    try {
      const initial = editor.state.doc.toJSON();
      const from = editor.state.doc.firstChild!.nodeSize;
      expect(moveNoteImage(editor, from, editor.state.doc.content.size, "right")).toBe(true);
      const moved = editor.state.doc.child(editor.state.doc.childCount - 2);
      expect(moved.type.name).toBe("image");
      expect(moved.attrs).toMatchObject({ alt: "First", title: "Original title", caption: "The image being moved",
        showCaption: true, widthPercent: 38, gap: 26, placement: "wrap", alignment: "right" });
      expect(editor.state.doc.child(2).attrs).toMatchObject({ alt: "Other copy", ...defaultNoteImageLayout });
      expect(editor.state.doc.textContent).toBe("Before.Middle.After.");
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(initial);
      expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.child(editor.state.doc.childCount - 2).attrs.caption).toBe("The image being moved");
      const beforeMoveBack = editor.state.doc.toJSON();
      let movedPosition = -1;
      editor.state.doc.forEach((node, position) => { if (node.type.name === "image" && node.attrs.alt === "First") movedPosition = position; });
      expect(moveNoteImage(editor, movedPosition, 0)).toBe(true);
      expect(editor.state.doc.firstChild!.attrs).toEqual(moved.attrs);
      expect(editor.commands.undo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(beforeMoveBack);
    } finally { editor.destroy(); }
  });

  it("does not split prose or add history for a drop at the original anchor", () => {
    const editor = createEditor(`Before.\n\n![Landscape](${src})\n\nAfter.`);
    try {
      const from = editor.state.doc.firstChild!.nodeSize;
      const initial = editor.state.doc.toJSON();
      expect(moveNoteImage(editor, from, from)).toBe(false);
      expect(moveNoteImage(editor, from, from + 1)).toBe(false);
      expect(moveNoteImage(editor, from, 2)).toBe(false);
      expect(moveNoteImage(editor, editor.state.doc.content.size + 2, 0)).toBe(false);
      expect(editor.state.doc.toJSON()).toEqual(initial);
      expect(editor.can().undo()).toBe(false);
    } finally { editor.destroy(); }
  });

  it("does not request unsafe remote or active images through generated HTML", () => {
    const editor = createEditor('![Unsafe](https://example.com/tracker.png)');
    try {
      expect(editor.getHTML()).not.toContain("src=");
      expect(editor.getHTML()).toContain('alt="Unsafe"');
    } finally { editor.destroy(); }
  });
});
