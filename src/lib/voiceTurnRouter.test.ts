import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTurnRouter, type RoutingVoiceTurn } from "./voiceTurnRouter";
import type { VoiceTurnDecision } from "./voiceWorkOrders";

const turn = (key: number): RoutingVoiceTurn => ({ key, prompt: `Research ${key}`, delegated: true, delegationId: null, focusNoteId: `note-${key}` });
function deferred() {
  let resolve!: (decision: VoiceTurnDecision) => void;
  const promise = new Promise<VoiceTurnDecision>(done => { resolve = done; });
  return { promise, resolve };
}
function setup() {
  const options = { enabled: () => true, budget: () => 45_000,
    route: vi.fn<(turn: RoutingVoiceTurn, signal: AbortSignal) => Promise<VoiceTurnDecision>>(async () => ({ action: "conversation" })),
    decide: vi.fn<(turn: RoutingVoiceTurn, decision: VoiceTurnDecision) => void>(), failed: vi.fn(), expired: vi.fn(), settled: vi.fn() };
  return { options, router: new VoiceTurnRouter(options) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("ordered voice interpretation lifecycle", () => {
  it("routes in spoken order and takes the next interpretation only after the previous decision updates state", async () => {
    const { options, router } = setup(), first = deferred(), seen: number[] = [];
    let revision = 1;
    options.route.mockImplementation(async () => { seen.push(revision); return seen.length === 1 ? first.promise : { action: "conversation" }; });
    options.decide.mockImplementation(() => { revision++; });
    router.enqueue(turn(1)); router.enqueue(turn(2)); router.pump();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);
    first.resolve({ action: "update", jobId: "job", revision: 1, prompt: "Correct" });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1, 2]);
    expect(options.decide.mock.calls.map(call => call[0].key)).toEqual([1, 2]);
    expect(router.pending).toEqual([]); expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a group and its dependent answers without waiting for an uncooperative provider", async () => {
    const { options, router } = setup(), hanging = deferred(), source = turn(1);
    const clarification = { turn: source, question: "Which topics?", workerCount: 3, epoch: 1, revision: 1 };
    const answer = { ...turn(2), clarification };
    options.route.mockImplementationOnce(() => hanging.promise);
    router.enqueue(answer); router.enqueue({ ...turn(3), clarification }); router.enqueue(turn(4)); router.pump();
    await vi.advanceTimersByTimeAsync(0);
    const signal = options.route.mock.calls[0][1];
    expect(router.cancelReservation(1)).toEqual([3, 2]);
    expect(signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.route.mock.calls.map(call => call[0].key)).toEqual([2, 4]);
    hanging.resolve({ action: "new", prompt: "Obsolete answer" }); await vi.advanceTimersByTimeAsync(0);
    expect(options.decide.mock.calls.map(call => call[0].key)).toEqual([4]);
    expect(options.settled.mock.calls.map(call => call[0].key)).toEqual([4]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences a late pre-reset result from a new call using the same turn key", async () => {
    const { options, router } = setup(), old = deferred(), fresh = deferred();
    options.route.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    router.enqueue(turn(1)); router.pump(); await vi.advanceTimersByTimeAsync(0);
    router.clear(); router.enqueue({ ...turn(1), focusNoteId: "fresh-note" }); router.pump(); await vi.advanceTimersByTimeAsync(0);
    old.resolve({ action: "new", prompt: "Old" }); await vi.advanceTimersByTimeAsync(0);
    expect(options.decide).not.toHaveBeenCalled(); expect(router.pending[0].focusNoteId).toBe("fresh-note");
    fresh.resolve({ action: "new", prompt: "Fresh" }); await vi.advanceTimersByTimeAsync(0);
    expect(options.decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ focusNoteId: "fresh-note" }), { action: "new", prompt: "Fresh" });
  });

  it("expires one route, advances unrelated work, and ignores the late result", async () => {
    const { options, router } = setup(), old = deferred();
    options.route.mockImplementationOnce(() => old.promise);
    router.enqueue(turn(1)); router.enqueue(turn(2)); router.pump(); await vi.advanceTimersByTimeAsync(45_000);
    expect(options.expired).toHaveBeenCalledExactlyOnceWith(turn(1));
    expect(options.decide.mock.calls.map(call => call[0].key)).toEqual([2]);
    old.resolve({ action: "new", prompt: "Too late" }); await vi.advanceTimersByTimeAsync(0);
    expect(options.decide).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("debounces fragments, enforces the pending-turn bound, and clears all timers at Stop", async () => {
    const { router } = setup(), consider = vi.fn();
    router.debounce(consider); await vi.advanceTimersByTimeAsync(800); router.debounce(consider);
    await vi.advanceTimersByTimeAsync(800); expect(consider).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); expect(consider).toHaveBeenCalledOnce();
    for (let key = 0; key < 8; key++) expect(router.enqueue(turn(key))).toBe(true);
    expect(router.enqueue(turn(9))).toBe(false);
    router.debounce(consider); router.clear();
    await vi.advanceTimersByTimeAsync(60_000); expect(consider).toHaveBeenCalledOnce(); expect(router.pending).toEqual([]);
  });
});
