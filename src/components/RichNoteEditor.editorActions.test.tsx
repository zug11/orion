// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorActionHost, EditorActionStartOptions, EditorActionState } from "../lib/assistant/editorActionHost";
import { RichNoteEditor } from "./RichNoteEditor";
import { startInlineFlow, finishInlineFlow } from "./editor/FlowWriting";
import * as storage from "../lib/storage";

type Props = ComponentProps<typeof RichNoteEditor>;
const markdown = "---\ntitle: Keep this frontmatter\n---\n\nThe opening thought.\n\n- [x] PRIVATE COMPLETED\n\nA final thought.";
const rewrite = { kind: "rewrite" as const, preset: "clarify" as const, instruction: "Preserve the voice." };
const image = { fileName: "illustration.jpg", mimeType: "image/jpeg" as const, byteSize: 4, base64Data: "/9j/2Q==", alt: "An opening" };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
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
async function fixture(extra: Partial<Props> = {}) {
  let host!: EditorActionHost;
  const onChange = vi.fn(), generate = vi.fn().mockResolvedValue("The revised opening.");
  const props: Props = { noteId: "draft", markdown, notes: [], concepts: [], sources: [], attachedSourceIds: [], onChange,
    onAttachSource: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn(), aiArticleWritingEnabled: true,
    aiImageGenerationEnabled: true, onGenerateAIWriting: generate, onGenerateAIImage: vi.fn().mockResolvedValue(image),
    onEditorActionHostChange: value => { if (value) host = value; }, ...extra };
  const view = render(<div className="workspace-content"><RichNoteEditor {...props}/></div>);
  const editor = (view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  if ((extra.markdown ?? markdown).includes("The opening thought.")) select(editor, "The opening thought.");
  return { ...view, host, editor, generate, onChange,
    update: (changes: Partial<Props>) => view.rerender(<div className="workspace-content"><RichNoteEditor {...props} {...changes}/></div>),
  };
}
function select(editor: Editor, phrase: string) {
  let position = -1;
  editor.state.doc.descendants((node, pos) => { if (node.isText && node.text?.includes(phrase)) position = pos + node.text.indexOf(phrase); });
  if (position < 0) throw new Error("Missing text");
  act(() => { editor.commands.setTextSelection({ from: position, to: position + phrase.length }); });
}
function options(overrides: Partial<EditorActionStartOptions> = {}) {
  return { grant: { actionId: "action-test", sessionId: "session-test" }, beforeReview: vi.fn().mockResolvedValue(undefined),
    beforeAccept: vi.fn().mockResolvedValue(undefined), afterAccept: vi.fn().mockResolvedValue(undefined),
    onState: vi.fn<(value: EditorActionState) => void>(), ...overrides };
}

describe("external inline actions use the actual rich editor", () => {
  it("captures original and normalized ranges, keeps frontmatter and working projection, and ignores control focus", async () => {
    const { host, editor, generate } = await fixture();
    const captured = host.capture(rewrite);
    expect(captured).toMatchObject({ noteId: "draft", markdown, selection: { from: 1, to: 21, empty: false }, effectiveTarget: { from: 1, to: 21, mode: "inline" } });
    act(() => { editor.commands.blur(); screen.getByRole("button", { name: "More formatting" }).focus(); });
    expect(host.isCaptureCurrent(captured.captureId)).toBe(true);
    const events = options(); act(() => host.start(captured.captureId, events));
    await screen.findByRole("region", { name: "AI writing preview" });
    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0][0]).toMatchObject({ action: "clarify", instruction: "Preserve the voice.", editorActionGrant: events.grant });
    expect(JSON.stringify(generate.mock.calls[0][0].workingContext)).not.toContain("PRIVATE COMPLETED");
    expect(generate.mock.calls[0][0].documentMarkdown).toContain("PRIVATE COMPLETED");
    expect(host.isCaptureCurrent(captured.captureId)).toBe(true);
    expect(editor.getMarkdown()).toContain("The opening thought.");
  });
  it("invalidates a capture after selection moves away and returns, or a document change is undone", async () => {
    const { host, editor, generate } = await fixture();
    const captured = host.capture(rewrite);
    act(() => { editor.commands.setTextSelection(2); }); select(editor, "The opening thought.");
    expect(host.isCaptureCurrent(captured.captureId)).toBe(false);
    expect(() => host.start(captured.captureId, options())).toThrow(/changed/);
    const second = host.capture(rewrite);
    act(() => { editor.commands.insertContentAt(1, "X"); editor.commands.undo(); });
    expect(host.isCaptureCurrent(second.captureId)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
  it("blocks Flow and an open composer and does not revive a previously captured selection", async () => {
    const { host, editor } = await fixture();
    const captured = host.capture(rewrite);
    act(() => { startInlineFlow(editor, 60_000, 10); });
    expect(host.getState().ready).toBe(false);
    expect(() => host.capture(rewrite)).toThrow(/Finish/);
    act(() => { finishInlineFlow(editor, true); });
    expect(host.isCaptureCurrent(captured.captureId)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Write with AI" }));
    expect(host.getState().ready).toBe(false);
    expect(() => host.capture(rewrite)).toThrow(/Finish/);
  });
  it("blocks local Rewrite and Image composers while preserving manual control focus", async () => {
    const { host } = await fixture();
    const captured = host.capture(rewrite);
    fireEvent.click(screen.getByRole("button", { name: "Rewrite" }));
    expect(host.getState().ready).toBe(false);
    expect(host.isCaptureCurrent(captured.captureId)).toBe(false);
    expect(() => host.capture(rewrite)).toThrow(/Finish/);
    fireEvent.keyDown(screen.getByRole("textbox", { name: /Rewrite direction/ }), { key: "Escape" });
    expect(host.getState().ready).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Generate image from selected text" }));
    expect(host.getState().ready).toBe(false);
    expect(() => host.capture({ kind: "image", quality: "fast", context: "selection" })).toThrow(/Finish/);
  });
  it("captures Write at the selected end without changing selection, and requires a passage for Rewrite and Image", async () => {
    const { host, editor } = await fixture();
    const originalSelection = editor.state.selection.toJSON();
    const selectedWrite = host.capture({ kind: "write", amount: "sentence" });
    expect(selectedWrite.selection.empty).toBe(false);
    expect(selectedWrite.effectiveTarget).toMatchObject({ from: selectedWrite.selection.to, to: selectedWrite.selection.to });
    expect(editor.state.selection.toJSON()).toEqual(originalSelection);
    act(() => { editor.commands.setTextSelection(5); });
    expect(() => host.capture(rewrite)).toThrow(/Select/);
    expect(() => host.capture({ kind: "image", quality: "fast", context: "selection" })).toThrow(/Select/);
    const captured = host.capture({ kind: "write", amount: "paragraph" });
    expect(captured.selection).toMatchObject({ from: 5, to: 5, empty: true });
    expect(captured.effectiveTarget.from).toBeGreaterThan(captured.selection.from);
  });
  it("clamps whole-document Write to the same text boundary as the local composer without moving AllSelection", async () => {
    const { host, editor, onChange } = await fixture();
    act(() => { editor.commands.selectAll(); });
    const originalSelection = editor.state.selection.toJSON(), originalDocument = editor.getJSON();
    expect(originalSelection.type).toBe("all");
    const captured = host.capture({ kind: "write", amount: "sentence" });
    expect(captured.selection.to).toBe(editor.state.doc.content.size);
    const textEnd = TextSelection.atEnd(editor.state.doc).to;
    expect(captured.effectiveTarget).toMatchObject({ from: textEnd, to: textEnd, mode: "inline" });
    expect(textEnd).toBeLessThan(captured.selection.to);
    expect(editor.state.selection.toJSON()).toEqual(originalSelection);
    const hooks = options(); act(() => host.start(captured.captureId, hooks));
    fireEvent.click(await screen.findByRole("button", { name: "Accept AI writing" }));
    await waitFor(() => expect(hooks.afterAccept).toHaveBeenCalledOnce());
    expect(onChange.mock.lastCall![0]).toContain("A final thought. The revised opening.");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor.getJSON()).toEqual(originalDocument);
  });
  it("uses an empty paragraph placeholder for Write and does not discard astral instruction characters", async () => {
    const { host, generate, editor } = await fixture({ markdown: "" });
    const capture = host.capture({ kind: "write", amount: "paragraph", instruction: "😀".repeat(1_250) });
    expect(capture.effectiveTarget).toEqual({ from: 0, to: 2, mode: "blocks" });
    const hooks = options(); act(() => host.start(capture.captureId, hooks));
    fireEvent.click(await screen.findByRole("button", { name: "Accept AI writing" }));
    await waitFor(() => expect(hooks.afterAccept).toHaveBeenCalledOnce());
    expect(generate.mock.calls[0][0].instruction).toHaveLength(2_500);
    expect(editor.getMarkdown()).toBe("The revised opening.");
  });
  it("awaits native review and native acceptance, records exact serialization once and retains one Undo", async () => {
    const review = deferred<void>(), claim = deferred<void>();
    const { host, editor, onChange } = await fixture(); const before = editor.getJSON();
    const hooks = options({ beforeReview: vi.fn(() => review.promise), beforeAccept: vi.fn(() => claim.promise) });
    const captured = host.capture(rewrite); act(() => host.start(captured.captureId, hooks));
    await waitFor(() => expect(hooks.beforeReview).toHaveBeenCalledOnce());
    expect(screen.queryByRole("button", { name: "Accept AI writing" })).toBeNull(); expect(onChange).not.toHaveBeenCalled();
    await act(async () => { review.resolve(); });
    fireEvent.click(await screen.findByRole("button", { name: "Accept AI writing" }));
    expect(hooks.beforeAccept).toHaveBeenCalledOnce(); expect(hooks.afterAccept).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
    expect(editor.isEditable).toBe(false);
    await act(async () => { claim.resolve(); });
    await waitFor(() => expect(hooks.afterAccept).toHaveBeenCalledOnce());
    expect(hooks.afterAccept).toHaveBeenCalledWith(onChange.mock.lastCall![0]);
    expect(onChange.mock.lastCall![0]).toContain("title: Keep this frontmatter");
    expect(onChange.mock.lastCall![0]).toContain("PRIVATE COMPLETED");
    expect(onChange.mock.lastCall![0]).toContain("The revised opening.");
    expect(host.cancel(captured.captureId)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor.getJSON()).toEqual(before);
  });
  it("cancels while native acceptance is pending without applying a late claim", async () => {
    const claim = deferred<void>(); const { host, editor, onChange } = await fixture(); const before = editor.getJSON();
    const hooks = options({ beforeAccept: vi.fn(() => claim.promise) }); const captured = host.capture(rewrite);
    act(() => host.start(captured.captureId, hooks));
    fireEvent.click(await screen.findByRole("button", { name: "Accept AI writing" }));
    act(() => { expect(host.cancel(captured.captureId)).toBe(true); });
    await act(async () => { claim.resolve(); });
    expect(onChange).not.toHaveBeenCalled(); expect(hooks.afterAccept).not.toHaveBeenCalled(); expect(editor.getJSON()).toEqual(before);
    expect(hooks.onState).toHaveBeenLastCalledWith({ captureId: captured.captureId, phase: "cancelled" });
    expect(editor.isEditable).toBe(true);
  });
  it("discards a ready preview without mutation or native acceptance", async () => {
    const { host, onChange } = await fixture(); const hooks = options(); const captured = host.capture(rewrite);
    act(() => host.start(captured.captureId, hooks));
    fireEvent.click(await screen.findByRole("button", { name: "Discard AI writing" }));
    expect(hooks.onState).toHaveBeenLastCalledWith({ captureId: captured.captureId, phase: "discarded" });
    expect(onChange).not.toHaveBeenCalled(); expect(hooks.beforeAccept).not.toHaveBeenCalled();
  });
  it("drops late generation after cancellation and does not publish native review", async () => {
    const result = deferred<string>(), generate = vi.fn(() => result.promise);
    const { host, editor, onChange } = await fixture({ onGenerateAIWriting: generate }); const hooks = options(), captured = host.capture(rewrite);
    act(() => host.start(captured.captureId, hooks)); act(() => { host.cancel(captured.captureId); });
    await act(async () => { result.resolve("This must never appear."); });
    expect(hooks.beforeReview).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled(); expect(editor.isEditable).toBe(true);
    expect(screen.queryByRole("region", { name: "AI writing preview" })).toBeNull();
  });
  it("drops a failed native claim and a document changed programmatically during preview", async () => {
    const { host, editor, onChange } = await fixture(); const hooks = options({ beforeAccept: vi.fn().mockRejectedValue(new Error("Permission revoked")) });
    const captured = host.capture(rewrite); act(() => host.start(captured.captureId, hooks));
    fireEvent.click(await screen.findByRole("button", { name: "Accept AI writing" }));
    await waitFor(() => expect(hooks.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "error", error: "Permission revoked" })));
    expect(onChange).not.toHaveBeenCalled(); expect(editor.isEditable).toBe(true);
    select(editor, "The opening thought."); const next = host.capture(rewrite), nextHooks = options();
    act(() => host.start(next.captureId, nextHooks)); await screen.findByRole("region", { name: "AI writing preview" });
    act(() => { editor.commands.insertContentAt(1, "Local change. "); });
    expect(nextHooks.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "stale" }));
    expect(screen.queryByRole("region", { name: "AI writing preview" })).toBeNull();
    expect(editor.getMarkdown()).not.toContain("The revised opening.");
  });
  it("sends the grant through image generation and acceptance storage, inserts once and undoes", async () => {
    const save = vi.spyOn(storage, "persistGeneratedNoteImage").mockResolvedValue({ id: "saved-image", fileName: image.fileName,
      mimeType: image.mimeType, byteSize: 4, src: "data:image/jpeg;base64,/9j/2Q==" });
    const generate = vi.fn().mockResolvedValue(image); const { host, editor, onChange } = await fixture({ onGenerateAIImage: generate });
    const before = editor.getJSON(), hooks = options(), captured = host.capture({ kind: "image", quality: "fast", context: "space", instruction: "A small illustration." });
    act(() => host.start(captured.captureId, hooks)); await screen.findByRole("region", { name: "Generated image preview" });
    expect(generate.mock.calls[0][0]).toMatchObject({ quality: "fast", contextMode: "space", editorActionGrant: hooks.grant });
    fireEvent.click(screen.getByRole("button", { name: "Insert generated image" }));
    await waitFor(() => expect(hooks.afterAccept).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(image, expect.any(String), hooks.grant);
    expect(hooks.afterAccept).toHaveBeenCalledWith(onChange.mock.lastCall![0]);
    expect(editor.getHTML()).toContain("<img");
    act(() => { editor.commands.undo(); }); expect(editor.getJSON()).toEqual(before);
  });
  it("unmounts cancel generation and stale callbacks never touch the closed editor", async () => {
    const result = deferred<string>(); const { host, unmount, onChange } = await fixture({ onGenerateAIWriting: () => result.promise });
    const captured = host.capture(rewrite), hooks = options(); act(() => host.start(captured.captureId, hooks)); unmount();
    expect(hooks.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "stale" }));
    await act(async () => { result.resolve("Late."); }); expect(hooks.beforeReview).not.toHaveBeenCalled(); expect(onChange).not.toHaveBeenCalled();
  });
  it("invalidates frontmatter-only external replacement and released or superseded captures", async () => {
    const { host, update } = await fixture();
    const first = host.capture(rewrite), second = host.capture(rewrite);
    expect(host.isCaptureCurrent(first.captureId)).toBe(false);
    expect(host.isCaptureCurrent(second.captureId)).toBe(true);
    host.release(second.captureId); expect(host.isCaptureCurrent(second.captureId)).toBe(false);
    const third = host.capture(rewrite), version = host.getState().documentVersion;
    update({ markdown: markdown.replace("Keep this frontmatter", "Changed frontmatter") });
    expect(host.getState().documentVersion).not.toBe(version);
    expect(host.isCaptureCurrent(third.captureId)).toBe(false);
  });
  it("cancels while native review staging is pending without showing a late preview", async () => {
    const review = deferred<void>(), { host, editor, onChange } = await fixture();
    const hooks = options({ beforeReview: vi.fn(() => review.promise) }), captured = host.capture(rewrite);
    act(() => host.start(captured.captureId, hooks));
    await waitFor(() => expect(hooks.beforeReview).toHaveBeenCalledOnce());
    act(() => { host.cancel(captured.captureId); });
    await act(async () => { review.resolve(); });
    expect(onChange).not.toHaveBeenCalled(); expect(editor.isEditable).toBe(true);
    expect(screen.queryByRole("region", { name: "AI writing preview" })).toBeNull();
  });
  it("preserves an accepted transaction if its subsequent save acknowledgement fails", async () => {
    const { host, editor, onChange } = await fixture();
    const hooks = options({ afterAccept: vi.fn().mockRejectedValue(new Error("Disk confirmation unavailable")) });
    const captured = host.capture(rewrite); act(() => host.start(captured.captureId, hooks));
    fireEvent.click(await screen.findByRole("button", { name: "Accept AI writing" }));
    await waitFor(() => expect(hooks.onState).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "accepted", error: "Disk confirmation unavailable" })));
    expect(hooks.afterAccept).toHaveBeenCalledOnce(); expect(onChange).toHaveBeenCalledOnce();
    expect(editor.getMarkdown()).toContain("The revised opening.");
    expect(host.cancel(captured.captureId)).toBe(false);
    expect(screen.queryByRole("button", { name: "Accept AI writing" })).toBeNull();
  });
  it.each(["writing capability", "writing callback", "image capability", "image callback"])("rejects a captured start after %s disappears", async kind => {
    const { host, editor, update, generate } = await fixture();
    const imageAction = { kind: "image" as const, quality: "fast" as const, context: "selection" as const };
    const capture = host.capture(kind.startsWith("image") ? imageAction : rewrite);
    update(kind === "writing capability" ? { aiArticleWritingEnabled: false }
      : kind === "writing callback" ? { onGenerateAIWriting: undefined }
      : kind === "image capability" ? { aiImageGenerationEnabled: false } : { onGenerateAIImage: undefined });
    const hooks = options();
    expect(() => host.start(capture.captureId, hooks)).toThrow(/unavailable/);
    expect(generate).not.toHaveBeenCalled(); expect(hooks.onState).not.toHaveBeenCalled();
    expect(editor.isEditable).toBe(true);
  });
  it("requires a fresh capture for an external retry", async () => {
    const generate = vi.fn().mockRejectedValue(new Error("Provider unavailable")); const { host } = await fixture({ onGenerateAIWriting: generate });
    const captured = host.capture(rewrite); act(() => host.start(captured.captureId, options()));
    await screen.findByText(/Ask your assistant to capture this passage again/);
    expect(screen.queryByRole("button", { name: "Try AI writing again" })).toBeNull();
    expect(generate).toHaveBeenCalledOnce();
  });
});
