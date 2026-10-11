// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichNoteEditor } from "./RichNoteEditor";
import { openEditorExternalLink } from "../lib/openEditorExternalLink";
vi.mock("../lib/openEditorExternalLink", () => ({ openEditorExternalLink: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-content")) return new DOMRect(0, 0, 1200, 760);
    if (this.classList.contains("rich-note-editor")) return new DOMRect(200, 80, 840, 620);
    if (this.classList.contains("editor-prose")) return new DOMRect(280, 130, 680, 500);
    return new DOMRect(280, 200, 80, 20);
  });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(280, 200, 80, 20) },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.clearAllMocks(); });
async function fixture(markdown = "The **evidence** matters.", enabled = false) {
  const onChange = vi.fn();
  const generate = vi.fn().mockResolvedValue("An added thought.");
  const props = { noteId: "draft", markdown, notes: [], concepts: [], sources: [], attachedSourceIds: [],
    onChange, onAttachSource: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn(),
    aiArticleWritingEnabled: enabled, onGenerateAIWriting: generate };
  const rendered = render(<div className="workspace-content"><RichNoteEditor {...props}/></div>);
  const editor = (rendered.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  await waitFor(() => expect(editor.isInitialized).toBe(true));
  return { ...rendered, props, editor, onChange, generate };
}
function select(editor: Editor, from = 5, to = 13) { act(() => { editor.commands.setTextSelection({ from, to }); }); }
describe("editor actions where you write", () => {
  it("offers selection Link without a key and never calls a provider for highlighting", async () => {
    const { editor, generate, onChange } = await fixture();
    select(editor);
    expect(await screen.findByRole("button", { name: "Link selected text" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Turn on AI tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue" })).not.toBeInTheDocument();
    expect(generate).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("preserves selected wording and bold marks in a portable web link, reopening and undoing it", async () => {
    const { editor, onChange, unmount } = await fixture();
    select(editor);
    fireEvent.click(await screen.findByRole("button", { name: "Link selected text" }));
    const input = screen.getByRole("textbox", { name: "Search notes or paste a URL" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "example.com/research" } });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(editor.state.doc.textContent).toBe("The evidence matters.");
    const saved = editor.getMarkdown();
    expect(saved).toContain("https://example.com/research");
    expect(editor.view.dom.querySelector("a strong, strong a")).toHaveTextContent("evidence");
    expect(onChange).toHaveBeenCalled();
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("The **evidence** matters.");
    unmount();
    const reopened = await fixture(saved);
    const link = reopened.editor.view.dom.querySelector("a")!;
    expect(link).toHaveAttribute("href", "https://example.com/research");
    fireEvent.click(link);
    expect(openEditorExternalLink).not.toHaveBeenCalled();
    fireEvent.click(link, { metaKey: true });
    expect(openEditorExternalLink).toHaveBeenCalledWith("https://example.com/research");
  });
  it("Cmd+K expands the current link for explicit Open and Escape restores the selection", async () => {
    const { editor } = await fixture("The [evidence](https://example.com) matters.");
    act(() => { editor.commands.setTextSelection(8); });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note body" }), { key: "k", metaKey: true });
    expect(screen.getByRole("textbox", { name: "Search notes or paste a URL" })).toHaveValue("https://example.com/");
    fireEvent.click(screen.getByRole("button", { name: "Open link in browser" }));
    expect(openEditorExternalLink).toHaveBeenCalledWith("https://example.com/");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(editor.state.selection.from).toBe(5);
    expect(editor.state.selection.to).toBe(13);
  });
  it("refuses stale link destinations after an external edit", async () => {
    const { editor } = await fixture();
    select(editor);
    fireEvent.click(await screen.findByRole("button", { name: "Link selected text" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search notes or paste a URL" }), { target: { value: "example.com" } });
    act(() => { editor.commands.insertContentAt(1, "New "); });
    fireEvent.submit(screen.getByRole("dialog"));
    expect(editor.getMarkdown()).not.toContain("https://");
    expect(screen.getByText("This note changed. Select the words and open Link again.")).toBeInTheDocument();
  });
  it("opens /write without requesting and writes at the captured cursor even after focus moves", async () => {
    const { editor, generate } = await fixture("First thought.\n\nSecond thought.", true);
    act(() => { editor.commands.focus(); editor.commands.setTextSelection(15); editor.commands.insertContent(" /write"); });
    fireEvent.click(await screen.findByRole("option", { name: "Write with AI" }));
    expect(generate).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).not.toContain("/write");
    const slider = screen.getByRole("slider", { name: "Amount of text" });
    fireEvent.change(slider, { target: { value: "0" } });
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
    fireEvent.click(screen.getByRole("button", { name: "Write" }));
    await waitFor(() => expect(generate).toHaveBeenCalled());
    expect(generate.mock.calls[0][0]).toMatchObject({ action: "continue", length: "sentence", caretContext: { beforeMarkdown: "First thought.", afterMarkdown: "Second thought." } });
  });
});
