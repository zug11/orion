import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceFindingScheduler } from "./voiceFindingScheduler";
import { voiceFindingDelivery } from "./voiceFindingDelivery";
import { voiceSynthesisContext, type PreparedVoiceFinding, type VoiceSynthesisConversation } from "./voiceFindingSynthesis";
import type { VoiceDelivery } from "./voiceConversation";
import { silentVoiceActivity } from "./voicePresence";

function finding(id: string, sequence = 1, completion = true): VoiceDelivery {
  const packet = voiceFindingDelivery({ id, spaceId: "space", revision: 1, sequence, subject: id, state: completion ? "completed" : "running", result: { reply: `${id} finding with a caveat.`, voice: { label: id, summary: `${id} finding with a caveat.` } } });
  return { id, revision: 1, sequence, text: packet.commentary, reference: packet.quiet, background: true, completion, delegationId: null };
}
function prepared(items: readonly VoiceDelivery[], conversation: VoiceSynthesisConversation, previous: readonly string[] = []): PreparedVoiceFinding {
  const context = voiceSynthesisContext("space", items, conversation.text, previous);
  return { context, result: { reply: "A combined finding, with its qualifications.", included: context.findings.map(f => f.key), deferred: [] } };
}
function setup() {
  let turn = { key: "first", text: "user: What connects these ideas?" };
  const live = new Map<string, VoiceDelivery>();
  const options = { enabled: () => true, valid: (item: VoiceDelivery) => !item.id || live.get(item.id)?.sequence === item.sequence,
    correcting: (_item: VoiceDelivery) => false, conversation: () => turn,
    synthesize: vi.fn(async (items: readonly VoiceDelivery[], conversation: VoiceSynthesisConversation, previous: readonly string[], _signal: AbortSignal) => prepared(items, conversation, previous)),
    sendPrepared: vi.fn((_packet: string, _summary: string, _delegationId: string | null) => true), sendReference: vi.fn((_item: VoiceDelivery) => true), send: vi.fn((_item: VoiceDelivery) => true), flushContext: vi.fn() };
  const scheduler = new VoiceFindingScheduler(options);
  return { options, scheduler, live, changeTopic: () => { turn = { key: "second", text: "user: A completely different topic." }; scheduler.transcript("user", 900, "A completely different topic."); },
    add: (item: VoiceDelivery) => { live.set(item.id!, item); scheduler.enqueue(item); } };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe("incremental synthesis and the conversation floor", () => {
  it("synthesizes while the voice speaks, protects a short mid-sentence gap, then sends one contribution", async () => {
    const { options, scheduler, add } = setup();
    scheduler.transcript("assistant", 0, "The useful distinction here is");
    scheduler.audio({ ...silentVoiceActivity(), outputActive: true });
    add(finding("a", 1, false)); add(finding("b")); scheduler.contextChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(options.synthesize).toHaveBeenCalledOnce(); expect(options.sendPrepared).not.toHaveBeenCalled();
    scheduler.audio(silentVoiceActivity());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(options.sendPrepared).not.toHaveBeenCalled(); expect(options.flushContext).not.toHaveBeenCalled();
    scheduler.transcript("assistant", 0, " how the evidence changes the idea.");
    await vi.advanceTimersByTimeAsync(2_500); expect(options.sendPrepared).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(options.sendPrepared).toHaveBeenCalledOnce();
    expect(JSON.parse(options.sendPrepared.mock.calls[0][0]).findings.map((f: any) => f.id)).toEqual(["b", "a"]);
    expect(options.send).not.toHaveBeenCalled(); expect(options.flushContext).toHaveBeenCalledOnce();
    scheduler.reset();
  });
  it("releases a prepared finding and pending context after sustained silence without terminal punctuation", async () => {
    const { options, scheduler, add } = setup();
    scheduler.transcript("assistant", 0, "I'm still thinking about what you said");
    scheduler.audio({ ...silentVoiceActivity(), outputActive: true });
    add(finding("a")); scheduler.contextChanged();
    scheduler.reference({ ...finding("a"), reference: "Research is complete." });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(options.sendPrepared).not.toHaveBeenCalled(); expect(options.sendReference).not.toHaveBeenCalled();
    scheduler.audio(silentVoiceActivity());
    await vi.advanceTimersByTimeAsync(7_500);
    expect(options.sendPrepared).not.toHaveBeenCalled(); expect(options.flushContext).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(options.sendPrepared).toHaveBeenCalledOnce(); expect(options.flushContext).toHaveBeenCalledOnce();
    expect(options.sendReference).toHaveBeenCalledOnce();
    expect(scheduler.status("a", 1)).toBe("shared");
    await vi.advanceTimersByTimeAsync(30_000); expect(options.sendPrepared).toHaveBeenCalledOnce();
    scheduler.reset();
  });
  it("keeps interim updates incremental and coalesces newer updates without waiting for unfinished workers", async () => {
    const { options, scheduler, add } = setup(); scheduler.transcript("user");
    add(finding("a", 1, false)); add(finding("a", 2, false)); add(finding("b", 1, false));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(options.synthesize).toHaveBeenCalledOnce();
    expect(options.synthesize.mock.calls[0][0].map(i => [i.id, i.sequence])).toEqual([["a", 2], ["b", 1]]);
    expect(options.sendPrepared).toHaveBeenCalledOnce();
    add(finding("a", 3, true));
    await vi.advanceTimersByTimeAsync(10_000); expect(options.sendPrepared).toHaveBeenCalledTimes(2);
    expect(options.synthesize.mock.calls[1][2]).toEqual(["A combined finding, with its qualifications."]);
    scheduler.reset();
  });
  it.each([
    ["delegation-a", "delegation-a", "delegation-a"],
    ["delegation-a", "delegation-b", null],
    ["delegation-a", null, null],
  ])("returns the consolidated substance with the shared delegation only: %s / %s", async (first, second, expected) => {
    const { options, scheduler, add } = setup();
    add({ ...finding("a"), delegationId: first }); add({ ...finding("b"), delegationId: second });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(options.sendPrepared).toHaveBeenCalledExactlyOnceWith(expect.any(String), "A combined finding, with its qualifications.", expected);
    scheduler.reset();
  });
  it("does not let a throttled interim batch strand a later completed worker", async () => {
    const { options, scheduler, add } = setup(); scheduler.transcript("user");
    for (let i = 0; i < 6; i++) add(finding(`interim-${i}`, 1, false));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(options.sendPrepared).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(options.synthesize).toHaveBeenCalledOnce();
    add(finding("completed")); await vi.advanceTimersByTimeAsync(2_000);
    expect(options.sendPrepared).toHaveBeenCalledTimes(2);
    const ids = JSON.parse(options.sendPrepared.mock.calls[1][0]).findings.map((f: any) => f.id);
    expect(ids).toEqual(["completed", "interim-4", "interim-5"]);
    expect(scheduler.status("completed", 1)).toBe("shared"); scheduler.reset();
  });
  it("reconsiders a prepared update after a new user topic and leaves unrelated findings available quietly", async () => {
    const { options, scheduler, add, changeTopic } = setup();
    scheduler.audio({ ...silentVoiceActivity(), outputActive: true }); add(finding("a"));
    await vi.advanceTimersByTimeAsync(2_000);
    options.synthesize.mockImplementation(async (items, conversation) => { const result = prepared(items, conversation); return { ...result, result: { reply: "", included: [], deferred: ["f1"] } }; });
    changeTopic(); scheduler.audio(silentVoiceActivity());
    await vi.advanceTimersByTimeAsync(3_000);
    expect(options.sendPrepared).not.toHaveBeenCalled(); expect(scheduler.status("a", 1)).toBe("deferred");
    await vi.advanceTimersByTimeAsync(60_000); expect(options.synthesize).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0); scheduler.reset();
  });
  it("drops an in-flight synthesis on cancellation and still delivers the surviving sibling", async () => {
    const { options, scheduler, add, live } = setup(); let resolve!: (value: PreparedVoiceFinding) => void;
    options.synthesize.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    add(finding("a")); add(finding("b")); await vi.advanceTimersByTimeAsync(1_500);
    const [items, context, , signal] = options.synthesize.mock.calls[0];
    live.delete("a"); scheduler.discardInvalid();
    expect(signal.aborted).toBe(true); resolve(prepared(items, context));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(options.sendPrepared).toHaveBeenCalledOnce();
    expect(JSON.parse(options.sendPrepared.mock.calls[0][0]).findings.map((f: any) => f.id)).toEqual(["b"]);
    scheduler.reset();
  });
  it("holds corrections, rejects a superseded checkpoint and suppresses all late work after Stop", async () => {
    const { options, scheduler, add } = setup(); let resolve!: (value: PreparedVoiceFinding) => void;
    options.synthesize.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    add(finding("a")); await vi.advanceTimersByTimeAsync(1_500);
    const [items, context, , signal] = options.synthesize.mock.calls[0];
    add(finding("a", 2)); scheduler.discardInvalid(); expect(signal.aborted).toBe(true);
    resolve(prepared(items, context)); scheduler.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.sendPrepared).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains research on synthesis failure, sleeps instead of retrying continuously, and retries on request", async () => {
    const { options, scheduler, add } = setup(); options.synthesize.mockRejectedValueOnce(new Error("provider unavailable"));
    add(finding("a")); await vi.advanceTimersByTimeAsync(2_000);
    expect(scheduler.status("a", 1)).toBe("failed"); expect(options.sendPrepared).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000); expect(options.synthesize).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    scheduler.retrySummary("a"); await vi.advanceTimersByTimeAsync(1_000);
    expect(options.sendPrepared).toHaveBeenCalledOnce(); expect(scheduler.status("a", 1)).toBe("shared"); scheduler.reset();
  });
  it("times out an unresponsive synthesiser without blocking direct result requests", async () => {
    const { options, scheduler, add } = setup(); options.synthesize.mockImplementation(() => new Promise(() => {}));
    add(finding("a")); await vi.advanceTimersByTimeAsync(1_500);
    add({ ...finding("b"), background: false }); await vi.advanceTimersByTimeAsync(500);
    expect(options.send).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(45_000); expect(scheduler.status("a", 1)).toBe("failed");
    expect(options.synthesize.mock.calls[0][3].aborted).toBe(true); scheduler.reset(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retries a rejected transport with the same prepared contribution, without another model call", async () => {
    const { options, scheduler, add } = setup(); options.sendPrepared.mockReturnValueOnce(false);
    add(finding("a")); await vi.advanceTimersByTimeAsync(2_000);
    expect(scheduler.status("a", 1)).toBe("waiting");
    await vi.advanceTimersByTimeAsync(500);
    expect(options.synthesize).toHaveBeenCalledOnce(); expect(scheduler.status("a", 1)).toBe("shared");
    expect(options.sendPrepared.mock.calls[0]).toEqual(options.sendPrepared.mock.calls[1]); scheduler.reset();
  });
  it("retains more than one team without dropping findings and never resumes speech in a worker conversation", async () => {
    const { options, scheduler, add } = setup();
    for (let i = 0; i < 10; i++) add(finding(`worker-${i}`));
    await vi.advanceTimersByTimeAsync(2_000); expect(options.sendPrepared).toHaveBeenCalledOnce();
    options.enabled = () => false; scheduler.handoff();
    await vi.advanceTimersByTimeAsync(20_000); expect(options.sendPrepared).toHaveBeenCalledOnce();
    options.enabled = () => true; scheduler.wake();
    await vi.advanceTimersByTimeAsync(20_000);
    const ids = options.sendPrepared.mock.calls.flatMap(([packet]) => JSON.parse(packet).findings.map((f: any) => f.id));
    expect(ids).toEqual(Array.from({ length: 10 }, (_, i) => `worker-${i}`));
    scheduler.reset(); expect(vi.getTimerCount()).toBe(0);
  });
});
