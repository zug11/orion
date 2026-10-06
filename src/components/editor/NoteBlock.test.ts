// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNoteExcerptContent } from "../../lib/noteExcerpts";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { NoteTable } from "./NoteTable";
import { NoteImage } from "./NoteImage";
import { NoteExcerpt } from "./NoteExcerpt";
import { enterNoteBlock, MAX_NOTE_BLOCK_MARKDOWN, NOTE_BLOCK_CLOSE, NOTE_BLOCK_OPEN, NoteBlock } from "./NoteBlock";

const editors: Editor[] = [];
const p = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
function create(content: string | JSONContent, withFrames = true) {
  const editor = new Editor({
    extensions: [
      NoteStarterKit.configure({ link: { protocols: ["orion-note"], HTMLAttributes: { target: null, rel: null } } }), TaskList, NoteTaskItem,
      NoteTable, TableRow, TableHeader, TableCell, NoteImage, NoteExcerpt, ...(withFrames ? [NoteBlock] : []),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content, ...(typeof content === "string" ? { contentType: "markdown" } : {}),
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  return editor;
}
function framed(content: JSONContent[]): JSONContent {
  return { type: "doc", content: [p("Ordinary before"), { type: "noteBlock", content }, p("Ordinary after")] };
}
function wrapper(editor: Editor) {
  let result: typeof editor.state.doc | undefined;
  editor.state.doc.descendants((node) => { if (node.type.name === "noteBlock") { result = node; return false; } });
  if (!result) throw new Error("Expected persistent frame");
  return result;
}
function enter(editor: Editor, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true, cancelable: true, ...options });
  editor.view.dom.dispatchEvent(event);
  return event;
}
function frames(editor: Editor) {
  const result: { node: typeof editor.state.doc; from: number }[] = [];
  editor.state.doc.forEach((node, from) => { if (node.type.name === "noteBlock") result.push({ node, from }); });
  return result;
}
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

describe("persistent explicit note blocks", () => {
  it.each<[string, JSONContent[]]>([
    ["paragraphs", [p("First **literal** words."), p("Second paragraph.")]],
    ["intentional blank paragraphs", [{ type: "paragraph" }, p("Spaced prose"), { type: "paragraph" }, { type: "paragraph" }]],
    ["heading", [{ type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "Deep title" }] }]],
    ["list", [{ type: "bulletList", content: [{ type: "listItem", content: [p("Outer"), {
      type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p("Nested")] }],
    }] }] }]],
    ["table", [{ type: "table", attrs: { tableWidth: 74, banded: false }, content: [{ type: "tableRow", content: [
      { type: "tableCell", attrs: { colwidth: [170] }, content: [p("One")] },
      { type: "tableCell", attrs: { colwidth: [230] }, content: [p("Two")] },
    ] }] }]],
    ["image", [{ type: "image", attrs: { src: "orion-image://localhost/image_Abc-123456789", alt: "Diagram", widthPercent: 36,
      caption: "Caption retained", showCaption: true, placement: "wrap", xPercent: 22.5, offsetY: 123 } }]],
    ["excerpt", [buildNoteExcerptContent({ noteId: "source", title: "Original", text: "Quoted sentence.",
      passages: [{ from: 10, to: 26, text: "Quoted sentence." }] })[0]]],
    ["code", [{ type: "codeBlock", attrs: { language: "markdown" }, content: [{ type: "text", text: `${NOTE_BLOCK_OPEN}\nExample text\n${NOTE_BLOCK_CLOSE}` }] }]],
  ])("roundtrips framed %s through repeated Markdown save and reopen", (_, children) => {
    let editor = create(framed(children));
    const original = wrapper(editor);
    let saved = editor.getMarkdown();
    expect(saved).toContain(`${NOTE_BLOCK_OPEN}\n`);
    expect(saved).toContain(`\n${NOTE_BLOCK_CLOSE}`);
    for (let round = 0; round < 3; round += 1) {
      editor = create(saved);
      expect(wrapper(editor).toJSON()).toEqual(original.toJSON());
      expect(editor.state.doc.firstChild!.type.name).toBe("paragraph");
      expect(editor.state.doc.lastChild!.type.name).toBe("paragraph");
      expect(editor.getMarkdown()).toBe(saved);
      saved = editor.getMarkdown();
    }
  });

  it("keeps its DOM frame after focus leaves without adding a new formatting context", () => {
    const editor = create(framed([p("Inside")]));
    const element = editor.view.dom.querySelector("[data-note-block]")!;
    expect(element.tagName).toBe("DIV");
    expect(element.className).toBe("note-block-node");
    expect(element.getAttribute("style")).toBeNull();
    expect(element.textContent).toBe("Inside");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.view.dom.blur();
    expect(editor.view.dom.querySelector("[data-note-block]")).toBe(element);
    expect(wrapper(editor).textContent).toBe("Inside");
    expect(editor.view.dom.textContent).not.toContain("orion-block");
  });

  it("splits direct prose into sibling frames on Enter and keeps outside prose outside", () => {
    const editor = create(framed([p("Inside text")]));
    const start = editor.state.doc.firstChild!.nodeSize;
    editor.commands.setTextSelection(start + 2 + "Inside".length);
    expect(enter(editor).defaultPrevented).toBe(true);
    expect(frames(editor).map(({ node }) => node.textContent)).toEqual(["Inside", " text"]);
    expect(frames(editor).map(({ node }) => node.childCount)).toEqual([1, 1]);
    expect(editor.state.doc.lastChild!.textContent).toBe("Ordinary after");
  });

  it("gets the editor's ordinary trailing paragraph after insertion of a terminal frame", () => {
    const editor = create({ type: "doc", content: [p("Before")] });
    editor.commands.insertContentAt(editor.state.doc.content.size, { type: "noteBlock", content: [p("Inside")] });
    expect(editor.state.doc.lastChild!.type.name).toBe("paragraph");
    expect(editor.state.doc.lastChild!.textContent).toBe("");
    expect(editor.state.doc.child(editor.state.doc.childCount - 2).type.name).toBe("noteBlock");
  });

  it.each([
    "<!-- orion-block:v2 -->\n\nUnknown version\n\n<!-- /orion-block -->",
    `${NOTE_BLOCK_OPEN}\n\nUnclosed frame`,
    "<!-- orion-block:v1 extra -->\n\nBody\n\n<!-- /orion-block -->",
    `Before ${NOTE_BLOCK_OPEN}\n\nBody\n\n${NOTE_BLOCK_CLOSE}`,
    `    ${NOTE_BLOCK_OPEN}\n    Indented example\n    ${NOTE_BLOCK_CLOSE}`,
    `\`\`\`markdown\n${NOTE_BLOCK_OPEN}\nFenced example\n${NOTE_BLOCK_CLOSE}\n\`\`\``,
    `~~~markdown\n${NOTE_BLOCK_OPEN}\nTilde example\n${NOTE_BLOCK_CLOSE}\n~~~`,
  ])("does not claim malformed markers or code examples: %s", (markdown) => {
    const ordinary = create(markdown, false);
    const editor = create(markdown);
    expect(editor.state.doc.toJSON()).toEqual(ordinary.state.doc.toJSON());
    expect(editor.getMarkdown()).toBe(ordinary.getMarkdown());
  });

  it("does not stop on an inner closing marker in a fenced code example", () => {
    const markdown = `${NOTE_BLOCK_OPEN}\n\nBefore\n\n\`\`\`markdown\n${NOTE_BLOCK_CLOSE}\n${NOTE_BLOCK_OPEN}\n\`\`\`\n\nAfter\n\n${NOTE_BLOCK_CLOSE}`;
    const editor = create(markdown);
    expect(wrapper(editor).childCount).toBe(3);
    expect(wrapper(editor).child(1).type.name).toBe("codeBlock");
    expect(wrapper(editor).child(1).textContent).toBe(`${NOTE_BLOCK_CLOSE}\n${NOTE_BLOCK_OPEN}`);
    expect(wrapper(editor).lastChild!.textContent).toBe("After");
  });

  it("flattens deeply nested delimiters in one bounded scan without nested containers", () => {
    const markdown = `${`${NOTE_BLOCK_OPEN}\n`.repeat(2000)}Preserved content\n${`${NOTE_BLOCK_CLOSE}\n`.repeat(2000)}`;
    const editor = create(markdown);
    let count = 0;
    editor.state.doc.descendants((node) => { if (node.type.name === "noteBlock") count += 1; });
    expect(count).toBe(1);
    expect(wrapper(editor).textContent).toBe("Preserved content");
    expect(wrapper(editor).content.size).toBeLessThan(100);
  });

  it("bounds the custom tokenizer instead of partially consuming overlong content", () => {
    const source = `${NOTE_BLOCK_OPEN}\n${"x".repeat(MAX_NOTE_BLOCK_MARKDOWN)}\n${NOTE_BLOCK_CLOSE}`;
    const tokenize = NoteBlock.config.markdownTokenizer!.tokenize;
    let parsed = false;
    expect(tokenize(source, [], { blockTokens: () => { parsed = true; return []; }, inlineTokens: () => [] })).toBeUndefined();
    expect(parsed).toBe(false);
  });

  it("retains an empty explicit frame as an editable paragraph on reopen", () => {
    const editor = create(`${NOTE_BLOCK_OPEN}\n\n${NOTE_BLOCK_CLOSE}`);
    expect(wrapper(editor).childCount).toBe(1);
    expect(wrapper(editor).firstChild!.type.name).toBe("paragraph");
    expect(wrapper(editor).textContent).toBe("");
    const reopened = create(editor.getMarkdown());
    expect(wrapper(reopened).toJSON()).toEqual(wrapper(editor).toJSON());
  });

  it("does not join adjacent frames or pull surrounding prose into them", () => {
    const editor = create(`${NOTE_BLOCK_OPEN}\nFirst\n${NOTE_BLOCK_CLOSE}\n\n${NOTE_BLOCK_OPEN}\nSecond\n${NOTE_BLOCK_CLOSE}\n\nOutside`);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0).type.name).toBe("noteBlock");
    expect(editor.state.doc.child(0).textContent).toBe("First");
    expect(editor.state.doc.child(1).type.name).toBe("noteBlock");
    expect(editor.state.doc.child(1).textContent).toBe("Second");
    expect(editor.state.doc.child(2).type.name).toBe("paragraph");
    expect(editor.state.doc.child(2).textContent).toBe("Outside");
  });

  it.each([0, 3, 6])("splits at offset %s and places the caret inside the right sibling", (offset) => {
    const editor = create(framed([p("Before")]));
    const from = frames(editor)[0].from;
    editor.commands.setTextSelection(from + 2 + offset);
    const before = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    enter(editor);
    const blocks = frames(editor);
    expect(blocks.map(({ node }) => node.textContent)).toEqual(["Before".slice(0, offset), "Before".slice(offset)]);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.from).toBe(blocks[1].from + 2);
    expect(editor.state.selection.empty).toBe(true);
    const after = editor.state.doc;
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(false);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.eq(after)).toBe(true);
  });

  it("creates new text frames on repeated Enter from an empty paragraph and persists them", () => {
    const editor = create(framed([{ type: "paragraph" }]));
    editor.commands.setTextSelection(frames(editor)[0].from + 2);
    enter(editor); enter(editor); enter(editor);
    expect(frames(editor)).toHaveLength(4);
    expect(frames(editor).every(({ node }) => node.childCount === 1 && node.firstChild!.type.name === "paragraph" && !node.textContent)).toBe(true);
    expect(editor.state.selection.from).toBe(frames(editor)[3].from + 2);
    const reopened = create(editor.getMarkdown());
    expect(reopened.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
    for (let expected = 3; expected >= 1; expected -= 1) {
      expect(editor.commands.undo()).toBe(true);
      expect(frames(editor)).toHaveLength(expected);
    }
  });

  it("preserves heading attrs, rich marks and later child content on an interior split", () => {
    const editor = create(framed([
      p("Prior child"),
      { type: "heading", attrs: { level: 4, textAlign: "justify" }, content: [{ type: "text", text: "Bold words", marks: [{ type: "bold" }, { type: "italic" }] }] },
      { type: "image", attrs: { src: "orion-image://localhost/image_Abc-123456789", alt: "Diagram", widthPercent: 35, placement: "wrap", offsetY: 71, xPercent: 13, caption: "Kept caption", showCaption: true } },
      p("Later child"),
    ]));
    const { node, from } = frames(editor)[0];
    editor.commands.setTextSelection(from + 2 + node.child(0).nodeSize + 4);
    enter(editor);
    const [left, right] = frames(editor);
    expect(left.node.child(0)).toBe(node.child(0));
    expect(left.node.lastChild!.attrs).toEqual(node.child(1).attrs);
    expect(left.node.lastChild!.textContent).toBe("Bold");
    expect(right.node.firstChild!.attrs).toEqual(node.child(1).attrs);
    expect(right.node.firstChild!.textContent).toBe(" words");
    expect(right.node.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(["bold", "italic"]);
    expect(right.node.child(1)).toBe(node.child(2));
    expect(right.node.child(2)).toBe(node.child(3));
    editor.commands.insertContent("New");
    expect(frames(editor)[1].node.firstChild!.firstChild!.marks.map((mark) => mark.type.name)).toEqual(["bold", "italic"]);
    const reopened = create(editor.getMarkdown());
    expect(reopened.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
  });

  it("starts plain text after a heading end while retaining shared alignment", () => {
    const editor = create(framed([{ type: "heading", attrs: { level: 3, textAlign: "justify" }, content: [{ type: "text", text: "Title" }] }]));
    editor.commands.setTextSelection(frames(editor)[0].from + 2 + 5);
    enter(editor);
    const [left, right] = frames(editor);
    expect(left.node.firstChild!.type.name).toBe("heading");
    expect(right.node.firstChild!.type.name).toBe("paragraph");
    expect(right.node.firstChild!.attrs.textAlign).toBe("justify");
    expect(right.node.textContent).toBe("");
  });

  it("keeps current rich formatting when typing in the empty frame created at the end", () => {
    const editor = create(framed([{ type: "paragraph", content: [{ type: "text", text: "Bold", marks: [{ type: "bold" }] }] }]));
    editor.commands.setTextSelection(frames(editor)[0].from + 2 + 4);
    enter(editor);
    editor.commands.insertContent("Continued");
    const next = frames(editor)[1].node.firstChild!.firstChild!;
    expect(next.text).toBe("Continued");
    expect(next.marks.map((mark) => mark.type.name)).toEqual(["bold"]);
  });

  it("reopens a justified marked heading without an invalid empty text token, including ordinary prose mode", () => {
    const markdown = "#### ***Formatted heading*** <!-- orion-text:v1 justify -->\n\n**Formatted paragraph** <!-- orion-text:v1 justify -->";
    const editor = create(markdown, false);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(0).attrs.textAlign).toBe("justify");
    expect(editor.state.doc.child(0).textContent).toBe("Formatted heading");
    expect(editor.state.doc.child(1).attrs.textAlign).toBe("justify");
    expect(editor.state.doc.child(1).textContent).toBe("Formatted paragraph");
    expect(create(editor.getMarkdown(), false).state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
  });

  it("deletes selected text within one frame before splitting and restores the selection with one Undo", () => {
    const editor = create(framed([p("Alpha 123"), p("456 Omega"), p("Kept child")]));
    const { node, from } = frames(editor)[0];
    editor.commands.setTextSelection({ from: from + 2 + 6, to: from + 2 + node.child(0).nodeSize + 3 });
    const before = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    enter(editor);
    const [left, right] = frames(editor);
    expect(left.node.textContent).toBe("Alpha ");
    expect(right.node.child(0).textContent).toBe(" Omega");
    expect(right.node.child(1)).toBe(node.child(2));
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
  });

  it("replaces a selected phrase in one paragraph without losing unselected text", () => {
    const editor = create(framed([p("Keep remove retained")]));
    const from = frames(editor)[0].from + 2;
    editor.commands.setTextSelection({ from: from + 5, to: from + 11 });
    enter(editor);
    expect(frames(editor).map(({ node }) => node.textContent)).toEqual(["Keep ", " retained"]);
    expect(editor.state.selection.from).toBe(frames(editor)[1].from + 2);
  });

  it.each(["frame", "image"])("creates a new empty frame after a selected %s without replacing it", (selected) => {
    const editor = create(framed([{ type: "image", attrs: { src: "orion-image://localhost/image_Abc-123456789", widthPercent: 34, caption: "Original", showCaption: true } }]));
    const { node, from } = frames(editor)[0];
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, from + (selected === "image" ? 1 : 0))));
    const before = editor.state.doc;
    enter(editor);
    const [left, right] = frames(editor);
    expect(left.node).toBe(node);
    expect(right.node.firstChild!.type.name).toBe("paragraph");
    expect(right.node.textContent).toBe("");
    expect(editor.state.selection.from).toBe(right.from + 2);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
  });

  it("isolates Enter from typing immediately before and after it", () => {
    const editor = create(framed([p("Words")]));
    editor.commands.setTextSelection(frames(editor)[0].from + 2 + 5);
    editor.commands.insertContent("!");
    const typed = editor.state.doc;
    enter(editor);
    const split = editor.state.doc;
    editor.commands.insertContent("Following");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(split)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(typed)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(frames(editor)[0].node.textContent).toBe("Words");
    expect(editor.commands.undo()).toBe(false);
  });

  it("keeps Shift+Enter as a hard break within the same frame", () => {
    const editor = create(framed([p("OneTwo")]));
    editor.commands.setTextSelection(frames(editor)[0].from + 2 + 3);
    enter(editor, { shiftKey: true });
    expect(frames(editor)).toHaveLength(1);
    expect(frames(editor)[0].node.firstChild!.child(1).type.name).toBe("hardBreak");
    expect(frames(editor)[0].node.textContent).toBe("OneTwo");
  });

  it.each<[string, JSONContent]>([
    ["list", { type: "bulletList", content: [{ type: "listItem", content: [p("Nested text")] }] }],
    ["table", { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [p("Nested text")] }] }] }],
    ["quote", { type: "blockquote", content: [p("Nested text")] }],
    ["code", { type: "codeBlock", content: [{ type: "text", text: "Nested text" }] }],
  ])("leaves native Enter semantics in %s content", (_, child) => {
    const editor = create(framed([child]));
    let cursor = 0;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === "Nested text") cursor = pos + 6; });
    editor.commands.setTextSelection(cursor);
    const before = editor.state.doc;
    expect(enterNoteBlock(editor)).toBe(false);
    expect(editor.state.doc).toBe(before);
    enter(editor);
    expect(frames(editor)).toHaveLength(1);
    expect(frames(editor)[0].node.firstChild!.type.name).toBe(child.type);
  });

  it("leaves ordinary prose and cross-frame text selections to standard Enter", () => {
    const editor = create({ type: "doc", content: [p("Ordinary prose"), { type: "noteBlock", content: [p("First")] }, { type: "noteBlock", content: [p("Second")] }, p("Outside")] });
    editor.commands.setTextSelection(5);
    const before = editor.state.doc;
    expect(enterNoteBlock(editor)).toBe(false);
    expect(editor.state.doc).toBe(before);
    enter(editor);
    expect(editor.state.doc.child(0).textContent).toBe("Ordi");
    expect(editor.state.doc.child(1).textContent).toBe("nary prose");
    const blocks = frames(editor);
    editor.commands.setTextSelection({ from: blocks[0].from + 3, to: blocks[1].from + 3 });
    const selected = editor.state.doc;
    expect(enterNoteBlock(editor)).toBe(false);
    expect(editor.state.doc).toBe(selected);
  });

  it("does not handle IME confirmation or a key already consumed by slash capture", () => {
    const editor = create(framed([p("Composing")]));
    editor.commands.setTextSelection(frames(editor)[0].from + 2 + 3);
    const before = editor.state.doc;
    const composition = vi.spyOn(editor.view, "composing", "get").mockReturnValue(true);
    enter(editor, { isComposing: true });
    expect(editor.state.doc).toBe(before);
    composition.mockRestore();
    expect(enter(editor, { isComposing: true }).defaultPrevented).toBe(false);
    expect(editor.state.doc).toBe(before);
    expect(enter(editor, { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(editor.state.doc).toBe(before);
    const capture = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
    editor.view.dom.addEventListener("keydown", capture, true);
    enter(editor);
    editor.view.dom.removeEventListener("keydown", capture, true);
    expect(editor.state.doc).toBe(before);
  });
});
