// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ImageToolbar, NoteImage } from "./NoteImage";

const editors: Editor[] = [];
const terminals: HTMLElement[] = [];
function fixture(compact: boolean) {
  const editor = new Editor({
    extensions: [StarterKit, NoteImage],
    content: { type: "doc", content: [
      { type: "image", attrs: { src: "orion-image://localhost/image_Abc-123456789", alt: "Diagram", widthPercent: 40, placement: "wrap", alignment: "left" } },
      { type: "paragraph", content: [{ type: "text", text: "Unchanged prose." }] },
    ] },
    editorProps: { handleScrollToSelection: () => true },
  });
  editor.commands.setNodeSelection(0);
  editors.push(editor);
  const terminal = document.createElement("div");
  document.body.append(terminal);
  terminals.push(terminal);
  return { editor, terminal, ...render(<ImageToolbar editor={editor} overflowTarget={terminal} compact={compact} />) };
}
afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  for (const terminal of terminals.splice(0)) terminal.remove();
});

describe("responsive image toolbar", () => {
  it("keeps placement in the compact row and all other image controls in its existing More dialog", () => {
    const { editor, terminal } = fixture(true);
    const main = screen.getByRole("group", { name: "Image tools" });
    expect(within(main).getByRole("combobox", { name: "Image placement" })).toBeVisible();
    expect(within(main).queryByRole("combobox", { name: "Image alignment" })).toBeNull();
    expect(within(main).queryByRole("spinbutton", { name: "Image width percent" })).toBeNull();
    const more = within(terminal).getByRole("button", { name: "More image options" });
    expect(more.textContent).toBe("•••");
    expect(more.querySelector("svg")).toBeNull();
    fireEvent.click(more);
    const dialog = screen.getByRole("dialog", { name: "Image options" });
    expect(terminal.contains(dialog)).toBe(true);
    const alignment = within(dialog).getByRole("combobox", { name: "Image alignment" });
    expect(alignment).toHaveFocus();
    expect(fireEvent.keyDown(alignment, { key: "ArrowDown" })).toBe(true);
    expect(alignment).toHaveFocus();
    fireEvent.change(alignment, { target: { value: "right" } });
    const width = within(dialog).getByRole("spinbutton", { name: "Image width percent" });
    fireEvent.change(width, { target: { value: "65" } });
    fireEvent.blur(width);
    fireEvent.change(within(dialog).getByRole("slider", { name: "Image text gap" }), { target: { value: "32" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Caption" }));
    expect(editor.getAttributes("image")).toMatchObject({ alignment: "right", widthPercent: 65, gap: 32, showCaption: true });
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    expect(editor.state.doc.lastChild?.textContent).toBe("Unchanged prose.");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image options" })).toBeNull();
    expect(more).toHaveFocus();
    expect(more).toHaveAttribute("aria-expanded", "false");
  });

  it("moves the same controls between layouts without changing image content or selection", () => {
    const { editor, terminal, rerender } = fixture(false);
    const original = editor.state.doc;
    const selection = editor.state.selection;
    const main = screen.getByRole("group", { name: "Image tools" });
    expect(within(main).getByRole("combobox", { name: "Image alignment" })).toHaveValue("left");
    expect(within(main).getByRole("spinbutton", { name: "Image width percent" })).toHaveValue(40);
    rerender(<ImageToolbar editor={editor} overflowTarget={terminal} compact />);
    fireEvent.click(screen.getByRole("button", { name: "More image options" }));
    expect(within(screen.getByRole("dialog", { name: "Image options" })).getByRole("spinbutton", { name: "Image width percent" })).toHaveValue(40);
    rerender(<ImageToolbar editor={editor} overflowTarget={terminal} compact={false} />);
    expect(within(main).getByRole("spinbutton", { name: "Image width percent" })).toHaveValue(40);
    expect(screen.getAllByRole("spinbutton", { name: "Image width percent" })).toHaveLength(1);
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(editor.state.selection.eq(selection)).toBe(true);
    expect(editor.can().undo()).toBe(false);
  });

  it("commits width with Enter from compact options and preserves one-step Undo", () => {
    const { editor } = fixture(true);
    const original = editor.state.doc;
    fireEvent.click(screen.getByRole("button", { name: "More image options" }));
    const width = screen.getByRole("spinbutton", { name: "Image width percent" });
    fireEvent.change(width, { target: { value: "55" } });
    fireEvent.keyDown(width, { key: "Enter" });
    expect(editor.getAttributes("image").widthPercent).toBe(55);
    expect(editor.state.selection).toBeInstanceOf(NodeSelection);
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
  });
});
