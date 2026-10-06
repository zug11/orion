// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { closeHistory } from "@tiptap/pm/history";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTable, insertNoteTable, NoteTable, runTableAction, setNoteTableDimensions, setNoteTableWidth, tableColumnLabel } from "./NoteTable";
import { TablePicker, TableToolbar } from "./TablePicker";
import { noteTableLayoutAtLine } from "../../lib/noteTables";

const editors: Editor[] = [];
function createEditor(content = "Before\n\nAfter") {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ element, extensions: [StarterKit, NoteTable, TableRow, TableHeader, TableCell, Markdown.configure({ markedOptions: { gfm: true } })], content, contentType: "markdown", editorProps: { handleScrollToSelection: () => true } });
  editors.push(editor);
  return editor;
}
function table(editor: Editor) {
  let result: { node: typeof editor.state.doc; pos: number } | undefined;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "table") { result = { node, pos }; return false; } return true; });
  if (!result) throw new Error("Expected table");
  return result;
}
function selectCell(editor: Editor, row: number, col: number) {
  const { node, pos } = table(editor);
  const map = TableMap.get(node);
  editor.commands.setTextSelection(pos + 1 + map.map[row * map.width + col] + 2);
}

afterEach(() => { cleanup(); for (const editor of editors.splice(0)) { const element = editor.options.element; editor.destroy(); if (element instanceof HTMLElement) element.remove(); } });

