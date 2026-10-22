import { LiveVoiceConnection, type VoiceStatus, type VoiceTransportOptions } from "./liveVoice";
import { VoiceDeliveryTiming } from "./voiceDeliveryTiming";

type Transport = Pick<LiveVoiceConnection, "start" | "close" | "dispose" | "mute" | "append">;
const activeStatus = (status: VoiceStatus) => ["connecting", "listening", "closing"].includes(status);
const WELCOME_DELAY_MS = 2_000;
const WELCOME = 'One-time opening: if the user has not begun speaking, greet them briefly in English: "Hey, where would you like to start?" Then stop and listen. If they have begun, skip the greeting and respond to them normally. Do not mention notes, suggest a topic, delegate work, or ask a second question. Never repeat this opening during this conversation.';

/** One audio recipient per window, with callbacks fenced to its exact call. */
export class VoiceCallLifecycle {
  private connection?: Transport;
  private epoch = 0;
  private currentStatus: VoiceStatus = "idle";
  private active = false;
  private accepting = false;
  private muted = false;
  private readonly delegations = new Set<string>();
  private readonly outputTiming = new VoiceDeliveryTiming();
  private handoffTimer?: ReturnType<typeof setTimeout>;
  private welcomeTimer?: ReturnType<typeof setTimeout>;
  private welcomePending = false;
  constructor(private readonly create = (options: VoiceTransportOptions): Transport => new LiveVoiceConnection(options)) {}

  get status() { return this.currentStatus; }
  get isActive() { return this.active; }
  get acceptsInput() { return this.accepting; }
  get canStart() { return !this.active && !activeStatus(this.currentStatus); }
  get isMuted() { return this.muted; }
  mute(value: boolean) { this.muted = value; if (value) this.cancelWelcome(); this.connection?.mute(value); }
  rememberDelegation(id: string) {
    if (!this.accepting) return;
    this.delegations.add(id);
    if (this.delegations.size > 1_000) this.delegations.delete(this.delegations.values().next().value!);
  }
  delegation(id: string | null | undefined) { return id && this.accepting && this.delegations.has(id) ? id : null; }
  append(...args: Parameters<LiveVoiceConnection["append"]>) {
    if (args[0] === "commentary") this.cancelWelcome();
    return this.accepting && this.connection?.append(...args) === true;
  }

  private cancelWelcome() {
    clearTimeout(this.welcomeTimer); this.welcomeTimer = undefined; this.welcomePending = false;
  }
  private scheduleWelcome(epoch: number) {
    if (!this.welcomePending || this.welcomeTimer || this.muted) return;
    this.welcomeTimer = setTimeout(() => {
      const eligible = this.welcomePending && epoch === this.epoch && this.accepting && this.currentStatus === "listening" && !this.muted;
      this.cancelWelcome();
      // A single trusted instruction, after session.started. It is an offer to
      // greet, not a synthetic user turn, a retry loop or proof of playback.
      if (eligible) this.append("instructions", WELCOME, null);
    }, WELCOME_DELAY_MS);
  }

  open(options: VoiceTransportOptions, welcome = false) {
    if (!this.canStart) return false;
    this.dispose();
    this.active = this.accepting = true;
    this.welcomePending = welcome && !this.muted;
    const epoch = this.epoch;
    const current = () => epoch === this.epoch;
    const transport = this.create({ ...options,
      onEvent: event => {
        if (!current() || !this.accepting) return;
        if ((event.type.endsWith("transcript.delta") && event.delta?.trim()) || event.type === "session.delegation.created") this.cancelWelcome();
        if (event.type.endsWith("transcript.delta") && event.delta?.trim()) this.outputTiming.transcript(Date.now(), event.type === "session.output_transcript.delta" ? "assistant" : "user", 0, event.delta);
        options.onEvent(event);
      },
      onActivity: activity => { if (current() && this.accepting) {
        if (activity.inputActive || activity.outputActive) this.cancelWelcome();
        this.outputTiming.audio(activity); options.onActivity?.(activity);
      } },
      onStatus: (status, error) => {
        if (!current() || !this.accepting && (status === "connecting" || status === "listening")) return;
        this.currentStatus = status; this.active = activeStatus(status);
        if (!this.active) this.accepting = false;
        options.onStatus(status, error);
        if (!current()) return;
        if (status === "listening") this.scheduleWelcome(epoch);
        else if (status === "closing" || status === "idle" || status === "disconnected") this.cancelWelcome();
      },
    });
    this.connection = transport; transport.mute(this.muted);
    void transport.start().catch(reason => {
      if (!current() || !this.accepting) return;
      this.accepting = this.active = false; this.currentStatus = "disconnected";
      this.cancelWelcome();
      transport.dispose(); options.onStatus("disconnected", reason instanceof Error ? reason.message : String(reason));
    });
    return true;
  }
  /** Automatic stale-result handback must not tear down a sentence in progress. */
  handoffWhenQuiet(action: () => void) {
    clearTimeout(this.handoffTimer);
    const epoch = this.epoch;
    const check = () => {
      this.handoffTimer = undefined;
      if (epoch !== this.epoch || !this.accepting) return;
      if (this.outputTiming.outputQuiet()) action();
      else this.handoffTimer = setTimeout(check, 250);
    };
    check();
  }
  stop() { this.cancelWelcome(); clearTimeout(this.handoffTimer); this.handoffTimer = undefined; this.accepting = false; this.connection?.close(); }
  /** Conversation text belongs to the caller; the old audio recipient goes quiet now. */
  pause() {
    const previous = this.connection;
    this.connection = undefined;
    this.dispose(); // fence callbacks before closing the departing recipient
    previous?.close(); previous?.dispose();
  }
  dispose() {
    this.cancelWelcome();
    clearTimeout(this.handoffTimer); this.handoffTimer = undefined; this.outputTiming.reset();
    this.epoch++; this.accepting = this.active = false; this.currentStatus = "idle";
    const previous = this.connection; this.connection = undefined;
    this.delegations.clear(); previous?.dispose();
  }
}
