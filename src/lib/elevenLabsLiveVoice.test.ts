import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, PartialOptions } from "@elevenlabs/client";
import { ElevenLabsLiveVoiceConnection } from "./elevenLabsLiveVoice";
import type { PrepareVoiceConnection, VoiceEvent } from "./liveVoice";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(), startSession: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: mocks.isTauri }));
vi.mock("@elevenlabs/client", () => ({ Conversation: { startSession: mocks.startSession } }));
type Config = PartialOptions & { signal: AbortSignal; orionCanPlayAudio: () => boolean; orionCanSendAudio: () => boolean };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const session = { signedUrl: "wss://api.elevenlabs.io/v1/convai/conversation?agent_id=private&conversation_signature=temporary", voiceId: "saved_custom_voice" };
let config: Config;
let sdk: ReturnType<typeof makeSdk>;
const connections: ElevenLabsLiveVoiceConnection[] = [];
function makeSdk() {
  return { setMicMuted: vi.fn(), setVolume: vi.fn(), endSession: vi.fn(async () => undefined), sendContextualUpdate: vi.fn(), sendUserMessage: vi.fn(), getInputVolume: vi.fn(() => 0.3), getOutputVolume: vi.fn(() => 0.4) };
}
function setup(prepareConnection?: PrepareVoiceConnection) {
  const events: VoiceEvent[] = [];
  const status = vi.fn(), activity = vi.fn();
  const connection = new ElevenLabsLiveVoiceConnection({ spaceId: "space-a", context: "Current Space excerpt", voiceId: "saved_custom_voice", provider: "elevenlabs", prepareConnection, onEvent: event => events.push(event), onStatus: status, onActivity: activity });
  connections.push(connection);
  return { connection, events, status, activity };
}
const incoming = (event: unknown) => config.onIncomingEvent?.(event);
const vad = (score: number) => incoming({ type: "vad_score", vad_score_event: { vad_score: score } });
const user = (text: string, id = 1) => incoming({ type: "user_transcript", user_transcription_event: { user_transcript: text, event_id: id } });
const tool = (id = "tool-1", request = "Model-proposed changes must not become user speech") => incoming({ type: "client_tool_call", client_tool_call: { tool_name: "delegate_to_orion", tool_call_id: id, parameters: { request }, event_id: 2 } });

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  vi.clearAllMocks();
  mocks.isTauri.mockReturnValue(true); mocks.invoke.mockResolvedValue(session);
  sdk = makeSdk();
  mocks.startSession.mockImplementation(async (options: Config) => {
    config = options;
    options.onConversationCreated?.(sdk as unknown as Conversation);
    options.onConnect?.({ conversationId: "test-session" });
    return sdk;
  });
});
afterEach(() => { connections.splice(0).forEach(item => item.dispose()); vi.useRealTimers(); });

