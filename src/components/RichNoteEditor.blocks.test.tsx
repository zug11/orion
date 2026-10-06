// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { redoDepth, undoDepth } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { TableMap } from "@tiptap/pm/tables";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichNoteEditor } from "./RichNoteEditor";

beforeEach(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  // jsdom has no layout. Only give the overlay measurable document nodes;
  // editor transactions, selection, menus, and history remain real.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const node = this as HTMLElement;
    const index = node.parentElement?.classList.contains("tiptap")
      ? Array.from(node.parentElement.children).indexOf(node) : 0;
    return new DOMRect(40, 100 + index * 60, 640, 36);
  });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(40, 100, 10, 20) },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fixture(markdown = "Opening paragraph\n\nSecond paragraph", blocks = false) {
  const onChange = vi.fn();
  const view = render(<RichNoteEditor noteId="block-integration" markdown={markdown} notes={[]} concepts={[]}
      sources={[]} attachedSourceIds={[]} onChange={onChange} onAttachSource={vi.fn()}
      onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  const element = view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor };
  const editor = element.editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 40, right: 41, top: 100, bottom: 120 });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  if (blocks) {
    const button = await blockControls();
    fireEvent.mouseDown(button);
    fireEvent.click(button);
  }
  onChange.mockClear();
  return { ...view, element, editor, onChange };
}

async function blockControls() {
  const more = screen.getByRole("button", { name: "More formatting" });
  if (more.getAttribute("aria-expanded") !== "true") {
    fireEvent.mouseDown(more);
    fireEvent.click(more);
  }
  return screen.findByRole("menuitemcheckbox", { name: "Block controls" });
}

async function expectBlockControlsState(active: boolean) {
  const item = await blockControls();
  expect(item).toHaveAttribute("aria-checked", String(active));
  fireEvent.keyDown(item, { key: "Escape" });
}

async function openInsertion(label = "Insert after text block") {
  const trigger = await screen.findByRole("button", { name: label });
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  return { trigger, menu: await screen.findByRole("menu", { name: "Insert block" }) };
}

