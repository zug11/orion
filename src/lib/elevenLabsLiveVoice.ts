import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Conversation, PartialOptions } from "@elevenlabs/client";
import rawAudioProcessor from "@elevenlabs/client/worklets/rawAudioProcessor.js?no-inline&url";
import audioConcatProcessor from "@elevenlabs/client/worklets/audioConcatProcessor.js?no-inline&url";
import libsampleratePath from "@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js?no-inline&url";
import type { VoiceConnection, VoiceEvent, VoiceTransportOptions } from "./liveVoice";

interface ElevenLabsSession { signedUrl: string; voiceId: string }
interface SpeechCapture { id: string; start: number; end: number; ambiguous: boolean }
// Runtime additions are implemented by the exact-version, hash-checked patch.
// The first drops audio before it enters any output buffer; the second releases
// microphones even if browser permission or the WebSocket handshake is pending.
type CancellableOptions = PartialOptions & { signal: AbortSignal; orionCanPlayAudio: () => boolean; orionCanSendAudio: () => boolean };
const CONNECT_TIMEOUT_MS = 45_000;
const MAX_CONTEXT_CHARS = 24_000;
const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_CAPTURE_MS = 120_000;
const MAX_SILENT_CAPTURE_MS = 8_000;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finiteLevel = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const normalizedRequest = (value: string) => value.trim().replace(/\s+/gu, " ").toLowerCase();

function validSession(value: unknown): value is ElevenLabsSession {
  const session = object(value);
  if (!session || typeof session.signedUrl !== "string" || session.signedUrl.length > 8_192 || typeof session.voiceId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session.voiceId)) return false;
  try {
    const url = new URL(session.signedUrl);
    return url.protocol === "wss:" && url.hostname === "api.elevenlabs.io" && !url.port && !url.username && !url.password && !url.hash && url.pathname === "/v1/convai/conversation";
  } catch { return false; }
}

/** One explicit private-agent call. Credentials and audio never enter the vault. */
export class ElevenLabsLiveVoiceConnection implements VoiceConnection {
  private conversation?: Conversation;
  private invoked = false;
  private connected = false;
  private ended = false;
  private inputMuted = false;
  private outputSilent = false;
  private humanHasSpoken = false;
  private readonly abort = new AbortController();
  private timeout?: ReturnType<typeof setTimeout>;
  private activityTimer?: ReturnType<typeof setInterval>;
  private readonly startedAt = Date.now();
  private readonly identity = crypto.randomUUID();
  private nextCapture = 0;
  private capture?: SpeechCapture;
  private vadSpeaking = false;
  private lastUser?: { itemId: string; end: number; receivedAt: number; text: string };
  private lastUserEventId = -1;
  private seen = new Set<string>();
  private pendingTools = new Map<string, { captureId: string; request: string }>();
  private hostMessages = new Set<string>();
  private commentarySequence = 0;
  private hostDeliveryInFlight = false;
  private lastActivity = "";