describe("Orion editable tables", () => {
  it("inserts a selected size at the cursor with a single undoable transaction", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(8);
    expect(insertNoteTable(editor, { rows: 4, cols: 5 })).toBe(true);
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 5, height: 4 });
    expect(currentTable(editor)).toBeDefined();
    expect(editor.getMarkdown()).toContain("Before");
    expect(editor.getMarkdown()).toContain("After");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("Before\n\nAfter");
  });

  it("keeps headerless cells, widths and shading through Markdown save/reopen", () => {
    const editor = createEditor();
    editor.commands.setTextSelection(8);
    insertNoteTable(editor, { rows: 3, cols: 2, withHeaderRow: false });
    selectCell(editor, 0, 0);
    editor.commands.insertContent("**First** [note](orion-note://n1)");
    selectCell(editor, 1, 1);
    editor.commands.insertContent("Second row");
    setNoteTableWidth(editor, 65);
    runTableAction(editor, "toggle-banding");
    const { node, pos } = table(editor);
    const map = TableMap.get(node);
    const tr = editor.state.tr;
    for (let row = 0; row < map.height; row += 1) for (let col = 0; col < map.width; col += 1) {
      const cellPos = pos + 1 + map.map[row * map.width + col];
      const cell = tr.doc.nodeAt(cellPos)!;
      tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, colwidth: [col ? 220 : 160] });
    }
    editor.view.dispatch(tr);
    const saved = editor.getMarkdown();
    expect(saved).toContain("<!-- orion-table:v1");
    expect(saved).toContain("| ---");
    const reopened = createEditor(saved);
    const restored = table(reopened).node;
    expect(TableMap.get(restored)).toMatchObject({ width: 2, height: 3 });
    expect(restored.attrs).toMatchObject({ tableWidth: 65, banded: false });
    expect(restored.firstChild?.firstChild?.type.name).toBe("tableCell");
    expect(restored.firstChild?.firstChild?.attrs.colwidth).toEqual([160]);
    expect(restored.firstChild?.child(1).attrs.colwidth).toEqual([220]);
    expect(restored.textContent).toContain("First");
    expect(restored.textContent).toContain("Second row");
    expect(reopened.getMarkdown()).toBe(saved);
  });

  it("reads ordinary GFM without metadata or changing its header", () => {
    const editor = createEditor("| Item | Value |\n| --- | --- |\n| Alpha | **two** |\n\nAfter");
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 2, height: 2 });
    expect(table(editor).node.firstChild?.firstChild?.type.name).toBe("tableHeader");
    expect(editor.getMarkdown()).not.toContain("orion-table");
  });

  it("keeps metadata invisible in the editor and stable through repeated save and reopen cycles", () => {
    const metadata = '<!-- orion-table:v1 {"width":74,"header":false,"banded":false,"columns":[127,220]} -->';
    let saved = `${metadata}\n| | |\n| --- | --- |\n| Author row | Content |\n\nAfter`;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const editor = createEditor(saved);
      const restored = table(editor).node;
      expect(restored.attrs).toMatchObject({ tableWidth: 74, banded: false });
      expect(restored.firstChild?.firstChild?.type.name).toBe("tableCell");
      expect(restored.firstChild?.firstChild?.attrs.colwidth).toEqual([127]);
      expect(editor.view.dom.textContent).not.toContain("orion-table:v1");
      selectCell(editor, 0, 1);
      editor.commands.insertContent(`Edit ${cycle} `);
      saved = editor.getMarkdown();
      expect(saved.match(/<!-- orion-table:v1/g)).toHaveLength(1);
      expect(saved).toContain("Author row");
    }
    expect(saved).toContain("Edit 2 Edit 1 Edit 0 Content");
  });

  it("selects full rows and columns from document rails and runs undoable actions", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |\n| Three | Four |\n\nAfter");
    selectCell(editor, 1, 0);
    fireEvent.click(editor.view.dom.querySelector('[aria-label="Select row 2"]')!);
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect((editor.state.selection as CellSelection).isRowSelection()).toBe(true);
    expect(runTableAction(editor, "delete-row")).toBe(true);
    expect(table(editor).node.textContent).not.toContain("One");
    expect(table(editor).node.textContent).toContain("Three");
    expect(editor.commands.undo()).toBe(true);
    expect(table(editor).node.textContent).toContain("One");
    fireEvent.click(editor.view.dom.querySelector('[aria-label="Select column B"]')!);
    expect((editor.state.selection as CellSelection).isColSelection()).toBe(true);
    expect(runTableAction(editor, "add-column-after")).toBe(true);
    expect(TableMap.get(table(editor).node).width).toBe(3);
    expect(table(editor).node.textContent).toContain("Four");
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(editor.view.dom.querySelector(".is-table-active")).toBeNull();
  });

  it("grows the table when Tab leaves the last cell and preserves ordinary prose", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |\n\nAfter");
    selectCell(editor, 1, 1);
    fireEvent.keyDown(editor.view.dom, { key: "Tab" });
    expect(TableMap.get(table(editor).node).height).toBe(3);
    expect(editor.getMarkdown()).toContain("After");
    expect(currentTable(editor)).toBeDefined();
  });

  it("changes both edge counts in one undo step, preserving existing cells and layout", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |\n\nAfter");
    selectCell(editor, 1, 1);
    setNoteTableWidth(editor, 65);
    const original = editor.getMarkdown();
    expect(setNoteTableDimensions(editor, 4, 5)).toBe("updated");
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 5, height: 4 });
    expect(table(editor).node.child(1).child(1).textContent).toBe("Two");
    expect(table(editor).node.attrs.tableWidth).toBe(65);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
  });

  it("requires confirmation before count reductions discard content, and undo restores it", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |\n| Three | Four |\n\nAfter");
    selectCell(editor, 2, 1);
    const original = editor.getMarkdown();
    expect(setNoteTableDimensions(editor, 1, 1)).toBe("confirmation-required");
    expect(editor.getMarkdown()).toBe(original);
    expect(setNoteTableDimensions(editor, 1, 1, true)).toBe("updated");
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 1, height: 1 });
    expect(table(editor).node.textContent).toBe("A");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(original);
  });

  it("edge steppers grow, shrink empty cells, and confirm filled-row removal inline", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |\n\nAfter");
    selectCell(editor, 1, 0);
    const control = (name: string) => editor.view.dom.querySelector(`[aria-label="${name}"]`)!;
    fireEvent.click(control("Increase row count"));
    expect(TableMap.get(table(editor).node).height).toBe(3);
    fireEvent.click(control("Decrease row count"));
    expect(TableMap.get(table(editor).node).height).toBe(2);
    fireEvent.click(control("Decrease row count"));
    expect(TableMap.get(table(editor).node).height).toBe(2);
    expect(control("Confirm table size reduction")).not.toHaveAttribute("hidden");
    fireEvent.click(control("Keep table size"));
    expect(control("Confirm table size reduction")).toHaveAttribute("hidden");
    fireEvent.click(control("Decrease row count"));
    fireEvent.click(control("Remove rows and content"));
    expect(TableMap.get(table(editor).node).height).toBe(1);
    expect(editor.commands.undo()).toBe(true);
    expect(table(editor).node.textContent).toContain("Two");
  });

  it("invalidates a pending destructive count after the table changes", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |\n\nAfter");
    selectCell(editor, 1, 0);
    fireEvent.click(editor.view.dom.querySelector('[aria-label="Decrease column count"]')!);
    const oldConfirm = editor.view.dom.querySelector('[aria-label="Remove columns and content"]')!;
    editor.commands.insertContent("New text");
    fireEvent.click(oldConfirm);
    expect(TableMap.get(table(editor).node).width).toBe(2);
    expect(table(editor).node.textContent).toContain("New text");
    expect(table(editor).node.textContent).toContain("Two");
  });

  it("keeps imported oversized rows when changing only the column count", () => {
    const editor = createEditor(`| A | B |\n| --- | --- |\n${Array.from({ length: 24 }, (_, i) => `| row ${i} | value |`).join("\n")}`);
    selectCell(editor, 0, 0);
    expect(setNoteTableDimensions(editor, 25, 3)).toBe("updated");
    expect(TableMap.get(table(editor).node)).toMatchObject({ height: 25, width: 3 });
    expect(table(editor).node.textContent).toContain("row 23");
    expect(setNoteTableDimensions(editor, 500, 100)).toBe("updated");
    expect(TableMap.get(table(editor).node)).toMatchObject({ height: 25, width: 12 });
  });

  it("keeps secondary table actions in More and supports the terminal toolbar portal", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |");
    selectCell(editor, 1, 0);
    const terminal = document.createElement("div");
    document.body.append(terminal);
    const view = render(<TableToolbar editor={editor} overflowTarget={terminal} />);
    expect(view.container.querySelector('[aria-label="More table options"]')).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete table" })).toBeNull();
    fireEvent.click(terminal.querySelector("button")!);
    expect(screen.getByRole("menuitem", { name: "Delete table" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete selected row" })).toHaveAttribute("title", "Delete selected row");
    expect(screen.getByRole("button", { name: "Add row below" }).querySelector("svg")).not.toBeNull();
    expect(view.container.querySelector(".orion-table-toolbar-label")).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu", { name: "More table options" }), { key: "Escape" });
    expect(document.activeElement).toBe(terminal.querySelector("button"));
    expect(screen.queryByRole("menuitem", { name: "Delete table" })).toBeNull();
    view.unmount(); terminal.remove();
  });

  it("removes /table and inserts the table as one undo step", () => {
    const editor = createEditor("/table");
    editor.view.dispatch(closeHistory(editor.state.tr));
    insertNoteTable(editor, { rows: 2, cols: 2 }, { from: 1, to: 7 });
    expect(editor.getMarkdown()).not.toContain("/table");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("/table");
  });

  it("bounds picker sizes and never inserts a nested table", () => {
    const editor = createEditor();
    insertNoteTable(editor, { rows: 200, cols: 90 });
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 12, height: 20 });
    expect(insertNoteTable(editor, { rows: 2, cols: 2 })).toBe(false);
    expect(tableColumnLabel(26)).toBe("AA");
  });

  it("inserts using keyboard navigation in the grid", () => {
    const editor = createEditor();
    const onClose = vi.fn();
    render(<TablePicker editor={editor} onClose={onClose} />);
    expect(document.activeElement).toHaveAttribute("aria-label", "3 columns, 3 rows");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toHaveAttribute("aria-label", "4 columns, 4 rows");
    fireEvent.click(document.activeElement!);
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 4, height: 4 });
    expect(onClose).toHaveBeenCalled();
  });

  it("rejects stale picker insertion without deleting a slash or changing the note", () => {
    const editor = createEditor("/table");
    render(<TablePicker editor={editor} range={{ from: 1, to: 7 }} canInsert={() => false} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "3 columns, 3 rows" }));
    expect(editor.getMarkdown()).toBe("/table");
    expect(screen.getByRole("alert")).toHaveTextContent("The note changed");
  });

  it("keeps core table icons visible in narrow layouts and leaves select keys native", () => {
    const editor = createEditor("| A | B |\n| --- | --- |\n| One | Two |");
    selectCell(editor, 1, 0);
    render(<TableToolbar editor={editor} compact cramped/>);
    for (const name of ["Add row below", "Delete selected row", "Add column right", "Delete selected column"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("title", name);
      expect(button.querySelector("svg")).not.toBeNull();
    }
    fireEvent.click(screen.getByRole("button", { name: "More table options" }));
    expect(screen.getByRole("menuitem", { name: "Add row above" })).toBeVisible();
    const width = screen.getByRole("combobox", { name: "Table width" });
    width.focus();
    expect(fireEvent.keyDown(width, { key: "ArrowDown" })).toBe(true);
    expect(width).toHaveFocus();
    fireEvent.keyDown(width, { key: "Escape" });
    expect(screen.getByRole("button", { name: "More table options" })).toHaveFocus();
  });

  it("exposes only adjacent bounded table metadata to read and export renderers", () => {
    const metadata = '<!-- orion-table:v1 {"width":700,"header":false,"banded":false,"columns":[-3,220,"color:red"]} -->';
    const markdown = `Before\n\n${metadata}\n| | | |\n| --- | --- | --- |\n| A | B | C |`;
    expect(noteTableLayoutAtLine(markdown, 4)).toEqual({ width: 100, header: false, banded: false, columns: [48, 220, null] });
    expect(noteTableLayoutAtLine(markdown, 6)).toBeUndefined();
    expect(noteTableLayoutAtLine('<!-- orion-table:v1 invalid -->\n| A |', 2)).toBeUndefined();
  });

  it("hands keyboard focus back to the grid when custom controls unmount", () => {
    const editor = createEditor();
    const onClose = vi.fn();
    render(<TablePicker editor={editor} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Custom size…" }));
    expect(document.activeElement).toBe(screen.getByRole("spinbutton", { name: "Table columns" }));
    fireEvent.click(screen.getByRole("button", { name: "Grid picker" }));
    expect(document.activeElement).toHaveAttribute("aria-label", "3 columns, 3 rows");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("honours custom dimensions and the header toggle", () => {
    const editor = createEditor();
    render(<TablePicker editor={editor} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Custom size…" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Table columns" }), { target: { value: "9" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Table rows" }), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Header row" }));
    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    expect(TableMap.get(table(editor).node)).toMatchObject({ width: 9, height: 7 });
    expect(table(editor).node.firstChild?.firstChild?.type.name).toBe("tableCell");
  });
});
