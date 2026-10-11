// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { NoteBlock } from "./NoteBlock";
import { NoteMarkdown, NoteMargins } from "./NoteMargins";
import { NoteStarterKit } from "./NoteStarterKit";

const editors: Editor[] = [];
function create(content: string | JSONContent) {
  const editor = new Editor({
    extensions: [NoteStarterKit, NoteBlock, NoteMargins, NoteMarkdown],
    content, ...(typeof content === "string" ? { contentType: "markdown" } : {}),
  });
  editors.push(editor);
  return editor;
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

const prose = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const formatting = { textAlign: "justify", marginLeft: 3, marginRight: 7 };

describe("formatted blank paragraphs", () => {
  it("retains a single blank paragraph's formatting without adding visible text", () => {
    const editor = create({ type: "doc", content: [{ type: "paragraph", attrs: formatting }] });
    const saved = editor.getMarkdown();
    expect(saved).toBe("&nbsp; <!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 3 7 -->");
    expect(create(saved).getJSON()).toEqual(editor.getJSON());
    expect(create(saved).view.dom.textContent).toBe("");
  });

  it.each([false, true])("retains five blank paragraphs and their formatting after repeated saves (framed: %s)", (framed) => {
    const paragraphs = [prose("Before."), ...Array.from({ length: 5 }, () => ({ type: "paragraph", attrs: formatting })), prose("After.")];
    let editor = create({ type: "doc", content: framed ? [{ type: "noteBlock", content: paragraphs }] : paragraphs });
    const original = editor.getJSON();
    for (let round = 0; round < 3; round += 1) {
      const saved = editor.getMarkdown();
      expect(saved).not.toContain("&amp;nbsp;");
      editor = create(saved);
      expect(editor.getJSON()).toEqual(original);
      expect(editor.view.dom.textContent).toBe("Before.After.");
      expect(editor.getMarkdown()).toBe(saved);
    }
  });

  it.each([
    "<!-- orion-text:v1 justify -->",
    "<!-- orion-paragraph-margins:v1 3 7 -->",
    "<!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 3 7 -->",
    "<!-- orion-paragraph-margins:v1 3 7 --> <!-- orion-text:v1 justify -->",
  ])("reads the portable blank marker before formatting metadata: %s", (markers) => {
    const editor = create(`Before.\n\n&nbsp; ${markers}\n\nAfter.`);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(1).content.size).toBe(0);
    expect(editor.view.dom.textContent).toBe("Before.After.");
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });

  it("preserves intentionally literal entities, escaped ampersands, and code examples", () => {
    const markdown = [
      "&amp;nbsp; <!-- orion-text:v1 justify -->",
      "\\&nbsp; <!-- orion-text:v1 justify -->",
      "Prose &nbsp; between words. <!-- orion-text:v1 justify -->",
      "`&nbsp;` <!-- orion-text:v1 justify -->",
      "```html\n&nbsp; <!-- orion-text:v1 justify -->\n```",
      "# &nbsp; <!-- orion-text:v1 justify -->",
    ].join("\n\n");
    const editor = create(markdown);
    expect(editor.state.doc.child(0).textContent).toBe("&nbsp;");
    expect(editor.state.doc.child(1).textContent).toBe("&nbsp;");
    expect(editor.state.doc.child(2).textContent).toBe("Prose &nbsp; between words.");
    expect(editor.state.doc.child(3).textContent).toBe("&nbsp;");
    expect(editor.state.doc.child(4).textContent).toBe("&nbsp; <!-- orion-text:v1 justify -->");
    expect(editor.state.doc.child(5).textContent).toBe("&nbsp;");
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });
});
