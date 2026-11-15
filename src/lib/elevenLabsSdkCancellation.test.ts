// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { Conversation } from "@elevenlabs/client";
// Exercise the installed SDK implementation, including Orion's pinned patch.
// Import its web strategy explicitly because Node resolves the package's default export.
import "../../node_modules/@elevenlabs/client/dist/platform/web/VoiceSessionSetup.js";
import { MediaDeviceInput } from "../../node_modules/@elevenlabs/client/dist/platform/web/input.js";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function microphone() {
  const track = { stop: vi.fn(), enabled: true };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  return { track, stream };
}

class BrowserSocket extends EventTarget {
  static instances: BrowserSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = BrowserSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code: 1000 })));
  });
  constructor(readonly url: string, readonly protocols?: string[]) {
    super(); BrowserSocket.instances.push(this);
  }
  open() { this.readyState = BrowserSocket.OPEN; this.dispatchEvent(new Event("open")); }
  metadata() {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: {
        conversation_id: "test-conversation", agent_output_audio_format: "pcm_16000", user_input_audio_format: "pcm_16000",
      },
    }) }));
  }
  audio(eventId: number, bytes: number[]) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "audio", audio_event: { event_id: eventId, audio_base_64: btoa(String.fromCharCode(...bytes)) },
    }) }));
  }
  interrupt(eventId: number) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "interruption", interruption_event: { event_id: eventId },
    }) }));
  }
}

class BrowserAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  frequencyBinCount = 32;
  gain = { value: 1, setTargetAtTime: vi.fn(), cancelScheduledValues: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
  getByteFrequencyData = vi.fn();
}

class BrowserAudioContext {
  static instances: BrowserAudioContext[] = [];
  static loadModule: (url: string) => Promise<void> = async () => undefined;
  static forcedSampleRate: number | undefined;
  state = "running";
  currentTime = 0;
  sampleRate: number;
  audioWorklet = { addModule: vi.fn((url: string) => BrowserAudioContext.loadModule(url)) };
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => { this.state = "closed"; });
  createAnalyser = vi.fn(() => new BrowserAudioNode());
  createGain = vi.fn(() => new BrowserAudioNode());
  createMediaStreamSource = vi.fn(() => new BrowserAudioNode());
  createMediaStreamDestination = vi.fn(() => ({ stream: { getTracks: () => [] } }));
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = BrowserAudioContext.forcedSampleRate ?? options?.sampleRate ?? 16_000; BrowserAudioContext.instances.push(this);
  }
}

class BrowserWorklet extends BrowserAudioNode {
  static instances: BrowserWorklet[] = [];
  port = Object.assign(new EventTarget(), { postMessage: vi.fn(), start: vi.fn(), close: vi.fn() });
  constructor(_context: unknown, readonly processor: string) {
    super(); BrowserWorklet.instances.push(this);
  }
}

const originalMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
const originalPermissions = Object.getOwnPropertyDescriptor(navigator, "permissions");
const getUserMedia = vi.fn<() => Promise<MediaStream>>();
const permissionQuery = vi.fn<() => Promise<EventTarget>>();
const controllers: AbortController[] = [];

function options(signal: AbortSignal) {
  return {
    signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=test-only",
    connectionType: "websocket" as const, useWakeLock: false,
    connectionDelay: { default: 0, android: 0, ios: 0 }, signal,
    workletPaths: { rawAudioProcessor: "/elevenlabs/rawAudioProcessor.js", audioConcatProcessor: "/elevenlabs/audioConcatProcessor.js" },
  };
}

function controller() {
  const value = new AbortController(); controllers.push(value); return value;
}

function outcome<T>(promise: Promise<T>) {
  // Attach rejection handling immediately: abort must not create an unhandled rejection.
  return promise.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
}

async function socketReady() {
  await vi.waitFor(() => expect(BrowserSocket.instances).toHaveLength(1));
  return BrowserSocket.instances[0];
}

beforeEach(() => {
  BrowserSocket.instances = []; BrowserAudioContext.instances = []; BrowserWorklet.instances = [];
  BrowserAudioContext.loadModule = async () => undefined;
  BrowserAudioContext.forcedSampleRate = undefined;
  getUserMedia.mockReset(); permissionQuery.mockReset().mockResolvedValue(new EventTarget());
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia, getSupportedConstraints: () => ({ sampleRate: true }) } });
  Object.defineProperty(navigator, "permissions", { configurable: true, value: { query: permissionQuery } });
  vi.stubGlobal("WebSocket", BrowserSocket);
  vi.stubGlobal("AudioContext", BrowserAudioContext);
  vi.stubGlobal("AudioWorkletNode", BrowserWorklet);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
});

