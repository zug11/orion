// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";
import { buildNoteExcerptContent } from "../../lib/noteExcerpts";
import { NoteExcerpt } from "./NoteExcerpt";
import { NoteImage } from "./NoteImage";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { NoteTable } from "./NoteTable";
import { NoteBlock } from "./NoteBlock";
import { deleteNoteBlock, insertNoteBlockContent, insertNoteBlockParagraph, listNoteBlocks, moveNoteBlock, moveNoteBlockTo, unwrapNoteBlock, wrapNoteBlock } from "./noteBlocks";

const editors: Editor[] = [];
const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const frame = (...content: JSONContent[]): JSONContent => ({ type: "noteBlock", content });
const image: JSONContent = {
  type: "image", attrs: {
    src: "orion-image://localhost/image_Abc-123456789", alt: "A diagram", widthPercent: 37,
    caption: "A preserved caption", showCaption: true, placement: "wrap", xPercent: 24.5, offsetY: 97,
  },
};
const nestedList: JSONContent = {
  type: "bulletList", content: [
    { type: "listItem", content: [paragraph("Outer item"), {
      type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [paragraph("Nested item")] }],
    }] },
    { type: "listItem", content: [paragraph("Other item")] },
  ],
};
const table: JSONContent = {
  type: "table", attrs: { tableWidth: 76, banded: false }, content: [
    { type: "tableRow", content: [
      { type: "tableCell", attrs: { colwidth: [160] }, content: [paragraph("One")] },
      { type: "tableCell", attrs: { colwidth: [220] }, content: [paragraph("Two")] },
    ] },
    { type: "tableRow", content: [
      { type: "tableCell", attrs: { colwidth: [160] }, content: [paragraph("Three")] },
      { type: "tableCell", attrs: { colwidth: [220] }, content: [paragraph("Four")] },
    ] },
  ],
};
const excerpt = buildNoteExcerptContent({
  noteId: "original", title: "Original note", text: "Quoted words.",
  passages: [{ from: 10, to: 23, text: "Quoted words." }],
})[0];

