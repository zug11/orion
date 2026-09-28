import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RichNoteEditor } from "../RichNoteEditor";
import { SlashMenu } from "./SlashMenu";

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ bottom: 250, height: 20, left: 20, right: 25, top: 230, width: 5, x: 20, y: 230, toJSON: () => ({}) }) },
  });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  window.scrollBy = vi.fn();
});
afterEach(cleanup);

describe("slash menu mounted lifecycle", () => {
  it("mounts the full rich editor in StrictMode and consumes Enter before paragraph keymaps", async () => {
    render(<StrictMode><RichNoteEditor noteId="strict-slash" markdown="" notes={[]} concepts={[]} sources={[]} attachedSourceIds={[]}
      onChange={vi.fn()} onAttachSource={vi.fn()} onRegisterConcept={() => "concept"} onDisableConceptAutoLink={vi.fn()} /></StrictMode>);
    const dom = await screen.findByRole("textbox", { name: "Note body" });
    const editor = (dom as HTMLElement & { editor: Editor }).editor;
    await act(async () => { editor.commands.focus(); });
    await waitFor(() => expect(editor.isFocused).toBe(true));
    act(() => { editor.commands.insertContent("/h6"); });
    await screen.findByRole("option", { name: "Heading 6" });
    fireEvent.keyDown(dom, { key: "Enter" });
    await waitFor(() => expect(editor.state.doc.firstChild?.type.name).toBe("heading"));
    expect(editor.state.doc.firstChild?.attrs.level).toBe(6);
    // StarterKit adds one ordinary trailing paragraph after a heading.
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("");
    expect(screen.queryByRole("listbox", { name: "Slash commands" })).not.toBeInTheDocument();
  });

  it("rebinds after suspend and editor remount without duplicate plugins or keyboard handlers", async () => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({ element, extensions: [StarterKit], content: "<p>/todo</p>" });
    const initialPlugins = [...editor.state.plugins];
    const onCommand = vi.fn();
    const view = render(<StrictMode><SlashMenu editor={editor} suspended={false} onCommand={onCommand}/></StrictMode>);
    try {
      await act(async () => { editor.commands.focus("end"); });
      await screen.findByRole("option", { name: "To-do" });
      view.rerender(<StrictMode><SlashMenu editor={editor} suspended onCommand={onCommand}/></StrictMode>);
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      view.rerender(<StrictMode><SlashMenu editor={editor} suspended={false} onCommand={onCommand}/></StrictMode>);
      await screen.findByRole("option", { name: "To-do" });
      const oldDOM = editor.view.dom;
      act(() => editor.unmount());
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      act(() => editor.mount(element));
      await act(async () => { editor.commands.focus("end"); });
      await screen.findByRole("option", { name: "To-do" });
      fireEvent.keyDown(editor.view.dom, { key: "Enter" });
      expect(onCommand).toHaveBeenCalledTimes(1);
      expect(onCommand).toHaveBeenCalledWith("todo", { from: 1, to: 6 });
      expect(editor.state.doc.childCount).toBe(1);
      expect(editor.state.plugins).toHaveLength(initialPlugins.length);
      expect(oldDOM).not.toHaveAttribute("aria-controls");
    } finally { view.unmount(); editor.destroy(); element.remove(); }
  });

  it("can render against an editor whose view has not been mounted", () => {
    const editor = new Editor({ element: null, extensions: [StarterKit], content: "<p>/</p>" });
    const view = render(<StrictMode><SlashMenu editor={editor} suspended={false} onCommand={vi.fn()}/></StrictMode>);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    view.unmount();
    editor.destroy();
  });

  it.each(["Escape", "Enter"])("allows the same inline command to be typed again after %s", async (key) => {
    const element = document.createElement("div");
    document.body.append(element);
    const editor = new Editor({ element, extensions: [StarterKit], content: "<p>Remember /todo</p>" });
    const view = render(<SlashMenu editor={editor} suspended={false} onCommand={vi.fn()}/>);
    try {
      await act(async () => { editor.commands.focus("end"); });
      await screen.findByRole("option", { name: "To-do" });
      fireEvent.keyDown(editor.view.dom, { key });
      // Unrelated state updates must not immediately reopen a dismissed menu.
      act(() => { editor.view.dispatch(editor.state.tr.setMeta("test-update", true)); });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      act(() => { editor.commands.deleteRange({ from: 10, to: 15 }); });
      act(() => { editor.commands.insertContent("/todo"); });
      await screen.findByRole("option", { name: "To-do" });
      expect(editor.state.doc.textContent).toBe("Remember /todo");
    } finally { view.unmount(); editor.destroy(); element.remove(); }
  });
});
