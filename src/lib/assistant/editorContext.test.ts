import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import { editorContextIdentity, type EditorSelectionSnapshot } from "../editorSelectionContext";
import { startEditorContextMailbox, type EditorContextRequest, type EditorContextSurface } from "./editorContext";

const controllers: ReturnType<typeof startEditorContextMailbox>[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });
async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  vi.useFakeTimers();
  const space = createEmptySnapshot("Reader", "2026-10-11", "space");
  const note = { id: "note", title: "Draft", body: "Alpha secret omega", slug: "draft", kind: "article" as const, status: "ready" as const,
    aliases: [], tags: [], conceptIds: [], sourceIds: [], summary: "", createdAt: "now", updatedAt: "now" };
  const snapshot: EditorSelectionSnapshot = { ...editorContextIdentity(note, space.workspace.id), state: "selected",
    selection: { coordinateSystem: "dom-text-utf16", from: 10, to: 28 }, text: note.body, hiddenTaskRanges: [{ start: 6, end: 12 }] };
  const state = { current: { spaceId: "space", note, snapshot } as EditorContextSurface | null,
    requests: [] as EditorContextRequest[] };
  const transport = vi.fn(async (command: string, _args: Record<string, unknown>): Promise<unknown> => command === "editor_context_poll"
    ? { targetId: "target", requests: state.requests.splice(0) } : { ok: true });
  const request = (id = "request", taskView: "working" | "history" = "working"): EditorContextRequest => ({ id, targetId: "target", spaceId: "space", noteId: "note", taskView, maxChars: 12_000 });
  const start = () => { const value = startEditorContextMailbox({ getCurrent: () => state.current }, transport as Parameters<typeof startEditorContextMailbox>[1]); controllers.push(value); return value; };
  const replies = () => transport.mock.calls.filter(([command]) => command === "editor_context_respond").map(([, args]) => args);
  return { state, note, snapshot, transport, request, start, replies };
}
describe("explicit read-only editor context mailbox", () => {
  it("does no native work without an eligible target and keeps one session across navigation", async () => {
    const f = fixture(), current = f.state.current; f.state.current = null; f.start();
    await vi.advanceTimersByTimeAsync(3_000); expect(f.transport).not.toHaveBeenCalled();
    f.state.current = current; await vi.advanceTimersByTimeAsync(1_000);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("editor_context_poll", { sessionId: expect.any(String), target: { spaceId: "space", noteId: "note", ready: true } });
    f.state.current = null; await vi.advanceTimersByTimeAsync(1_000);
    const calls = f.transport.mock.calls.length; await vi.advanceTimersByTimeAsync(3_000); expect(f.transport).toHaveBeenCalledTimes(calls);
    f.state.current = current; await vi.advanceTimersByTimeAsync(1_000);
    expect(new Set(f.transport.mock.calls.map(([, args]) => args.sessionId)).size).toBe(1);
    expect(f.replies()).toEqual([]);
    expect(JSON.stringify(f.transport.mock.calls)).not.toContain("Alpha");
  });
  it("sends only an explicitly requested bounded working projection and preserves local capture", async () => {
    const f = fixture(); f.state.requests.push({ ...f.request(), maxChars: 7 }); f.start(); await settle();
    expect(f.replies()).toEqual([{ sessionId: expect.any(String), id: "request", targetId: "target", reference: {
      state: "selected", documentVersion: f.snapshot.documentVersion,
      selection: { coordinateSystem: "dom-text-utf16", from: 10, to: 28 },
      fragments: [{ text: "Alpha ", from: 10, to: 16 }, { text: " ", from: 22, to: 23 }],
      truncated: true, omittedChars: 11, completedTasksOmitted: true, completedTaskChars: 6,
    } }]);
    expect(JSON.stringify(f.replies())).not.toContain("secret");
    expect(f.state.current?.note.body).toBe("Alpha secret omega");
    expect(f.snapshot.state === "selected" && f.snapshot.text).toBe("Alpha secret omega");
    expect(f.transport.mock.calls.every(([name]) => name.startsWith("editor_context_"))).toBe(true);
  });
  it("reads explicit history once without changing the next working projection", async () => {
    const f = fixture(); f.state.requests.push(f.request("history", "history")); f.start(); await settle();
    expect(JSON.stringify(f.replies()[0])).toContain("Alpha secret omega");
    f.state.requests.push(f.request("working")); await vi.advanceTimersByTimeAsync(1_000);
    expect(JSON.stringify(f.replies()[1])).not.toContain("secret");
  });
  it.each(["navigation", "draft", "selection", "grant"])("withholds a pending read after %s changes", async change => {
    const f = fixture(), held = deferred<unknown>(); f.transport.mockImplementationOnce(() => held.promise);
    f.start();
    if (change === "navigation") f.state.current = { ...f.state.current!, note: { ...f.note, id: "other" } };
    if (change === "draft") f.state.current = { ...f.state.current!, note: { ...f.note, body: "New authored text" } };
    if (change === "selection") f.state.current = { ...f.state.current!, snapshot: { ...f.snapshot } };
    if (change === "grant") f.state.current = null;
    held.resolve({ targetId: "target", requests: [f.request()] }); await settle();
    expect(f.replies()[0]).toMatchObject({ reference: { state: "unavailable", reason: "stale-document", fragments: [] } });
    expect(JSON.stringify(f.replies())).not.toContain("Alpha");
  });
  it.each(["pending", "unavailable"] as const)("advertises %s honestly without exposing prior passage", async state => {
    const f = fixture(); f.state.current = { ...f.state.current!, snapshot: { ...editorContextIdentity(f.note, "space"), state,
      ...(state === "unavailable" ? { reason: "flow" as const } : {}) } };
    f.state.requests.push(f.request()); f.start(); await settle();
    expect(f.transport.mock.calls[0][1].target).toEqual({ spaceId: "space", noteId: "note", ready: false });
    expect(f.replies()[0]).toMatchObject({ reference: { state, fragments: [] } });
  });
  it("rejects foreign, stale target and malformed requests and does not answer replays", async () => {
    const f = fixture(); f.state.requests.push({ ...f.request("foreign"), spaceId: "foreign" }, { ...f.request("stale"), targetId: "old" }, { ...f.request("bad"), maxChars: Infinity }, f.request());
    f.start(); await settle(); expect(f.replies()).toHaveLength(1);
    f.state.requests.push(f.request()); await vi.advanceTimersByTimeAsync(1_000); expect(f.replies()).toHaveLength(1);
  });
  it("does not answer a delayed poll after disposal and never overlaps native polls", async () => {
    const f = fixture(), held = deferred<unknown>(); f.transport.mockImplementationOnce(() => held.promise);
    const mailbox = f.start(); await vi.advanceTimersByTimeAsync(5_000); expect(f.transport).toHaveBeenCalledOnce();
    mailbox.dispose(); held.resolve({ targetId: "target", requests: [f.request()] }); await settle();
    expect(f.replies()).toEqual([]); expect(f.transport.mock.calls[1][1].target).toBeNull();
  });
});
