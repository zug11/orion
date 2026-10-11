import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceReservations } from "../voiceReservations";
import type { VoiceResearch, VoiceWorkOrder } from "../voiceResearch";
import { voiceWorkOrderDetail, voiceWorkOrderSummary, type VoiceExternalAuthority } from "../voiceWorkOrderAccess";
import { VoiceWorkOrderHost, type VoiceAccessRequest, type VoiceControlRequest, type VoiceListRequest } from "./voiceWorkOrderHost";
import { startVoiceWorkOrderMailbox } from "./voiceWorkOrders";

const controllers: ReturnType<typeof startVoiceWorkOrderMailbox>[] = [];
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()); vi.useRealTimers(); });
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  vi.useFakeTimers(); let next = 0;
  const reservations = new VoiceReservations(() => `worker-${++next}`);
  const state = { jobs: [] as VoiceWorkOrder[], ready: true, allowAI: true, failPoll: false,
    focused: undefined as string | undefined,
    requests: [] as { id: string; targetId: string; request: VoiceAccessRequest }[],
    grants: new Map<string, { id: string; workOrderId: string; revision: number }>(), authority: undefined as VoiceExternalAuthority | undefined };
  const revise = (id: string, _revision: number, direction: string, authority: VoiceExternalAuthority) => {
    state.authority = authority;
    const previous = state.jobs.find(job => job.id === id);
    const job: VoiceWorkOrder = { id, revision: (previous?.revision ?? 0) + 1, subject: direction, prompt: direction, state: "running", progress: "Researching" };
    state.jobs = [...state.jobs.filter(job => job.id !== id), job];
    return { id, revision: job.revision, action: "steer" as const, state: job.state, changed: true, readOnly: true as const };
  };
  const engine = {
    inventory: vi.fn((taskView = "working") => state.jobs.map(job => voiceWorkOrderSummary(job, taskView as "working" | "history", true))),
    inspect: vi.fn((id, _revision, options) => voiceWorkOrderDetail(state.jobs.find(job => job.id === id)!, undefined, { ...options, current: true })),
    cancelVersion: vi.fn((id, revision) => {
      const job = state.jobs.find(job => job.id === id)!, changed = job.state === "running";
      if (changed) job.state = "cancelled";
      return { id, revision, action: "cancel" as const, state: job.state, changed };
    }),
    steerExternal: vi.fn(revise),
    retryExternal: vi.fn((id, revision, authority) => ({ ...revise(id, revision, "Retry", authority), action: "retry" as const })),
    admitExternalReserved: vi.fn((id, direction, binding, authority) => {
      const receipt = revise(id, 0, direction, authority);
      Object.assign(state.jobs.find(job => job.id === id)!, binding); return receipt;
    }),
    cancelExternal: vi.fn(),
    externalIsRunning: (_grantId: string, id: string, revision: number) => state.jobs.some(job => job.id === id && job.revision === revision && job.state === "running"),
  };
  const changed = vi.fn();
  const host = new VoiceWorkOrderHost({ spaceId: "space", engine: engine as unknown as VoiceResearch, reservations, ready: () => state.ready,
    focusedWorker: () => state.focused, reservationChanged: changed });
  const list = (overrides: Partial<VoiceListRequest> = {}): VoiceListRequest => ({ operation: "list", space_id: "space", voice_target_id: "target", task_view: "working", offset: 0, limit: 20, ...overrides });
  const control = (id: string, action: VoiceControlRequest["action"] = "steer"): VoiceControlRequest => {
    const job = host.inventory().find(job => job.id === id)!;
    return { operation: "control", space_id: "space", voice_target_id: "target", task_view: "working", work_order_id: id,
      expected_revision: job.revision, expected_control_version: job.controlVersion, request_id: `control-${++next}`, action,
      ...(action === "steer" ? { direction: "Research the original passage's structure" } : {}) };
  };
  const transport = vi.fn(async (command: string, args: Record<string, unknown>): Promise<unknown> => {
    if (command === "voice_work_orders_poll") {
      if (state.failPoll) throw new Error("Native host unavailable");
      return { targetId: args.target ? "target" : null, requests: state.requests.splice(0), grants: [...state.grants.values()], allowAI: state.allowAI };
    }
    if (command === "voice_work_orders_claim") {
      const grant = args.admittedRevision ? { id: `grant-${args.id}`, workOrderId: "worker-1", revision: Number(args.admittedRevision) } : undefined;
      if (grant) state.grants.set(grant.id, grant);
      return { claimed: true, grantId: grant?.id ?? null };
    }
    if (command === "voice_work_orders_authorize") return state.allowAI;
    if (command === "voice_work_orders_release") state.grants.delete(String(args.grantId));
    return { ok: true };
  });
  const enqueue = (request: VoiceAccessRequest, id = "request") => state.requests.push({ id, targetId: "target", request });
  const start = () => { const c = startVoiceWorkOrderMailbox(host, transport as Parameters<typeof startVoiceWorkOrderMailbox>[1]); controllers.push(c); return c; };
  const replies = () => transport.mock.calls.filter(([command]) => command === "voice_work_orders_respond").map(([, args]) => args);
  const reserve = (phase: "routing" | "clarifying" = "clarifying") => {
    reservations.reserve({ key: 1, prompt: "Have three workers research this note", delegationId: null, delegated: false,
      focusNoteId: "original", selection: { id: "selected", noteId: "original", spaceId: "space", noteTitle: "Original", version: "v1",
        text: "Exact captured passage", range: { from: 0, to: 22, unit: "dom-text-utf16" }, hiddenTaskRanges: [] } }, 3, phase);
  };
  return { state, reservations, engine, host, changed, list, control, transport, enqueue, start, replies, reserve };
}

