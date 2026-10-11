import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../../types";
import type { EditorActionCapture, EditorActionHost, EditorActionStartOptions } from "./editorActionHost";
import { startEditorActionMailbox, validEditorAction, type EditorActionDelivery, type EditorActionReceipt, type EditorActionSurface } from "./editorActions";

const controllers: ReturnType<typeof startEditorActionMailbox>[] = [];
afterEach(() => { controllers.splice(0).forEach(c => c.dispose()); vi.useRealTimers(); });
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  vi.useFakeTimers();
  const note: Note = { id: "n", title: "Draft", body: "Saved prose", summary: "", kind: "article", status: "ready", slug: "draft", aliases: [], tags: [], conceptIds: [], sourceIds: [], createdAt: "now", updatedAt: "now" };
  const capture: EditorActionCapture = { captureId: "local-capture", noteId: "n", markdown: "Unsaved prose", action: { kind: "rewrite", preset: "clarify" },
    selection: { from: 1, to: 5, empty: false }, effectiveTarget: { from: 1, to: 5, mode: "inline" }, documentVersion: "doc-1", selectionVersion: "selection-1" };
  let current = true;
  let options: EditorActionStartOptions | undefined;
  const editor: EditorActionHost = {
    getState: vi.fn(() => ({ ready: options === undefined, documentVersion: capture.documentVersion, selectionVersion: capture.selectionVersion })),
    capture: vi.fn(() => capture), isCaptureCurrent: vi.fn(() => current),
    start: vi.fn((_id, value) => { options = value; }), cancel: vi.fn(() => true), release: vi.fn(),
  };
  const state = { surface: { spaceId: "s", noteId: "n", baseNote: note, ready: true, editor } as EditorActionSurface | null,
    captures: [] as EditorActionDelivery[], starts: [] as EditorActionDelivery[], receipts: [] as EditorActionReceipt[] };
  const delivery: EditorActionDelivery = { id: "action-1", editorTargetId: "target", spaceId: "s", noteId: "n", action: capture.action,
    documentVersion: capture.documentVersion, selectionVersion: capture.selectionVersion, baseNoteVersion: "native-version" };
  const receipt = (status: EditorActionReceipt["state"]): EditorActionReceipt => ({ id: delivery.id, editorTargetId: "target", spaceId: "s", noteId: "n", state: status,
    captureId: "native-capture", documentVersion: capture.documentVersion });
  const transport = vi.fn(async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    if (command === "editor_actions_poll") return { targetId: args.target ? "target" : null, captures: state.captures.splice(0), deliveries: state.starts.splice(0), receipts: state.receipts.splice(0) };
    if (command === "editor_actions_capture") return receipt("captured");
    if (command === "editor_actions_claim") return receipt("generating");
    if (command === "editor_actions_authorize") return { ok: true };
    if (command === "editor_actions_review") return receipt("awaiting_review");
    if (command === "editor_actions_decide") return receipt(args.accept ? "accepting" : "discarded");
    if (command === "editor_actions_accepted") return receipt("accepted_in_editor");
    if (command === "editor_actions_saved") return receipt("saved");
    return receipt("failed");
  });
  const flush = vi.fn(async (): Promise<void> => undefined), onError = vi.fn();
  const start = () => { const value = startEditorActionMailbox({ getCurrent: () => state.surface, flushAccepted: flush, onError }, transport as Parameters<typeof startEditorActionMailbox>[1]); controllers.push(value); return value; };
  const admit = async () => {
    state.captures.push(delivery); const mailbox = start(); await settle();
    state.starts.push({ ...delivery, captureId: "native-capture" }); await vi.advanceTimersByTimeAsync(1_000);
    expect(options).toBeDefined(); return mailbox;
  };
  return { note, capture, state, delivery, receipt, editor, transport, flush, onError, start, admit, options: () => options!, stale: () => { current = false; } };
}

