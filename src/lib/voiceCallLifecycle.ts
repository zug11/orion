import { LiveVoiceConnection, type VoiceStatus, type VoiceTransportOptions } from "./liveVoice";
import { VoiceDeliveryTiming } from "./voiceDeliveryTiming";

type Transport = Pick<LiveVoiceConnection, "start" | "close" | "dispose" | "mute" | "append">;
const activeStatus = (status: VoiceStatus) => ["connecting", "listening", "closing"].includes(status);
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
  constructor(private readonly create = (options: VoiceTransportOptions): Transport => new LiveVoiceConnection(options)) {}

  get status() { return this.currentStatus; }
  get isActive() { return this.active; }
  get acceptsInput() { return this.accepting; }
  get canStart() { return !this.active && !activeStatus(this.currentStatus); }
  get isMuted() { return this.muted; }
  mute(value: boolean) { this.muted = value; this.connection?.mute(value); }
  rememberDelegation(id: string) {
    if (!this.accepting) return;
    this.delegations.add(id);
    if (this.delegations.size > 1_000) this.delegations.delete(this.delegations.values().next().value!);
  }
  delegation(id: string | null | undefined) { return id && this.accepting && this.delegations.has(id) ? id : null; }
  append(...args: Parameters<LiveVoiceConnection["append"]>) {
    return this.accepting && this.connection?.append(...args) === true;
  }

  open(options: VoiceTransportOptions) {
    if (!this.canStart) return false;
    this.dispose();
    this.active = this.accepting = true;
    const epoch = this.epoch;
    const current = () => epoch === this.epoch;
    const transport = this.create({ ...options,
      onEvent: event => {
        if (!current() || !this.accepting) return;
        if (event.type.endsWith("transcript.delta") && event.delta?.trim()) this.outputTiming.transcript(Date.now(), event.type === "session.output_transcript.delta" ? "assistant" : "user", 0, event.delta);
        options.onEvent(event);
      },
      onActivity: activity => { if (current() && this.accepting) {
        this.outputTiming.audio(activity); options.onActivity?.(activity);
      } },
      onStatus: (status, error) => {
        if (!current() || !this.accepting && (status === "connecting" || status === "listening")) return;
        this.currentStatus = status; this.active = activeStatus(status);
        if (!this.active) this.accepting = false;
        options.onStatus(status, error);
      },
    });
    this.connection = transport; transport.mute(this.muted);
    void transport.start().catch(reason => {
      if (!current() || !this.accepting) return;
      this.accepting = this.active = false; this.currentStatus = "disconnected";
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
  stop() { clearTimeout(this.handoffTimer); this.handoffTimer = undefined; this.accepting = false; this.connection?.close(); }
  /** Conversation text belongs to the caller; the old audio recipient goes quiet now. */
  pause() {
    const previous = this.connection;
    this.connection = undefined;
    this.dispose(); // fence callbacks before closing the departing recipient
    previous?.close(); previous?.dispose();
  }
  dispose() {
    clearTimeout(this.handoffTimer); this.handoffTimer = undefined; this.outputTiming.reset();
    this.epoch++; this.accepting = this.active = false; this.currentStatus = "idle";
    const previous = this.connection; this.connection = undefined;
    this.delegations.clear(); previous?.dispose();
  }
}
