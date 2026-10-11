// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { spaceNoteVersion } from "./spaceKnowledge";
import { captureVoiceSelection, createVoiceSelectionStore, voiceSelectionContext, voiceSelectionReference, VOICE_SELECTION_CONTEXT_BYTES } from "./voiceSelection";

function fixture() {
  const snapshot = createEmptySnapshot("Writing", "2026-10-11", "s");
  snapshot.notes = [{ id: "n", title: "Story", slug: "story", body: "Before **warm light** after.\n\n- [x] Secret completed\n- [ ] New work", summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-11", updatedAt: "2026-10-11" }];
  const root = document.createElement("article"); root.innerHTML = '<p>Before <strong>warm light</strong> after.</p><ul><li><input type="checkbox" checked>Secret completed<ul><li>Hidden child</li></ul></li><li><input type="checkbox">New work</li></ul>';
  document.body.replaceChildren(root);
  return { snapshot, note: snapshot.notes[0], root };
}
function select(node: Node, from?: number, to?: number) {
  const range = document.createRange(); range.selectNodeContents(node);
  if (from !== undefined) range.setStart(node, from);
  if (to !== undefined) range.setEnd(node, to);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); return selection;
}
describe("voice selected reference", () => {
  it("captures exact displayed text, note version and local range across formatting", () => {
    const { snapshot, note, root } = fixture();
    const result = captureVoiceSelection(root, select(root.querySelector("strong")!), note, snapshot.workspace.id)!;
    expect(result).toMatchObject({ text: "warm light", noteId: note.id, version: spaceNoteVersion(note), range: { from: 7, to: 17, unit: "dom-text-utf16" }, hiddenTaskRanges: [] });
    const original = structuredClone(snapshot);
    const store = createVoiceSelectionStore("s"), changed = vi.fn(); store.subscribe(changed);
    store.capture(result); const first = store.getSnapshot(); store.capture(result);
    expect(changed).toHaveBeenCalledTimes(1); expect(store.getSnapshot()).toBe(first);
    store.capture({ ...result, spaceId: "other" }); expect(store.getSnapshot()).toBe(first);
    store.clear("different-note"); expect(store.getSnapshot()).toBe(first);
    store.clear(note.id); expect(store.getSnapshot()).toBeUndefined();
    expect(snapshot).toEqual(original);
  });
  it("masks selected completed tasks and descendants unless the current spoken request explicitly asks for history", () => {
    const { snapshot, note, root } = fixture(); const store = createVoiceSelectionStore("s");
    store.capture(captureVoiceSelection(root, select(root), note, "s")!);
    const selected = store.getSnapshot()!;
    expect(selected.text).toContain("Secret completedHidden child");
    expect(JSON.stringify(voiceSelectionContext(selected, snapshot))).not.toMatch(/Secret completed|Hidden child/);
    expect(voiceSelectionReference(selected, snapshot, "What do you think of this?")).not.toMatch(/Secret completed|Hidden child/);
    expect(voiceSelectionContext(selected, snapshot, "Show completed tasks")?.passage).toContain("Secret completedHidden child");
    expect(voiceSelectionContext(selected, snapshot)?.passage).toContain("New work");
  });
  it.each(["data-chat-addition", "data-ai-writing-preview"])("rejects selections inside or across %s without blocking ordinary authored text", marker => {
    const { note, root } = fixture();
    root.innerHTML = `<p>Original <span ${marker}="true">Unsaved proposal</span><strong>Authored ending</strong></p>`;
    expect(captureVoiceSelection(root, select(root.querySelector("span")!), note, "s")).toBeUndefined();
    expect(captureVoiceSelection(root, select(root), note, "s")).toBeUndefined();
    expect(captureVoiceSelection(root, select(root.querySelector("strong")!), note, "s")?.text).toBe("Authored ending");
    // Ordinary freshly authored text remains valid with its actual draft version.
    const authored = { ...note, body: "A freshly typed sentence", updatedAt: "newer" }; root.textContent = authored.body;
    expect(captureVoiceSelection(root, select(root), authored, "s")?.version).toBe(spaceNoteVersion(authored));
  });
  it("withholds stale text and titles before router/voice transport, including a task completed after capture", () => {
    const { snapshot, note, root } = fixture();
    note.body = "- [ ] Newly completed private task"; note.title = "Old private title";
    root.innerHTML = '<ul><li><input type="checkbox">Newly completed private task</li></ul>';
    const store = createVoiceSelectionStore("s"); store.capture(captureVoiceSelection(root, select(root), note, "s")!);
    const selected = store.getSnapshot()!; note.body = "- [x] Newly completed private task";
    for (const prompt of ["What do you think of this?", "Show completed tasks"]) {
      const packet = voiceSelectionContext(selected, snapshot, prompt)!;
      expect(packet).toMatchObject({ id: selected.id, version: selected.version, stale: true, referenceOnly: true });
      expect(packet).not.toHaveProperty("passage"); expect(packet).not.toHaveProperty("localRange"); expect(packet).not.toHaveProperty("title");
      expect(voiceSelectionReference(selected, snapshot, prompt)).not.toMatch(/Newly completed private task|Old private title/);
      expect(new TextEncoder().encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(VOICE_SELECTION_CONTEXT_BYTES);
    }
  });
  it("keeps a large exact selection locally and transports bounded valid unicode with honest incompleteness", () => {
    const { snapshot, note, root } = fixture(); root.textContent = "🧭漢\\\"".repeat(10_000);
    note.body = root.textContent;
    const store = createVoiceSelectionStore("s"); store.capture(captureVoiceSelection(root, select(root), note, "s")!);
    const selected = store.getSnapshot()!, packet = voiceSelectionContext(selected, snapshot)!;
    expect(selected.text).toBe(root.textContent); expect(selected.range.to).toBe(root.textContent.length);
    expect(new TextEncoder().encode(JSON.stringify(packet)).length).toBeLessThanOrEqual(VOICE_SELECTION_CONTEXT_BYTES);
    expect(packet.complete).toBe(false); expect(packet.stale).toBe(false);
    expect(packet.localRange).toEqual(selected.range); expect(packet.instruction).toContain("existing note reader");
    note.body += " changed"; expect(voiceSelectionContext(selected, snapshot)?.stale).toBe(true);
    expect(selected.version).not.toBe(spaceNoteVersion(note));
    expect(voiceSelectionContext({ ...selected, spaceId: "foreign" }, snapshot)).toBeNull();
  });
});
