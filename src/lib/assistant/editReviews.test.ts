import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { ChatEditApplication } from "../chatEdits";
import { externalEditProposal, startExternalEditReviews, type EditReviewReceipt, type EditReviewState, type ExternalEditDelivery } from "./editReviews";
const controllers: ReturnType<typeof startExternalEditReviews>[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
async function settle() { for (let i = 0; i < 15; i++) await Promise.resolve(); }
function fixture() {
  vi.useFakeTimers();
  const snapshot = createEmptySnapshot("Review");
  snapshot.notes = [{ id: "note", title: "Draft", body: "An old sentence.", slug: "draft", kind: "article", status: "ready", tags: [], aliases: [], conceptIds: [], sourceIds: [], summary: "", createdAt: "now", updatedAt: "now" }];
  const delivery: ExternalEditDelivery = { id: "review-one", spaceId: snapshot.workspace.id, noteId: "note", expectedVersion: "version", title: "Draft", baseBody: snapshot.notes[0].body, edit: { kind: "focused", edits: [{ before: "old", after: "clear" }] } };
  const receipt = (state: EditReviewState): EditReviewReceipt => ({ id: delivery.id, spaceId: delivery.spaceId, noteId: delivery.noteId, reviewTargetId: "target", state, createdAt: 1, updatedAt: 1 });
  const state = { target: { spaceId: delivery.spaceId, noteId: delivery.noteId, ready: true } as { spaceId: string; noteId: string; ready: boolean } | null, deliveries: [delivery], receipts: [] as EditReviewReceipt[], shown: undefined as ChatEditApplication | undefined };
  const transport = vi.fn(async (command: string, _args: Record<string, unknown>): Promise<unknown> => {
    if (command === "assistant_review_poll") { const deliveries = state.deliveries.splice(0); return { deliveries, receipts: state.receipts }; }
    if (command === "assistant_review_stage") return receipt("awaiting_review");
    if (command === "assistant_review_decide") return receipt("accepting");
    return receipt("saved");
  });
  const host = {
    getTarget: () => state.target,
    getSpace: (id: string) => id === snapshot.workspace.id ? snapshot : undefined,
    flush: vi.fn(async (): Promise<void> => undefined),
    present: vi.fn((application: ChatEditApplication) => { state.shown = application; state.target!.ready = false; }),
    close: vi.fn(() => { state.shown = undefined; }),
    getAcceptedBody: () => snapshot.notes[0].body,
    onError: vi.fn(),
  };
  const start = () => { const controller = startExternalEditReviews(host, transport as Parameters<typeof startExternalEditReviews>[1]); controllers.push(controller); return controller; };
  return { snapshot, delivery, receipt, state, host, transport, start };
}

describe("external review mailbox", () => {
  it("does no idle native work and preserves one session across target permission changes during saving", async () => {
    const f = fixture(), target = f.state.target; f.state.target = null;
    const controller = f.start(); await vi.advanceTimersByTimeAsync(3_000);
    expect(f.transport).not.toHaveBeenCalled();
    f.state.target = target; await vi.advanceTimersByTimeAsync(1_000);
    expect(f.host.present).toHaveBeenCalledOnce();
    await controller.beforeAccept(f.delivery.id); f.snapshot.notes[0].body = "Accepted.";
    const saved = deferred<void>(); f.host.flush.mockImplementationOnce(() => saved.promise);
    const completion = controller.complete(f.delivery.id); await settle();
    f.state.target = null; await vi.advanceTimersByTimeAsync(1_000);
    f.state.target = { ...target!, ready: false }; await vi.advanceTimersByTimeAsync(1_000);
    saved.resolve(); await completion;
    expect(new Set(f.transport.mock.calls.map(([, args]) => args.sessionId)).size).toBe(1);
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_fail")).toBe(false);
    f.state.target = null; await vi.advanceTimersByTimeAsync(1_000);
    const idleCalls = f.transport.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000); expect(f.transport).toHaveBeenCalledTimes(idleCalls);
  });

  it("flushes before staging, waits without occupying research, claims once, and confirms only after persistence", async () => {
    const f = fixture(), controller = f.start(); await settle();
    expect(f.host.present).toHaveBeenCalledOnce(); expect(f.host.flush).toHaveBeenCalledOnce();
    expect(f.snapshot.notes[0].body).toBe("An old sentence.");
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_accepted")).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.transport.mock.calls.filter(([command]) => command === "assistant_review_poll")).toHaveLength(3);
    expect(f.state.shown).toBeDefined(); // ready=false does not revoke ownership.
    const claim = deferred<unknown>();
    f.transport.mockImplementationOnce(async () => claim.promise);
    const accepting = controller.beforeAccept(f.delivery.id);
    await expect(controller.beforeAccept(f.delivery.id)).rejects.toThrow("no longer available");
    claim.resolve(f.receipt("accepting")); await accepting;
    f.snapshot.notes[0].body = "An clear sentence.";
    const saved = deferred<void>(); f.host.flush.mockImplementationOnce(() => saved.promise);
    const completion = controller.complete(f.delivery.id); await settle();
    expect(f.transport).toHaveBeenCalledWith("assistant_review_accepted", expect.objectContaining({ body: "An clear sentence." }));
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_saved")).toBe(false);
    saved.resolve(); await completion;
    expect(f.transport).toHaveBeenCalledWith("assistant_review_saved", expect.objectContaining({ id: f.delivery.id }));
    expect(controller.busy()).toBe(false);
  });

  it("does not stage pending typing that changes the captured base during the save queue", async () => {
    const f = fixture(); f.host.flush.mockImplementation(async () => { f.snapshot.notes[0].body += " User typing."; });
    f.start(); await settle();
    expect(f.host.present).not.toHaveBeenCalled();
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_stage")).toBe(false);
    expect(f.transport).toHaveBeenCalledWith("assistant_review_fail", expect.objectContaining({ error: expect.stringContaining("changed") }));
  });

  it.each(["navigation", "cancellation"])("never presents a late staged proposal after %s", async kind => {
    const f = fixture(), save = deferred<void>(); f.host.flush.mockImplementationOnce(() => save.promise);
    f.start(); await settle();
    if (kind === "navigation") f.state.target = null;
    else f.state.receipts = [f.receipt("cancelled")];
    await vi.advanceTimersByTimeAsync(1_000); save.resolve(); await settle();
    expect(f.host.present).not.toHaveBeenCalled(); expect(f.snapshot.notes[0].body).toBe(f.delivery.baseBody);
  });

  it("rejects navigation while an accept claim is pending and never acknowledges a transaction", async () => {
    const f = fixture(), controller = f.start(); await settle();
    const claim = deferred<unknown>(); f.transport.mockImplementationOnce(() => claim.promise);
    const pending = controller.beforeAccept(f.delivery.id); f.state.target = null;
    claim.resolve(f.receipt("accepting")); await expect(pending).rejects.toThrow("no longer open");
    await controller.complete(f.delivery.id, "The editor closed.");
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_accepted")).toBe(false);
  });

  it("retains the accepted local edit when saving fails and reports no saved receipt", async () => {
    const f = fixture(), controller = f.start(); await settle(); await controller.beforeAccept(f.delivery.id);
    f.snapshot.notes[0].body = "An accepted local sentence.";
    f.host.flush.mockRejectedValueOnce(new Error("A competing disk revision needs your choice."));
    await controller.complete(f.delivery.id);
    expect(f.snapshot.notes[0].body).toBe("An accepted local sentence.");
    expect(f.transport).toHaveBeenCalledWith("assistant_review_fail", expect.objectContaining({ error: expect.stringContaining("competing") }));
    expect(f.host.onError).toHaveBeenCalledOnce();
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_saved")).toBe(false);
  });

  it("finishes an admitted editor transaction after navigation and mailbox disposal, without undoing it", async () => {
    const f = fixture(), controller = f.start(); await settle(); await controller.beforeAccept(f.delivery.id);
    f.snapshot.notes[0].body = "Accepted text.";
    const saved = deferred<void>(); f.host.flush.mockImplementationOnce(() => saved.promise);
    const completion = controller.complete(f.delivery.id); await settle();
    f.state.target = null; await vi.advanceTimersByTimeAsync(1_000); controller.dispose();
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_fail")).toBe(false);
    saved.resolve(); await completion;
    expect(f.transport).toHaveBeenCalledWith("assistant_review_saved", expect.objectContaining({ id: f.delivery.id }));
    expect(f.snapshot.notes[0].body).toBe("Accepted text.");
  });

  it("rejects a remote cancellation delivered while the native accept claim is pending", async () => {
    const f = fixture(), controller = f.start(); await settle();
    const claim = deferred<unknown>(); f.transport.mockImplementationOnce(() => claim.promise);
    const pending = controller.beforeAccept(f.delivery.id);
    f.state.receipts = [f.receipt("cancelled")]; await vi.advanceTimersByTimeAsync(1_000);
    claim.resolve(f.receipt("cancelled")); await expect(pending).rejects.toThrow("no longer open");
    expect(f.host.close).toHaveBeenCalledWith(f.delivery.id);
    expect(f.transport.mock.calls.some(([command]) => command === "assistant_review_accepted")).toBe(false);
  });

  it("discards without changing text, and never treats an unsolicited completion as acceptance", async () => {
    const f = fixture(), controller = f.start(); await settle();
    await controller.complete(f.delivery.id, undefined, false);
    expect(f.transport).toHaveBeenCalledWith("assistant_review_decide", expect.objectContaining({ accept: false }));
    expect(f.snapshot.notes[0].body).toBe(f.delivery.baseBody);
    const g = fixture(), unclaimed = g.start(); await settle(); await unclaimed.complete(g.delivery.id);
    expect(g.transport.mock.calls.some(([command]) => command === "assistant_review_accepted")).toBe(false);
  });

  it("refuses busy or foreign targets before opening the existing note surface", async () => {
    const f = fixture(); f.state.target!.ready = false; f.start(); await settle();
    expect(f.host.present).not.toHaveBeenCalled();
    expect(() => externalEditProposal({ ...f.delivery, spaceId: "other" }, f.snapshot)).toThrow("different");
  });

  it("requires explicit history for a whole rewrite over hidden completed tasks", () => {
    const f = fixture(); f.snapshot.notes[0].body = "Opening.\n\n- [x] Keep this completed task.";
    const delivery: ExternalEditDelivery = { ...f.delivery, baseBody: f.snapshot.notes[0].body, edit: { kind: "rewrite", body: "New opening." } };
    expect(() => externalEditProposal(delivery, f.snapshot)).toThrow("history");
    expect(externalEditProposal({ ...delivery, taskView: "history" }, f.snapshot).rewrite).toBe("New opening.");
    expect(() => externalEditProposal({ ...f.delivery, baseBody: "---\nsecret: old\n---\n\nText" }, { ...f.snapshot, notes: [{ ...f.snapshot.notes[0], body: "---\nsecret: old\n---\n\nText" }] })).toThrow();
  });
});