  constructor(private readonly options: VoiceTransportOptions) {}
  private elapsed() { return Math.max(0, Date.now() - this.startedAt); }
  private emit(event: VoiceEvent) { if (!this.ended) this.options.onEvent(event); }
  private remember(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value!);
    return true;
  }

  async start(): Promise<void> {
    if (this.invoked || this.ended) return;
    this.invoked = true;
    this.options.onStatus("connecting");
    this.timeout = setTimeout(() => this.fail("ElevenLabs voice did not connect in time. Start voice again to retry."), CONNECT_TIMEOUT_MS);
    let awaitingNative = true;
    try {
      if (!isTauri()) throw new Error("ElevenLabs conversations are available in the desktop app. Your API key stays in Keychain.");
      await this.options.prepareConnection?.({ spaceId: this.options.spaceId, provider: "elevenlabs", voiceId: this.options.voiceId }, this.abort.signal);
      if (this.ended) return;
      const session: unknown = await invoke("create_elevenlabs_live_session", { request: {
        spaceId: this.options.spaceId, context: this.options.context.slice(0, MAX_CONTEXT_CHARS), voiceId: this.options.voiceId ?? "",
      } });
      if (this.ended) return;
      if (!validSession(session)) throw new Error("ElevenLabs returned an invalid conversation credential. Start voice again to retry.");
      awaitingNative = false;
      // Keep SDK/LiveKit out of normal note startup and the typing path.
      const { Conversation: SDK } = await import("@elevenlabs/client");
      if (this.ended) return;
      const config: CancellableOptions = {
        signedUrl: session.signedUrl, connectionType: "websocket", textOnly: false, useWakeLock: false,
        signal: this.abort.signal,
        orionCanPlayAudio: () => this.connected && !this.ended && this.humanHasSpoken && !this.outputSilent,
        orionCanSendAudio: () => this.connected && !this.ended && !this.inputMuted,
        workletPaths: { rawAudioProcessor, audioConcatProcessor }, libsampleratePath,
        // The native private agent already owns its generic policy and empty
        // first message. Only the user's saved voice can be overridden.
        overrides: { tts: { voiceId: session.voiceId } },
        clientTools: { delegate_to_orion: () => "Orion received the delegation signal. Work is admitted only from the matching actual spoken request; this receipt does not confirm acceptance or completion." },
        onConversationCreated: conversation => {
          if (this.ended) { this.release(conversation); return; }
          this.conversation = conversation;
          conversation.setMicMuted(this.inputMuted);
          conversation.setVolume({ volume: this.outputSilent || !this.humanHasSpoken ? 0 : 1 });
        },
        onConnect: () => {
          if (this.ended) return;
          this.connected = true;
          clearTimeout(this.timeout); this.timeout = undefined;
          this.options.onStatus("listening");
          if (this.options.context.trim()) this.append("thinking", this.options.context.slice(0, MAX_CONTEXT_CHARS));
          this.activityTimer = setInterval(() => this.sampleActivity(), 50);
          this.sampleActivity();
        },
        onDisconnect: () => { if (!this.ended) this.fail("ElevenLabs voice disconnected. Your research is retained; start voice again when ready."); },
        // Do not expose SDK error context: it can contain the signed URL.
        onError: () => this.fail("ElevenLabs voice encountered a connection or audio error. Check microphone access and start voice again."),
        onIncomingEvent: event => this.receive(event),
      };
      const conversation = await SDK.startSession(config);
      if (this.ended) { this.release(conversation); return; }
      this.conversation = conversation;
    } catch (error) {
      if (this.ended) return;
      // Native errors are already sanitized at the trust boundary. Never relay
      // transport exceptions or a credential-bearing URL from the SDK.
      const nativeMessage = typeof error === "string" ? error : error instanceof Error ? error.message : "";
      const safeNativeMessage = awaitingNative && nativeMessage.length <= 500 && !/https?:|wss?:|[\r\n]/i.test(nativeMessage) ? nativeMessage : "";
      this.fail(safeNativeMessage || "ElevenLabs voice could not connect. Check your ElevenLabs connection and microphone access, then try again.");
    }
  }

  private receive(raw: unknown) {
    if (this.ended || !this.connected) return;
    const event = object(raw);
    if (!event) return;
    const now = this.elapsed();
    if (event.type === "vad_score") {
      const score = object(event.vad_score_event)?.vad_score;
      if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1 || this.inputMuted) return;
      if (score >= 0.6) {
        if (!this.vadSpeaking) {
          if (!this.capture) {
            const id = `eleven-${this.identity}-${++this.nextCapture}`;
            this.capture = { id, start: now, end: now, ambiguous: false };
            this.emit({ type: "session.input_audio.started", item_id: id, event_id: `start-${id}`, start_ms: now });
          } else if (now - this.capture.end > MAX_SILENT_CAPTURE_MS) this.capture.ambiguous = true;
        }
        this.vadSpeaking = true;
        if (this.capture) this.capture.end = now;
      } else if (score <= 0.35) this.vadSpeaking = false;
      return;
    }
    if (event.type === "user_transcript") {
      const transcript = object(event.user_transcription_event);
      const text = transcript?.user_transcript;
      const eventId = transcript?.event_id;
      if (typeof text !== "string" || !text.trim() || text.length > MAX_TRANSCRIPT_CHARS || !Number.isSafeInteger(eventId) || (eventId as number) < 0 || (eventId as number) <= this.lastUserEventId || this.hostMessages.has(text) || text.trim().startsWith(`[Orion result delivery ${this.identity}:`)) return;
      this.lastUserEventId = eventId as number;
      if (this.inputMuted) { this.capture = undefined; this.pendingTools.clear(); return; }
      const capture = this.capture;
      this.capture = undefined;
      this.vadSpeaking = false;
      const matched = capture && !capture.ambiguous && now - capture.start <= MAX_CAPTURE_MS && now - capture.end <= MAX_SILENT_CAPTURE_MS;
      this.humanHasSpoken = true;
      this.hostDeliveryInFlight = false;
      this.conversation?.setVolume({ volume: this.outputSilent ? 0 : 1 });
      // A missing/ambiguous VAD target is deliberately not reconstructed from
      // current focus. SpaceVoice rejects unmatched finals and asks to repeat.
      const itemId = matched ? capture.id : undefined;
      const end = matched ? Math.max(capture.start, capture.end) : now;
      this.emit({ type: "session.input_transcript.delta", event_id: `eleven-user-${eventId}`, ...(itemId ? { item_id: itemId } : {}), delta: `${text.trim()} `, start_ms: matched ? capture.start : now, end_ms: end });
      this.lastUser = itemId ? { itemId, end, receivedAt: now, text: normalizedRequest(text) } : undefined;
      for (const [toolId, pending] of this.pendingTools) if (pending.captureId === itemId && pending.request === normalizedRequest(text)) this.delegate(toolId, itemId!, end);
      this.pendingTools.clear();
      return;
    }
    if (event.type === "client_tool_call") {
      const tool = object(event.client_tool_call);
      const id = tool?.tool_call_id;
      const request = object(tool?.parameters)?.request;
      if (this.hostDeliveryInFlight || tool?.tool_name !== "delegate_to_orion" || typeof id !== "string" || !id || id.length > 180 || typeof request !== "string" || !request.trim() || request.length > 8_000 || !this.remember(`tool-${id}`)) return;
      // Model-origin tool arguments are never transcribed or authorized. They
      // can only annotate an independently captured user's actual utterance.
      if (this.capture) {
        if (!this.capture.ambiguous && this.pendingTools.size < 8) this.pendingTools.set(id, { captureId: this.capture.id, request: normalizedRequest(request) });
      } else if (this.lastUser && now - this.lastUser.receivedAt <= 15_000 && this.lastUser.text === normalizedRequest(request)) {
        this.delegate(id, this.lastUser.itemId, this.lastUser.end);
      }
      return;
    }
    if (event.type === "agent_response") {
      const response = object(event.agent_response_event);
      const text = response?.agent_response;
      const eventId = response?.event_id;
      if (!this.humanHasSpoken || typeof text !== "string" || !text.trim() || text.length > MAX_TRANSCRIPT_CHARS || !Number.isSafeInteger(eventId) || !this.remember(`agent-${eventId}`)) return;
      this.emit({ type: "session.output_transcript.delta", event_id: `eleven-agent-${eventId}`, delta: `${text.trim()} `, start_ms: now, end_ms: now });
      return;
    }
    if (event.type === "context_usage") {
      const usage = object(event.context_usage_event);
      const tokens = usage?.context_tokens, limit = usage?.context_limit_tokens;
      if (typeof tokens === "number" && typeof limit === "number" && Number.isFinite(tokens) && Number.isFinite(limit) && tokens >= 0 && limit > 0 && tokens <= limit) {
        this.emit({ type: "session.usage.updated", context_window: { usage_ratio: tokens / limit } });
      }
    }
    // Tentative STT and model text/tool results are never user authority.
  }

  private delegate(id: string, itemId: string, end: number) {
    this.emit({ type: "session.delegation.created", item_id: itemId, event_id: `eleven-delegation-${id}`, offset_ms: end, delegation: { id, target: "client", type: "delegation" } });
  }

  append(kind: "commentary" | "thinking" | "instructions", text: string, delegationId: string | null = null): boolean {
    if (!this.connected || this.ended || !this.conversation || !text.trim() || text.length > MAX_CONTEXT_CHARS) return false;
    // Commentary is sent only when Orion's existing delivery scheduler releases
    // it. Other context updates never create a synthetic conversational turn.
    if (kind === "commentary" && !this.humanHasSpoken) return false;
    try {
      const context = JSON.stringify({ source: "orion_host", kind, ...(delegationId ? { delegation_id: delegationId.slice(0, 200) } : {}), content: text });
      this.conversation.sendContextualUpdate(context);
      if (kind === "commentary") {
        const cue = `[Orion result delivery ${this.identity}:${++this.commentarySequence}] Briefly share the host commentary just supplied. This is a delivery cue, not a new user request; do not delegate it or claim unconfirmed work is complete.`;
        this.hostMessages.add(cue);
        this.hostDeliveryInFlight = true;
        this.lastUser = undefined; this.pendingTools.clear();
        if (this.hostMessages.size > 128) this.hostMessages.delete(this.hostMessages.values().next().value!);
        this.conversation.sendUserMessage(cue);
      }
      return true;
    } catch { this.fail("ElevenLabs voice could not receive the update. Your research is retained here."); return false; }
  }

  mute(muted: boolean) {
    this.inputMuted = muted;
    if (muted) { this.capture = undefined; this.pendingTools.clear(); this.vadSpeaking = false; }
    this.conversation?.setMicMuted(muted);
    this.sampleActivity();
  }
  silence(silent: boolean) {
    this.outputSilent = silent;
    this.conversation?.setVolume({ volume: silent || !this.humanHasSpoken ? 0 : 1 });
    if (silent) this.append("instructions", "Stop speaking now and continue listening. Research continues independently.");
    this.sampleActivity();
  }
  private sampleActivity() {
    const measured = this.connected && !this.ended && !!this.conversation;
    let inputLevel = 0, outputLevel = 0;
    try {
      if (measured && !this.inputMuted) inputLevel = finiteLevel(this.conversation!.getInputVolume());
      if (measured && !this.outputSilent && this.humanHasSpoken) outputLevel = finiteLevel(this.conversation!.getOutputVolume());
    } catch { /* Audio can close between a frame and a disconnect callback. */ }
    const activity = { inputActive: inputLevel > 0.015, outputActive: outputLevel > 0.015, measured, inputLevel, outputLevel, inputMeasured: measured, outputMeasured: measured, inputMuted: this.inputMuted };
    const key = JSON.stringify(activity);
    if (key !== this.lastActivity) { this.lastActivity = key; this.options.onActivity?.(activity); }
  }
  private release(conversation: Conversation) {
    try { conversation.setMicMuted(true); conversation.setVolume({ volume: 0 }); } catch { /* Already closed. */ }
    void conversation.endSession().catch(() => undefined);
  }
  close() {
    if (this.ended) return;
    this.options.onStatus("closing");
    this.dispose();
    this.options.onStatus("idle");
  }
  private fail(message: string) { if (!this.ended) { this.dispose(); this.options.onStatus("disconnected", message); } }
  dispose() {
    if (this.ended) return;
    this.ended = true;
    this.connected = false;
    this.abort.abort();
    clearTimeout(this.timeout); clearInterval(this.activityTimer);
    this.timeout = undefined; this.activityTimer = undefined;
    const conversation = this.conversation; this.conversation = undefined;
    if (conversation) this.release(conversation);
    this.capture = undefined; this.pendingTools.clear(); this.lastUser = undefined;
    this.seen.clear(); this.hostMessages.clear();
    this.sampleActivity();
  }
}