describe("external editor generation mailbox", () => {
  it("stays idle without an eligible surface and advertises no prose", async () => {
    const f = fixture(), surface = f.state.surface; f.state.surface = null; f.start();
    await vi.advanceTimersByTimeAsync(3_000); expect(f.transport).not.toHaveBeenCalled();
    f.state.surface = surface; await vi.advanceTimersByTimeAsync(1_000);
    expect(f.transport).toHaveBeenCalledExactlyOnceWith("editor_actions_poll", { sessionId: expect.any(String), target: { spaceId: "s", noteId: "n", ready: true, documentVersion: "doc-1", selectionVersion: "selection-1" } });
    expect(f.editor.capture).not.toHaveBeenCalled(); expect(f.editor.start).not.toHaveBeenCalled();
    expect(JSON.stringify(f.transport.mock.calls)).not.toContain("prose");
    f.state.surface = null; await vi.advanceTimersByTimeAsync(1_000); const count = f.transport.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000); expect(f.transport).toHaveBeenCalledTimes(count);
  });
  it("captures exact live and persisted bodies separately without starting generation", async () => {
    const f = fixture(); f.state.captures.push(f.delivery); f.start(); await settle();
    expect(f.transport).toHaveBeenCalledWith("editor_actions_capture", { sessionId: expect.any(String), id: "action-1", targetId: "target", capture: {
      documentVersion: "doc-1", selectionVersion: "selection-1", selection: { coordinateSystem: "prosemirror", from: 1, to: 5 },
      effectiveTarget: { coordinateSystem: "prosemirror", from: 1, to: 5 }, baseNote: f.note, capturedBody: "Unsaved prose",
    } });
    expect(f.editor.start).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled();
    f.state.captures.push(f.delivery); await vi.advanceTimersByTimeAsync(1_000); expect(f.editor.capture).toHaveBeenCalledOnce();
  });
  it.each(["space", "note", "version", "selection", "target", "action"])("rejects a mismatched %s before reading rich content", async kind => {
    const f = fixture(); const bad = { ...f.delivery };
    if (kind === "space") bad.spaceId = "other";
    if (kind === "note") bad.noteId = "other";
    if (kind === "version") bad.documentVersion = "other";
    if (kind === "selection") bad.selectionVersion = "other";
    if (kind === "target") bad.editorTargetId = "other";
    if (kind === "action") bad.action = { ...bad.action, accept: true } as unknown as typeof bad.action;
    f.state.captures.push(bad); f.start(); await settle();
    expect(f.editor.capture).not.toHaveBeenCalled(); expect(f.editor.start).not.toHaveBeenCalled();
  });
  it("rechecks local selection after an asynchronous native claim and suppresses stale provider work", async () => {
    const f = fixture(); f.state.captures.push(f.delivery); f.start(); await settle();
    const original = f.transport.getMockImplementation()!, held = deferred<unknown>();
    f.transport.mockImplementation((command, args) => command === "editor_actions_claim" ? held.promise : original(command, args));
    f.state.starts.push({ ...f.delivery, captureId: "native-capture" });
    await vi.advanceTimersByTimeAsync(1_000); f.stale(); held.resolve(f.receipt("generating")); await settle();
    expect(f.editor.start).not.toHaveBeenCalled(); expect(f.editor.cancel).toHaveBeenCalledWith("local-capture");
  });
  it("starts once, waits for review/accept claims, then confirms actual persistence", async () => {
    const f = fixture(); const mailbox = await f.admit(); expect(mailbox.busy()).toBe(true);
    expect(f.options().grant).toEqual({ actionId: "action-1", sessionId: expect.any(String) });
    f.state.starts.push({ ...f.delivery, captureId: "native-capture" }); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.editor.start).toHaveBeenCalledOnce(); expect(f.flush).not.toHaveBeenCalled();
    await f.options().beforeReview(); expect(f.flush).not.toHaveBeenCalled();
    await f.options().beforeAccept(); expect(f.flush).not.toHaveBeenCalled();
    await f.options().afterAccept("Accepted authored body");
    expect(f.transport).toHaveBeenCalledWith("editor_actions_accepted", { sessionId: expect.any(String), id: "action-1", body: "Accepted authored body" });
    expect(f.flush).toHaveBeenCalledExactlyOnceWith("s", "n", "Accepted authored body");
    expect(f.transport.mock.calls.map(([name]) => name).slice(-3)).toEqual(["editor_actions_decide", "editor_actions_accepted", "editor_actions_saved"]);
    expect(mailbox.busy()).toBe(false); expect(f.onError).not.toHaveBeenCalled();
  });
  it("cannot accept without a review and cannot save before an accepted transaction", async () => {
    const f = fixture(); await f.admit();
    await expect(f.options().beforeAccept()).rejects.toThrow(/not ready/);
    await expect(f.options().afterAccept("injected")).rejects.toThrow(/no acceptance/);
    expect(f.flush).not.toHaveBeenCalled(); expect(f.transport.mock.calls.some(([command]) => command === "editor_actions_accepted")).toBe(false);
  });
  it("discards a preview without flushing or writing its generated result", async () => {
    const f = fixture(); await f.admit(); await f.options().beforeReview();
    f.options().onState({ captureId: "local-capture", phase: "discarded" }); await settle();
    expect(f.transport).toHaveBeenCalledWith("editor_actions_decide", { sessionId: expect.any(String), id: "action-1", accept: false });
    expect(f.flush).not.toHaveBeenCalled();
  });
  it.each(["cancelled", "stale", "failed"] as const)("stops the local preview on native %s and never accepts late results", async status => {
    const f = fixture(); await f.admit(); f.state.receipts.push(f.receipt(status)); await vi.advanceTimersByTimeAsync(1_000);
    expect(f.editor.cancel).toHaveBeenCalledWith("local-capture");
    await expect(f.options().beforeReview()).rejects.toThrow(/captured passage/); expect(f.flush).not.toHaveBeenCalled();
  });
  it("stops external work when native polling fails", async () => {
    const f = fixture(); await f.admit(); f.transport.mockRejectedValueOnce(new Error("mailbox lost"));
    await vi.advanceTimersByTimeAsync(1_000); expect(f.editor.cancel).toHaveBeenCalledWith("local-capture");
    await expect(f.options().beforeReview()).rejects.toThrow(/captured passage/);
  });
  it("reports save failure without replaying acceptance or claiming a saved result", async () => {
    const f = fixture(); await f.admit(); await f.options().beforeReview(); await f.options().beforeAccept();
    f.flush.mockRejectedValueOnce(new Error("save conflict")); await f.options().afterAccept("New body");
    expect(f.onError).toHaveBeenCalledWith("save conflict", true);
    expect(f.transport.mock.calls.some(([command]) => command === "editor_actions_saved")).toBe(false);
    expect(f.editor.start).toHaveBeenCalledOnce(); await expect(f.options().afterAccept("New body")).rejects.toThrow(/no acceptance/);
  });
  it("lets an already applied transaction finish saving after navigation without redirecting it", async () => {
    const f = fixture(); await f.admit(); await f.options().beforeReview(); await f.options().beforeAccept();
    const held = deferred<void>(); f.flush.mockImplementationOnce(() => held.promise);
    const done = f.options().afterAccept("New body"); await settle(); f.state.surface = null;
    await vi.advanceTimersByTimeAsync(1_000); expect(f.editor.cancel).not.toHaveBeenCalled();
    held.resolve(); await done; expect(f.flush).toHaveBeenCalledWith("s", "n", "New body");
    expect(f.transport.mock.calls.some(([command]) => command === "editor_actions_saved")).toBe(true);
  });
  it("rejects malformed actions without changing ordinary selection or starting generation", () => {
    expect(validEditorAction({ kind: "rewrite", preset: "clarify", instruction: "🧭".repeat(1_250) })).toBe(true);
    expect(validEditorAction({ kind: "rewrite", preset: "clarify", instruction: "🧭".repeat(1_251) })).toBe(false);
    expect(validEditorAction({ kind: "image", context: "space", quality: "fast", model: "override" } as never)).toBe(false);
  });
});
