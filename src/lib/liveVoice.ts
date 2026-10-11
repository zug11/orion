import { invoke, isTauri } from "@tauri-apps/api/core";
import { VoiceAudioEnvelope } from "./voiceAudioActivity";

export type VoiceStatus = "idle" | "connecting" | "listening" | "closing" | "disconnected";
export interface VoiceEvent { type: string; event_id?: string; client_event_id?: string; delta?: string; start_ms?: number; end_ms?: number; offset_ms?: number; delegation?: { id: string; target?: "client" | "responses"; type?: "delegation" }; usage?: { seconds: number }; context_window?: { usage_ratio: number }; error?: { message?: string; client_event_id?: string }; }
/** The provider's actual context snapshot, including audio; never infer it from text length. */
export function voiceContextUsageRatio(event: VoiceEvent): number | undefined {
  if (event.type !== "session.usage.updated") return undefined;
  const ratio = event.context_window?.usage_ratio;
  return typeof ratio === "number" && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1 ? ratio : undefined;
}
/** Local audio energy, not a provider turn boundary or proof that a result was heard. */
export interface VoiceActivity {
  inputActive: boolean; outputActive: boolean; measured: boolean;
  /** Smoothed local PCM energy, 0–1. Zero when that channel cannot be heard/read. */
  inputLevel: number; outputLevel: number;
  inputMeasured: boolean; outputMeasured: boolean;
  inputMuted: boolean;
}
export interface VoiceTransportOptions {
  spaceId: string; context: string;
  onEvent: (event: VoiceEvent) => void;
  onStatus: (status: VoiceStatus, error?: string) => void;
  onActivity?: (activity: VoiceActivity) => void;
  connect?: (request: { spaceId: string; context: string; sdp: string }) => Promise<{ id: string; sdp: string }>;
}
export function voiceAppendChunks(text: string): string[] {
  // Prefer complete sentences, then words. The API allows 500 tokens, but does
  // not expose a model tokenizer: UTF-8 bytes conservatively bound byte-level
  // tokens for every language, unlike a chars-per-token estimate. Only a single
  // oversized word/grapheme needs a Unicode-code-point fallback.
  const encoder = new TextEncoder();
  const chunks: string[] = []; let current = "", bytes = 0;
  const flush = () => { if (current) chunks.push(current); current = ""; bytes = 0; };
  const append = (part: string) => {
    const size = encoder.encode(part).length;
    if (bytes + size > 480) flush();
    current += part; bytes += size;
  };
  // The project's ES2020 baseline predates Segmenter's types. Current WebKit
  // supports it; older engines retain safe sentence/word/code-point fallbacks.
  type Granularity = "sentence" | "word" | "grapheme";
  const Segmenter = (Intl as typeof Intl & { Segmenter?: new(locales: undefined, options: { granularity: Granularity }) => { segment(value: string): Iterable<{ segment: string }> } }).Segmenter;
  const segments = (value: string, granularity: Granularity): string[] => {
    if (Segmenter) return Array.from(new Segmenter(undefined, { granularity }).segment(value), item => item.segment);
    if (granularity === "grapheme") return Array.from(value);
    return value.match(granularity === "sentence" ? /[^.!?。！？]*(?:[.!?。！？]+["'”’)\]]*\s*|$)/gu : /\s+|[^\s]+/gu)?.filter(Boolean) ?? [];
  };
  for (const sentence of segments(text, "sentence")) {
    if (encoder.encode(sentence).length <= 480) { append(sentence); continue; }
    flush();
    for (const word of segments(sentence, "word")) {
      if (encoder.encode(word).length <= 480) { append(word); continue; }
      flush();
      for (const grapheme of segments(word, "grapheme")) {
        if (encoder.encode(grapheme).length <= 480) append(grapheme);
        else for (const char of grapheme) append(char);
      }
    }
    flush();
  }
  if (current) chunks.push(current);
  return chunks;
}

/** One explicit call, no background reconnect and no renderer credential. */
export class LiveVoiceConnection {
  private peer?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private stream?: MediaStream;
  private captureListeners: (() => void)[] = [];
  private audio?: HTMLAudioElement;
  private started = false;
  private ended = false;
  private closing = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private connectAbort = new AbortController();
  private activityContext?: AudioContext;
  private activityInterval?: ReturnType<typeof setInterval>;
  private activityChannels: Partial<Record<"input" | "output", { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; stream: MediaStream; samples: Float32Array<ArrayBuffer>; envelope: VoiceAudioEnvelope }>> = {};
  private lastActivity = "";
  private inputMuted = false;
  private playbackReady = false;
  constructor(private readonly options: VoiceTransportOptions) {}
  private later(fn: () => void, delay: number) { const id = setTimeout(() => { this.timers.delete(id); fn(); }, delay); this.timers.add(id); return id; }
  async start() {
    if (this.peer || this.ended) return;
    this.options.onStatus("connecting");
    this.later(() => this.fail("Voice did not connect in time. You can reconnect."), 45_000);
    try {
      if (!this.options.connect && !isTauri()) throw new Error("Live voice is available in the desktop app. Your API key stays in Keychain.");
      this.peer = new RTCPeerConnection();
      this.audio = new Audio(); this.audio.autoplay = true;
      // A received stream or output transcript alone does not mean anything is
      // playing. Follow the playback element as well as the existing PCM track.
      const audio = this.audio;
      audio.onplaying = () => { if (this.audio === audio && !this.ended && !this.closing) { this.playbackReady = true; this.sampleActivity(); } };
      const playbackStopped = () => { if (this.audio === audio) { this.playbackReady = false; this.sampleActivity(); } };
      audio.onpause = playbackStopped; audio.onwaiting = playbackStopped; audio.onended = playbackStopped;
      this.openActivityMonitor();
      const peer = this.peer;
      peer.ontrack = event => {
        if (!this.ended && !this.closing && this.audio) {
          const audio = this.audio;
          const output = event.streams[0] ?? new MediaStream([event.track]);
          this.playbackReady = false;
          audio.srcObject = output;
          this.monitorAudio("output", output);
          void audio.play().then(() => {
            if (!this.ended && !this.closing && this.audio === audio && audio.srcObject === output) {
              this.playbackReady = !audio.paused;
              this.sampleActivity();
            }
          }, () => {
            // Playback may settle after Stop. Never revive that call's status or
            // keep capturing a user who cannot hear the other side of the call.
            if (!this.ended && !this.closing && this.audio === audio && audio.srcObject === output) this.fail("Voice audio could not play. Start voice again to retry.");
          });
        }
      };
      peer.onconnectionstatechange = () => {
        if (!this.ended && ["failed", "disconnected"].includes(peer.connectionState)) this.fail("Voice disconnected. Research is retained here; reconnect when ready.");
      };
      const channel = peer.createDataChannel("oai-events"); this.channel = channel;
      channel.onmessage = message => this.receive(message.data);
      channel.onclose = () => { if (!this.ended) this.fail("Voice connection closed. Reconnect to continue."); };
      channel.onerror = () => this.fail("Voice connection failed. Reconnect to continue.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      if (this.ended) { stream.getTracks().forEach(track => track.stop()); return; }
      this.stream = stream;
      const audioTracks = stream.getAudioTracks();
      const captureEnded = () => {
        if (this.stream === stream && !this.ended && !this.closing && !audioTracks.some(track => track.readyState !== "ended")) {
          this.fail("Microphone capture ended. Check your microphone and reconnect when ready. Research is retained here.");
        }
      };
      for (const track of audioTracks) {
        track.enabled = !this.inputMuted;
        track.addEventListener("ended", captureEnded);
        this.captureListeners.push(() => track.removeEventListener("ended", captureEnded));
      }
      // Device removal/permission withdrawal can end capture without failing
      // WebRTC. Temporary track mute is different and can recover in-place.
      captureEnded();
      if (this.ended) return;
      this.monitorAudio("input", stream);
      stream.getTracks().forEach(track => peer.addTrack(track, stream));
      const offer = await peer.createOffer();
      if (this.ended) return;
      await peer.setLocalDescription(offer);
      if (this.ended) return;
      if (peer.iceGatheringState !== "complete") await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => { peer.removeEventListener("icegatheringstatechange", check); this.connectAbort.signal.removeEventListener("abort", abort); clearTimeout(timeout); this.timers.delete(timeout); error ? reject(error) : resolve(); };
        const check = () => { if (peer.iceGatheringState === "complete") finish(); };
        const abort = () => finish(new Error("Voice was stopped."));
        const timeout = this.later(() => finish(new Error("Voice network negotiation timed out.")), 10_000);
        peer.addEventListener("icegatheringstatechange", check); this.connectAbort.signal.addEventListener("abort", abort, { once: true }); check();
      });
      if (this.ended) return;
      const request = { spaceId: this.options.spaceId, context: this.options.context, sdp: peer.localDescription?.sdp ?? "" };
      const answer = await (this.options.connect ? this.options.connect(request) : invoke<{ id: string; sdp: string }>("create_live_voice_session", { request }));
      if (this.ended) return;
      await peer.setRemoteDescription({ type: "answer", sdp: answer.sdp });
      // HTTP started the session. session.start must never be sent over WebRTC.
    } catch (error) { if (!this.ended) this.fail(error instanceof Error ? error.message : String(error)); }
  }
  private receive(raw: unknown) {
    if (this.ended || typeof raw !== "string" || raw.length > 100_000) return;
    let event: VoiceEvent;
    try { event = JSON.parse(raw) as VoiceEvent; } catch { return; }
    if (!event || typeof event.type !== "string") return;
    if (event.context_window !== undefined) {
      const ratio = voiceContextUsageRatio(event);
      if (ratio === undefined) delete event.context_window;
      else event.context_window = { usage_ratio: ratio };
    }
    if (event.type === "session.started") {
      this.started = true;
      this.timers.forEach(clearTimeout); this.timers.clear();
      if (this.closing) this.close(); else {
        // A mute selected while permission/network negotiation was in flight
        // also reaches the provider once its session accepts control messages.
        if (this.inputMuted) this.send("session.input_audio.mute");
        this.options.onStatus("listening");
      }
    }
    this.options.onEvent(event);
    if (event.type === "session.closed") { this.dispose(); this.options.onStatus("idle"); }
    if (event.type === "error") {
      // Closing cancels pending context injection. That expected acknowledgement
      // failure must not turn an intentionally ended call back into Listening.
      if (this.closing) return;
      const message = event.error?.message ?? "Voice rejected an update.";
      if (!this.started) this.fail(message); else this.options.onStatus("listening", message);
    }
  }
  private send(type: string, fields: Record<string, unknown> = {}) {
    if (!this.started || this.channel?.readyState !== "open" || this.ended) return false;
    try { this.channel.send(JSON.stringify({ type, event_id: crypto.randomUUID(), ...fields })); return true; }
    catch { this.fail("Voice connection closed before the update could be sent. Research is retained here."); return false; }
  }
  /** Caller buffers a complete useful update and verifies its job revision before sending.
   * A true return means locally sent only; append ACKs never establish spoken delivery.
   */
  append(kind: "commentary" | "thinking" | "instructions", text: string, delegationId: string | null = null): boolean {
    if (this.closing || !this.started || this.ended || this.channel?.readyState !== "open" || !text || text.length > 24_000) return false;
    for (const content of voiceAppendChunks(text)) if (!this.send(`session.${kind}.append`, { delegation_id: delegationId, content })) return false;
    return true;
  }
  private openActivityMonitor() {
    if (!this.options.onActivity) return;
    this.publishActivity({ inputActive: false, outputActive: false, measured: false, inputLevel: 0, outputLevel: 0, inputMeasured: false, outputMeasured: false, inputMuted: this.inputMuted });
    // GPT-Live has no speech-start/stop or audio-done events. Observe the existing
    // tracks locally; never acquire another microphone or route a second playback.
    try {
      const Context = globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Context) return;
      this.activityContext = new Context();
      void this.activityContext.resume().catch(() => undefined);
      this.activityInterval = setInterval(() => this.sampleActivity(), 1000 / 30);
    } catch { this.activityContext = undefined; }
  }
  private monitorAudio(kind: "input" | "output", stream: MediaStream) {
    if (!this.activityContext || this.ended || this.closing) return;
    try {
      this.activityChannels[kind]?.source.disconnect();
      this.activityChannels[kind]?.analyser.disconnect();
      const source = this.activityContext.createMediaStreamSource(stream);
      const analyser = this.activityContext.createAnalyser(); analyser.fftSize = 1024;
      source.connect(analyser); // No destination connection: normal WebRTC audio plays once.
      this.activityChannels[kind] = { source, analyser, stream, samples: new Float32Array(1024), envelope: new VoiceAudioEnvelope() };
    } catch { delete this.activityChannels[kind]; }
  }
  private sampleActivity() {
    if (this.ended || this.closing) return;
    const now = performance.now();
    const sample = (kind: "input" | "output") => {
      const channel = this.activityChannels[kind];
      const tracks = channel?.stream.getAudioTracks() ?? [];
      const measured = Boolean(channel && this.activityContext?.state === "running" && tracks.some(track => track.readyState !== "ended"));
      const enabled = measured && tracks.some(track => track.enabled && !track.muted && track.readyState !== "ended") && (kind === "input"
        ? !this.inputMuted
        : this.playbackReady && this.audio && !this.audio.muted && !this.audio.paused && this.audio.volume !== 0);
      if (!channel || !enabled) { channel?.envelope.reset(); return { active: false, level: 0, measured }; }
      try {
        channel.analyser.getFloatTimeDomainData(channel.samples);
        return { ...channel.envelope.sample(channel.samples, now), measured };
      } catch {
        channel.source.disconnect(); channel.analyser.disconnect(); delete this.activityChannels[kind];
        return { active: false, level: 0, measured: false };
      }
    };
    const input = sample("input"), output = sample("output");
    this.publishActivity({ inputActive: input.active, outputActive: output.active, measured: input.measured && output.measured, inputLevel: input.level, outputLevel: output.level, inputMeasured: input.measured, outputMeasured: output.measured, inputMuted: this.inputMuted });
  }
  private publishActivity(activity: VoiceActivity) {
    const key = JSON.stringify(activity);
    if (key !== this.lastActivity) { this.lastActivity = key; this.options.onActivity?.(activity); }
  }
  private closeActivityMonitor() {
    clearInterval(this.activityInterval); this.activityInterval = undefined;
    for (const channel of Object.values(this.activityChannels)) { channel.source.disconnect(); channel.analyser.disconnect(); }
    this.activityChannels = {};
    const context = this.activityContext; this.activityContext = undefined;
    if (context) void context.close().catch(() => undefined);
    this.playbackReady = false;
    this.publishActivity({ inputActive: false, outputActive: false, measured: false, inputLevel: 0, outputLevel: 0, inputMeasured: false, outputMeasured: false, inputMuted: this.inputMuted });
  }
  mute(muted: boolean) {
    this.inputMuted = muted;
    this.stream?.getAudioTracks().forEach(track => { track.enabled = !muted; });
    this.send(muted ? "session.input_audio.mute" : "session.input_audio.unmute");
    this.sampleActivity();
  }
  silence(silent: boolean) {
    if (this.audio) { this.audio.muted = silent; if (!silent) void this.audio.play().catch(() => undefined); }
    this.sampleActivity();
    if (silent) this.append("instructions", "Stop speaking now and continue listening. Research continues independently.");
  }
  private releaseCapture() {
    this.captureListeners.splice(0).forEach(remove => remove());
    const stream = this.stream; this.stream = undefined;
    stream?.getTracks().forEach(track => track.stop());
  }
  close() {
    if (this.ended || this.closing) return;
    this.closing = true; this.mute(true);
    this.closeActivityMonitor();
    this.releaseCapture();
    if (this.audio) this.audio.muted = true;
    this.options.onStatus("closing");
    if (this.send("session.close")) this.later(() => {
      this.dispose();
      this.options.onStatus("idle", "Voice stopped locally, but the service did not confirm the session ended. Final usage is unavailable.");
    }, 8_000);
    else { this.dispose(); this.options.onStatus("idle"); }
  }
  private fail(message: string) { if (this.ended) return; this.dispose(); this.options.onStatus("disconnected", message); }
  dispose() {
    this.ended = true; this.connectAbort.abort();
    this.closeActivityMonitor();
    this.releaseCapture();
    if (this.audio) {
      this.audio.onplaying = null; this.audio.onpause = null; this.audio.onwaiting = null; this.audio.onended = null;
      this.audio.pause(); this.audio.srcObject = null;
    }
    this.channel?.close(); this.peer?.close();
    this.timers.forEach(clearTimeout); this.timers.clear();
  }
}