describe("voice work-order public owner", () => {
  it("pages admitted and waiting workers without exposing captured transcripts or selections", () => {
    const f = fixture(); f.reserve();
    const first = f.host.list(f.list({ limit: 2 }));
    expect(first).toMatchObject({ total: 3, nextOffset: 2 });
    expect(JSON.stringify(first)).not.toContain("Exact captured passage");
    expect(JSON.stringify(first)).not.toContain("Have three workers");
    const last = f.host.list(f.list({ offset: 2, inventory_version: first.inventoryVersion }));
    expect(last.items).toHaveLength(1); expect(last.nextOffset).toBeNull();
    f.reservations.removeMember(first.items[0].id, "cancel");
    expect(() => f.host.list(f.list({ offset: 2, inventory_version: first.inventoryVersion }))).toThrow("inventory changed");
  });
  it("keeps control identity across read views and changes it after clarification even at revision1", () => {
    const f = fixture(); f.reserve(); const before = f.host.inventory()[0];
    expect(f.host.inventory("history")[0].controlVersion).toBe(before.controlVersion);
    const request = f.control(before.id), prepared = f.host.prepare(request);
    f.reservations.ask({ key: 1, prompt: "new", delegated: false, delegationId: null }, "Which topics?", 3);
    expect(() => prepared.execute()).toThrow("changed");
    expect(f.host.inventory()[0].revision).toBe(1);
  });
  it("steers one waiting identity into read-only research with its original binding and preserves siblings", () => {
    const f = fixture(); f.reserve(); const ids = f.host.inventory().map(job => job.id);
    const authority = { grantId: "grant", taskView: "working" as const, assertCurrent: vi.fn() };
    const admission = f.host.prepare(f.control(ids[0]));
    expect(admission.admittedRevision).toBe(1);
    expect(admission.execute(authority)).toMatchObject({ id: ids[0], revision: 1, readOnly: true });
    expect(f.engine.admitExternalReserved).toHaveBeenCalledWith(ids[0], expect.any(String),
      expect.objectContaining({ focusNoteId: "original", selection: expect.objectContaining({ text: "Exact captured passage" }) }), authority);
    expect(f.reservations.jobs().map(job => job.id)).toEqual(ids.slice(1));
    expect(f.host.inventory().map(job => job.id)).toEqual(ids); expect(f.changed).toHaveBeenCalledExactlyOnceWith(1);
  });
  it("does not erase a waiting orb if admission fails and rejects retry before its assignment exists", () => {
    const f = fixture(); f.reserve(); const id = f.host.inventory()[0].id;
    expect(() => f.host.prepare(f.control(id, "retry"))).toThrow("waiting");
    f.engine.admitExternalReserved.mockImplementationOnce(() => { throw new Error("Invalid scope"); });
    expect(() => f.host.prepare(f.control(id)).execute({ grantId: "g", taskView: "working", assertCurrent: vi.fn() })).toThrow("Invalid scope");
    expect(f.reservations.jobs()).toHaveLength(3); expect(f.changed).not.toHaveBeenCalled();
  });
  it("steering during the initial route leaves siblings waiting for direction rather than pretending to research", () => {
    const f = fixture(); f.reserve("routing");
    f.host.prepare(f.control("worker-1")).execute({ grantId: "grant", taskView: "working", assertCurrent: vi.fn() });
    expect(f.host.inventory().filter(job => job.id !== "worker-1").map(job => job.stage)).toEqual(["clarifying", "clarifying"]);
    expect(f.reservations.clarification?.workerCount).toBe(2); expect(f.changed).toHaveBeenCalledWith(1);
  });
  it("cancels one reservation without AI and preserves terminal results on repeated cancellation", () => {
    const f = fixture(); f.reserve(); f.state.ready = false;
    const id = f.host.inventory()[0].id;
    expect(f.host.prepare(f.control(id, "cancel")).execute()).toMatchObject({ id, state: "cancelled", changed: true });
    expect(f.reservations.jobs()).toHaveLength(2);
    f.state.jobs.push({ id, revision: 1, state: "completed", subject: "Completed", prompt: "Original", progress: "", result: { reply: "Saved answer" } });
    expect(f.host.prepare(f.control(id, "cancel")).execute()).toMatchObject({ state: "completed", changed: false });
    expect(f.state.jobs[0].result?.reply).toBe("Saved answer");
  });
  it("withholds historical reservation subjects in the working view", () => {
    const f = fixture();
    f.reservations.reserve({ key: 1, prompt: "Research completed tasks about SECRET", delegated: false, delegationId: null }, 1, "routing");
    const job = f.host.inventory()[0]; expect(job.subject).toBe("History research"); expect(job.historyWithheld).toBe(true);
    expect(JSON.stringify(f.host.inspect({ operation: "get", space_id: "space", voice_target_id: "target", task_view: "working", work_order_id: job.id, expected_revision: 1, max_chars: 4000 }))).not.toContain("SECRET");
    expect(f.host.inventory("history")[0].subject).toContain("SECRET");
  });
  it("cannot restart the focused worker's conversation, including focus acquired during a claim", () => {
    const f = fixture(); f.state.jobs.push({ id: "worker-1", revision: 1, state: "completed", subject: "Result", prompt: "Research", progress: "", result: { reply: "Answer" } });
    const request = f.control("worker-1"), prepared = f.host.prepare(request);
    f.state.focused = "worker-1";
    expect(() => f.host.prepare(request)).toThrow("Return to the main conversation");
    expect(() => prepared.execute()).toThrow("Return to the main conversation");
    expect(f.engine.steerExternal).not.toHaveBeenCalled();
    expect(f.host.prepare(f.control("worker-1", "cancel")).execute()).toMatchObject({ changed: false, state: "completed" });
  });
});

