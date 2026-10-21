// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { createVoiceSelectionStore, VOICE_SELECTION_SETTLE_MS, type VoiceSelectionStore } from "../lib/voiceSelection";
import { spaceNoteVersion } from "../lib/spaceKnowledge";
import { useVoiceSelection } from "./useVoiceSelection";
import { editorDocumentVersion, type EditorSelectionOptions } from "../lib/editorSelectionContext";
const note: Note = { id: "n", title: "Note", slug: "n", body: "Alpha Beta", summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "today", updatedAt: "today" };
function Surface({ store, current = note, editor = false, displayed, preview = false, editorOptions }: { store: VoiceSelectionStore; current?: Note; editor?: boolean; displayed?: Note; preview?: boolean; editorOptions?: EditorSelectionOptions }) {
  const scope = useRef<HTMLElement>(null);
  useVoiceSelection(scope, current, store, "s", () => displayed ?? current, editorOptions);
  return <><article ref={scope}><div data-voice-note-body={editor ? "editor" : "reading"}>
    {editor ? <div className="tiptap" contentEditable suppressContentEditableWarning>{current.body}</div> : current.body}
    {preview && <span data-chat-addition="true">Unsaved addition</span>}
  </div></article><button>Mute microphone</button><textarea aria-label="Message Orion" /></>;
}
function range(root: HTMLElement, from: number, to: number) {
  const range = document.createRange(); range.setStart(root.firstChild!, from); range.setEnd(root.firstChild!, to);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); fireEvent(document, new Event("selectionchange"));
}
async function settle() { await act(() => vi.advanceTimersByTimeAsync(VOICE_SELECTION_SETTLE_MS)); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("settled voice selection capture", () => {
  it.each([false, true])("captures once after drag settles on the %s editor surface; voice controls preserve it", async editor => {
    const store = createVoiceSelectionStore("s"), listener = vi.fn(); store.subscribe(listener);
    const { container } = render(<Surface store={store} editor={editor} />);
    const body = container.querySelector<HTMLElement>(editor ? ".tiptap" : '[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 2); await settle(); range(body, 0, 5); await settle();
    expect(store.getSnapshot()).toBeUndefined();
    fireEvent.pointerUp(body); await settle(); expect(store.getSnapshot()?.text).toBe("Alpha"); expect(listener).toHaveBeenCalledTimes(1);
    const captured = store.getSnapshot();
    fireEvent.pointerDown(screen.getByRole("button")); window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(screen.getByRole("button")); await settle();
    expect(store.getSnapshot()).toBe(captured);
    fireEvent.pointerDown(body); range(body, 6, 10); fireEvent.pointerUp(body); await settle();
    expect(store.getSnapshot()?.text).toBe("Beta"); expect(store.getSnapshot()?.id).not.toBe(captured?.id);
    fireEvent.pointerDown(body); range(body, 1, 1); fireEvent.pointerUp(body); await settle(); expect(store.getSnapshot()).toBeUndefined();
  });
  it("clears the prior reference when the replacement selection crosses an unaccepted proposal", async () => {
    const store = createVoiceSelectionStore("s"); const { container } = render(<Surface store={store} preview />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle();
    expect(store.getSnapshot()?.text).toBe("Alpha");
    const proposal = body.querySelector<HTMLElement>("[data-chat-addition]")!;
    fireEvent.pointerDown(proposal); range(proposal, 0, 8); fireEvent.pointerUp(proposal); await settle();
    expect(store.getSnapshot()).toBeUndefined();
  });
  it("clears on navigation and captures the displayed authored version ahead of old note props", async () => {
    const store = createVoiceSelectionStore("s"), displayed = { ...note, body: "Alpha Beta\nNew authoring", updatedAt: "newer" };
    const { container, rerender } = render(<Surface store={store} displayed={displayed} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.keyDown(body, { key: "Shift" }); range(body, 0, 5); await settle();
    expect(store.getSnapshot()?.version).toBe(spaceNoteVersion(displayed));
    const captured = store.getSnapshot();
    rerender(<Surface store={store} current={{ ...note, id: "other", title: "Elsewhere" }} />);
    expect(store.getSnapshot()).toBeUndefined(); expect(captured?.text).toBe("Alpha");
  });
  it("publishes pending immediately throughout a drag, then preserves the stable settled snapshot through controls", async () => {
    const store = createVoiceSelectionStore("s"); const { container } = render(<Surface store={store} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body);
    expect(store.getEditorSnapshot()).toMatchObject({ state: "pending", noteId: "n", documentVersion: editorDocumentVersion(note) });
    range(body, 0, 2); await settle(); range(body, 0, 5); await settle();
    expect(store.getEditorSnapshot()).toMatchObject({ state: "pending" }); expect(store.getEditorSnapshot()).not.toHaveProperty("text");
    fireEvent.pointerUp(body); await act(() => vi.advanceTimersByTimeAsync(179));
    expect(store.getEditorSnapshot().state).toBe("pending"); await act(() => vi.advanceTimersByTimeAsync(1));
    expect(store.getEditorSnapshot()).toMatchObject({ state: "selected", text: "Alpha", selection: { coordinateSystem: "dom-text-utf16", from: 0, to: 5 } });
    const selected = store.getEditorSnapshot(), voice = store.getSnapshot();
    fireEvent.pointerDown(screen.getByRole("button")); window.getSelection()?.removeAllRanges(); fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(screen.getByRole("button")); await settle();
    expect(store.getEditorSnapshot()).toBe(selected); expect(store.getSnapshot()).toBe(voice);
  });
  it.each([false, true])("captures a %s editor cursor separately and never injects it into voice context", async editor => {
    const store = createVoiceSelectionStore("s");
    const { container } = render(<Surface store={store} editor={editor} editorOptions={{ state: () => ({ available: true, cursor: { position: 8, unit: "prosemirror-position" } }) }} />);
    const body = container.querySelector<HTMLElement>(editor ? ".tiptap" : '[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle(); expect(store.getSnapshot()?.text).toBe("Alpha");
    fireEvent.pointerDown(body); range(body, 2, 2); fireEvent.pointerUp(body);
    expect(store.getSnapshot()).toBeUndefined(); expect(store.getEditorSnapshot().state).toBe("pending");
    await settle();
    expect(store.getEditorSnapshot()).toMatchObject({ state: "cursor", selection: { coordinateSystem: editor ? "prosemirror-position" : "dom-text-utf16", from: editor ? 8 : 2, to: editor ? 8 : 2 } });
    expect(store.getEditorSnapshot()).not.toHaveProperty("text"); expect(store.getSnapshot()).toBeUndefined();
    window.getSelection()?.removeAllRanges(); fireEvent(document, new Event("selectionchange")); await settle();
    expect(store.getEditorSnapshot().state).toBe("none");
  });
  it("cancels a pending capture on authored mutation and navigation instead of recapturing stale DOM", async () => {
    const store = createVoiceSelectionStore("s"), { container, rerender } = render(<Surface store={store} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body);
    const changed = { ...note, body: "Other draft", updatedAt: "later" };
    rerender(<Surface store={store} current={changed} />); await settle();
    expect(store.getEditorSnapshot()).toMatchObject({ state: "none", documentVersion: editorDocumentVersion(changed) }); expect(store.getSnapshot()).toBeUndefined();
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle();
    expect(store.getEditorSnapshot().state).toBe("selected");
    rerender(<Surface store={store} current={{ ...changed, id: "another" }} />); await settle();
    expect(store.getEditorSnapshot().state).toBe("none"); expect(store.getEditorSnapshot()).not.toHaveProperty("text");
  });
  it.each(["flow", "preview"] as const)("withholds settled and pending content when %s becomes unavailable", async reason => {
    const store = createVoiceSelectionStore("s"), { container, rerender } = render(<Surface store={store} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle(); expect(store.getEditorSnapshot().state).toBe("selected");
    rerender(<Surface store={store} editorOptions={{ state: () => ({ available: false, reason }) }} />);
    expect(store.getEditorSnapshot()).toMatchObject({ state: "unavailable", reason }); expect(store.getSnapshot()).toBeUndefined();
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle();
    expect(store.getEditorSnapshot()).toMatchObject({ state: "unavailable", reason }); expect(store.getEditorSnapshot()).not.toHaveProperty("text");
    rerender(<Surface store={store} />); expect(store.getEditorSnapshot().state).toBe("none");
  });
  it("rechecks synchronous availability at settlement even before a parent rerenders", async () => {
    let available = true;
    const store = createVoiceSelectionStore("s"), { container } = render(<Surface store={store} editorOptions={{ state: () => ({ available, reason: "preview" }) }} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); available = false; await settle();
    expect(store.getEditorSnapshot()).toMatchObject({ state: "unavailable", reason: "preview" }); expect(store.getSnapshot()).toBeUndefined();
  });
  it("clears an unfinished range when controls take over rather than leaving pending indefinitely", async () => {
    const store = createVoiceSelectionStore("s"), { container } = render(<Surface store={store} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5);
    expect(store.getEditorSnapshot().state).toBe("pending");
    fireEvent.pointerDown(screen.getByRole("button")); window.getSelection()?.removeAllRanges(); fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(screen.getByRole("button")); await settle();
    expect(store.getEditorSnapshot().state).toBe("none"); expect(store.getSnapshot()).toBeUndefined();
    expect(store.getEditorSnapshot()).not.toHaveProperty("text");
  });
  it.each([false, true])("retains the visible passage when the %s surface gives focus to Chat, without selecting its input", async editor => {
    const registry = new Map<string, { ranges: Range[] }>();
    vi.stubGlobal("CSS", { highlights: registry });
    vi.stubGlobal("Highlight", class { constructor(...ranges: Range[]) { this.ranges = ranges; } ranges: Range[]; });
    const store = createVoiceSelectionStore("s"), { container, unmount } = render(<Surface store={store} editor={editor} />);
    const body = container.querySelector<HTMLElement>(editor ? ".tiptap" : '[data-voice-note-body="reading"]')!;
    const original = body.innerHTML;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle();
    const composer = screen.getByRole("textbox", { name: "Message Orion" });
    // Programmatic Chat focus is covered as well as a pointer click.
    composer.focus(); window.getSelection()?.removeAllRanges(); fireEvent(document, new Event("selectionchange")); await settle();
    expect(document.activeElement).toBe(composer);
    expect(window.getSelection()?.rangeCount).toBe(0);
    expect(registry.get("orion-selected-passage")?.ranges[0].toString()).toBe("Alpha");
    expect(store.getSnapshot()?.text).toBe("Alpha"); expect(body.innerHTML).toBe(original);
    fireEvent.pointerDown(body); range(body, 6, 10); fireEvent.pointerUp(body); await settle();
    expect(registry.get("orion-selected-passage")?.ranges[0].toString()).toBe("Beta");
    fireEvent.pointerDown(body); range(body, 1, 1); fireEvent.pointerUp(body); await settle();
    expect(registry.size).toBe(0);
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body); await settle();
    unmount(); expect(registry.size).toBe(0);
  });
  it("finishes a released highlight when Chat is opened before the debounce expires", async () => {
    const store = createVoiceSelectionStore("s"), { container } = render(<Surface store={store} />);
    const body = container.querySelector<HTMLElement>('[data-voice-note-body="reading"]')!;
    fireEvent.pointerDown(body); range(body, 0, 5); fireEvent.pointerUp(body);
    const composer = screen.getByRole("textbox", { name: "Message Orion" });
    fireEvent.pointerDown(composer); composer.focus(); window.getSelection()?.removeAllRanges();
    fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(composer); await settle();
    expect(store.getEditorSnapshot()).toMatchObject({ state: "selected", text: "Alpha" });
    expect(store.getSnapshot()?.text).toBe("Alpha");
    expect(document.activeElement).toBe(composer);
    expect(body.querySelector(".orion-selection-highlight")).toBeNull();
    expect(document.querySelector(".orion-selection-highlight")).not.toBeNull();
    act(() => store.clear()); expect(document.querySelector(".orion-selection-highlight")).toBeNull();
  });
});