function createEditor(content: JSONContent[] = [paragraph("Before"), paragraph("After")], trailingNode = true) {
  const editor = new Editor({
    extensions: [
      NoteStarterKit.configure({ trailingNode: trailingNode ? {} : false, link: { protocols: ["orion-note"] } }),
      TaskList, NoteTaskItem.configure({ nested: true }), NoteExcerpt, NoteImage, NoteBlock,
      NoteTable, TableRow, TableHeader, TableCell, Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content: { type: "doc", content },
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  return editor;
}

afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

describe("optional note block operations", () => {
  it("enumerates only exact document children, keeping lists, tables, images and excerpts whole", () => {
    const editor = createEditor([
      paragraph("Intro"), { type: "heading", attrs: { level: 6 }, content: [{ type: "text", text: "Deep heading" }] },
      nestedList, table, excerpt, image,
      { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [paragraph("Task")] }] },
      { type: "blockquote", content: [paragraph("Ordinary quotation")] },
      { type: "codeBlock", attrs: { language: "ts" }, content: [{ type: "text", text: "const n = 1;" }] },
      { type: "horizontalRule" }, paragraph("End"),
    ]);
    const before = editor.state.doc;
    const saved = editor.getMarkdown();
    const blocks = listNoteBlocks(before);
    expect(blocks.map((block) => block.label)).toEqual([
      "Paragraph", "Heading 6", "Bullet list", "Table", "Excerpt", "Image", "To-do list", "Quote", "Code block", "Divider", "Paragraph",
    ]);
    let boundary = 0;
    for (const [index, block] of blocks.entries()) {
      expect(block.from).toBe(boundary);
      expect(block.node).toBe(before.child(index));
      expect(block.to).toBe(boundary + block.node.nodeSize);
      boundary = block.to;
    }
    expect(boundary).toBe(before.content.size);
    expect(editor.state.doc).toBe(before);
    expect(editor.getMarkdown()).toBe(saved);
    expect(editor.commands.undo()).toBe(false);
  });

  it.each<[string, JSONContent]>([
    ["nested list", nestedList], ["table", table], ["excerpt", excerpt], ["image", image],
  ])("deletes a whole %s and restores its exact content, attrs and original selection with one undo", (_, target) => {
    const editor = createEditor([paragraph("Before"), target, image, paragraph("After")]);
    const block = listNoteBlocks(editor.state.doc)[1];
    editor.commands.setTextSelection(3);
    const before = editor.state.doc;
    const saved = editor.getMarkdown();
    const selection = editor.state.selection.toJSON();
    expect(deleteNoteBlock(editor, block)).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.child(0)).toBe(before.child(0));
    expect(editor.state.doc.child(1)).toBe(before.child(2));
    expect(editor.state.doc.child(2)).toBe(before.child(3));
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.getMarkdown()).toBe(saved);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(false);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.childCount).toBe(3);
  });

  it.each([paragraph("Only text"), image, nestedList, table, excerpt])("replaces the final block with one editable paragraph", (target) => {
    // Disable the independent trailing-paragraph plugin so a bare final atom
    // can be tested without that plugin adding a paragraph during Undo.
    const editor = createEditor([target], false);
    const before = editor.state.doc;
    expect(deleteNoteBlock(editor, listNoteBlocks(before)[0])).toBe(true);
    expect(editor.state.doc.toJSON()).toMatchObject({ type: "doc", content: [{ type: "paragraph" }] });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild!.content.size).toBe(0);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it("leaves an already empty final paragraph unchanged, without adding history", () => {
    const editor = createEditor([{ type: "paragraph" }]);
    const before = editor.state.doc;
    expect(deleteNoteBlock(editor, listNoteBlocks(before)[0])).toBe(false);
    expect(editor.state.doc).toBe(before);
    expect(editor.commands.undo()).toBe(false);
  });

  it("rejects changed, shifted and equal-looking replacement blocks captured by an old menu", () => {
    const editor = createEditor();
    const first = listNoteBlocks(editor.state.doc)[0];
    editor.commands.insertContentAt(1, "Changed ");
    const changed = editor.state.doc;
    expect(deleteNoteBlock(editor, first)).toBe(false);
    expect(editor.state.doc).toBe(changed);

    const after = listNoteBlocks(editor.state.doc)[1];
    editor.commands.insertContentAt(0, paragraph("Inserted before"));
    const shifted = editor.state.doc;
    expect(deleteNoteBlock(editor, after)).toBe(false);
    expect(editor.state.doc).toBe(shifted);

    const replacement = listNoteBlocks(editor.state.doc)[0];
    editor.view.dispatch(editor.state.tr.replaceWith(replacement.from, replacement.to,
      editor.schema.nodeFromJSON(replacement.node.toJSON())));
    expect(editor.state.doc.nodeAt(replacement.from)!.eq(replacement.node)).toBe(true);
    expect(deleteNoteBlock(editor, replacement)).toBe(false);
  });

  it("allows unrelated later edits but refuses a forged partial or nested range", () => {
    const editor = createEditor([nestedList, paragraph("After")]);
    const captured = listNoteBlocks(editor.state.doc)[0];
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, " changed");
    const before = editor.state.doc;
    expect(deleteNoteBlock(editor, { ...captured, to: captured.to - 1 })).toBe(false);
    expect(deleteNoteBlock(editor, { ...captured, from: 1, to: 1 + captured.node.child(0).nodeSize, node: captured.node.child(0) })).toBe(false);
    expect(editor.state.doc).toBe(before);
    expect(deleteNoteBlock(editor, captured)).toBe(true);
    expect(editor.state.doc.textContent).toBe("After changed");
  });

  it("isolates deletion from typing immediately before and after it", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(7);
    editor.commands.insertContent("!");
    const typed = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    expect(deleteNoteBlock(editor, listNoteBlocks(typed)[1])).toBe(true);
    const deleted = editor.state.doc;
    editor.commands.insertContent("?");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(deleted)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(typed)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
    expect(editor.commands.undo()).toBe(false);
  });

  it.each(["start", "middle", "end"] as const)("inserts a selected empty paragraph at the %s boundary without rewriting other nodes", (where) => {
    const editor = createEditor([image, nestedList, table, paragraph("After")]);
    const before = editor.state.doc;
    const position = where === "start" ? 0 : where === "end" ? before.content.size : before.child(0).nodeSize;
    const index = before.resolve(position).index();
    expect(insertNoteBlockParagraph(editor, position)).toEqual({ from: position + 1, to: position + 1 });
    expect(editor.state.doc.childCount).toBe(before.childCount + 1);
    expect(editor.state.doc.child(index).type.name).toBe("paragraph");
    expect(editor.state.doc.child(index).content.size).toBe(0);
    before.forEach((node, _, oldIndex) => {
      expect(editor.state.doc.child(oldIndex < index ? oldIndex : oldIndex + 1)).toBe(node);
    });
    expect(editor.state.selection.from).toBe(position + 1);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.commands.undo()).toBe(false);
  });

  it("rejects invalid or nested insertion positions and read-only/destroyed editors", () => {
    const editor = createEditor([nestedList, table, paragraph("After")]);
    const before = editor.state.doc;
    for (const position of [-1, NaN, Infinity, 0.5, 1, 3, before.child(0).nodeSize + 1, before.content.size + 1]) {
      expect(insertNoteBlockParagraph(editor, position)).toBeNull();
    }
    expect(editor.state.doc).toBe(before);
    expect(editor.commands.undo()).toBe(false);
    const block = listNoteBlocks(before)[0];
    editor.setEditable(false);
    expect(insertNoteBlockParagraph(editor, 0)).toBeNull();
    expect(deleteNoteBlock(editor, block)).toBe(false);
    editor.destroy();
    expect(insertNoteBlockParagraph(editor, 0)).toBeNull();
    expect(deleteNoteBlock(editor, block)).toBe(false);
  });

  it("isolates insertion from preceding typing and subsequent slash text", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(7);
    editor.commands.insertContent("!");
    const typed = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    const range = insertNoteBlockParagraph(editor, typed.child(0).nodeSize);
    expect(range).not.toBeNull();
    const inserted = editor.state.doc;
    editor.commands.insertContent("/table");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(inserted)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(typed)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
    expect(editor.commands.undo()).toBe(false);
  });

  it.each<[string, JSONContent]>([
    ["heading", { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "A heading" }] }],
    ["nested list", nestedList], ["table", table], ["divider", { type: "horizontalRule" }], ["image", image],
  ])("inserts a whole %s between existing blocks and chooses a useful selection", (_, content) => {
    const editor = createEditor([image, paragraph("After")]);
    const before = editor.state.doc;
    const position = before.firstChild!.nodeSize;
    expect(insertNoteBlockContent(editor, position, content)).toBe(true);
    const inserted = editor.state.doc.child(1);
    expect(inserted.eq(editor.schema.nodeFromJSON(content))).toBe(true);
    expect(editor.state.doc.firstChild).toBe(before.firstChild);
    expect(editor.state.doc.lastChild).toBe(before.lastChild);
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(position);
    expect(editor.state.selection.from).toBeLessThan(position + inserted.nodeSize);
    expect(editor.state.selection).toBeInstanceOf(inserted.isAtom ? NodeSelection : TextSelection);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.commands.undo()).toBe(false);
  });

  it("wraps inline note links into an ordinary paragraph while preserving marks and mixed block order", () => {
    const editor = createEditor();
    const before = editor.state.doc;
    const position = before.firstChild!.nodeSize;
    const link: JSONContent = { type: "text", text: "Connected note", marks: [{
      type: "link", attrs: { href: "orion-note://source", target: null, rel: null },
    }] };
    expect(insertNoteBlockContent(editor, position, [
      { type: "text", text: "See " }, link, { type: "horizontalRule" }, { type: "text", text: "Below" },
    ])).toBe(true);
    expect(listNoteBlocks(editor.state.doc).map((block) => block.node.type.name)).toEqual([
      "paragraph", "paragraph", "horizontalRule", "paragraph", "paragraph",
    ]);
    expect(editor.state.doc.child(1).textContent).toBe("See Connected note");
    expect(editor.state.doc.child(1).lastChild!.marks[0].attrs.href).toBe("orion-note://source");
    expect(editor.state.doc.child(3).textContent).toBe("Below");
    expect(editor.state.selection.from).toBe(position + 1);
    expect(editor.getMarkdown()).toContain("[Connected note](orion-note://source)");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
  });

  it("rejects empty, invalid and non-top-level content without partial mutations", () => {
    const editor = createEditor();
    const before = editor.state.doc;
    for (const content of [
      [], { type: "unknown" }, { type: "tableRow" }, { type: "paragraph", content: [nestedList] },
      [paragraph("Valid first"), { type: "unknown" }],
    ]) {
      expect(insertNoteBlockContent(editor, 0, content)).toBe(false);
      expect(editor.state.doc).toBe(before);
    }
    expect(insertNoteBlockContent(editor, 2, paragraph("Nested"))).toBe(false);
    expect(editor.commands.undo()).toBe(false);
  });
});