describe("voice work-order native mailbox lifecycle", () => {
  it("sends only identity/readiness on heartbeats and serves explicit reads without claiming AI", async () => {
    const f = fixture(); f.reserve(); f.enqueue(f.list()); f.start(); await settle();
    expect(f.replies()[0].result).toMatchObject({ total: 3 });
    const heartbeats = f.transport.mock.calls.filter(([command]) => command === "voice_work_orders_poll");
    expect(heartbeats[0][1]).toEqual({ sessionId: expect.any(String), target: { spaceId: "space", ready: true } });
    expect(f.transport.mock.calls.some(([command]) => command.includes("claim"))).toBe(false);
    expect(JSON.stringify(heartbeats)).not.toContain("Exact captured passage");
  });
  it("claims an exact existing worker and independently authorizes each external provider stage", async () => {
    const f = fixture(); f.reserve(); f.enqueue(f.control("worker-1")); f.start(); await settle();
    expect(f.replies()[0].result).toMatchObject({ id: "worker-1", revision: 1, readOnly: true });
    expect(f.transport.mock.calls.find(([command]) => command === "voice_work_orders_claim")?.[1].admittedRevision).toBe(1);
    await f.state.authority!.assertCurrent(); expect(f.transport.mock.calls.filter(([command]) => command === "voice_work_orders_authorize")).toHaveLength(1);
    f.state.allowAI = false; await expect(f.state.authority!.assertCurrent()).rejects.toThrow("revoked");
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.engine.cancelExternal).toHaveBeenCalledWith("grant-request");
    expect(f.engine.cancelVersion).not.toHaveBeenCalled();
  });
  it("rechecks semantic identity after the asynchronous native claim", async () => {
    const f = fixture(); f.reserve(); const held = deferred<unknown>(), original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation((command, args) => command === "voice_work_orders_claim" ? held.promise : original(command, args));
    f.enqueue(f.control("worker-1")); f.start(); await settle();
    f.reservations.removeMember("worker-2", "cancel");
    held.resolve({ claimed: true, grantId: "late-grant" }); await settle();
    expect(f.engine.admitExternalReserved).not.toHaveBeenCalled();
    expect(f.replies()[0].error).toContain("changed");
    expect(f.transport.mock.calls.some(([command, args]) => command === "voice_work_orders_release" && args.grantId === "late-grant")).toBe(true);
    expect(f.reservations.jobs().map(job => job.id)).toEqual(["worker-1", "worker-3"]);
  });
  it("rejects replays, wrong owners and malformed input without mutating work", async () => {
    const f = fixture(); f.reserve();
    f.enqueue(f.list(), "read"); f.enqueue({ ...f.list(), space_id: "other" }, "wrong-space");
    f.enqueue({ ...f.list(), limit: Infinity }, "invalid"); f.start(); await settle();
    f.enqueue(f.list(), "read"); await vi.advanceTimersByTimeAsync(1000);
    expect(f.replies()).toHaveLength(1); expect(f.engine.cancelVersion).not.toHaveBeenCalled();
  });
  it("lets terminal grants go and cancels only external work on a failed heartbeat", async () => {
    const f = fixture(); f.reserve(); f.enqueue(f.control("worker-1")); f.start(); await settle();
    f.state.jobs[0].state = "completed"; await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.grants.size).toBe(0); expect(f.engine.cancelExternal).not.toHaveBeenCalled();
    f.enqueue(f.control("worker-1"), "again"); await vi.advanceTimersByTimeAsync(1000);
    f.state.failPoll = true; await vi.advanceTimersByTimeAsync(1000);
    expect(f.engine.cancelExternal).toHaveBeenCalledWith("grant-again");
    expect(f.engine.cancelVersion).not.toHaveBeenCalled();
  });
  it("withdraws on disposal and cannot admit a delayed claim or restart polling", async () => {
    const f = fixture(); f.reserve(); const held = deferred<unknown>(), original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation((command, args) => command === "voice_work_orders_claim" ? held.promise : original(command, args));
    f.enqueue(f.control("worker-1")); const c = f.start(); await settle(); c.dispose();
    held.resolve({ claimed: true, grantId: "late" }); await settle(); await vi.advanceTimersByTimeAsync(5000);
    expect(f.engine.admitExternalReserved).not.toHaveBeenCalled(); expect(f.replies()).toEqual([]);
    expect(f.transport.mock.calls.filter(([command]) => command === "voice_work_orders_poll")).toHaveLength(2);
    expect(f.transport.mock.calls.find(([command, args]) => command === "voice_work_orders_poll" && args.target === null)).toBeTruthy();
  });
});