afterEach(() => {
  controllers.splice(0).forEach(value => value.abort());
  BrowserSocket.instances.forEach(socket => socket.close());
  BrowserAudioContext.instances.forEach(context => { void context.close(); });
  document.querySelectorAll("audio").forEach(audio => audio.remove());
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  if (originalMediaDevices) Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  else Reflect.deleteProperty(navigator, "mediaDevices");
  if (originalPermissions) Object.defineProperty(navigator, "permissions", originalPermissions);
  else Reflect.deleteProperty(navigator, "permissions");
});

describe("installed ElevenLabs SDK cancellation", () => {
  it("does not request capture or a socket for an already aborted start", async () => {
    const abort = controller(); abort.abort();
    const result = await outcome(Conversation.startSession(options(abort.signal)));
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(BrowserSocket.instances).toHaveLength(0);
  });

  it("stops a preliminary microphone while the socket handshake is still pending", async () => {
    const mic = microphone(); getUserMedia.mockResolvedValue(mic.stream);
    const abort = controller();
    const pending = outcome(Conversation.startSession(options(abort.signal)));
    const socket = await socketReady(); socket.open();
    expect(mic.track.stop).not.toHaveBeenCalled();
    abort.abort();
    const result = await pending;
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(mic.track.stop).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
    expect(BrowserAudioContext.instances).toHaveLength(0);
    // A queued metadata packet cannot restart setup after the user has stopped.
    socket.metadata(); await Promise.resolve();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(BrowserAudioContext.instances).toHaveLength(0);
  });

  it("rejects while a permission prompt is open and stops any stream returned after cancellation", async () => {
    const permission = deferred<MediaStream>(); getUserMedia.mockReturnValue(permission.promise);
    const abort = controller();
    const pending = outcome(Conversation.startSession(options(abort.signal)));
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledOnce());
    abort.abort();
    expect((await pending).error).toMatchObject({ name: "AbortError" });
    const lateMic = microphone(); permission.resolve(lateMic.stream);
    await vi.waitFor(() => expect(lateMic.track.stop).toHaveBeenCalled());
    expect(BrowserSocket.instances).toHaveLength(0);
    expect(BrowserAudioContext.instances).toHaveLength(0);
  });

  it("stops preliminary capture and closes audio setup when the real input stream arrives after cancellation", async () => {
    const preliminary = microphone(), lateMic = microphone(), permission = deferred<MediaStream>();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockReturnValueOnce(permission.promise);
    const abort = controller();
    const pending = outcome(Conversation.startSession(options(abort.signal)));
    const socket = await socketReady(); socket.open(); socket.metadata();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    abort.abort();
    expect((await pending).error).toMatchObject({ name: "AbortError" });
    expect(preliminary.track.stop).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
    expect(BrowserAudioContext.instances.length).toBeGreaterThan(0);
    expect(BrowserAudioContext.instances.every(context => context.state === "closed")).toBe(true);
    permission.resolve(lateMic.stream);
    await vi.waitFor(() => expect(lateMic.track.stop).toHaveBeenCalled());
    expect(document.querySelector("audio")).toBeNull();
    expect(permissionQuery).not.toHaveBeenCalled();
  });

  it("closes acquired input while a permission-status query is pending", async () => {
    const mic = microphone(), permission = deferred<EventTarget>();
    getUserMedia.mockResolvedValue(mic.stream); permissionQuery.mockReturnValue(permission.promise);
    const abort = controller();
    const inputOptions = { sampleRate: 16_000, format: "pcm" as const, signal: abort.signal, workletPaths: options(abort.signal).workletPaths };
    const pending = outcome(MediaDeviceInput.create(inputOptions));
    await vi.waitFor(() => expect(permissionQuery).toHaveBeenCalledOnce());
    abort.abort();
    expect((await pending).error).toMatchObject({ name: "AbortError" });
    expect(mic.track.stop).toHaveBeenCalled();
    expect(BrowserAudioContext.instances[0].state).toBe("closed");
    const latePermission = new EventTarget(), listen = vi.spyOn(latePermission, "addEventListener");
    permission.resolve(latePermission); await Promise.resolve();
    expect(listen).not.toHaveBeenCalled();
  });

  it("does not acquire input after a worklet finishes loading for an aborted setup", async () => {
    const module = deferred<void>(); BrowserAudioContext.loadModule = () => module.promise;
    const abort = controller();
    const inputOptions = { sampleRate: 16_000, format: "pcm" as const, signal: abort.signal, workletPaths: options(abort.signal).workletPaths };
    const pending = outcome(MediaDeviceInput.create(inputOptions));
    await vi.waitFor(() => expect(BrowserAudioContext.instances).toHaveLength(1));
    abort.abort();
    expect((await pending).error).toMatchObject({ name: "AbortError" });
    expect(BrowserAudioContext.instances[0].state).toBe("closed");
    module.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("loads the local resampler when the device ignores the requested input sample rate", async () => {
    BrowserAudioContext.forcedSampleRate = 48_000;
    const mic = microphone(); getUserMedia.mockResolvedValue(mic.stream);
    const abort = controller();
    const inputOptions = {
      sampleRate: 16_000, format: "pcm" as const, signal: abort.signal,
      workletPaths: options(abort.signal).workletPaths,
      libsampleratePath: "/elevenlabs/libsamplerate.worklet.js",
    };
    const input = await MediaDeviceInput.create(inputOptions);
    const context = BrowserAudioContext.instances[0];
    expect(context.sampleRate).toBe(48_000);
    expect(context.audioWorklet.addModule.mock.calls.map(([url]) => url)).toEqual([
      "/elevenlabs/libsamplerate.worklet.js", "/elevenlabs/rawAudioProcessor.js",
    ]);
    expect(mic.track.stop).not.toHaveBeenCalled();
    await input.close();
    expect(mic.track.stop).toHaveBeenCalled();
    expect(context.state).toBe("closed");
  });

  it("does not leave either microphone running while a sibling output worklet is pending", async () => {
    const preliminary = microphone(), liveMic = microphone(), outputModule = deferred<void>();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockResolvedValueOnce(liveMic.stream);
    BrowserAudioContext.loadModule = url => url.includes("audioConcatProcessor") ? outputModule.promise : Promise.resolve();
    const abort = controller();
    const pending = outcome(Conversation.startSession(options(abort.signal)));
    const socket = await socketReady(); socket.open(); socket.metadata();
    await vi.waitFor(() => expect(permissionQuery).toHaveBeenCalledOnce());
    abort.abort();
    expect((await pending).error).toMatchObject({ name: "AbortError" });
    expect(preliminary.track.stop).toHaveBeenCalled();
    expect(liveMic.track.stop).toHaveBeenCalled();
    outputModule.resolve();
    await vi.waitFor(() => expect(BrowserAudioContext.instances.every(context => context.state === "closed")).toBe(true));
    expect(document.querySelector("audio")).toBeNull();
  });

  it("permanently drops pre-human audio and plays only a new response after the host opens its gate", async () => {
    const preliminary = microphone(), liveMic = microphone(), permission = deferred<MediaStream>();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockReturnValueOnce(permission.promise);
    const abort = controller(); let canPlay = false;
    const pending = outcome(Conversation.startSession({ ...options(abort.signal), orionCanPlayAudio: () => canPlay }));
    const socket = await socketReady(); socket.open(); socket.metadata();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    // This frame reaches the SDK before its output attachment is installed.
    socket.audio(1, [1, 0]);
    permission.resolve(liveMic.stream);
    const result = await pending;
    expect(result.error).toBeUndefined();
    const output = BrowserWorklet.instances.find(worklet => worklet.processor.startsWith("audioConcatProcessor@"))!;
    const buffers = () => output.port.postMessage.mock.calls.filter(([message]) => message.type === "buffer");
    expect(buffers()).toHaveLength(0);
    socket.audio(2, [2, 0]);
    expect(buffers()).toHaveLength(0);
    canPlay = true; await Promise.resolve();
    expect(buffers()).toHaveLength(0);
    socket.audio(3, [3, 0]);
    expect(buffers()).toHaveLength(1);
    expect([...new Uint8Array(buffers()[0][0].buffer)]).toEqual([3, 0]);
    await result.value!.endSession();
  });

  it("drops capture before connection and while muted without replaying it when input opens", async () => {
    const preliminary = microphone(), liveMic = microphone(), permission = deferred<EventTarget>();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockResolvedValueOnce(liveMic.stream);
    permissionQuery.mockReturnValue(permission.promise);
    const abort = controller(); let connected = false, muted = true, ended = false;
    const pending = outcome(Conversation.startSession({
      ...options(abort.signal), orionCanSendAudio: () => connected && !muted && !ended,
      onConnect: () => { connected = true; },
    }));
    const socket = await socketReady(); socket.open(); socket.metadata();
    await vi.waitFor(() => expect(permissionQuery).toHaveBeenCalledOnce());
    const input = BrowserWorklet.instances.find(worklet => worklet.processor.startsWith("rawAudioProcessor@"))!;
    const emit = (value: number) => input.port.dispatchEvent(new MessageEvent("message", { data: [new Int16Array([value]), 1] }));
    const chunks = () => socket.send.mock.calls.map(([message]) => JSON.parse(message)).filter(message => "user_audio_chunk" in message);
    const addListener = input.port.addEventListener.bind(input.port);
    vi.spyOn(input.port, "addEventListener").mockImplementation((type, listener, listenerOptions) => {
      addListener(type, listener, listenerOptions);
      if (type === "message") {
        // A browser worklet may deliver a frame as soon as capture is attached,
        // before startSession has reached its onConnect callback.
        expect(connected).toBe(false);
        emit(1);
      }
    });
    permission.resolve(new EventTarget());
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(connected).toBe(true);
    expect(chunks()).toHaveLength(0);
    emit(2); expect(chunks()).toHaveLength(0);
    muted = false; await Promise.resolve();
    expect(chunks()).toHaveLength(0);
    emit(3);
    expect(chunks()).toEqual([{ user_audio_chunk: btoa(String.fromCharCode(3, 0)) }]);
    muted = true; emit(4); expect(chunks()).toHaveLength(1);
    ended = true; muted = false; emit(5); expect(chunks()).toHaveLength(1);
    await result.value!.endSession();
    emit(6); expect(chunks()).toHaveLength(1);
  });

  it("stops output immediately, rejects old audio, and preserves the next reply after duplicate interruptions", async () => {
    const preliminary = microphone(), liveMic = microphone();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockResolvedValueOnce(liveMic.stream);
    const onInterruption = vi.fn();
    const pending = outcome(Conversation.startSession({ ...options(controller().signal), onInterruption }));
    const socket = await socketReady(); socket.open(); socket.metadata();
    const result = await pending;
    expect(result.error).toBeUndefined();
    const output = BrowserWorklet.instances.find(worklet => worklet.processor.startsWith("audioConcatProcessor@"))!;
    const gain = BrowserAudioContext.instances.flatMap(context => context.createGain.mock.results.map(result => result.value))[0];
    const buffers = () => output.port.postMessage.mock.calls.filter(([message]) => message.type === "buffer");
    socket.audio(1, [1, 0]);
    expect(buffers()).toHaveLength(1);
    socket.interrupt(5);
    expect(gain.gain.value).toBe(0);
    expect(gain.gain.exponentialRampToValueAtTime).not.toHaveBeenCalled();
    expect(output.port.postMessage).toHaveBeenLastCalledWith({ type: "interrupt" });
    socket.audio(1, [2, 0]); socket.audio(4, [3, 0]);
    expect(buffers()).toHaveLength(1);
    expect(gain.gain.value).toBe(0);
    result.value!.setVolume({ volume: 0.7 });
    expect(gain.gain.value).toBe(0);
    // The provider's boundary is inclusive for the next accepted audio event.
    socket.audio(5, [4, 0]); socket.audio(6, [5, 0]);
    expect(buffers()).toHaveLength(3);
    expect(gain.gain.value).toBe(0.7);
    socket.interrupt(5); socket.interrupt(3);
    expect(onInterruption).toHaveBeenCalledTimes(1);
    expect(gain.gain.value).toBe(0.7);
    expect(output.port.postMessage.mock.calls.filter(([message]) => message.type === "interrupt")).toHaveLength(1);
    socket.interrupt(7); socket.audio(6, [6, 0]);
    expect(buffers()).toHaveLength(3);
    expect(gain.gain.value).toBe(0);
    socket.audio(8, [7, 0]);
    expect([...new Uint8Array(buffers()[buffers().length - 1][0].buffer)]).toEqual([7, 0]);
    expect(gain.gain.value).toBe(0.7);
    await result.value!.endSession();
  });

  it("discards interrupted audio queued before the SDK output listener is attached", async () => {
    const preliminary = microphone(), liveMic = microphone(), permission = deferred<MediaStream>();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockReturnValueOnce(permission.promise);
    const incoming = vi.fn();
    const pending = outcome(Conversation.startSession({ ...options(controller().signal), onIncomingEvent: incoming }));
    const socket = await socketReady(); socket.open(); socket.metadata();
    await vi.waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
    socket.audio(1, [1, 0]); socket.interrupt(2); socket.audio(1, [2, 0]);
    permission.resolve(liveMic.stream);
    const result = await pending;
    expect(result.error).toBeUndefined();
    const output = BrowserWorklet.instances.find(worklet => worklet.processor.startsWith("audioConcatProcessor@"))!;
    const buffers = () => output.port.postMessage.mock.calls.filter(([message]) => message.type === "buffer");
    expect(buffers()).toHaveLength(0);
    expect(incoming.mock.calls.some(([event]) => event.type === "audio")).toBe(false);
    socket.audio(3, [3, 0]);
    expect(buffers()).toHaveLength(1);
    expect([...new Uint8Array(buffers()[0][0].buffer)]).toEqual([3, 0]);
    await result.value!.endSession();
  });

  it("the actual output worklet clears its current and queued samples without a delayed reset", () => {
    type Worklet = { port: { onmessage: (event: { data: Record<string, unknown> }) => void }; process: (input: unknown[], output: Float32Array[][]) => boolean };
    let Processor!: new () => Worklet;
    runInNewContext(readFileSync("node_modules/@elevenlabs/client/worklets/audioConcatProcessor.js", "utf8"), {
      AudioWorkletProcessor: class { port = { postMessage: vi.fn() }; },
      sampleRate: 16_000,
      registerProcessor: (_name: string, implementation: new () => Worklet) => { Processor = implementation; },
      Int16Array, Uint8Array,
    });
    const worklet = new Processor();
    const send = (data: Record<string, unknown>) => worklet.port.onmessage({ data });
    const render = () => { const output = new Float32Array(128); worklet.process([], [[output]]); return [...output]; };
    send({ type: "setFormat", format: "pcm", sampleRate: 16_000 });
    send({ type: "buffer", buffer: new Int16Array(1_000).fill(16_384).buffer });
    send({ type: "buffer", buffer: new Int16Array(1_000).fill(8_192).buffer });
    expect(render()).toEqual(Array(128).fill(0.5));
    send({ type: "interrupt" });
    expect(render()).toEqual(Array(128).fill(0));
    send({ type: "clearInterrupted" });
    expect(render()).toEqual(Array(128).fill(0));
    send({ type: "buffer", buffer: new Int16Array(128).fill(-8_192).buffer });
    expect(render()).toEqual(Array(128).fill(-0.25));
  });

  it("still starts and ends a normal SDK voice session with all tracks and output resources released", async () => {
    const preliminary = microphone(), liveMic = microphone();
    getUserMedia.mockResolvedValueOnce(preliminary.stream).mockResolvedValueOnce(liveMic.stream);
    const abort = controller();
    const pending = outcome(Conversation.startSession(options(abort.signal)));
    const socket = await socketReady(); socket.open(); socket.metadata();
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(preliminary.track.stop).toHaveBeenCalled();
    expect(liveMic.track.stop).not.toHaveBeenCalled();
    expect(document.querySelector("audio")).not.toBeNull();
    socket.audio(1, [4, 0]);
    const output = BrowserWorklet.instances.find(worklet => worklet.processor.startsWith("audioConcatProcessor@"))!;
    expect(output.port.postMessage.mock.calls.some(([message]) => message.type === "buffer")).toBe(true);
    const input = BrowserWorklet.instances.find(worklet => worklet.processor.startsWith("rawAudioProcessor@"))!;
    input.port.dispatchEvent(new MessageEvent("message", { data: [new Int16Array([7]), 1] }));
    expect(socket.send.mock.calls.some(([message]) => JSON.parse(message).user_audio_chunk === btoa(String.fromCharCode(7, 0)))).toBe(true);
    await result.value!.endSession();
    expect(liveMic.track.stop).toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalled();
    expect(BrowserAudioContext.instances.every(context => context.state === "closed")).toBe(true);
    expect(document.querySelector("audio")).toBeNull();
  });
});
