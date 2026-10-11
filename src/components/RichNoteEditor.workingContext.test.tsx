// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RichNoteEditor } from "./RichNoteEditor";
import * as conceptLinkSelection from "./editor/conceptLinkSelection";

type Props = ComponentProps<typeof RichNoteEditor>;
const body = "Visible introduction.\n\n- [x] PRIVATE DONE\n  - [ ] PRIVATE CHILD\n- [ ] OPEN SIBLING\n\nVisible conclusion.";
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function fixture(callbacks: Partial<Props>) {
  const rendered = render(<div className="workspace-content"><RichNoteEditor noteId="draft" markdown={body}
    notes={[]} concepts={[]} sources={[]} attachedSourceIds={[]} onChange={vi.fn()} onAttachSource={vi.fn()}
    onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} aiArticleWritingEnabled aiImageGenerationEnabled {...callbacks}/></div>);
  const editor = (rendered.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  return editor;
}
function select(editor: Editor, phrase: string) {
  let position = -1;
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(phrase)) position = pos + node.text.indexOf(phrase); });
  if (position < 0) throw new Error("Missing selected fixture text");
  act(() => { editor.commands.setTextSelection({ from: position, to: position + phrase.length }); });
}
function assertSafe(input: { documentMarkdown?: string; workingContext?: unknown }) {
  expect(input.documentMarkdown).toContain("PRIVATE DONE");
  expect(JSON.stringify(input.workingContext)).not.toContain("PRIVATE");
  expect(JSON.stringify(input.workingContext)).toContain("OPEN SIBLING");
}
describe("rich editor provider-only working context", () => {
  it("passes the safe writing projection and preserves it for Retry without changing the original capture", async () => {
    const generate = vi.fn<NonNullable<Props["onGenerateAIWriting"]>>().mockRejectedValue(new Error("Try later"));
    const editor = await fixture({ onGenerateAIWriting: generate }); select(editor, "OPEN SIBLING");
    fireEvent.click(await screen.findByRole("button", { name: "Rewrite" }));
    fireEvent.submit(screen.getByRole("dialog", { name: "Rewrite selected text" }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    assertSafe(generate.mock.calls[0][0]);
    fireEvent.click(await screen.findByRole("button", { name: "Try AI writing again" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][0].workingContext).toEqual(generate.mock.calls[0][0].workingContext);
    expect(editor.getMarkdown()).toContain("PRIVATE DONE");
  });
  it("passes protected-selection flags to image generation and preserves them through Retry", async () => {
    const generate = vi.fn<NonNullable<Props["onGenerateAIImage"]>>().mockRejectedValue(new Error("Try later"));
    const editor = await fixture({ onGenerateAIImage: generate }); select(editor, "PRIVATE CHILD");
    fireEvent.click(await screen.findByRole("button", { name: "Generate image from selected text" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    assertSafe(generate.mock.calls[0][0]);
    expect(generate.mock.calls[0][0].workingContext).toMatchObject({ selectionTouchesCompleted: true });
    fireEvent.click(await screen.findByRole("button", { name: "Retry image generation" }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    expect(generate.mock.calls[1][0].workingContext).toEqual(generate.mock.calls[0][0].workingContext);
  });
  it("binds link naming to the captured exact selection despite later focus/selection changes", async () => {
    const generate = vi.fn<NonNullable<Props["onGenerateLinkTitle"]>>().mockRejectedValue(new Error("Try later"));
    const editor = await fixture({ onGenerateLinkTitle: generate }); select(editor, "OPEN SIBLING");
    fireEvent.click(await screen.findByRole("button", { name: "Link selected text" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a linked article" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Generate title with AI" }));
    act(() => { editor.commands.setTextSelection(2); });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(generate).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0][0]).toBe("OPEN SIBLING");
    assertSafe(generate.mock.calls[0][2]!);
    expect(generate.mock.calls[0][2]?.workingContext).toMatchObject({ selectionTouchesCompleted: false, selectedText: "OPEN SIBLING" });
    act(() => { editor.commands.insertContentAt(1, "A changed note. "); });
    fireEvent.submit(screen.getByRole("dialog"));
    await screen.findByText(/This note changed or its selection is unavailable/);
    expect(generate).toHaveBeenCalledOnce();
  });
  it("passes the same captured context when creating an AI article with a manually entered title", async () => {
    const register = vi.fn<NonNullable<Props["onRegisterConcept"]>>().mockReturnValue("concept");
    const editor = await fixture({ onRegisterConcept: register }); select(editor, "PRIVATE CHILD");
    fireEvent.click(await screen.findByRole("button", { name: "Link selected text" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a linked article" }));
    act(() => { editor.commands.setTextSelection(2); });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(register).toHaveBeenCalledOnce());
    const input = register.mock.calls[0][0];
    expect(input).toMatchObject({ articleMode: "ai", selectedContext: "PRIVATE CHILD" });
    assertSafe(input.editorContext!);
    expect(input.editorContext?.workingContext).toMatchObject({ selectionTouchesCompleted: true, selectedText: "" });
  });
  it("records the exact emitted authored body after a contextual link, including frontmatter", async () => {
    const onChange = vi.fn(), register = vi.fn<NonNullable<Props["onRegisterConcept"]>>().mockReturnValue("concept-context");
    const prefix = "---\ntitle: Authored note\ncustom: retain me\n---\n\n";
    const prose = "First paragraph stays.\n\nSecond paragraph stays.";
    const editor = await fixture({ markdown: prefix + prose, onChange, onRegisterConcept: register });
    act(() => { editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 }); });
    fireEvent.click(await screen.findByRole("button", { name: "Link selected text" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a linked article" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Page title" }), { target: { value: "Context page" } });
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(register).toHaveBeenCalledOnce());
    const receipt = register.mock.calls[0][0].linkedDocument;
    expect(receipt?.body).toBe(onChange.mock.calls[onChange.mock.calls.length - 1][0]);
    expect(receipt?.body).toContain(prefix.trim());
    expect(receipt?.body).toContain("[Context page](orion-concept://concept-context)");
    expect(receipt?.body).toContain(prose);
    expect(editor.getMarkdown()).not.toContain("custom: retain me");
    expect(editor.getMarkdown()).toContain(prose);
  });
  it("does not confirm an authored body when the link transaction fails", async () => {
    const register = vi.fn<NonNullable<Props["onRegisterConcept"]>>().mockReturnValue("concept-failed");
    const editor = await fixture({ onRegisterConcept: register }); select(editor, "OPEN SIBLING");
    fireEvent.click(await screen.findByRole("button", { name: "Link selected text" }));
    fireEvent.click(screen.getByRole("button", { name: "Create a linked article" }));
    const before = editor.getMarkdown();
    vi.spyOn(conceptLinkSelection, "applyConceptLinkToEditor").mockReturnValue(false);
    fireEvent.submit(screen.getByRole("dialog"));
    await waitFor(() => expect(register).toHaveBeenCalledOnce());
    expect(register.mock.calls[0][0].linkedDocument).toEqual({});
    expect(editor.getMarkdown()).toBe(before);
  });
});
