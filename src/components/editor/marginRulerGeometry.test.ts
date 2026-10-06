// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import TaskList from "@tiptap/extension-task-list";
import { afterEach, describe, expect, it } from "vitest";
import { captureMarginTarget, NoteMarkdown, NoteMargins } from "./NoteMargins";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { marginFromRulerPointer, marginRulerPosition, measureMarginRuler, rulerContentBox, type MarginRulerGeometry } from "./marginRulerGeometry";

const editors: Editor[] = [];
const surfaces: HTMLElement[] = [];
function box(element: HTMLElement, left: number, width: number) {
  element.getBoundingClientRect = () => ({ left, right: left + width, width, height: 400, top: 0, bottom: 400, x: left, y: 0, toJSON: () => ({}) });
}
function create(markdown: string) {
  const surface = document.createElement("div");
  surface.className = "editor-prose";
  document.body.append(surface);
  surfaces.push(surface);
  const editor = new Editor({ element: surface, extensions: [NoteStarterKit, TaskList, NoteTaskItem.configure({ nested: true }), NoteMargins, NoteMarkdown], content: markdown, contentType: "markdown" });
  editors.push(editor);
  box(surface, 100, 800);
  box(editor.view.dom, 100, 800);
  editor.view.dom.style.padding = "3px 4px 54px";
  return { editor, surface };
}
afterEach(() => {
  editors.splice(0).forEach(editor => editor.destroy());
  surfaces.splice(0).forEach(surface => surface.remove());
});

describe("margin ruler layout", () => {
  it("uses the unindented writing width as the document basis, including editor text padding", () => {
    const { editor } = create("<!-- orion-document-margins:v1 10 10 -->\n\nDocument.");
    box(editor.view.dom, 180, 640);
    const geometry = measureMarginRuler(editor)!;
    expect(geometry).toEqual({ left: 100, width: 800, start: 4, end: 796, basis: 800, leftValue: 10, rightValue: 10, scope: "document" });
    expect(marginRulerPosition(geometry, "left")).toBe(84);
    expect(marginRulerPosition(geometry, "right")).toBe(716);
    expect(marginFromRulerPointer(geometry, "left", 184)).toBe(10);
    expect(marginFromRulerPointer(geometry, "right", 816)).toBe(10);
  });

  it("anchors highlighted paragraph percentages inside existing document margins", () => {
    const { editor } = create("<!-- orion-document-margins:v1 10 10 -->\n\nSelected. <!-- orion-paragraph-margins:v1 5 15 -->");
    box(editor.view.dom, 180, 640);
    editor.commands.setTextSelection({ from: 1, to: 8 });
    const geometry = measureMarginRuler(editor)!;
    expect(geometry).toEqual({ left: 100, width: 800, start: 84, end: 716, basis: 632, leftValue: 5, rightValue: 15, scope: "paragraphs" });
    expect(marginRulerPosition(geometry, "left")).toBeCloseTo(115.6);
    expect(marginFromRulerPointer(geometry, "right", 721.2)).toBe(15);
  });

  it("uses the first selected paragraph as a mixed-selection guide and includes list indentation", () => {
    const { editor } = create("- First. <!-- orion-paragraph-margins:v1 5 15 -->\n- Second. <!-- orion-paragraph-margins:v1 12 3 -->");
    const listItems = editor.view.dom.querySelectorAll("li");
    listItems.forEach(item => box(item, 140, 750));
    editor.commands.selectAll();
    const geometry = measureMarginRuler(editor)!;
    expect(geometry).toEqual({ left: 100, width: 800, start: 40, end: 790, basis: 750, leftValue: 5, rightValue: 15, scope: "paragraphs" });
    expect(marginRulerPosition(geometry, "left")).toBe(77.5);
  });

  it("subtracts blockquote border and padding from the paragraph percentage basis", () => {
    const { editor } = create("> Selected quote. <!-- orion-paragraph-margins:v1 5 0 -->");
    const quote = editor.view.dom.querySelector("blockquote")!;
    box(quote, 110, 780);
    quote.style.borderLeft = "3px solid black";
    quote.style.paddingLeft = "20px";
    quote.style.paddingRight = "10px";
    editor.commands.setTextSelection({ from: 2, to: 10 });
    const geometry = measureMarginRuler(editor)!;
    expect(geometry).toMatchObject({ start: 33, end: 780, basis: 747 });
    expect(marginRulerPosition(geometry, "left")).toBeCloseTo(70.35);
  });

  it("uses the task content div so its checkbox stays outside the margin guide", () => {
    const { editor } = create("- [ ] Selected task. <!-- orion-paragraph-margins:v1 10 5 -->");
    const paragraph = editor.view.dom.querySelector("p")!;
    expect(paragraph.parentElement?.tagName).toBe("DIV");
    box(paragraph.parentElement!, 125, 771);
    editor.commands.selectAll();
    const geometry = measureMarginRuler(editor)!;
    expect(geometry).toMatchObject({ start: 25, end: 796, basis: 771, scope: "paragraphs" });
    expect(marginRulerPosition(geometry, "left")).toBeCloseTo(102.1);
    expect(marginFromRulerPointer(geometry, "left", 202.1)).toBe(10);
  });

  it("measures a captured target after the visible editor selection changes", () => {
    const { editor } = create("First. <!-- orion-paragraph-margins:v1 8 6 -->\n\nSecond.");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const target = captureMarginTarget(editor);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(measureMarginRuler(editor, target)?.scope).toBe("paragraphs");
    expect(measureMarginRuler(editor, target)?.leftValue).toBe(8);
    expect(measureMarginRuler(editor)?.scope).toBe("document");
  });

  it("uses the same percentage bounds on either side, with inward movement increasing right margin", () => {
    const geometry: MarginRulerGeometry = { left: 100, width: 800, start: 4, end: 796, basis: 800, leftValue: 0, rightValue: 0, scope: "document" };
    expect(marginFromRulerPointer(geometry, "left", 184)).toBe(10);
    expect(marginFromRulerPointer(geometry, "right", 816)).toBe(10);
    expect(marginFromRulerPointer(geometry, "left", -100)).toBe(0);
    expect(marginFromRulerPointer(geometry, "right", 1200)).toBe(0);
    expect(marginFromRulerPointer(geometry, "left", 1000)).toBe(25);
    expect(marginFromRulerPointer(geometry, "right", 0)).toBe(25);
  });

  it("does not invent geometry for hidden or zero-width layout", () => {
    const { editor, surface } = create("Text.");
    box(surface, 100, 0);
    expect(measureMarginRuler(editor)).toBeNull();
    expect(rulerContentBox(surface)).toBeNull();
  });
});
