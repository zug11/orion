// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Note, Settings } from "../types";
import { defaultSettings } from "../data/defaults";
import * as visualGeneration from "../lib/visualArtifactGeneration";
import type { VisualArtifact } from "../lib/visualArtifacts";
import { RichNoteEditor } from "./RichNoteEditor";

beforeAll(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) },
  });
});
afterEach(cleanup);

function fixture(markdown: string, notes: Note[] = [], settings?: Settings) {
  const view = render(<RichNoteEditor settings={settings} noteId="origin" markdown={markdown} notes={notes} concepts={[]} sources={[]} attachedSourceIds={[]} onChange={vi.fn()} onAttachSource={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  const element = view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor };
  return { ...view, element, editor: element.editor };
}

async function chooseInlineCommand(editor: Editor, original: string, token: string, name: string) {
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
  act(() => { editor.commands.focus(undefined, { scrollIntoView: false }); });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  act(() => { editor.commands.setTextSelection(original.indexOf(token) + token.length + 1); });
  const choice = await screen.findByRole("option", { name });
  fireEvent.mouseDown(choice);
  fireEvent.click(choice);
}

describe("inline slash commands in the real note editor", () => {
  it("chooses /visualise by keyboard, keeps cancellation local, then saves a generated artifact in one Undo", async () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    const generated: VisualArtifact = { version: 1, format: "explainer", title: "Capacity",
      blocks: [{ kind: "text", text: "A battery stores excess power." }] };
    const generate = vi.spyOn(visualGeneration, "generateVisualArtifact").mockResolvedValue(generated);
    const original = "The battery stores excess power. /vis";
    const { element, editor } = fixture(original + "\n\nPrivate follow-up.", [], { ...defaultSettings, apiKeyConfigured: true });
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 10, right: 11, top: 25, bottom: 40 });
    async function chooseWithKeyboard() {
      act(() => { editor.commands.focus(undefined, { scrollIntoView: false }); });
      await waitFor(() => expect(editor.isFocused).toBe(true));
      act(() => { editor.commands.setTextSelection(original.length + 1); });
      const option = await screen.findByRole("option", { name: "Visualise" });
      expect(option).toHaveAttribute("aria-selected", "true");
      fireEvent.keyDown(element, { key: "Enter" });
      return screen.findByRole("dialog", { name: "Visualise" });
    }
    try {
      const cancelDialog = await chooseWithKeyboard();
      expect(within(cancelDialog).getByRole("blockquote")).toHaveTextContent("The battery stores excess power.");
      expect(generate).not.toHaveBeenCalled();
      // Native Escape on a modal dispatches cancel. jsdom has no dialog default action.
      fireEvent(cancelDialog, new Event("cancel", { cancelable: true }));
      expect(editor.getMarkdown()).toBe(original + "\n\nPrivate follow-up.");
      expect(generate).not.toHaveBeenCalled();
      act(() => { editor.commands.setTextSelection(1); });
      const dialog = await chooseWithKeyboard();
      fireEvent.change(within(dialog).getByLabelText("Format"), { target: { value: "explainer" } });
      const guidance = within(dialog).getByLabelText(/Guidance/);
      expect(guidance).toHaveFocus();
      fireEvent.keyDown(guidance, { key: "Enter" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Visualise" })).toBeNull());
      expect(generate).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledWith("The battery stores excess power.", "explainer", "", expect.any(Object), expect.any(AbortSignal));
      expect(editor.state.doc.child(1).type.name).toBe("noteVisualArtifact");
      expect(screen.getByRole("heading", { name: "Capacity" })).toBeInTheDocument();
      act(() => { editor.commands.undo(); });
      expect(editor.getMarkdown()).toBe(original + "\n\nPrivate follow-up.");
    } finally {
      generate.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it.each(["/block", "Before /block after."])("creates a persistent block from %s with the caret ready to write", async original => {
    const { editor } = fixture(original);
    await chooseInlineCommand(editor, original, "/block", "Block");
    expect(editor.state.doc.firstChild?.type.name).toBe("noteBlock");
    expect(editor.state.doc.firstChild?.textContent).toBe(original.replace("/block", ""));
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.node(1).type.name).toBe("noteBlock");
    act(() => { editor.commands.insertContent("New words"); });
    expect(editor.state.doc.firstChild?.textContent).toBe(original.replace("/block", "New words"));
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.firstChild?.type.name).toBe("noteBlock");
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe(original);
    act(() => { editor.commands.redo(); });
    expect(editor.state.doc.firstChild?.type.name).toBe("noteBlock");
    const saved = editor.getMarkdown();
    const reopened = fixture(saved);
    expect(reopened.editor.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
  });

  it("keeps an existing block when /block is selected again without nesting or unwrapping", async () => {
    const { editor } = fixture("<!-- orion-block:v1 -->\nInside /block\n<!-- /orion-block -->");
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
    act(() => { editor.commands.focus(undefined, { scrollIntoView: false }); });
    await waitFor(() => expect(editor.isFocused).toBe(true));
    act(() => { editor.commands.setTextSelection(2 + "Inside /block".length); });
    fireEvent.click(await screen.findByRole("option", { name: /^Block$/ }));
    expect(editor.state.doc.firstChild?.type.name).toBe("noteBlock");
    expect(editor.state.doc.firstChild?.child(0).type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("Inside ");
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.firstChild?.textContent).toBe("Inside /block");
  });

  it.each(["Before the table /table", "Before the table /table after the table."])("inserts a table without removing surrounding prose: %s", async (original) => {
    const { editor } = fixture(original);
    await chooseInlineCommand(editor, original, "/table", "Table");
    fireEvent.click(await screen.findByRole("button", { name: "2 columns, 2 rows" }));
    expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.doc.firstChild?.textContent).toBe("Before the table ");
    expect(editor.state.doc.child(1).type.name).toBe("table");
    expect(editor.state.doc.lastChild?.textContent).toBe(original.includes(" after") ? " after the table." : "");
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.textContent).toBe(original);
  });

  it("replaces only the inline /link token with the selected note title", async () => {
    const target: Note = { id: "target", title: "Target article", body: "Evidence in the target.", slug: "target", summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
    const original = "Read /link for the explanation.";
    const { editor } = fixture(original, [target]);
    await chooseInlineCommand(editor, original, "/link", "Link a note");
    const picker = await screen.findByRole("dialog", { name: "Link a note" });
    fireEvent.click(within(picker).getByRole("button", { name: /Target article/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Link a note" })).toBeNull());
    expect(editor.state.doc.textContent).toBe("Read Target article for the explanation.");
    expect(editor.getHTML()).toContain('href="orion-note://target"');
    expect(editor.getHTML()).toContain('>Target article</a>');
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.textContent).toBe(original);
  });

  it("formats the containing paragraph as a to-do while preserving prose and one-step undo", async () => {
    const original = "Remember /todo to call the editor.";
    const { editor } = fixture(original);
    await chooseInlineCommand(editor, original, "/todo", "To-do");
    expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
    expect(editor.state.doc.textContent).toBe("Remember  to call the editor.");
    expect(editor.getMarkdown()).toContain("- [ ] Remember");
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe(original);
  });

  it("opens a repeated command at the same location after undo and retyping", async () => {
    const original = "Before /table after.";
    const { editor } = fixture(original);
    await chooseInlineCommand(editor, original, "/table", "Table");
    fireEvent.click(await screen.findByRole("button", { name: "2 columns, 2 rows" }));
    act(() => { editor.commands.undo(); });
    act(() => { editor.commands.insertContentAt({ from: 8, to: 14 }, "/"); });
    await screen.findByRole("option", { name: "Table" });
    act(() => { editor.commands.insertContent("table"); });
    expect(await screen.findByRole("option", { name: "Table" })).toBeVisible();
  });
});
