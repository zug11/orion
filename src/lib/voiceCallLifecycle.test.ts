import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceCallLifecycle } from "./voiceCallLifecycle";
import type { VoiceTransportOptions } from "./liveVoice";
import { silentVoiceActivity } from "./voicePresence";
afterEach(() => vi.useRealTimers());

function setup(start?: () => Promise<void>) {
  const events: string[] = [];
  const transports: Array<{ options: VoiceTransportOptions; start: ReturnType<typeof vi.fn<() => Promise<void>>>; close: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn>; mute: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> }> = [];
  const call = new VoiceCallLifecycle(options => {
    events.push("create");
    const transport = { options, start: vi.fn(start ?? (async () => { options.onStatus("connecting"); })),
      close: vi.fn(() => options.onStatus("closing")), dispose: vi.fn(() => { events.push("dispose"); }), mute: vi.fn(), append: vi.fn(() => true) };
    transports.push(transport); return transport;
  });
  const options = { spaceId: "space", context: "Captured context", onEvent: vi.fn(), onActivity: vi.fn(), onStatus: vi.fn() };
  return { call, transports, options, events };
}

describe("single-recipient voice call lifecycle", () => {
  it("offers one neutral opening after connection and a short pause, never on repeated status events", async () => {
    vi.useFakeTimers();
    const { call, transports, options } = setup(); call.open(options, true);
    const transport = transports[0];
    await vi.advanceTimersByTimeAsync(5_000); expect(transport.append).not.toHaveBeenCalled();
    transport.options.onStatus("listening");
    await vi.advanceTimersByTimeAsync(1_999); expect(transport.append).not.toHaveBeenCalled();
    transport.options.onStatus("listening");
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.append).toHaveBeenCalledExactlyOnceWith("instructions", expect.stringContaining("where would you like to start?"), null);
    expect(transport.mute).toHaveBeenCalledExactlyOnceWith(false);
    transport.options.onStatus("listening"); await vi.advanceTimersByTimeAsync(30_000);
    expect(transport.append).toHaveBeenCalledOnce(); call.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["user", "assistant", "inputAudio", "outputAudio", "delegation", "finding", "mute", "stop", "disconnect", "handoff"])("abandons the pending welcome on %s without replaying it later", async cause => {
    vi.useFakeTimers();
    const { call, transports, options } = setup(); call.open(options, true);
    const transport = transports[0]; transport.options.onStatus("listening");
    await vi.advanceTimersByTimeAsync(1_000);
    if (cause === "user" || cause === "assistant") transport.options.onEvent({ type: `session.${cause === "user" ? "input" : "output"}_transcript.delta`, delta: "Hello" });
    if (cause === "inputAudio" || cause === "outputAudio") transport.options.onActivity?.({ ...silentVoiceActivity(), inputActive: cause === "inputAudio", outputActive: cause === "outputAudio" });
    if (cause === "delegation") transport.options.onEvent({ type: "session.delegation.created", delegation: { id: "work" } });
    if (cause === "finding") call.append("commentary", "The requested finding.");
    if (cause === "mute") { call.mute(true); call.mute(false); }
    if (cause === "stop") call.stop();
    if (cause === "disconnect") transport.options.onStatus("disconnected");
    if (cause === "handoff") { call.pause(); call.open(options); transports[1].options.onStatus("listening"); }
    await vi.advanceTimersByTimeAsync(30_000);
    for (const recipient of transports) expect(recipient.append.mock.calls.filter(call => call[0] === "instructions")).toEqual([]);
    call.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps a resumed or initially muted call quiet even before any transcript arrives", async () => {
    vi.useFakeTimers();
    const { call, transports, options } = setup(); call.open(options);
    transports[0].options.onStatus("listening"); await vi.advanceTimersByTimeAsync(5_000);
    expect(transports[0].append).not.toHaveBeenCalled();
    call.pause(); call.mute(true); call.open(options, true);
    transports[1].options.onStatus("listening"); call.mute(false);
    await vi.advanceTimersByTimeAsync(5_000); expect(transports[1].append).not.toHaveBeenCalled(); call.dispose();
  });
  it("waits out arriving speech before an automatic handback even with a silent output meter", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const { call, transports, options } = setup(); call.open(options);
    const transport = transports[0], handback = vi.fn();
    transport.options.onEvent({ type: "session.output_transcript.delta", delta: "A sentence" });
    call.handoffWhenQuiet(handback);
    for (let i = 0; i < 40; i++) {
      transport.options.onEvent({ type: "session.output_transcript.delta", delta: " still speaking" });
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(handback).not.toHaveBeenCalled(); expect(transport.dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000); expect(handback).not.toHaveBeenCalled();
    transport.options.onEvent({ type: "session.output_transcript.delta", delta: " and now finished." });
    await vi.advanceTimersByTimeAsync(3_000); expect(handback).toHaveBeenCalledOnce();
    call.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("pauses the departing recipient immediately and cancels any deferred handback on an explicit switch", async () => {
    vi.useFakeTimers();
    const { call, transports, options } = setup(); call.open(options);
    transports[0].options.onActivity?.({ ...silentVoiceActivity(), outputActive: true });
    const handback = vi.fn(); call.handoffWhenQuiet(handback);
    call.pause();
    expect(transports[0].close).toHaveBeenCalledOnce(); expect(transports[0].dispose).toHaveBeenCalledOnce();
    expect(call.acceptsInput).toBe(false); expect(call.canStart).toBe(true);
    call.open(options); options.onStatus.mockClear();
    transports[0].options.onStatus("disconnected"); await vi.advanceTimersByTimeAsync(30_000);
    expect(options.onStatus).not.toHaveBeenCalled(); expect(handback).not.toHaveBeenCalled();
    call.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it("opens only one connection and disposes the old recipient before creating a new one", () => {
    const { call, transports, options, events } = setup();
    expect(call.open(options)).toBe(true); expect(call.open(options)).toBe(false);
    expect(transports).toHaveLength(1); expect(call.acceptsInput).toBe(true);
    call.dispose(); call.open(options);
    expect(events).toEqual(["create", "dispose", "create"]);
    expect(transports[0].dispose).toHaveBeenCalledOnce();
  });

  it("fences all stale events, activity, status and delegation IDs across reconnect", () => {
    const { call, transports, options } = setup();
    call.open(options); const old = transports[0];
    old.options.onStatus("listening"); call.rememberDelegation("old");
    expect(call.delegation("old")).toBe("old");
    call.dispose(); call.open(options); options.onStatus.mockClear();
    old.options.onEvent({ type: "session.input_transcript.delta", delta: "Old speech" });
    old.options.onActivity?.({ ...silentVoiceActivity(), outputActive: true, outputLevel: 1 });
    old.options.onStatus("disconnected", "Old error");
    expect(options.onEvent).not.toHaveBeenCalled(); expect(options.onActivity).not.toHaveBeenCalled(); expect(options.onStatus).not.toHaveBeenCalled();
    expect(call.status).toBe("connecting"); expect(call.delegation("old")).toBeNull();
    transports[1].options.onStatus("listening"); call.rememberDelegation("fresh");
    expect(call.delegation("fresh")).toBe("fresh");
  });

  it("stops input immediately while allowing the current close handshake, ignoring late connecting/listening events", () => {
    const { call, transports, options } = setup();
    call.open(options); call.stop(); options.onStatus.mockClear();
    const transport = transports[0];
    expect(call.acceptsInput).toBe(false); expect(call.status).toBe("closing");
    expect(call.append("commentary", "Late finding")).toBe(false); expect(call.open(options)).toBe(false);
    transport.options.onStatus("listening"); transport.options.onEvent({ type: "session.input_transcript.delta", delta: "Too late" });
    transport.options.onActivity?.({ ...silentVoiceActivity(), inputActive: true });
    expect(options.onStatus).not.toHaveBeenCalled(); expect(options.onEvent).not.toHaveBeenCalled(); expect(options.onActivity).not.toHaveBeenCalled();
    transport.options.onStatus("idle"); expect(call.canStart).toBe(true); expect(options.onStatus).toHaveBeenCalledWith("idle", undefined);
  });

  it("preserves mute across recipient changes while continuing playback activity and context delivery", () => {
    const { call, transports, options } = setup();
    call.mute(true); call.open(options);
    expect(transports[0].mute).toHaveBeenCalledWith(true);
    const playing = { ...silentVoiceActivity(), inputMuted: true, outputActive: true, outputLevel: 0.4 };
    transports[0].options.onActivity?.(playing); expect(options.onActivity).toHaveBeenCalledWith(playing);
    expect(call.append("thinking", "Quiet context")).toBe(true);
    call.dispose(); call.open(options); expect(transports[1].mute).toHaveBeenCalledWith(true);
    call.mute(false); expect(call.isMuted).toBe(false); expect(transports[1].mute).toHaveBeenLastCalledWith(false);
  });

  it("bounds current-call delegation tracking without accepting IDs after Stop", () => {
    const { call, options } = setup(); call.open(options);
    for (let id = 0; id <= 1_000; id++) call.rememberDelegation(String(id));
    expect(call.delegation("0")).toBeNull(); expect(call.delegation("1000")).toBe("1000");
    call.stop(); call.rememberDelegation("after-stop"); expect(call.delegation("after-stop")).toBeNull();
  });

  it("disposes a rejected start and makes an explicit reconnect available", async () => {
    const { call, transports, options } = setup(async () => { throw new Error("Unavailable transport"); });
    call.open(options); await Promise.resolve();
    expect(transports[0].dispose).toHaveBeenCalledOnce();
    expect(call.canStart).toBe(true); expect(call.acceptsInput).toBe(false);
    expect(options.onStatus).toHaveBeenCalledWith("disconnected", "Unavailable transport");
  });
});
