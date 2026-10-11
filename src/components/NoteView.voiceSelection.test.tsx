// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { NoteView } from "./NoteView";
import { captureVoiceSelection, createVoiceSelectionStore } from "../lib/voiceSelection";
import { spaceNoteVersion } from "../lib/spaceKnowledge";
const note: Note = { id: "draft", title: "Draft", slug: "draft", summary: "", body: "Before **warm light** after.\n\n- [x] Secret completed", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-10-11", updatedAt: "2026-10-11" };
afterEach(() => { cleanup(); window.getSelection()?.removeAllRanges(); });
beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }) },
}));
it.each([false, true])("captures priority text from the real note surface, editing=%s, without requesting an edit", async initialEditing => {
  const store = createVoiceSelectionStore("space"), save = vi.fn();
  const props = { note, notes: [note], concepts: [], initialEditing, voiceSelection: store, onUpdateNote: save,
    onOpenNote: vi.fn(), onOpenConcept: vi.fn(), onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const { container, rerender } = render(<NoteView {...props} />);
  if (initialEditing) await screen.findByRole("textbox", { name: "Note body" });
  const root = container.querySelector<HTMLElement>(initialEditing ? '[data-voice-note-body="editor"] .tiptap' : '[data-voice-note-body="reading"]')!;
  expect(root).toBeTruthy(); const selected = root.querySelector("strong")!;
  const baselineSaves = save.mock.calls.length;
  // Wait for the real editor's scheduled initial caret/focus before simulating a user drag.
  if (initialEditing) await waitFor(() => expect(document.activeElement).toBe(root));
  fireEvent.pointerDown(selected);
  const range = document.createRange(); range.selectNodeContents(selected);
  act(() => { const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
  fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(selected);
  await waitFor(() => expect(store.getSnapshot()?.text).toBe("warm light"));
  expect(store.getSnapshot()).toMatchObject({ noteId: note.id, spaceId: "space", version: spaceNoteVersion(note), range: { from: 7, to: 17, unit: "dom-text-utf16" } });
  expect(save.mock.calls).toHaveLength(baselineSaves);
  rerender(<NoteView {...props} note={{ ...note, id: "second", title: "Second note" }} />);
  await waitFor(() => expect(store.getSnapshot()).toBeUndefined());
});

it("does not capture unsaved gray additions from the real in-note proposal", async () => {
  const save = vi.fn();
  render(<NoteView note={note} notes={[note]} concepts={[]} onUpdateNote={save}
    chatEdit={{ id: "preview", proposal: { spaceId: "space", noteId: note.id, title: note.title, baseBody: note.body,
      edits: [{ before: "warm light", after: "unaccepted sunlight" }] } }}
    onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  await screen.findByRole("button", { name: "Accept changes" });
  const root = screen.getByRole("textbox", { name: "Note body" });
  const addition = root.querySelector("[data-chat-addition]")!; expect(addition).toBeTruthy();
  const range = document.createRange(); range.selectNodeContents(addition);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  expect(captureVoiceSelection(root, selection, note, "space")).toBeUndefined();
  range.selectNodeContents(root); selection.removeAllRanges(); selection.addRange(range);
  expect(captureVoiceSelection(root, selection, note, "space")).toBeUndefined();
  expect(save).not.toHaveBeenCalled();
});