describe("persistent framed note blocks", () => {
  it("wraps an adjacent selected range in one frame without changing any child or ordinary neighboring prose", () => {
    const editor = createEditor([paragraph("Before"), paragraph("Selected text"), image, table, paragraph("Selected ending"), paragraph("After")]);
    const blocks = listNoteBlocks(editor.state.doc);
    editor.commands.setTextSelection({ from: blocks[1].from + 2, to: blocks[4].from + 5 });
    const before = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    const wrapped = wrapNoteBlock(editor);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.label).toBe("Block");
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.firstChild).toBe(before.firstChild);
    expect(editor.state.doc.lastChild).toBe(before.lastChild);
    expect(wrapped!.node.type.name).toBe("noteBlock");
    expect(wrapped!.node.childCount).toBe(4);
    for (let index = 0; index < 4; index += 1) expect(wrapped!.node.child(index)).toBe(before.child(index + 1));
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(wrapped!.from);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(false);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.child(1).eq(wrapped!.node)).toBe(true);
  });

  it("selects an existing frame without nesting it or changing document history", () => {
    const editor = createEditor([frame(paragraph("Framed prose")), paragraph("Ordinary prose")]);
    const before = editor.state.doc;
    editor.commands.setTextSelection(4);
    const selected = wrapNoteBlock(editor);
    expect(selected?.node).toBe(before.firstChild);
    expect(selected?.label).toBe("Text");
    expect(editor.state.doc).toBe(before);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(0);
    expect(editor.commands.undo()).toBe(false);
    editor.commands.setTextSelection({ from: 3, to: before.content.size - 2 });
    expect(wrapNoteBlock(editor)).toBeNull();
    expect(editor.state.doc).toBe(before);
  });

  it("unwraps children intact and keeps a reversed text selection on the same characters", () => {
    const editor = createEditor([paragraph("Before"), frame(paragraph("Framed prose"), image, nestedList, table, excerpt), paragraph("After")]);
    const block = listNoteBlocks(editor.state.doc)[1];
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, block.from + 8, block.from + 3)));
    const before = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    expect(unwrapNoteBlock(editor, block)).toBe(true);
    expect(editor.state.doc.childCount).toBe(7);
    expect(editor.state.doc.firstChild).toBe(before.firstChild);
    expect(editor.state.doc.lastChild).toBe(before.lastChild);
    block.node.forEach((node, _offset, index) => expect(editor.state.doc.child(index + 1)).toBe(node));
    expect(editor.state.selection.anchor).toBe(block.from + 7);
    expect(editor.state.selection.head).toBe(block.from + 2);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(false);
  });

  it("preserves an image node selection when removing its surrounding frame", () => {
    const editor = createEditor([paragraph("Before"), frame(image), paragraph("After")]);
    const block = listNoteBlocks(editor.state.doc)[1];
    editor.commands.setNodeSelection(block.from + 1);
    expect(unwrapNoteBlock(editor, block)).toBe(true);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.selection.from).toBe(block.from);
    expect((editor.state.selection as NodeSelection).node).toBe(block.node.firstChild);
  });

  it.each(["up", "down"] as const)("moves a whole frame %s with every image/table attribute and text selection preserved", (direction) => {
    const editor = createEditor([paragraph("Before"), frame(paragraph("Framed prose"), image, table), paragraph("After")]);
    const before = editor.state.doc;
    const block = listNoteBlocks(before)[1];
    editor.commands.setTextSelection({ from: block.from + 3, to: block.from + 8 });
    const selection = editor.state.selection.toJSON();
    expect(moveNoteBlock(editor, block, direction)).toBe(true);
    const index = direction === "up" ? 0 : 2;
    const moved = listNoteBlocks(editor.state.doc)[index];
    expect(moved.node).toBe(block.node);
    expect(editor.state.doc.child(direction === "up" ? 1 : 0)).toBe(before.firstChild);
    expect(editor.state.doc.child(direction === "up" ? 2 : 1)).toBe(before.lastChild);
    expect(moved.node.child(1).attrs).toEqual(before.child(1).child(1).attrs);
    expect(moved.node.child(2)).toBe(before.child(1).child(2));
    expect(editor.state.selection.anchor).toBe(moved.from + 3);
    expect(editor.state.selection.head).toBe(moved.from + 8);
    const after = editor.state.doc;
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(editor.commands.undo()).toBe(false);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.eq(after)).toBe(true);
  });

  it("preserves node and table-cell selections inside a moved frame", () => {
    const imageEditor = createEditor([paragraph("Before"), frame(image), paragraph("After")]);
    const imageFrame = listNoteBlocks(imageEditor.state.doc)[1];
    imageEditor.commands.setNodeSelection(imageFrame.from + 1);
    expect(moveNoteBlock(imageEditor, imageFrame, "up")).toBe(true);
    expect(imageEditor.state.selection).toBeInstanceOf(NodeSelection);
    expect(imageEditor.state.selection.from).toBe(1);
    expect((imageEditor.state.selection as NodeSelection).node).toBe(imageFrame.node.firstChild);

    const tableEditor = createEditor([paragraph("Before"), frame(table), paragraph("After")]);
    const tableFrame = listNoteBlocks(tableEditor.state.doc)[1];
    const map = TableMap.get(tableFrame.node.firstChild!);
    tableEditor.view.dispatch(tableEditor.state.tr.setSelection(CellSelection.create(tableEditor.state.doc,
      tableFrame.from + 2 + map.map[0], tableFrame.from + 2 + map.map[3])));
    expect(moveNoteBlock(tableEditor, tableFrame, "up")).toBe(true);
    expect(tableEditor.state.selection).toBeInstanceOf(CellSelection);
    expect((tableEditor.state.selection as CellSelection).$anchorCell.pos).toBe(2 + map.map[0]);
    expect((tableEditor.state.selection as CellSelection).$headCell.pos).toBe(2 + map.map[3]);
  });

  it("keeps a selection in ordinary prose attached to that prose while a frame moves past it", () => {
    const editor = createEditor([paragraph("Before"), frame(paragraph("Framed")), paragraph("After")]);
    const blocks = listNoteBlocks(editor.state.doc);
    editor.commands.setTextSelection({ from: 2, to: 5 });
    expect(moveNoteBlock(editor, blocks[1], "up")).toBe(true);
    expect(editor.state.selection.anchor).toBe(blocks[1].node.nodeSize + 2);
    expect(editor.state.selection.head).toBe(blocks[1].node.nodeSize + 5);
    expect(editor.state.selection.$from.parent.textContent).toBe("Before");
  });

  it("moves a frame to a distant original boundary in one operation and leaves intervening prose ordinary", () => {
    const editor = createEditor([paragraph("One"), frame(paragraph("Framed"), image), paragraph("Two"), paragraph("Three")]);
    const original = editor.state.doc;
    const block = listNoteBlocks(original)[1];
    editor.commands.setNodeSelection(block.from);
    expect(moveNoteBlockTo(editor, block, original.content.size)).toBe(true);
    expect(editor.state.doc.child(0)).toBe(original.child(0));
    expect(editor.state.doc.child(1)).toBe(original.child(2));
    expect(editor.state.doc.child(2)).toBe(original.child(3));
    expect(editor.state.doc.child(3)).toBe(block.node);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect((editor.state.selection as NodeSelection).node).toBe(block.node);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(editor.commands.undo()).toBe(false);
  });

  it("rejects stale frames, ordinary nodes, partial ranges, own-range drops and invalid target boundaries", () => {
    const editor = createEditor([paragraph("Before"), frame(paragraph("Framed")), paragraph("After")]);
    const original = editor.state.doc;
    const blocks = listNoteBlocks(original);
    const block = blocks[1];
    for (const position of [block.from, block.to, block.from + 1, -1, NaN, Infinity, 0.5, original.content.size + 1]) {
      expect(moveNoteBlockTo(editor, block, position)).toBe(false);
    }
    expect(moveNoteBlock(editor, blocks[0], "down")).toBe(false);
    expect(unwrapNoteBlock(editor, blocks[0])).toBe(false);
    expect(moveNoteBlockTo(editor, { ...block, to: block.to - 1 }, 0)).toBe(false);
    expect(editor.state.doc).toBe(original);
    expect(editor.commands.undo()).toBe(false);
    editor.commands.insertContentAt(block.from + 2, "Changed ");
    const changed = editor.state.doc;
    expect(moveNoteBlock(editor, block, "up")).toBe(false);
    expect(unwrapNoteBlock(editor, block)).toBe(false);
    expect(editor.state.doc).toBe(changed);
    const shifted = listNoteBlocks(changed)[1];
    editor.commands.insertContentAt(0, paragraph("Inserted"));
    expect(moveNoteBlockTo(editor, shifted, 0)).toBe(false);
    expect(unwrapNoteBlock(editor, shifted)).toBe(false);
  });

  it("isolates wrap, movement and subsequent typing into separate Undo steps", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(3);
    editor.commands.insertContent("!");
    const typed = editor.state.doc;
    const block = wrapNoteBlock(editor)!;
    const wrapped = editor.state.doc;
    expect(moveNoteBlock(editor, block, "down")).toBe(true);
    const moved = editor.state.doc;
    const movedBlock = listNoteBlocks(moved).find(candidate => candidate.node.type.name === "noteBlock")!;
    editor.commands.setTextSelection(movedBlock.from + 3);
    editor.commands.insertContent("?");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(moved)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(wrapped)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(typed)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.textContent).toBe("BeforeAfter");
    expect(editor.commands.undo()).toBe(false);
  });

  it("rejects all framing operations in read-only or destroyed editors", () => {
    const editor = createEditor([paragraph("Before"), frame(paragraph("Framed")), paragraph("After")]);
    const block = listNoteBlocks(editor.state.doc)[1];
    editor.setEditable(false);
    expect(wrapNoteBlock(editor)).toBeNull();
    expect(unwrapNoteBlock(editor, block)).toBe(false);
    expect(moveNoteBlock(editor, block, "up")).toBe(false);
    expect(moveNoteBlockTo(editor, block, 0)).toBe(false);
    editor.destroy();
    expect(wrapNoteBlock(editor)).toBeNull();
    expect(unwrapNoteBlock(editor, block)).toBe(false);
    expect(moveNoteBlock(editor, block, "up")).toBe(false);
    expect(moveNoteBlockTo(editor, block, 0)).toBe(false);
  });
});
