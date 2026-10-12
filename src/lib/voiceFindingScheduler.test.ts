import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceFindingScheduler } from "./voiceFindingScheduler";
import { silentVoiceActivity } from "./voicePresence";
import type { VoiceDelivery } from "./voiceConversation";
import { voiceFindingDelivery } from "./voiceFindingDelivery";

const finding = (id = "one", revision = 1): VoiceDelivery => ({ id, revision, sequence: 1, text: `${id} finding`, delegationId: null });
function setup() {
  const options = { enabled: () => true, valid: (_item: VoiceDelivery) => true, correcting: (_item: VoiceDelivery) => false, send: vi.fn((_item: VoiceDelivery) => true) };
  return { options, scheduler: new VoiceFindingScheduler(options) };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(() => vi.useRealTimers());

describe("voice finding scheduler lifecycle", () => {
  it("retains 24 completions through continuous speech and offers six coherent groups with breathing room", async () => {
    const { options } = setup(), sendBatch = vi.fn((_packet: string) => true);
    const scheduler = new VoiceFindingScheduler({ ...options, sendBatch });
    for (let i = 0; i < 24; i++) scheduler.enqueue({ ...finding(`done-${i}`), completion: true, background: true });
    for (let tick = 0; tick < 60; tick++) { scheduler.transcript("user"); await vi.advanceTimersByTimeAsync(500); }
    expect(sendBatch).not.toHaveBeenCalled();
    for (let i = 0; i < 24; i++) expect(scheduler.status(`done-${i}`, 1)).toBe("waiting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6_000); expect(sendBatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(40_000);
    const delivered = sendBatch.mock.calls.flatMap(([packet]) => JSON.parse(packet).findings.map((item: VoiceDelivery) => item.id));
    expect(delivered).toEqual(Array.from({ length: 24 }, (_, i) => `done-${i}`));
    expect(sendBatch).toHaveBeenCalledTimes(6); expect(options.send).not.toHaveBeenCalled();
    for (let i = 0; i < 24; i++) expect(scheduler.status(`done-${i}`, 1)).toBe("shared");
    scheduler.enqueue({ ...finding("done-0"), completion: true, background: true });
    await vi.advanceTimersByTimeAsync(10_000); expect(sendBatch).toHaveBeenCalledTimes(6);
    scheduler.reset(); expect(vi.getTimerCount()).toBe(0);
  });
  it("holds an incomplete thought, retries the batch as a unit, and never marks a rejected offer shared", async () => {
    const { options } = setup(), sendBatch = vi.fn((_packet: string) => false);
    const scheduler = new VoiceFindingScheduler({ ...options, sendBatch });
    scheduler.enqueue({ ...finding(), background: true, completion: true });
    scheduler.transcript("user", 3_200);
    await vi.advanceTimersByTimeAsync(3_000); expect(sendBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(sendBatch).toHaveBeenCalledOnce(); expect(scheduler.status("one", 1)).toBe("waiting");
    sendBatch.mockReturnValue(true); await vi.advanceTimersByTimeAsync(500);
    expect(scheduler.status("one", 1)).toBe("shared");
    expect(sendBatch.mock.calls[0]).toEqual(sendBatch.mock.calls[1]); scheduler.reset();
  });
  it("coalesces staggered completions, bypasses a corrected job, and preserves waiting siblings across an orb handoff", async () => {
    const { options } = setup(), sendBatch = vi.fn((_packet: string) => true);
    let correction = true, revision = 1, enabled = true;
    const scheduler = new VoiceFindingScheduler({ ...options,
      enabled: () => enabled,
      correcting: item => item.id === "one" && correction,
      valid: item => item.id !== "one" || item.revision === revision, sendBatch });
    scheduler.enqueue({ ...finding(), completion: true, background: true });
    await vi.advanceTimersByTimeAsync(500);
    scheduler.enqueue({ ...finding("two"), completion: true, background: true });
    await vi.advanceTimersByTimeAsync(1_000); expect(sendBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(JSON.parse(sendBatch.mock.calls[0][0]).findings.map((item: VoiceDelivery) => item.id)).toEqual(["two"]);
    scheduler.handoff(); enabled = false;
    revision = 2; correction = false; scheduler.discardInvalid();
    expect(scheduler.status("one", 1)).toBeUndefined();
    scheduler.enqueue({ ...finding("one", 2), completion: true, background: true });
    await vi.advanceTimersByTimeAsync(10_000); expect(sendBatch).toHaveBeenCalledTimes(1);
    enabled = true; scheduler.wake(); await vi.advanceTimersByTimeAsync(500); expect(sendBatch).toHaveBeenCalledTimes(2);
    // A handoff keeps deduplication and its batch spacing, without replaying two.
    expect(JSON.parse(sendBatch.mock.calls[1][0]).findings[0]).toMatchObject({ id: "one", revision: 2 });
    scheduler.reset();
  });
  it("returns each completed assignment automatically after an interim update without opening a worker", async () => {
    const { options, scheduler } = setup(); scheduler.transcript("user");
    scheduler.enqueue({ ...finding("interim"), background: true });
    await vi.advanceTimersByTimeAsync(1_500); expect(options.send).toHaveBeenCalledOnce();
    scheduler.audio({ ...silentVoiceActivity(), outputActive: true });
    for (let i = 0; i < 3; i++) scheduler.enqueue({ ...finding(`done-${i}`), background: true, completion: true });
    await vi.advanceTimersByTimeAsync(20_000); expect(options.send).toHaveBeenCalledOnce();
    scheduler.audio(silentVoiceActivity());
    await vi.advanceTimersByTimeAsync(1_500); expect(options.send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3_000); expect(options.send).toHaveBeenCalledTimes(4);
    scheduler.enqueue({ ...finding("done-0"), background: true, completion: true });
    scheduler.enqueue({ ...finding("another-interim"), background: true });
    await vi.advanceTimersByTimeAsync(60_000); expect(options.send).toHaveBeenCalledTimes(4);
    scheduler.reset(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a batch quiet after one brief finding until the user speaks, without blocking explicit requests", async () => {
    const { options, scheduler } = setup();
    scheduler.transcript("user");
    for (let i = 0; i < 10; i++) scheduler.enqueue({ ...finding(`worker-${i}`), background: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(options.send).toHaveBeenCalledTimes(1);
    scheduler.transcript("assistant");
    scheduler.audio({ ...silentVoiceActivity(), inputActive: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.send).toHaveBeenCalledTimes(1);
    scheduler.enqueue({ ...finding("requested"), background: false });
    await vi.advanceTimersByTimeAsync(500);
    expect(options.send).toHaveBeenLastCalledWith(expect.objectContaining({ id: "requested" }));
    scheduler.handoff(); scheduler.wake();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(options.send).toHaveBeenCalledTimes(2);
    scheduler.transcript("user");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(options.send).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(options.send).toHaveBeenCalledTimes(3);
    scheduler.reset(); expect(vi.getTimerCount()).toBe(0);
  });
  it("waits briefly after a transcript but caps noisy-room delay and paces successive findings", async () => {
    const { options, scheduler } = setup();
    scheduler.enqueue(finding()); scheduler.enqueue(finding("two"));
    scheduler.audio({ ...silentVoiceActivity(), inputActive: true });
    for (let tick = 0; tick < 23; tick++) { scheduler.transcript(); await vi.advanceTimersByTimeAsync(500); }
    expect(options.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(options.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500); expect(options.send.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000); expect(options.send.mock.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500); expect(options.send.mock.calls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("holds an exact correction until its revision is resolved and drops superseded evidence", async () => {
    const { options, scheduler } = setup();
    let correcting = true;
    options.correcting = item => correcting && item.id === "one";
    scheduler.enqueue(finding()); await vi.advanceTimersByTimeAsync(15_000);
    expect(options.send).not.toHaveBeenCalled();
    options.valid = () => false; correcting = false;
    await vi.advanceTimersByTimeAsync(500); expect(options.send).not.toHaveBeenCalled();
    options.valid = () => true; scheduler.enqueue(finding("one", 2));
    await vi.advanceTimersByTimeAsync(500); expect(options.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ revision: 2 }));
  });

  it("offers unrelated findings within the wait cap while retaining a corrected head and suppressing its stale revision", async () => {
    const { options, scheduler } = setup();
    let correcting = true;
    let currentRevision = 1;
    options.correcting = item => correcting && item.id === "one";
    options.valid = item => item.id !== "one" || item.revision === currentRevision;
    scheduler.enqueue(finding()); scheduler.enqueue(finding("two")); scheduler.enqueue(finding("three"));
    scheduler.audio({ ...silentVoiceActivity(), inputActive: true });
    for (let tick = 0; tick < 24; tick++) { scheduler.transcript(); await vi.advanceTimersByTimeAsync(500); }
    expect(options.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(options.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "two" }));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(options.send.mock.calls.map(call => call[0].id)).toEqual(["two", "three"]);
    // The held finding survives bypass, but must never narrate once the host
    // resolves the correction to a new revision.
    currentRevision = 2; correcting = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(options.send).toHaveBeenCalledTimes(2);
    scheduler.enqueue(finding("one", 2)); await vi.advanceTimersByTimeAsync(500);
    expect(options.send).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one", revision: 2 }));
    expect(options.send.mock.calls.some(call => call[0].id === "one" && call[0].revision === 1)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains bypassed evidence when a resolved correction leaves the original revision current", async () => {
    const { options, scheduler } = setup();
    let correcting = true;
    options.correcting = item => correcting && item.id === "one";
    scheduler.enqueue(finding()); scheduler.enqueue(finding("two"));
    await vi.advanceTimersByTimeAsync(500);
    expect(options.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "two" }));
    correcting = false;
    await vi.advanceTimersByTimeAsync(1_500);
    expect(options.send).toHaveBeenLastCalledWith(expect.objectContaining({ id: "one", revision: 1 }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a finding until the transport accepts it, without treating acceptance as audible playback", async () => {
    const { options, scheduler } = setup();
    options.send.mockReturnValueOnce(false).mockReturnValueOnce(true);
    scheduler.enqueue(finding()); await vi.advanceTimersByTimeAsync(1_000);
    expect(options.send).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });

  it("pairs each delayed finding with its own exact source packet after interleaved worker arrivals", async () => {
    const trace: { kind: string; text: string }[] = [];
    let correcting = true;
    const scheduler = new VoiceFindingScheduler({ enabled: () => true, valid: () => true,
      correcting: item => correcting && item.id === "one",
      sendReference: item => { trace.push({ kind: "reference", text: item.reference! }); return true; },
      send: item => { trace.push({ kind: "commentary", text: item.text }); return true; } });
    for (const id of ["one", "two"]) {
      const delivery = voiceFindingDelivery({ id, spaceId: "space", revision: 3, sequence: 2, subject: id, state: "completed",
        result: { reply: `${id} finding`, evidence: [{ id: "e1", kind: "note", entityId: `note-${id}`, title: `Source ${id}`,
          version: "exact-version", start: 0, end: 4, text: "Text", offsetUnit: "utf16" }] } });
      // Immediate context remains useful, but is not enough to attribute a
      // finding offered later after a different worker has supplied context.
      trace.push({ kind: "immediate", text: delivery.quiet });
      scheduler.enqueue({ ...finding(id, 3), sequence: 2, text: delivery.commentary, reference: delivery.quiet });
    }
    await vi.advanceTimersByTimeAsync(500);
    correcting = false; await vi.advanceTimersByTimeAsync(1_500);
    expect(trace.map(item => item.kind)).toEqual(["immediate", "immediate", "reference", "commentary", "reference", "commentary"]);
    expect(JSON.parse(trace[2].text)).toMatchObject({ id: "two", spaceId: "space", revision: 3, sequence: 2,
      sourceReferences: [{ evidenceId: "e1", entityId: "note-two", title: "Source two" }] });
    expect(trace[3].text).toBe("two finding");
    expect(JSON.parse(trace[4].text)).toMatchObject({ id: "one", spaceId: "space", revision: 3, sequence: 2,
      sourceReferences: [{ evidenceId: "e1", entityId: "note-one", title: "Source one" }] });
    expect(trace[5].text).toBe("one finding");
  });

  it("does not offer or pace commentary until its paired reference is accepted", async () => {
    const sendReference = vi.fn((_item: VoiceDelivery) => false);
    const send = vi.fn((_item: VoiceDelivery) => true);
    const scheduler = new VoiceFindingScheduler({ enabled: () => true, valid: () => true, correcting: () => false, sendReference, send });
    const item = { ...finding(), reference: "Exact source packet" };
    scheduler.enqueue(item); await vi.advanceTimersByTimeAsync(500);
    expect(sendReference).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(item));
    expect(send).not.toHaveBeenCalled();
    sendReference.mockReturnValue(true); await vi.advanceTimersByTimeAsync(500);
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(item));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed without a reference channel and repeats the pair after a commentary transport retry", async () => {
    const { options, scheduler } = setup();
    scheduler.enqueue({ ...finding(), reference: "Exact source packet" });
    await vi.advanceTimersByTimeAsync(500); expect(options.send).not.toHaveBeenCalled(); scheduler.clear();
    const trace: string[] = [];
    const next = new VoiceFindingScheduler({ ...options,
      sendReference: () => { trace.push("reference"); return true; },
      send: () => { trace.push("commentary"); return trace.length === 4; } });
    next.enqueue({ ...finding(), reference: "Exact source packet" }); await vi.advanceTimersByTimeAsync(1_000);
    expect(trace).toEqual(["reference", "commentary", "reference", "commentary"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains current findings across an internal audio handoff, discarding the old timer and speech timing", async () => {
    const { options, scheduler } = setup();
    scheduler.enqueue(finding()); await vi.advanceTimersByTimeAsync(500);
    scheduler.enqueue(finding("two")); scheduler.enqueue(finding("stale"));
    scheduler.transcript(); scheduler.audio({ ...silentVoiceActivity(), outputActive: true });
    await vi.advanceTimersByTimeAsync(250);
    scheduler.discardInvalid(item => item.id !== "stale");
    options.enabled = () => false; scheduler.handoff();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(250); expect(options.send).toHaveBeenCalledTimes(1);
    options.enabled = () => true; scheduler.wake(); await vi.advanceTimersByTimeAsync(500);
    // Old recipient's recent audio/transcript and offered timestamp cannot hold
    // the retained finding in the fresh recipient; its source is re-sent there.
    expect(options.send.mock.calls.map(call => call[0].id)).toEqual(["one", "two"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never sends while another conversation is focused and discards all pending speech across Stop/reconnect", async () => {
    const { options, scheduler } = setup();
    options.enabled = () => false; scheduler.enqueue(finding());
    await vi.advanceTimersByTimeAsync(15_000); expect(options.send).not.toHaveBeenCalled();
    options.enabled = () => true; scheduler.wake(); scheduler.clear();
    await vi.advanceTimersByTimeAsync(15_000); expect(options.send).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    scheduler.reset(); scheduler.enqueue(finding("fresh")); await vi.advanceTimersByTimeAsync(500);
    expect(options.send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "fresh" }));
  });
});