describe("optional block controls in the real note editor", () => {
  it.each([
    "![Photo](orion-image://localhost/image_123456789012345678)\n\nStart writing here.",
    "![Photo](orion-image://localhost/image_123456789012345678)",
    "<!-- orion-block:v1 -->\n![Photo](orion-image://localhost/image_123456789012345678)\n<!-- /orion-block -->\n\nStart writing here.",
  ])("enters editing with a text caret instead of selecting the opening photo: %s", async markdown => {
    const { editor, container, onChange } = await fixture(markdown);
    expect(editor.state.selection).toBeInstanceOf(TextSelection);
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.parent.isTextblock).toBe(true);
    expect(container.querySelector(".note-image-view.is-selected")).toBeNull();
    expect(screen.queryByRole("group", { name: "Image tools" })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    // Image selection is still available when explicitly requested.
    let imagePosition: number | undefined;
    editor.state.doc.descendants((node, position) => { if (node.type.name === "image") imagePosition = position; });
    await act(async () => { editor.commands.setNodeSelection(imagePosition!); });
    await waitFor(() => expect(container.querySelector(".note-image-view.is-selected")).not.toBeNull());
  });

  it("enters editing under StrictMode without reading an unmounted editor view", async () => {
    const view = render(<StrictMode><RichNoteEditor noteId="strict-blocks" markdown="Plain prose" notes={[]} concepts={[]}
      sources={[]} attachedSourceIds={[]} onChange={vi.fn()} onAttachSource={vi.fn()}
      onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} /></StrictMode>);
    const element = await screen.findByRole("textbox", { name: "Note body" }) as HTMLElement & { editor: Editor };
    await waitFor(() => expect(element.editor.isFocused).toBe(true));
    fireEvent.click(await blockControls());
    await screen.findByRole("button", { name: "Insert after text block" });
    expect(element.editor.state.doc.firstChild?.type.name).toBe("noteBlock");
    expect(element.editor.state.doc.firstChild?.textContent).toBe("Plain prose");
    expect(() => view.unmount()).not.toThrow();
  });

  it("frames and explicitly unwraps current content without replacing the editor, with separate Undo steps", async () => {
    const { editor, element, container, onChange } = await fixture();
    const original = editor.state.doc;
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      editor.commands.insertContent(" revised");
      editor.commands.setTextSelection({ from: 2, to: 8 });
    });
    const edited = editor.state.doc;
    const selection = editor.state.selection;
    const depth = undoDepth(editor.state);
    let button = await blockControls();
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    await expectBlockControlsState(true);
    expect(container.querySelector(".tiptap")).toBe(element);
    const framed = editor.state.doc;
    expect(framed.firstChild?.type.name).toBe("noteBlock");
    expect(framed.firstChild?.firstChild).toBe(edited.firstChild);
    expect(framed.lastChild).toBe(edited.lastChild);
    expect(undoDepth(editor.state)).toBe(depth + 1);
    expect(onChange).toHaveBeenLastCalledWith(editor.getMarkdown());
    button = await blockControls();
    fireEvent.mouseDown(button);
    fireEvent.click(button);
    await expectBlockControlsState(false);
    expect(editor.state.doc.eq(edited)).toBe(true);
    expect(undoDepth(editor.state)).toBe(depth + 2);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(framed)).toBe(true);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(edited)).toBe(true);
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(redoDepth(editor.state)).toBe(2);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
  });

  it("opens and cancels an insertion menu without inserting an empty paragraph or moving selection", async () => {
    const { editor, onChange } = await fixture(undefined, true);
    act(() => { editor.commands.setTextSelection({ from: 3, to: 7 }); });
    const original = editor.state.doc;
    const selection = editor.state.selection;
    const depth = undoDepth(editor.state);
    const { trigger, menu } = await openInsertion();
    expect(within(menu).getByRole("menuitem", { name: "Text" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Insert block" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(undoDepth(editor.state)).toBe(depth);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("cancels a boundary table picker without changing the document or history", async () => {
    const { editor, onChange } = await fixture(undefined, true);
    const original = editor.state.doc;
    const depth = undoDepth(editor.state);
    const { menu } = await openInsertion();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Table" }));
    const picker = await screen.findByRole("dialog", { name: "Insert table" });
    fireEvent.keyDown(picker, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Insert table" })).toBeNull();
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(undoDepth(editor.state)).toBe(depth);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("supports wrapping keyboard navigation and returning from heading choices before a single Undoable insertion", async () => {
    const { editor } = await fixture(undefined, true);
    const original = editor.state.doc;
    const { menu } = await openInsertion();
    const text = within(menu).getByRole("menuitem", { name: "Text" });
    const table = within(menu).getByRole("menuitem", { name: "Table" });
    fireEvent.keyDown(text, { key: "ArrowUp" });
    expect(table).toHaveFocus();
    fireEvent.keyDown(table, { key: "ArrowDown" });
    expect(text).toHaveFocus();
    fireEvent.keyDown(text, { key: "End" });
    expect(table).toHaveFocus();
    fireEvent.keyDown(table, { key: "Home" });
    expect(text).toHaveFocus();
    fireEvent.keyDown(text, { key: "ArrowDown" });
    const heading = within(menu).getByRole("menuitem", { name: "Heading" });
    expect(heading).toHaveFocus();
    // Native buttons generate click for Enter; jsdom does not synthesize that default action.
    fireEvent.click(heading);
    expect(within(menu).getByRole("menuitem", { name: "Heading 1" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(within(menu).getByRole("menuitem", { name: "Text" })).toHaveFocus();
    expect(editor.state.doc.eq(original)).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Heading" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(within(menu).getByRole("menuitem", { name: "Heading 2" })).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(screen.queryByRole("menu", { name: "Insert block" })).toBeNull();
    expect(editor.state.doc.child(1).type.name).toBe("noteBlock");
    expect(editor.state.doc.child(1).firstChild?.type.name).toBe("heading");
    expect(editor.state.doc.child(1).firstChild?.attrs.level).toBe(2);
    expect(editor.state.doc.child(0).eq(original.child(0))).toBe(true);
    expect(editor.state.doc.child(2).eq(original.child(1))).toBe(true);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
  });

  it("inserts a table at the chosen block boundary when the text selection is in another block", async () => {
    const { editor } = await fixture("# Opening\n\nMiddle paragraph\n\nFinal paragraph", true);
    const original = editor.state.doc;
    const { menu } = await openInsertion("Insert after heading 1 block");
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 3); });
    expect(editor.state.selection.from).toBe(original.content.size - 3);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Table" }));
    fireEvent.click(await screen.findByRole("button", { name: "2 columns, 2 rows" }));
    expect(editor.state.doc.childCount).toBe(4);
    expect(editor.state.doc.child(0).eq(original.child(0))).toBe(true);
    expect(editor.state.doc.child(1).type.name).toBe("noteBlock");
    const table = editor.state.doc.child(1).firstChild!;
    expect(table.type.name).toBe("table");
    expect(TableMap.get(table)).toMatchObject({ width: 2, height: 2 });
    expect(table.firstChild?.firstChild?.type.name).toBe("tableHeader");
    expect(editor.state.doc.child(2).eq(original.child(1))).toBe(true);
    expect(editor.state.doc.child(3).eq(original.child(2))).toBe(true);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
  });

  it("dismisses a captured insertion boundary when the document changes", async () => {
    const { editor } = await fixture(undefined, true);
    await openInsertion();
    act(() => { editor.commands.insertContentAt(2, "changed "); });
    expect(screen.queryByRole("menu", { name: "Insert block" })).toBeNull();
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.textContent).toBe("changed Opening paragraph");
  });

  it("retains the framed content when clicking below it and reactivates controls when the cursor returns", async () => {
    const { editor, element, onChange } = await fixture(undefined, true);
    await screen.findByRole("button", { name: "Insert after text block" });
    const original = editor.state.doc;
    const depth = undoDepth(editor.state);
    const nextParagraph = element.querySelectorAll("p")[1];
    fireEvent.pointerDown(nextParagraph, { clientX: 80, clientY: 170 });
    // jsdom does not perform the browser's default caret placement after a click.
    act(() => { editor.commands.setTextSelection(original.firstChild!.nodeSize + 1); });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Insert after text block" })).toBeNull());
    await expectBlockControlsState(false);
    expect(element.querySelectorAll(".note-block-node")).toHaveLength(1);
    expect(element.querySelector(".note-block-node")).toBeVisible();
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(undoDepth(editor.state)).toBe(depth);
    expect(onChange).not.toHaveBeenCalled();
    act(() => { editor.commands.setTextSelection(3); });
    await screen.findByRole("button", { name: "Insert after text block" });
    await expectBlockControlsState(true);
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(undoDepth(editor.state)).toBe(depth);
  });

  it("keeps ordinary editable prose after the final frame without unwrapping the frame", async () => {
    const { editor, element } = await fixture("Only paragraph", true);
    await screen.findByRole("button", { name: "Insert after text block" });
    const originalFrame = editor.state.doc.firstChild!;
    expect(originalFrame.type.name).toBe("noteBlock");
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    fireEvent.pointerDown(element, { clientX: 80, clientY: 200 });
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
    await expectBlockControlsState(false);
    act(() => { editor.commands.insertContent("Ordinary writing continues."); });
    expect(editor.state.doc.firstChild).toBe(originalFrame);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.lastChild?.textContent).toBe("Ordinary writing continues.");
    expect(editor.state.doc.childCount).toBe(2);
  });

  it("splits a persistent block with Enter, keeping text and moving the cursor into the new block", async () => {
    const { editor, element } = await fixture("FirstSecond\n\nOutside prose", true);
    act(() => { editor.commands.setTextSelection(7); });
    const original = editor.state.doc;
    const selection = editor.state.selection;
    const depth = undoDepth(editor.state);
    // Dispatch through the editor DOM so slash capture and ProseMirror keymaps
    // run in the same order as an actual key press.
    fireEvent.keyDown(element, { key: "Enter" });
    const { doc } = editor.state;
    expect(doc.childCount).toBe(3);
    expect(doc.child(0).type.name).toBe("noteBlock");
    expect(doc.child(0).textContent).toBe("First");
    expect(doc.child(1).type.name).toBe("noteBlock");
    expect(doc.child(1).textContent).toBe("Second");
    expect(doc.child(2)).toBe(original.child(1));
    expect(editor.state.selection.empty).toBe(true);
    expect(editor.state.selection.$from.node(1)).toBe(doc.child(1));
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(element.querySelectorAll(".note-block-node")).toHaveLength(2);
    expect(editor.getMarkdown().match(/<!-- orion-block:v1 -->/g)).toHaveLength(2);
    expect(undoDepth(editor.state)).toBe(depth + 1);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(editor.state.selection.eq(selection)).toBe(true);
  });

  it("keeps Shift+Enter as a line break inside the same persistent block", async () => {
    const { editor, element } = await fixture("FirstSecond\n\nOutside prose", true);
    const outside = editor.state.doc.child(1);
    act(() => { editor.commands.setTextSelection(7); });
    fireEvent.keyDown(element, { key: "Enter", shiftKey: true });
    const frame = editor.state.doc.firstChild!;
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1)).toBe(outside);
    expect(frame.type.name).toBe("noteBlock");
    expect(frame.childCount).toBe(1);
    expect(frame.firstChild?.toJSON().content).toEqual([
      { type: "text", text: "First" }, { type: "hardBreak" }, { type: "text", text: "Second" },
    ]);
    expect(editor.state.selection.$from.node(1)).toBe(frame);
    expect(editor.state.selection.$from.parentOffset).toBe(6);
    expect(element.querySelectorAll(".note-block-node")).toHaveLength(1);
  });

  it("keeps Enter in ordinary prose after clicking outside a persistent block", async () => {
    const { editor, element } = await fixture("Framed\n\nOutsideTail", true);
    const frame = editor.state.doc.firstChild!;
    fireEvent.pointerDown(element.querySelectorAll("p")[1], { clientX: 80, clientY: 170 });
    // Supply the caret placement that jsdom does not perform after a click.
    act(() => { editor.commands.setTextSelection(frame.nodeSize + 8); });
    fireEvent.keyDown(element, { key: "Enter" });
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.firstChild).toBe(frame);
    expect(editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(editor.state.doc.child(1).textContent).toBe("Outside");
    expect(editor.state.doc.child(2).type.name).toBe("paragraph");
    expect(editor.state.doc.child(2).textContent).toBe("Tail");
    expect(editor.state.selection.$from.depth).toBe(1);
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(element.querySelectorAll(".note-block-node")).toHaveLength(1);
    await expectBlockControlsState(false);
  });

  it("uses Enter to choose an open slash command before splitting its persistent block", async () => {
    const { editor, element } = await fixture("Before\n\nOutside prose", true);
    const outside = editor.state.doc.child(1);
    act(() => {
      editor.commands.setTextSelection(editor.state.doc.firstChild!.nodeSize - 2);
      editor.commands.insertContent(" /h2");
    });
    await screen.findByRole("option", { name: "Heading 2" });
    fireEvent.keyDown(element, { key: "Enter" });
    const frame = editor.state.doc.firstChild!;
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1)).toBe(outside);
    expect(frame.type.name).toBe("noteBlock");
    expect(frame.firstChild?.type.name).toBe("heading");
    expect(frame.firstChild?.attrs.level).toBe(2);
    expect(frame.textContent).toBe("Before ");
    expect(editor.state.selection.$from.node(1)).toBe(frame);
    expect(element.querySelectorAll(".note-block-node")).toHaveLength(1);
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull();
  });

  it("saves and reopens persistent frames alongside ordinary document content", async () => {
    const first = await fixture(undefined, true);
    const saved = first.editor.getMarkdown();
    const original = first.editor.state.doc.toJSON();
    expect(saved).toContain("<!-- orion-block:v1 -->");
    first.unmount();
    const reopened = await fixture(saved);
    expect(reopened.editor.state.doc.toJSON()).toEqual(original);
    expect(reopened.element.querySelectorAll(".note-block-node")).toHaveLength(1);
    expect(reopened.editor.state.doc.child(1).type.name).toBe("paragraph");
    expect(reopened.editor.getMarkdown()).toBe(saved);
    expect(reopened.onChange).not.toHaveBeenCalled();
  });

  it("moves a frame with the handle's arrow keys and restores its position with one Undo", async () => {
    const { editor } = await fixture(undefined, true);
    const original = editor.state.doc;
    const move = await screen.findByRole("button", { name: "Move block" });
    fireEvent.keyDown(move, { key: "ArrowDown" });
    expect(editor.state.doc.firstChild).toBe(original.lastChild);
    expect(editor.state.doc.child(1)).toBe(original.firstChild);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
  });
});
