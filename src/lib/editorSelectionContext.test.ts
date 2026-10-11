// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { captureEditorSelection, createVoiceSelectionStore } from "./voiceSelection";
import { EDITOR_CONTEXT_MAX_FRAGMENTS, editorContextIdentity, editorSelectionReference, type EditorSelectionSnapshot } from "./editorSelectionContext";

const note: Note = { id: "n", title: "Private title", slug: "n", body: "Authored body", summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "today", updatedAt: "today" };
function selected(text: string, hiddenTaskRanges: { start: number; end: number }[] = [], from = 7): EditorSelectionSnapshot {
  return { ...editorContextIdentity(note, "s"), state: "selected", selection: { coordinateSystem: "dom-text-utf16", from, to: from + text.length }, text, hiddenTaskRanges };
}
const read = (snapshot: EditorSelectionSnapshot, maxChars = 12_000, taskView: "working" | "history" = "working", current = note) => editorSelectionReference(snapshot, { maxChars, taskView }, current);
function dom(html: string, from?: number, to?: number) {
  const root = document.createElement("article"); root.innerHTML = html; document.body.replaceChildren(root);
  const range = document.createRange(); range.selectNodeContents(root);
  if (from !== undefined) range.setStart(root.firstChild!, from);
  if (to !== undefined) range.setEnd(root.firstChild!, to);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return { root, selection };
}
describe("bounded external editor reference", () => {
  it("keeps editor snapshots stable and separate from voice selections", () => {
    const store = createVoiceSelectionStore("s"), voice = vi.fn(), editor = vi.fn();
    store.subscribe(voice); store.subscribeEditor(editor);
    const value = selected("exact"); store.captureEditor(value); const first = store.getEditorSnapshot();
    store.captureEditor(value); store.captureEditor({ ...value, spaceId: "foreign" });
    expect(store.getEditorSnapshot()).toBe(first); expect(editor).toHaveBeenCalledOnce();
    expect(voice).not.toHaveBeenCalled(); expect(store.getSnapshot()).toBeUndefined();
    store.clearEditor("other"); expect(store.getEditorSnapshot()).toBe(first);
    store.clearEditor("n"); expect(store.getEditorSnapshot()).toEqual({ state: "none" });
  });
  it("masks completed tasks and descendants before serialization while retaining exact original fragment offsets", () => {
    const { root, selection } = dom('<p>Open 🧭</p><ul><li><input type="checkbox" checked>SECRET<ul><li>hidden child</li></ul></li><li><input type="checkbox">Visible end</li></ul>');
    const snapshot = captureEditorSelection(root, selection, note, "s");
    const result = read(snapshot);
    expect(result).toMatchObject({ state: "selected", selection: { coordinateSystem: "dom-text-utf16", from: 0, to: root.textContent!.length },
      completedTasksOmitted: true, completedTaskChars: 18, omittedChars: 18, truncated: false });
    expect(result.fragments).toEqual([{ text: "Open 🧭", from: 0, to: 7 }, { text: "Visible end", from: 25, to: 36 }]);
    expect(JSON.stringify(result)).not.toMatch(/SECRET|hidden child|Private title|Authored body/);
    expect(read(snapshot, 12_000, "history").fragments).toEqual([{ text: root.textContent, from: 0, to: root.textContent!.length }]);
  });
  it("does not spend the visible character budget on hidden tasks or join nonadjacent source text", () => {
    const value = selected("secret🧭A😀BC", [{ start: 0, end: 8 }], 20);
    expect(read(value, 2)).toMatchObject({ fragments: [{ text: "A😀", from: 28, to: 31 }], omittedChars: 9, completedTaskChars: 7, truncated: true });
    const hidden = read(selected("😀secret", [{ start: 0, end: 8 }]));
    expect(hidden).toMatchObject({ fragments: [], completedTasksOmitted: true, completedTaskChars: 7, omittedChars: 7, truncated: false });
  });
  it("retains full local selections and bounds scalar text, including emoji and exact whitespace", () => {
    const text = "😀 \t漢".repeat(10_000), value = selected(text), result = read(value, 12_000);
    expect(result.fragments[0].text).toBe([...text].slice(0, 12_000).join(""));
    expect(result.fragments[0].to).toBe(7 + result.fragments[0].text.length);
    expect(result).toMatchObject({ omittedChars: 28_000, truncated: true });
    expect(value).toMatchObject({ text });
    const whitespace = dom(" \t ");
    expect(read(captureEditorSelection(whitespace.root, whitespace.selection, note, "s")).fragments[0].text).toBe(" \t ");
  });
  it("bounds fragmented mixed task selections and accurately reports omitted visible text", () => {
    const text = "hx".repeat(200), hidden = Array.from({ length: 200 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 }));
    const result = read(selected(text, hidden));
    expect(result.fragments).toHaveLength(EDITOR_CONTEXT_MAX_FRAGMENTS);
    expect(result.fragments.every(fragment => fragment.text === "x" && fragment.to - fragment.from === 1)).toBe(true);
    expect(result).toMatchObject({ completedTaskChars: 200, omittedChars: 400 - EDITOR_CONTEXT_MAX_FRAGMENTS, truncated: true });
  });
  it("withholds the entire stale draft, even for explicit history, and never adds surrounding text", () => {
    for (const taskView of ["working", "history"] as const) {
      const result = read(selected("old private passage"), 12_000, taskView, { ...note, body: "changed" });
      expect(result).toMatchObject({ state: "unavailable", reason: "stale-document", fragments: [] });
      expect(result).not.toHaveProperty("selection"); expect(JSON.stringify(result)).not.toContain("old private passage");
    }
  });
  it("exposes real rich-editor or explicitly DOM cursors without a text fragment", () => {
    const { root, selection } = dom("A😀B", 3, 3);
    expect(read(captureEditorSelection(root, selection, note, "s"))).toMatchObject({ state: "cursor", selection: { coordinateSystem: "dom-text-utf16", from: 3, to: 3 }, fragments: [] });
    root.className = "tiptap";
    expect(captureEditorSelection(root, selection, note, "s")).toMatchObject({ state: "unavailable", reason: "not-ready" });
    expect(read(captureEditorSelection(root, selection, note, "s", { available: true, cursor: { position: 12, unit: "prosemirror-position" } }))).toMatchObject({ state: "cursor", selection: { coordinateSystem: "prosemirror-position", from: 12, to: 12 }, fragments: [] });
  });
  it("withholds all content during preview or Flow and preserves finite body-free pending/none states", () => {
    const { root, selection } = dom('<p>Author text</p><span data-ai-writing-preview>Private proposal</span>');
    expect(read(captureEditorSelection(root, selection, note, "s"))).toMatchObject({ state: "unavailable", reason: "preview", fragments: [] });
    expect(read(captureEditorSelection(root, selection, note, "s", { available: false, reason: "flow" }))).toMatchObject({ state: "unavailable", reason: "flow", fragments: [] });
    for (const state of ["pending", "none"] as const) expect(read({ ...editorContextIdentity(note, "s"), state })).toMatchObject({ state, fragments: [], truncated: false, omittedChars: 0 });
  });
  it("withholds a cursor inside completed-task descendants unless history was explicitly requested", () => {
    const { root, selection } = dom('<ul><li><input type="checkbox" checked>Done<ul><li>Secret child</li></ul></li></ul>');
    const text = root.querySelector("li li")!.firstChild!, range = document.createRange();
    range.setStart(text, 3); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    const snapshot = captureEditorSelection(root, selection, note, "s");
    expect(read(snapshot)).toMatchObject({ state: "unavailable", reason: "completed-task", completedTasksOmitted: true, fragments: [], omittedChars: 0 });
    expect(read(snapshot)).not.toHaveProperty("selection");
    expect(read(snapshot, 12000, "history")).toMatchObject({ state: "cursor", selection: { coordinateSystem: "dom-text-utf16", from: 7, to: 7 }, fragments: [] });
  });
  it("fails closed on invalid options, broken scalar boundaries and inconsistent ranges", () => {
    for (const maxChars of [0, -1, 1.5, 12001, Infinity]) expect(() => read(selected("word"), maxChars)).toThrow();
    expect(read(selected("😀secret", [{ start: 1, end: 2 }]))).toMatchObject({ state: "unavailable", reason: "invalid-range", fragments: [] });
    expect(read(selected("\ud83d"))).toMatchObject({ state: "unavailable", reason: "invalid-range", fragments: [] });
    const value = selected("word"); if (value.state !== "selected") throw new Error("fixture");
    expect(read({ ...value, selection: { ...value.selection, to: 999 } })).toMatchObject({ state: "unavailable", fragments: [] });
  });
});
