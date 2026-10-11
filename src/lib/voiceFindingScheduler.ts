import { VoiceDeliveryQueue, type VoiceDelivery } from "./voiceConversation";
import { VoiceDeliveryTiming } from "./voiceDeliveryTiming";
import type { VoiceActivity } from "./liveVoice";

interface Options {
  enabled: () => boolean;
  valid: (item: VoiceDelivery) => boolean;
  correcting: (item: VoiceDelivery) => boolean;
  sendReference?: (item: VoiceDelivery) => boolean;
  send: (item: VoiceDelivery) => boolean;
}

/** Offers whole findings at conversational boundaries; never claims playback. */
export class VoiceFindingScheduler {
  private readonly queue = new VoiceDeliveryQueue();
  private readonly timing = new VoiceDeliveryTiming();
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  constructor(private readonly options: Options) {}

  enqueue(item: VoiceDelivery) { this.queue.enqueue(item); this.wake(); }
  discardInvalid(valid = this.options.valid) { this.queue.discardInvalid(valid); }
  transcript() { this.timing.transcript(); }
  audio(activity: VoiceActivity) { this.timing.audio(activity); this.wake(); }
  clear() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.queue.clear();
  }
  reset() { this.clear(); this.timing.reset(); }
  /** Internal audio handoff keeps admitted findings; explicit Stop uses reset. */
  handoff() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.timing.reset();
  }
  wake() {
    if (this.timer || !this.queue.length || !this.options.enabled()) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (epoch !== this.epoch || !this.options.enabled()) return;
      this.queue.flush(this.options.valid,
        item => {
          // Other workers may have supplied quiet context since this finding
          // arrived. Re-establish its exact provenance immediately before its
          // prose, and retain both if the new transport cannot accept them.
          if (item.reference !== undefined && (!this.options.sendReference || !this.options.sendReference(item))) return false;
          const sent = this.options.send(item);
          if (sent) this.timing.offered();
          return sent;
        },
        item => !this.options.correcting(item) && this.timing.canOffer(item.queuedAt),
      );
      this.wake();
    }, 500);
  }
}