describe("ElevenLabs managed conversational transport", () => {
  it("waits for the App's actual settings save before native authentication or microphone setup", async () => {
    const pending = deferred<void>();
    const prepare = vi.fn<PrepareVoiceConnection>(() => pending.promise);
    const { connection, status } = setup(prepare); const start = connection.start();
    expect(status).toHaveBeenLastCalledWith("connecting");
    expect(prepare).toHaveBeenCalledWith({ spaceId: "space-a", provider: "elevenlabs", voiceId: "saved_custom_voice" }, expect.any(AbortSignal));
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.startSession).not.toHaveBeenCalled();
    pending.resolve(); await start;
    expect(mocks.invoke).toHaveBeenCalledOnce(); expect(mocks.startSession).toHaveBeenCalledOnce();
  });

  it("aborts preparation on Stop and never authenticates after the late settings save", async () => {
    const pending = deferred<void>(); const prepare = vi.fn<PrepareVoiceConnection>(() => pending.promise);
    const { connection, status } = setup(prepare); const start = connection.start();
    connection.close();
    expect(prepare.mock.calls[0][1].aborted).toBe(true);
    pending.resolve(); await start;
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.startSession).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("idle");
  });

  it("reports save rejection and does not create an authenticated or microphone session", async () => {
    const prepare = vi.fn<PrepareVoiceConnection>().mockRejectedValue(new Error("Your voice choice could not be saved."));
    const { connection, status } = setup(prepare); await connection.start();
    expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.startSession).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("disconnected", "Your voice choice could not be saved.");
  });

  it("starts only explicitly, authenticates natively, uses the saved voice and local worklets, and begins silently", async () => {
    const { connection, events, status } = setup();
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
    await connection.start(); await connection.start();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("create_elevenlabs_live_session", { request: { spaceId: "space-a", context: "Current Space excerpt", voiceId: "saved_custom_voice" } });
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
    expect(config).toMatchObject({ connectionType: "websocket", useWakeLock: false, textOnly: false, overrides: { tts: { voiceId: "saved_custom_voice" } } });
    expect(config.overrides).not.toHaveProperty("agent");
    expect(config.workletPaths?.rawAudioProcessor).toContain("rawAudioProcessor");
    expect(config.workletPaths?.audioConcatProcessor).toContain("audioConcatProcessor");
    expect(config.libsampleratePath).toContain("libsamplerate.worklet");
    expect(config.orionCanPlayAudio()).toBe(false);
    expect(sdk.setVolume).toHaveBeenCalledWith({ volume: 0 });
    expect(sdk.sendUserMessage).not.toHaveBeenCalled();
    expect(JSON.parse(sdk.sendContextualUpdate.mock.calls[0][0])).toMatchObject({ source: "orion_host", kind: "thinking", content: "Current Space excerpt" });
    incoming({ type: "agent_response", agent_response_event: { event_id: 1, agent_response: "Unwanted introduction" } });
    expect(events).toEqual([]);
    expect(status).toHaveBeenLastCalledWith("listening");
  });

  it("captures a stable target at speech onset and emits only one final transcript without provisional authority", async () => {
    const { connection, events } = setup(); await connection.start();
    vad(0.8);
    const started = events[0];
    expect(started).toMatchObject({ type: "session.input_audio.started", start_ms: 0 });
    vi.advanceTimersByTime(400); vad(0.9);
    incoming({ type: "tentative_user_transcript", tentative_user_transcription_event: { user_transcript: "Delete this", event_id: 1 } });
    expect(events).toHaveLength(1);
    vad(0.1); vi.advanceTimersByTime(400); user("Don't delete this. Research it.", 2); user("Duplicate changed command", 2);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ type: "session.input_transcript.delta", item_id: started.item_id, delta: "Don't delete this. Research it. ", start_ms: 0, end_ms: 400 });
    expect(config.orionCanPlayAudio()).toBe(true);
    expect(sdk.setVolume).toHaveBeenLastCalledWith({ volume: 1 });
  });

  it("never reconstructs a missing, expired or ambiguous target at final-transcript time", async () => {
    const { connection, events } = setup(); await connection.start();
    user("Uncaptured command", 1);
    expect(events[0]).toMatchObject({ type: "session.input_transcript.delta" });
    expect(events[0].item_id).toBeUndefined();
    vad(0.8); vad(0.1); vi.advanceTimersByTime(8_001); vad(0.9); user("Ambiguous delayed command", 2);
    expect(events[events.length - 1]?.item_id).toBeUndefined();
    vad(0.1); vad(0.8); vi.advanceTimersByTime(120_001); user("Expired capture", 3);
    expect(events[events.length - 1]?.item_id).toBeUndefined();
    tool();
    expect(events.filter(item => item.type === "session.delegation.created")).toEqual([]);
  });

  it("maps model delegation to independently recorded speech and never transcribes tool arguments", async () => {
    const { connection, events } = setup(); await connection.start();
    tool("unbound"); expect(events).toEqual([]);
    vad(0.9); tool("pending", "  Research   the options ");
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(200); vad(0.9); vad(0.1); user("Research the options", 5);
    const transcript = events.find(item => item.type === "session.input_transcript.delta")!;
    expect(events[events.length - 1]).toMatchObject({ type: "session.delegation.created", item_id: transcript.item_id, offset_ms: 200, delegation: { id: "pending", target: "client" } });
    tool("pending", "Research the options"); tool("after-final", "Research the options");
    expect(events.filter(item => item.type === "session.delegation.created")).toHaveLength(2);
    expect(events.filter(item => item.delta).map(item => item.delta)).toEqual(["Research the options "]);
    expect(config.clientTools?.delegate_to_orion({ request: "invented action" })).toContain("does not confirm");
  });

  it("keeps worker context quiet, delivers released commentary, and refuses host echoes as user authority", async () => {
    const { connection, events } = setup(); await connection.start();
    expect(connection.append("commentary", "Premature finding")).toBe(false);
    expect(connection.append("instructions", "Current note changed")).toBe(true);
    expect(sdk.sendUserMessage).not.toHaveBeenCalled();
    vad(0.9); vad(0.1); user("Research these options", 1);
    expect(connection.append("commentary", "Verified finding", "delegation-1")).toBe(true);
    const cue = sdk.sendUserMessage.mock.calls[0][0];
    expect(JSON.parse(sdk.sendContextualUpdate.mock.calls[sdk.sendContextualUpdate.mock.calls.length - 1][0])).toMatchObject({ kind: "commentary", content: "Verified finding", delegation_id: "delegation-1" });
    user(`  ${cue}  `, 2); tool("host-triggered", "Research these options");
    expect(events.filter(item => item.type === "session.input_transcript.delta")).toHaveLength(1);
    expect(events.filter(item => item.type === "session.delegation.created")).toHaveLength(0);
    vad(0.9); vad(0.1); user("Read the first option", 3); tool("real-followup", "Read the first option");
    expect(events[events.length - 1]?.delegation?.id).toBe("real-followup");
  });

  it("starts a new capture after a final without requiring another low score, and rejects a delayed older tool", async () => {
    const { connection, events } = setup(); await connection.start();
    vad(0.9); user("Research the first option", 1);
    vi.advanceTimersByTime(1_000);
    vad(0.9); user("Research the second option", 2);
    const starts = events.filter(event => event.type === "session.input_audio.started");
    const finals = events.filter(event => event.type === "session.input_transcript.delta");
    expect(starts).toHaveLength(2);
    expect(starts[0].item_id).not.toBe(starts[1].item_id);
    expect(finals.map(event => event.item_id)).toEqual(starts.map(event => event.item_id));
    tool("late-old", "Research the first option");
    tool("invented", "Delete the second option");
    expect(events.filter(event => event.type === "session.delegation.created")).toHaveLength(0);
    tool("matched", "Research the second option");
    expect(events[events.length - 1]).toMatchObject({ item_id: starts[1].item_id, delegation: { id: "matched" } });
  });

  it("does not authorize a model's stronger pending request when the final speech keeps its qualification", async () => {
    const { connection, events } = setup(); await connection.start();
    vad(0.9); tool("stronger", "Rewrite this note");
    user("Don't rewrite this note; just explain it", 1);
    expect(events.filter(event => event.type === "session.delegation.created")).toHaveLength(0);
    expect(events.find(event => event.type === "session.input_transcript.delta")?.delta).toBe("Don't rewrite this note; just explain it ");
  });

  it("uses measured SDK audio and provider context usage; mute and silence fence audio and pending transcripts", async () => {
    const { connection, events, activity } = setup(); await connection.start();
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ inputLevel: 0.3, outputLevel: 0, measured: true }));
    vad(0.9); connection.mute(true); user("Do not accept while muted", 1);
    expect(events.filter(item => item.delta)).toEqual([]);
    expect(sdk.setMicMuted).toHaveBeenLastCalledWith(true);
    expect(config.orionCanSendAudio()).toBe(false);
    connection.mute(false); vad(0.9); vad(0.1); user("Hello", 2);
    expect(config.orionCanSendAudio()).toBe(true);
    vi.advanceTimersByTime(50);
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ inputLevel: 0.3, outputLevel: 0.4, outputActive: true }));
    connection.silence(true);
    expect(config.orionCanPlayAudio()).toBe(false);
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ outputLevel: 0, outputActive: false }));
    incoming({ type: "context_usage", context_usage_event: { context_tokens: 25, context_limit_tokens: 100 } });
    expect(events[events.length - 1]).toMatchObject({ type: "session.usage.updated", context_window: { usage_ratio: 0.25 } });
    const count = events.length;
    incoming({ type: "context_usage", context_usage_event: { context_tokens: Infinity, context_limit_tokens: 100 } });
    expect(events).toHaveLength(count);
  });

  it("stops a pending native handshake without creating a later microphone session", async () => {
    const pending = deferred<unknown>(); mocks.invoke.mockReturnValue(pending.promise);
    const { connection, status } = setup(); const start = connection.start();
    connection.close(); pending.resolve(session); await start;
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("idle");
  });

  it("aborts pending SDK setup, releases a late instance and fences stale callbacks", async () => {
    const pending = deferred<Conversation>();
    mocks.startSession.mockImplementation((options: Config) => { config = options; return pending.promise; });
    const { connection, events, status } = setup(); const start = connection.start();
    await vi.waitFor(() => expect(mocks.startSession).toHaveBeenCalled());
    connection.close(); expect(config.signal.aborted).toBe(true); expect(config.orionCanPlayAudio()).toBe(false);
    expect(config.orionCanSendAudio()).toBe(false);
    config.onConversationCreated?.(sdk as unknown as Conversation); config.onConnect?.({ conversationId: "late" });
    incoming({ type: "vad_score", vad_score_event: { vad_score: 1 } });
    pending.resolve(sdk as unknown as Conversation); await start;
    expect(events).toEqual([]); expect(sdk.endSession).toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("idle");
  });

  it("times out a hung setup and sanitizes errors without exposing signed credentials", async () => {
    mocks.startSession.mockImplementation((options: Config) => { config = options; return new Promise(() => undefined); });
    const { connection, status } = setup(); void connection.start();
    await vi.waitFor(() => expect(mocks.startSession).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(45_000);
    expect(config.signal.aborted).toBe(true);
    expect(status).toHaveBeenLastCalledWith("disconnected", expect.stringContaining("did not connect in time"));
    const next = setup(); mocks.startSession.mockRejectedValue(new Error(session.signedUrl)); await next.connection.start();
    expect(JSON.stringify(next.status.mock.calls)).not.toContain("conversation_signature");
  });

  it("rejects unexpected credential hosts before loading an audio session", async () => {
    mocks.invoke.mockResolvedValue({ ...session, signedUrl: "wss://api.elevenlabs.io.evil.example/v1/convai/conversation" });
    const { connection, status } = setup(); await connection.start();
    expect(mocks.startSession).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith("disconnected", expect.stringContaining("invalid conversation credential"));
  });
});
