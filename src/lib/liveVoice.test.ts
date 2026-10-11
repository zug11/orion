import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveVoiceConnection, voiceAppendChunks, voiceContextUsageRatio } from "./liveVoice";
import { voiceFindingDelivery } from "./voiceFindingDelivery";
class Channel {
  readyState = "open"; sent: string[] = []; onmessage?: (event: { data: string }) => void; onclose?: () => void;
  send(text: string) { this.sent.push(text); }
  close() { this.readyState = "closed"; this.onclose?.(); }
  emit(event: unknown) { this.onmessage?.({ data: JSON.stringify(event) }); }
}
class Peer {
  static latest: Peer; channel = new Channel(); iceGatheringState = "complete";
  localDescription = { sdp: "v=0\r\n" }; connectionState = "connected"; close = vi.fn();
  constructor() { Peer.latest = this; }
  ontrack?: (event: { streams: MediaStream[] }) => void;
  onconnectionstatechange?: () => void;
  createDataChannel(name: string) { expect(name).toBe("oai-events"); return this.channel; }
  addTrack = vi.fn(); async createOffer() { return { type: "offer", sdp: "v=0" }; }
  async setLocalDescription() {} async setRemoteDescription() {}
}
const track = Object.assign(new EventTarget(), { stop: vi.fn(), enabled: true });
const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
beforeEach(() => {
  vi.useFakeTimers(); track.enabled = true; track.stop.mockClear();
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("Audio", class { autoplay = false; muted = false; pause() {} play() { return Promise.resolve(); } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function options() { return { spaceId: "a", context: "Space a", onEvent: vi.fn(), onStatus: vi.fn(), connect: vi.fn().mockResolvedValue({ id: "session", sdp: "v=0" }) }; }

function localAudioFixture() {
  class Analyser {
    fftSize = 0; level = 0; disconnect = vi.fn();
    getFloatTimeDomainData(samples: Float32Array) { samples.fill(this.level); }
  }
  class Context {
    static latest: Context;
    state = "running"; analysers: Analyser[] = [];
    close = vi.fn().mockResolvedValue(undefined); resume = vi.fn().mockResolvedValue(undefined);
    constructor() { Context.latest = this; }
    createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
    createAnalyser() { const analyser = new Analyser(); this.analysers.push(analyser); return analyser; }
  }
  class Playback {
    static latest: Playback;
    autoplay = false; muted = false; paused = true; volume = 1;
    onplaying?: () => void; onwaiting?: () => void; onpause?: () => void; onended?: () => void;
    constructor() { Playback.latest = this; }
    play = vi.fn(async () => { this.paused = false; this.onplaying?.(); });
    pause() { this.paused = true; this.onpause?.(); }
  }
  const outputTrack = { enabled: true, muted: false, readyState: "live" };
  const output = { getTracks: () => [outputTrack], getAudioTracks: () => [outputTrack] } as unknown as MediaStream;
  vi.stubGlobal("AudioContext", Context); vi.stubGlobal("Audio", Playback);
  return { Context, Playback, output, outputTrack };
}
describe("live voice transport", () => {
  it("sends finding metadata only as quiet thinking and qualified prose only as commentary", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    const delivery = voiceFindingDelivery({ id: "worker-private", revision: 2, sequence: 5, subject: "Connection", state: "running",
      result: { reply: "It may be connected, but the evidence is inconclusive.", coverage: { availableNotes: 3, availableSources: 0, openedNotes: 1, openedSources: 0, searches: 1, limited: true } } });
    expect(voice.append("thinking", delivery.quiet, "delegation-a")).toBe(true);
    expect(voice.append("commentary", delivery.commentary, "delegation-a")).toBe(true);
    const events = Peer.latest.channel.sent.map(value => JSON.parse(value));
    expect(events.every(event => event.delegation_id === "delegation-a")).toBe(true);
    const quiet = events.filter(event => event.type === "session.thinking.append").map(event => event.content).join("");
    const commentary = events.filter(event => event.type === "session.commentary.append").map(event => event.content).join("");
    expect(JSON.parse(quiet)).toMatchObject({ id: "worker-private", revision: 2, sequence: 5, state: "running" });
    expect(commentary).toBe(delivery.commentary); expect(commentary).toContain("inconclusive");
    expect(commentary).not.toMatch(/worker-private|referenceOnly|revision|sequence|research is still running/);
    voice.dispose();
  });
  it("passes actual context-window snapshots unchanged, including a lower snapshot after rollover", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    for (const ratio of [0, 0.42, 0.91, 1, 0.08]) {
      Peer.latest.channel.emit({ type: "session.usage.updated", usage: { seconds: 12 }, context_window: { usage_ratio: ratio } });
      const event = config.onEvent.mock.lastCall?.[0];
      expect(event.context_window).toEqual({ usage_ratio: ratio });
      expect(voiceContextUsageRatio(event)).toBe(ratio);
    }
    expect(Peer.latest.channel.sent).toEqual([]); // A usage update is neither a prompt nor a request to reconnect.
    expect(config.connect).toHaveBeenCalledOnce(); voice.dispose();
  });
  it("ignores missing, malformed and out-of-range context ratios without inventing usage", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    for (const context_window of [undefined, null, 0.5, {}, { usage_ratio: "0.91" }, { usage_ratio: -0.1 }, { usage_ratio: 1.1 }]) {
      Peer.latest.channel.emit({ type: "session.usage.updated", usage: { seconds: 12 }, context_window });
      const event = config.onEvent.mock.lastCall?.[0];
      expect(event.context_window).toBeUndefined(); expect(voiceContextUsageRatio(event)).toBeUndefined();
    }
    for (const ratio of [NaN, Infinity, -Infinity]) expect(voiceContextUsageRatio({ type: "session.usage.updated", context_window: { usage_ratio: ratio } })).toBeUndefined();
    Peer.latest.channel.emit({ type: "session.thinking.appended", context_window: { usage_ratio: 0.99 } });
    expect(config.onEvent.mock.lastCall?.[0].context_window).toBeUndefined();
    expect(Peer.latest.channel.sent).toEqual([]); voice.dispose();
  });
  it("waits for session.started, never sends session.start, and closes with final usage", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    voice.append("thinking", "Wait"); expect(Peer.latest.channel.sent).toEqual([]);
    Peer.latest.channel.emit({ type: "session.started" }); voice.append("commentary", "Result", "d1");
    const event = JSON.parse(Peer.latest.channel.sent[0]); expect(event.type).toBe("session.commentary.append"); expect(event.delegation_id).toBe("d1");
    voice.silence(true); expect(track.enabled).toBe(true); // stopping speech does not stop listening/research
    voice.mute(true); expect(track.enabled).toBe(false);
    voice.close(); expect(Peer.latest.channel.sent.map(value => JSON.parse(value).type)).toContain("session.close");
    Peer.latest.channel.emit({ type: "session.closed", usage: { seconds: 23 } });
    expect(track.stop).toHaveBeenCalledOnce(); expect(config.onStatus).toHaveBeenLastCalledWith("idle");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("stops capture when an in-flight permission request resolves after cancellation", async () => {
    let grant!: (value: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const config = options(); const voice = new LiveVoiceConnection(config); const pending = voice.start(); voice.close(); grant(stream as unknown as MediaStream); await pending;
    expect(track.stop).toHaveBeenCalledOnce(); expect(config.connect).not.toHaveBeenCalled();
  });
  it("does not resume network negotiation when an offer resolves after Stop", async () => {
    let resolveOffer!: (value: { type: string; sdp: string }) => void;
    const offer = vi.spyOn(Peer.prototype, "createOffer").mockImplementationOnce(() => new Promise(resolve => { resolveOffer = resolve; }));
    const localDescription = vi.spyOn(Peer.prototype, "setLocalDescription");
    const config = options(); const voice = new LiveVoiceConnection(config); const pending = voice.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(offer).toHaveBeenCalledOnce();
    voice.close(); resolveOffer({ type: "offer", sdp: "v=0" }); await pending;
    expect(localDescription).not.toHaveBeenCalled();
    expect(config.connect).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    offer.mockRestore(); localDescription.mockRestore();
  });
  it.each(["close", "dispose"] as const)("ignores late playback failure after %s", async method => {
    let rejectPlayback!: (reason: Error) => void;
    vi.stubGlobal("Audio", class {
      autoplay = false; muted = false; pause() {}
      play() { return new Promise<void>((_, reject) => { rejectPlayback = reject; }); }
    });
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    Peer.latest.ontrack?.({ streams: [stream as unknown as MediaStream] });
    voice[method](); const statusCount = config.onStatus.mock.calls.length;
    rejectPlayback(new Error("Playback cancelled")); await Promise.resolve();
    expect(config.onStatus).toHaveBeenCalledTimes(statusCount);
    expect(track.stop).toHaveBeenCalledOnce();
    voice.dispose();
  });
  it("ends capture with an actionable retry when active voice playback fails", async () => {
    vi.stubGlobal("Audio", class {
      autoplay = false; muted = false; pause() {}
      play() { return Promise.reject(new Error("Playback blocked")); }
    });
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    Peer.latest.ontrack?.({ streams: [stream as unknown as MediaStream] }); await Promise.resolve();
    expect(config.onStatus).toHaveBeenLastCalledWith("disconnected", "Voice audio could not play. Start voice again to retry.");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(Peer.latest.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(voice.append("commentary", "No unheard result")).toBe(false);
  });
  it("cleans up failed connections and never automatically reconnects", async () => {
    const config = options(); config.connect.mockRejectedValue(new Error("Offline"));
    const voice = new LiveVoiceConnection(config); await voice.start();
    expect(track.stop).toHaveBeenCalled(); expect(config.onStatus).toHaveBeenLastCalledWith("disconnected", "Offline");
    await vi.advanceTimersByTimeAsync(60_000); expect(config.connect).toHaveBeenCalledOnce();
  });
  it("bounds appended Unicode data below the event token ceiling", () => {
    const value = "🧭漢字".repeat(900); const chunks = voiceAppendChunks(value);
    expect(chunks.join("")).toBe(value); for (const text of chunks) expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(480);
  });
  it("keeps ordinary spoken sentences intact instead of cutting at an arbitrary byte", () => {
    const sentence = "The evidence supports the first proposal, but the second still needs a source. ";
    const value = sentence.repeat(20), chunks = voiceAppendChunks(value);
    expect(chunks.join("")).toBe(value); expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("The evidence")).toBe(true); expect(chunk.endsWith("source. ")).toBe(true);
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(480);
    }
  });
  it("splits an oversized sentence at words and retains every space and punctuation mark", () => {
    const value = "independent investigations and their verified receipts ".repeat(40) + "finish together.";
    const chunks = voiceAppendChunks(value);
    expect(chunks.join("")).toBe(value);
    for (let index = 1; index < chunks.length; index++) {
      expect(/\s$/u.test(chunks[index - 1]) || /^\s/u.test(chunks[index])).toBe(true);
      expect(new TextEncoder().encode(chunks[index]).length).toBeLessThanOrEqual(480);
    }
  });
  it("keeps emoji graphemes intact and only splits an unbounded combining sequence by code point", () => {
    const emoji = "👩🏽‍💻", ordinary = emoji.repeat(200);
    const chunks = voiceAppendChunks(ordinary);
    expect(chunks.join("")).toBe(ordinary);
    chunks.forEach(chunk => expect(chunk.split(emoji).join("")).toBe(""));
    const pathological = "a" + "\u0301".repeat(900);
    const fallback = voiceAppendChunks(pathological);
    expect(fallback.join("")).toBe(pathological);
    fallback.forEach(chunk => expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(480));
  });
  it("preserves text and safe word boundaries when Intl.Segmenter is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
    Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
    try {
      const value = "A complete sentence stays together. ".repeat(20) + "singleverylongword".repeat(100) + " 👩🏽‍💻. 終わり。";
      const chunks = voiceAppendChunks(value);
      expect(chunks.join("")).toBe(value);
      expect(chunks[0].endsWith("together. ")).toBe(true);
      chunks.forEach(chunk => expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(480));
    } finally {
      if (descriptor) Object.defineProperty(Intl, "Segmenter", descriptor);
      else delete (Intl as typeof Intl & { Segmenter?: unknown }).Segmenter;
    }
  });
  it("sends the complete update or rejects an oversized one without silently dropping its ending", async () => {
    const voice = new LiveVoiceConnection(options()); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    const update = "Read-only evidence. ".repeat(700) + "The final caveat matters.";
    expect(update.length).toBeGreaterThan(12_000);
    expect(voice.append("thinking", update)).toBe(true);
    expect(Peer.latest.channel.sent.map(value => JSON.parse(value).content).join("")).toBe(update);
    const sent = Peer.latest.channel.sent.length;
    expect(voice.append("commentary", "x".repeat(24_001))).toBe(false);
    expect(Peer.latest.channel.sent).toHaveLength(sent);
    voice.dispose();
  });
  it("reports send failure without retrying or replaying a partially delivered update", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    const send = Peer.latest.channel.send.bind(Peer.latest.channel);
    vi.spyOn(Peer.latest.channel, "send").mockImplementationOnce(send).mockImplementationOnce(() => { throw new Error("Closed"); });
    expect(voice.append("commentary", "Complete finding. ".repeat(90), "job-a")).toBe(false);
    expect(config.onStatus).toHaveBeenLastCalledWith("disconnected", expect.stringContaining("Research is retained"));
    expect(Peer.latest.channel.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(config.connect).toHaveBeenCalledOnce();
    expect(voice.append("commentary", "Repeat")).toBe(false);
  });
  it("measures existing input and output tracks, holds brief pauses, and releases monitoring at Stop", async () => {
    class Analyser {
      fftSize = 0; level = 0; disconnect = vi.fn();
      getFloatTimeDomainData(samples: Float32Array) { samples.fill(this.level); }
    }
    const analysers: Analyser[] = [];
    const sources: { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = [];
    const close = vi.fn().mockResolvedValue(undefined), resume = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("AudioContext", class {
      state = "running"; close = close; resume = resume;
      createMediaStreamSource() { const source = { connect: vi.fn(), disconnect: vi.fn() }; sources.push(source); return source; }
      createAnalyser() { const analyser = new Analyser(); analysers.push(analyser); return analyser; }
    });
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.ontrack?.({ streams: [stream as unknown as MediaStream] });
    Peer.latest.channel.emit({ type: "session.started" });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce();
    expect(resume).toHaveBeenCalledOnce();
    expect(sources).toHaveLength(2);
    sources.forEach((source, index) => expect(source.connect).toHaveBeenCalledExactlyOnceWith(analysers[index]));
    analysers[0].level = 0.05;
    await vi.advanceTimersByTimeAsync(100);
    expect(config.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ inputActive: true, outputActive: false, measured: true, inputLevel: expect.any(Number), outputLevel: 0 }));
    analysers[0].level = 0; analysers[1].level = 0.03;
    await vi.advanceTimersByTimeAsync(200);
    expect(config.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ inputActive: true, outputActive: true, measured: true }));
    await vi.advanceTimersByTimeAsync(500);
    expect(config.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ inputActive: false, outputActive: true, measured: true }));
    const count = config.onActivity.mock.calls.length;
    Peer.latest.channel.emit({ type: "session.commentary.appended", start_ms: 20, end_ms: 40, client_event_id: "result" });
    expect(config.onActivity).toHaveBeenCalledTimes(count); // Context ACK is unrelated to playback.
    voice.close();
    expect(close).toHaveBeenCalledOnce();
    sources.forEach(source => expect(source.disconnect).toHaveBeenCalledOnce());
    expect(config.onActivity).toHaveBeenLastCalledWith(expect.objectContaining({ inputActive: false, outputActive: false, measured: false, inputLevel: 0, outputLevel: 0 }));
    await vi.advanceTimersByTimeAsync(8_000);
    expect(close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps voice usable if local activity measurement is unavailable", async () => {
    vi.stubGlobal("AudioContext", class { constructor() { throw new Error("Unavailable"); } });
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    expect(config.onStatus).toHaveBeenLastCalledWith("listening");
    expect(voice.append("thinking", "Still available")).toBe(true);
    voice.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("publishes changing bounded amplitudes while a speaking/listening boolean remains active", async () => {
    const { Context, output } = localAudioFixture();
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Context.latest.analysers[0].level = 0.025;
    await vi.advanceTimersByTimeAsync(100);
    const inputOnly = config.onActivity.mock.lastCall?.[0];
    expect(inputOnly).toMatchObject({ inputActive: true, inputMeasured: true, outputMeasured: false, measured: false, outputLevel: 0 });
    expect(inputOnly.inputLevel).toBeGreaterThan(0);
    Peer.latest.ontrack?.({ streams: [output] });
    Context.latest.analysers[1].level = 0.025;
    await vi.advanceTimersByTimeAsync(100);
    const soft = config.onActivity.mock.lastCall?.[0];
    Context.latest.analysers[0].level = 0.15; Context.latest.analysers[1].level = 0.18;
    await vi.advanceTimersByTimeAsync(100);
    const emphasis = config.onActivity.mock.lastCall?.[0];
    expect(soft.outputActive).toBe(true); expect(emphasis.outputActive).toBe(true);
    expect(emphasis.outputLevel).toBeGreaterThan(soft.outputLevel);
    expect(emphasis.inputLevel).toBeGreaterThan(soft.inputLevel);
    expect(emphasis.outputLevel).toBeLessThanOrEqual(1);
    voice.dispose();
  });
  it("keeps output at zero until playback starts even if remote PCM and output text have arrived", async () => {
    const { Context, Playback, output } = localAudioFixture();
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    let finish!: () => void;
    Playback.latest.play.mockImplementationOnce(() => new Promise(resolve => { finish = () => { Playback.latest.paused = false; resolve(); }; }));
    Peer.latest.ontrack?.({ streams: [output] });
    Context.latest.analysers[1].level = 0.15;
    Peer.latest.channel.emit({ type: "session.output_transcript.delta", delta: "An unheard answer" });
    Peer.latest.channel.emit({ type: "session.commentary.appended" });
    await vi.advanceTimersByTimeAsync(100);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ outputActive: false, outputLevel: 0, outputMeasured: true });
    finish(); await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0].outputLevel).toBeGreaterThan(0);
    voice.dispose();
  });
  it("mutes input immediately without muting playback or stopping the call, then resumes from fresh input", async () => {
    const { Context, output, outputTrack } = localAudioFixture();
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" }); Peer.latest.ontrack?.({ streams: [output] });
    Context.latest.analysers.forEach(analyser => { analyser.level = 0.12; });
    await vi.advanceTimersByTimeAsync(100); voice.mute(true);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputActive: false, inputLevel: 0, inputMuted: true, outputActive: true });
    expect(config.onActivity.mock.lastCall?.[0].outputLevel).toBeGreaterThan(0);
    expect(track.enabled).toBe(false); expect(track.stop).not.toHaveBeenCalled(); expect(outputTrack.enabled).toBe(true);
    expect(voice.append("thinking", "Background work continues")).toBe(true);
    Context.latest.analysers[0].level = 0;
    voice.mute(false);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputActive: false, inputLevel: 0, inputMuted: false, outputActive: true });
    expect(track.enabled).toBe(true); voice.dispose();
  });
  it("retains a mute chosen before microphone permission and sends it when the session starts", async () => {
    localAudioFixture();
    let grant!: (value: MediaStream) => void;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockImplementation(() => new Promise(resolve => { grant = resolve; }));
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); const pending = voice.start();
    voice.mute(true); grant(stream as unknown as MediaStream); await pending;
    expect(track.enabled).toBe(false);
    Peer.latest.channel.emit({ type: "session.started" });
    expect(Peer.latest.channel.sent.map(value => JSON.parse(value).type)).toEqual(["session.input_audio.mute"]);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputMuted: true, inputLevel: 0 });
    voice.dispose();
  });
  it("clears output on playback stalls, silence, or ended tracks despite energy in the analyser", async () => {
    const { Context, Playback, output, outputTrack } = localAudioFixture();
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.ontrack?.({ streams: [output] }); Context.latest.analysers[1].level = 0.14;
    await vi.advanceTimersByTimeAsync(100);
    expect(config.onActivity.mock.lastCall?.[0].outputLevel).toBeGreaterThan(0);
    Playback.latest.onwaiting?.();
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ outputActive: false, outputLevel: 0 });
    Playback.latest.onplaying?.(); await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0].outputLevel).toBeGreaterThan(0);
    voice.silence(true);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ outputActive: false, outputLevel: 0 });
    voice.silence(false); await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0].outputLevel).toBeGreaterThan(0);
    outputTrack.readyState = "ended"; await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ outputActive: false, outputLevel: 0, outputMeasured: false });
    voice.dispose();
  });
  it("clears activity when measurement suspends or the transport disconnects and releases its sampling loop", async () => {
    const { Context, output } = localAudioFixture();
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" }); Peer.latest.ontrack?.({ streams: [output] });
    Context.latest.analysers.forEach(analyser => { analyser.level = 0.12; });
    await vi.advanceTimersByTimeAsync(100);
    Context.latest.state = "suspended"; await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputLevel: 0, outputLevel: 0, measured: false, inputActive: false, outputActive: false });
    Context.latest.state = "running"; Context.latest.analysers.forEach(analyser => { analyser.level = 0; });
    await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputLevel: 0, outputLevel: 0, measured: true, inputActive: false, outputActive: false });
    Peer.latest.connectionState = "disconnected"; Peer.latest.onconnectionstatechange?.();
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputLevel: 0, outputLevel: 0, measured: false });
    expect(Context.latest.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    const count = config.onActivity.mock.calls.length; await vi.advanceTimersByTimeAsync(1000);
    expect(config.onActivity).toHaveBeenCalledTimes(count);
  });
  it.each([false, true])("ends a call truthfully when microphone capture ends externally, including while muted=%s", async muted => {
    const { Context, Playback, output } = localAudioFixture();
    const inputTrack = Object.assign(new EventTarget(), { enabled: true, muted: false, readyState: "live", stop: vi.fn() });
    const removeListener = vi.spyOn(inputTrack, "removeEventListener");
    const input = { getTracks: () => [inputTrack], getAudioTracks: () => [inputTrack] } as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(input);
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" }); Peer.latest.ontrack?.({ streams: [output] });
    Context.latest.analysers.forEach(analyser => { analyser.level = .12; });
    await vi.advanceTimersByTimeAsync(100);
    voice.mute(muted);
    inputTrack.readyState = "ended"; inputTrack.dispatchEvent(new Event("ended"));
    expect(config.onStatus).toHaveBeenLastCalledWith("disconnected", expect.stringContaining("Microphone capture ended"));
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputLevel: 0, outputLevel: 0, inputMeasured: false, outputMeasured: false });
    expect(Playback.latest.paused).toBe(true); expect(inputTrack.stop).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("ended", expect.any(Function));
    expect(Context.latest.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(voice.append("thinking", "Old call must stay closed")).toBe(false);
    const calls = config.onStatus.mock.calls.length;
    inputTrack.dispatchEvent(new Event("ended")); await vi.advanceTimersByTimeAsync(1000);
    expect(config.onStatus).toHaveBeenCalledTimes(calls); expect(config.connect).toHaveBeenCalledOnce();
  });
  it("keeps temporary device mute recoverable while playback continues, then samples fresh microphone energy", async () => {
    const { Context, output } = localAudioFixture();
    const inputTrack = Object.assign(new EventTarget(), { enabled: true, muted: false, readyState: "live", stop: vi.fn() });
    const input = { getTracks: () => [inputTrack], getAudioTracks: () => [inputTrack] } as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(input);
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" }); Peer.latest.ontrack?.({ streams: [output] });
    Context.latest.analysers.forEach(analyser => { analyser.level = .12; });
    await vi.advanceTimersByTimeAsync(100);
    inputTrack.muted = true; inputTrack.dispatchEvent(new Event("mute"));
    await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputLevel: 0, inputActive: false, outputActive: true });
    expect(config.onStatus).toHaveBeenLastCalledWith("listening"); expect(inputTrack.stop).not.toHaveBeenCalled();
    Context.latest.analysers[0].level = 0;
    inputTrack.muted = false; inputTrack.dispatchEvent(new Event("unmute"));
    await vi.advanceTimersByTimeAsync(40);
    expect(config.onActivity.mock.lastCall?.[0]).toMatchObject({ inputLevel: 0, inputActive: false, outputActive: true });
    Context.latest.analysers[0].level = .12; await vi.advanceTimersByTimeAsync(100);
    expect(config.onActivity.mock.lastCall?.[0].inputLevel).toBeGreaterThan(0);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce(); voice.dispose();
  });
  it("rejects a permission result whose audio capture has already ended before network negotiation", async () => {
    localAudioFixture();
    const inputTrack = Object.assign(new EventTarget(), { enabled: true, readyState: "ended", stop: vi.fn() });
    const input = { getTracks: () => [inputTrack], getAudioTracks: () => [inputTrack] } as unknown as MediaStream;
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(input);
    const config = { ...options(), onActivity: vi.fn() };
    const voice = new LiveVoiceConnection(config); await voice.start();
    expect(config.onStatus).toHaveBeenLastCalledWith("disconnected", expect.stringContaining("Microphone capture ended"));
    expect(config.connect).not.toHaveBeenCalled(); expect(inputTrack.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("closes without a new context injection and ignores cancellation errors while ending", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" });
    voice.close(); voice.close();
    expect(track.stop).toHaveBeenCalledOnce();
    voice.append("commentary", "A result that arrived during closing");
    const events = Peer.latest.channel.sent.map(value => JSON.parse(value).type);
    expect(events).not.toContain("session.instructions.append");
    expect(events).not.toContain("session.commentary.append");
    expect(events.filter(type => type === "session.close")).toHaveLength(1);
    Peer.latest.channel.emit({ type: "error", error: { message: "The session closed before the estimated context injection completed." } });
    expect(config.onStatus).toHaveBeenLastCalledWith("closing");
    Peer.latest.channel.emit({ type: "session.closed", usage: { seconds: 20 } });
    expect(config.onStatus).toHaveBeenLastCalledWith("idle");
  });
  it("releases the connection but reports unconfirmed finalization when close times out", async () => {
    const config = options(); const voice = new LiveVoiceConnection(config); await voice.start();
    Peer.latest.channel.emit({ type: "session.started" }); voice.close();
    expect(track.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(config.onStatus).toHaveBeenLastCalledWith("idle", expect.stringContaining("service did not confirm"));
    expect(Peer.latest.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    expect(config.onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session.closed" }));
  });
});
