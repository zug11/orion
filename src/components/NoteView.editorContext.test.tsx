// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { NoteView } from "./NoteView";
import type { Note } from "../types";
import { createVoiceSelectionStore } from "../lib/voiceSelection";
import { editorContextIdentity, editorDocumentVersion, editorSelectionReference } from "../lib/editorSelectionContext";
import type { EditorContextDocument } from "../lib/assistant/editorContext";
import { startInlineFlow } from "./editor/FlowWriting";

const note: Note = { id: "draft", title: "Draft", body: "The river was dark.", slug: "draft", summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-10-11", updatedAt: "2026-10-11" };
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });
beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 100, 20) },
}));
async function setup() {
  let get: (() => EditorContextDocument) | null = null;
  const store = createVoiceSelectionStore("space"), update = vi.fn();
  const props = { note, notes: [note], concepts: [], voiceSelection: store, initialEditing: true,
    onEditorContextChange: (_id: string, read: (() => EditorContextDocument) | null) => { get = read; },
    onUpdateNote: update, onOpenNote: vi.fn(), onOpenConcept: vi.fn(), onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const view = render(<NoteView {...props} />);
  const element = await screen.findByRole("textbox", { name: "Note body" }) as HTMLElement & { editor: Editor };
  await waitFor(() => expect(get?.().snapshot.state).toBe("none"));
  // Readiness can precede the editor's scheduled initial caret placement.
  // Let that real mount interaction settle before simulating a user gesture.
  await waitFor(() => expect(document.activeElement).toBe(element));
  const read = () => { const current = get!(); return editorSelectionReference(current.snapshot, { taskView: "working", maxChars: 12_000 }, current.note); };
  return { view, props, element, editor: element.editor, store, update, get: () => get?.(), read };
}
function select(element: HTMLElement, text: string, from: number, to: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT); let node: Node | null;
  while ((node = walker.nextNode()) && !node.textContent?.includes(text)) { /* Rendered body text. */ }
  if (!node) throw new Error("Rendered prose missing");
  fireEvent.pointerDown(element);
  const range = document.createRange(), offset = node.textContent!.indexOf(text);
  const editor = (element as HTMLElement & { editor: Editor }).editor;
  act(() => { editor.commands.setTextSelection({ from: editor.view.posAtDOM(node!, offset + from), to: editor.view.posAtDOM(node!, offset + to) }); });
  range.setStart(node, offset + from); range.setEnd(node, offset + to);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(element);
}
it("binds a selection to the real unsaved authored document even before its parent echoes it", async () => {
  const f = await setup();
  act(() => { f.editor.commands.insertContentAt(1, "Fresh "); });
  expect(f.update).toHaveBeenCalled(); expect(f.props.note.body).toBe("The river was dark.");
  select(f.element, "Fresh The river was dark.", 0, 5);
  await waitFor(() => expect(f.read().state).toBe("selected"));
  expect(f.get()!.note.body).toBe("Fresh The river was dark.");
  expect(f.read()).toMatchObject({ documentVersion: editorDocumentVersion(f.get()!.note), fragments: [{ text: "Fresh", from: 0, to: 5 }] });
  expect(f.read().documentVersion).not.toBe(editorDocumentVersion(note));
  const updates = f.update.mock.calls.length; f.read(); f.read(); expect(f.update).toHaveBeenCalledTimes(updates);
});
it("forwards an actual collapsed ProseMirror caret and does not treat editor mount focus as a selection", async () => {
  const f = await setup(); expect(f.read().state).toBe("none");
  act(() => { f.editor.commands.setTextSelection(5); });
  select(f.element, "The river was dark.", 4, 4);
  await waitFor(() => expect(f.read().state).toBe("cursor"));
  expect(f.read()).toMatchObject({ selection: { coordinateSystem: "prosemirror-position", from: 5, to: 5 }, fragments: [] });
});
it("recovers an initial unavailable capture from live editor readiness without another render or selection", async () => {
  const f = await setup();
  // The parent capture effect can run before Tiptap's asynchronous create
  // event. Simulate that retained mount snapshot after the real editor is ready.
  const unavailable = { ...editorContextIdentity(note, "space"), state: "unavailable" as const, reason: "not-ready" as const };
  f.store.captureEditor(unavailable);
  const stored = f.store.getEditorSnapshot();
  const recovered = f.get()!.snapshot;
  expect(f.read()).toMatchObject({ state: "none", fragments: [] });
  expect(f.get()!.snapshot).toBe(recovered);
  expect(f.store.getEditorSnapshot()).toBe(stored);
  expect(f.update).not.toHaveBeenCalled();
  expect(f.store.getSnapshot()).toBeUndefined();
  // A genuinely unfinished selection must still be withheld.
  f.store.captureEditor({ ...editorContextIdentity(note, "space"), state: "pending" });
  expect(f.read()).toMatchObject({ state: "pending", fragments: [] });
});
it("clears context through keyed note navigation and accepts a new selection without reviving either old passage", async () => {
  const f = await setup();
  select(f.element, "The river was dark.", 4, 9);
  await waitFor(() => expect(f.read().state).toBe("selected"));
  const other: Note = { ...note, id: "other", title: "Other", body: "Another independent passage." };
  f.view.rerender(<NoteView key={other.id} {...f.props} note={other} notes={[note, other]} />);
  const otherElement = await screen.findByRole("textbox", { name: "Note body" });
  await waitFor(() => expect(f.read().state).toBe("none"));
  await waitFor(() => expect(document.activeElement).toBe(otherElement));
  expect(f.get()!.note.id).toBe(other.id);
  expect(f.store.getSnapshot()).toBeUndefined();
  select(otherElement, "Another independent passage.", 8, 19);
  await waitFor(() => expect(f.read().state).toBe("selected"));
  expect(f.read().fragments.map(part => part.text).join("")).toBe("independent");
  f.view.rerender(<NoteView key={note.id} {...f.props} />);
  await waitFor(() => expect(f.read().state).toBe("none"));
  expect(f.get()!.note.id).toBe(note.id);
  expect(f.read().fragments).toEqual([]);
  expect(f.store.getSnapshot()).toBeUndefined();
});
it("keeps an authored trailing paragraph in the displayed version before its parent echoes", async () => {
  const f = await setup();
  act(() => { f.editor.commands.insertContentAt(f.editor.state.doc.content.size, { type: "paragraph" }); });
  const emitted = f.update.mock.lastCall![0] as Note;
  expect(emitted.body).not.toBe(note.body);
  expect(emitted.body.trimEnd()).toBe(note.body);
  expect(f.get()!.note.body).toBe(emitted.body);
  expect(editorDocumentVersion(f.get()!.note)).not.toBe(editorDocumentVersion(note));
});
it("withholds transient Flow text synchronously without committing or exposing it", async () => {
  const f = await setup();
  select(f.element, "The river was dark.", 4, 9); await waitFor(() => expect(f.read().state).toBe("selected"));
  const updates = f.update.mock.calls.length;
  act(() => {
    expect(startInlineFlow(f.editor, 60_000, 10)).toBe(true);
    f.editor.commands.insertContent("Private provisional Flow text");
    expect(f.read()).toMatchObject({ state: "unavailable", reason: "flow", fragments: [] });
  });
  expect(f.update).toHaveBeenCalledTimes(updates);
  expect(f.get()!.note.body).not.toContain("Private provisional");
});
it("withholds staged review additions and unregisters the exact note on unmount", async () => {
  const f = await setup();
  f.view.rerender(<NoteView {...f.props} chatEdit={{ id: "review", proposal: { spaceId: "space", noteId: note.id, title: note.title, baseBody: note.body,
    edits: [{ before: "dark", after: "SECRET PROPOSAL" }] } }} />);
  await screen.findByRole("button", { name: "Accept changes" });
  expect(f.read()).toMatchObject({ state: "unavailable", reason: "preview", fragments: [] });
  expect(f.get()!.note.body).not.toContain("SECRET PROPOSAL");
  f.view.unmount(); expect(f.get()).toBeUndefined();
});
