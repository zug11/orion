// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import TaskList from "@tiptap/extension-task-list";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { activateMarginTarget, applyNoteMargins, captureMarginTarget, finishMarginAdjustment, getNoteMargins, NoteMarkdown, NoteMargins, restoreMarginSelection } from "./NoteMargins";

const editors: Editor[] = [];
function create(markdown: string) {
  const editor = new Editor({ extensions: [NoteStarterKit, NoteMargins, TaskList, NoteTaskItem.configure({ nested: true }), Table, TableRow, TableCell, TableHeader, NoteMarkdown],
    content: markdown, contentType: "markdown", editorProps: { handleScrollToSelection: () => true } });
  editors.push(editor);
  return editor;
}
function selectText(editor: Editor) { editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 }); }
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

describe("portable document and paragraph margins", () => {
  it("leaves default Markdown unchanged and applies document margins as undoable root attributes", () => {
    const editor = create("Ordinary **prose**.");
    expect(editor.getMarkdown()).toBe("Ordinary **prose**.");
    const target = captureMarginTarget(editor);
    expect(target.scope).toBe("document");
    expect(applyNoteMargins(editor, target, { left: 12, right: 7 })).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.marginLeft).toBe(0);
    expect(editor.view.dom.style.marginLeft).toBe("12%");
    const saved = editor.getMarkdown();
    expect(saved).toBe("<!-- orion-document-margins:v1 12 7 -->\n\nOrdinary **prose**.");
    expect(create(saved).getJSON()).toEqual(editor.getJSON());
    expect(editor.commands.undo()).toBe(true);
    expect(editor.view.dom.style.marginLeft).toBe("0%");
    expect(editor.getMarkdown()).toBe("Ordinary **prose**.");
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getMarkdown()).toBe(saved);
  });

  it("retains margins on an empty document and resets or restores them during external content replacement", () => {
    const editor = create("<!-- orion-document-margins:v1 9 11 -->");
    expect(editor.state.doc.attrs.marginLeft).toBe(9);
    expect(editor.getMarkdown()).toBe("<!-- orion-document-margins:v1 9 11 -->");
    editor.commands.setContent("Plain.", { contentType: "markdown" });
    expect(editor.state.doc.attrs.marginLeft).toBe(0);
    editor.commands.setContent("<!-- orion-document-margins:v1 3 4 -->\n\nLoaded.", { contentType: "markdown" });
    expect(editor.state.doc.attrs.marginLeft).toBe(3);
    expect(editor.state.doc.attrs.marginRight).toBe(4);
    expect(editor.view.dom.textContent).toBe("Loaded.");
  });

  it("changes just selected paragraphs and excludes a selection ending at the next paragraph start", () => {
    const editor = create("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.");
    const secondStart = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection({ from: 3, to: secondStart });
    const target = captureMarginTarget(editor);
    expect(getNoteMargins(editor, target).count).toBe(1);
    applyNoteMargins(editor, target, { left: 15, right: 6 });
    expect(editor.state.doc.child(0).attrs.marginLeft).toBe(15);
    expect(editor.state.doc.child(1).attrs.marginLeft).toBe(0);
    expect(editor.state.doc.attrs.marginLeft).toBe(0);
    expect(editor.state.doc.child(0).type.name).toBe("paragraph");
    expect(editor.getMarkdown()).not.toContain("orion-block");
    expect(editor.view.dom.querySelector("p")?.style.marginRight).toBe("6%");
  });

  it("keeps a captured paragraph target while toolbar controls take focus and preserves mixed opposite margins", () => {
    const editor = create("First. <!-- orion-paragraph-margins:v1 4 6 -->\n\nSecond. <!-- orion-paragraph-margins:v1 9 12 -->\n\nThird.");
    const last = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1;
    editor.commands.setTextSelection({ from: 1, to: last });
    const target = captureMarginTarget(editor);
    expect(getNoteMargins(editor, target)).toMatchObject({ left: null, right: null, count: 2 });
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    applyNoteMargins(editor, target, { left: 10 });
    expect(getNoteMargins(editor, target)).toMatchObject({ left: 10, right: null });
    expect(editor.state.doc.child(0).attrs.marginRight).toBe(6);
    expect(editor.state.doc.child(1).attrs.marginRight).toBe(12);
    expect(editor.state.doc.child(2).attrs.marginLeft).toBe(0);
    expect(restoreMarginSelection(editor, target)).toBe(true);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(last);
  });

  it.each(["A paragraph.", "### A heading", "> A quoted paragraph.", "- [ ] A task.\n  - [x] Nested task.", "- A list item.\n  - Nested item."])("round trips existing structure and marks: %s", (markdown) => {
    const editor = create(markdown);
    selectText(editor);
    applyNoteMargins(editor, captureMarginTarget(editor), { left: 8, right: 13 });
    const saved = editor.getMarkdown();
    const restored = create(saved);
    expect(restored.getJSON()).toEqual(editor.getJSON());
    expect(restored.getMarkdown()).toBe(saved);
    expect(restored.view.dom.textContent).not.toContain("orion-paragraph-margins");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).not.toContain("orion-paragraph-margins");
  });

  it.each([
    "<!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 3 7 -->",
    "<!-- orion-paragraph-margins:v1 3 7 --> <!-- orion-text:v1 justify -->",
  ])("accepts justification and margins in either order: %s", (markers) => {
    const editor = create(`**Text**. ${markers}`);
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({ marginLeft: 3, marginRight: 7, textAlign: "justify" });
    expect(create(editor.getMarkdown()).getJSON()).toEqual(editor.getJSON());
  });

  it("does not apply malformed metadata or interpret literal code examples", () => {
    const editor = create("```html\n<!-- orion-document-margins:v1 4 5 -->\n<!-- orion-paragraph-margins:v1 8 9 -->\n```\n\nProse. <!-- orion-paragraph-margins:v1 99 1 -->");
    expect(editor.state.doc.attrs.marginLeft).toBe(0);
    expect(editor.state.doc.lastChild?.attrs.marginLeft).toBe(0);
    expect(editor.state.doc.firstChild?.textContent).toContain("orion-paragraph-margins");
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 0)));
    const target = captureMarginTarget(editor);
    expect(target.available).toBe(false);
    expect(applyNoteMargins(editor, target, { left: 12 })).toBe(false);
  });

  it("groups a slider session separately from preceding and subsequent typing", () => {
    const editor = create("Draft.");
    editor.commands.insertContent("Typed ");
    const typed = editor.getMarkdown();
    const target = captureMarginTarget(editor);
    applyNoteMargins(editor, target, { left: 4 });
    applyNoteMargins(editor, target, { left: 8 });
    applyNoteMargins(editor, target, { left: 12 });
    finishMarginAdjustment(editor, target);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(typed);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("Draft.");
  });

  it("invalidates a captured target when another note replaces the document", () => {
    const editor = create("Original.");
    selectText(editor);
    const target = captureMarginTarget(editor);
    editor.commands.setContent("Different note.", { contentType: "markdown" });
    expect(applyNoteMargins(editor, target, { left: 12 })).toBe(false);
    expect(editor.getMarkdown()).toBe("Different note.");
  });

  it("treats Select All as paragraph selection without formatting table cells", () => {
    const editor = create("First.\n\n| Header |\n| --- |\n| Cell |\n\nLast.");
    editor.commands.selectAll();
    const target = captureMarginTarget(editor);
    expect(getNoteMargins(editor, target)).toMatchObject({ scope: "paragraphs", available: true, count: 2 });
    expect(applyNoteMargins(editor, target, { left: 8 })).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.marginLeft).toBe(8);
    expect(editor.state.doc.lastChild?.attrs.marginLeft).toBe(8);
    const table = editor.state.doc.child(1);
    expect(table.firstChild?.firstChild?.firstChild?.attrs.marginLeft).toBe(0);
    expect(editor.state.doc.attrs.marginLeft).toBe(0);
    restoreMarginSelection(editor, target);
    expect(editor.state.selection.constructor.name).toBe("AllSelection");
  });

  it("does not treat a selected cell or selected code text as document margins", () => {
    const editor = create("| Header |\n| --- |\n| Cell |");
    editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 2)));
    const target = captureMarginTarget(editor);
    expect(getNoteMargins(editor, target).available).toBe(false);
    expect(applyNoteMargins(editor, target, { left: 8 })).toBe(false);
    const code = create("```\nCode example.\n```");
    code.commands.setTextSelection({ from: 1, to: 6 });
    expect(getNoteMargins(code).available).toBe(false);
    expect(code.state.doc.attrs.marginLeft).toBe(0);
  });

  it("maps a captured paragraph through ordinary typing without changing the document margins", () => {
    const editor = create("First.\n\nSecond.");
    editor.commands.setTextSelection({ from: 1, to: 5 });
    const target = captureMarginTarget(editor);
    editor.commands.setTextSelection(2);
    editor.commands.insertContent("more");
    expect(applyNoteMargins(editor, target, { right: 5 })).toBe(true);
    expect(editor.state.doc.firstChild?.attrs.marginRight).toBe(5);
    expect(editor.state.doc.lastChild?.attrs.marginRight).toBe(0);
  });

  it("reactivates the same captured target after control effect cleanup and replay", () => {
    const editor = create("Original paragraph.\n\nLeave alone.");
    editor.commands.setTextSelection({ from: 1, to: 9 });
    const target = captureMarginTarget(editor);
    finishMarginAdjustment(editor, target);
    expect(activateMarginTarget(editor, target)).toBe(true);
    expect(applyNoteMargins(editor, target, { left: 8 })).toBe(true);
    expect(applyNoteMargins(editor, target, { right: 12 })).toBe(true);
    expect(editor.state.doc.firstChild?.attrs).toMatchObject({ marginLeft: 8, marginRight: 12 });
    expect(editor.state.doc.lastChild?.attrs).toMatchObject({ marginLeft: 0, marginRight: 0 });
    finishMarginAdjustment(editor, target);
    editor.commands.setContent("Another note.", { contentType: "markdown" });
    expect(activateMarginTarget(editor, target)).toBe(false);
    expect(applyNoteMargins(editor, target, { left: 4 })).toBe(false);
  });

  it("starts a separate margin undo event if text changes during an open session", () => {
    const editor = create("Draft.");
    const target = captureMarginTarget(editor);
    applyNoteMargins(editor, target, { left: 4 });
    editor.commands.insertContent("New ");
    applyNoteMargins(editor, target, { right: 8 });
    editor.commands.undo();
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 4, marginRight: 0 });
    expect(editor.state.doc.textContent).toBe("New Draft.");
  });

  it("makes each completed ruler drag one undo step while preserving surrounding typing", () => {
    const editor = create("Draft.");
    editor.commands.insertContent("New ");
    const leftDrag = captureMarginTarget(editor);
    applyNoteMargins(editor, leftDrag, { left: 3 });
    applyNoteMargins(editor, leftDrag, { left: 7 });
    applyNoteMargins(editor, leftDrag, { left: 12 });
    finishMarginAdjustment(editor, leftDrag);
    const rightDrag = captureMarginTarget(editor);
    applyNoteMargins(editor, rightDrag, { right: 4 });
    applyNoteMargins(editor, rightDrag, { right: 8 });
    finishMarginAdjustment(editor, rightDrag);
    editor.commands.undo();
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 12, marginRight: 0 });
    editor.commands.undo();
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 0, marginRight: 0 });
    expect(editor.state.doc.textContent).toBe("New Draft.");
  });
});
