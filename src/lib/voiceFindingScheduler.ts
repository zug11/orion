import { VoiceDeliveryQueue, type VoiceDelivery } from "./voiceConversation";
import { VoiceDeliveryTiming } from "./voiceDeliveryTiming";
import type { VoiceActivity } from "./liveVoice";
import { VOICE_FINDING_BATCH_GAP_MS, VOICE_FINDING_BATCH_LIMIT, VOICE_FINDING_BATCH_WINDOW_MS, voiceFindingBatch } from "./voiceFindingBatch";

interface Options {
  enabled: () => boolean;
  valid: (item: VoiceDelivery) => boolean;
  correcting: (item: VoiceDelivery) => boolean;
  sendReference?: (item: VoiceDelivery) => boolean;
  send: (item: VoiceDelivery) => boolean;
  sendBatch?: (reference: string) => boolean;
  onChange?: () => void;
}

/** Offers whole findings at conversational boundaries; never claims playback. */
export class VoiceFindingScheduler {
  private readonly queue = new VoiceDeliveryQueue();
  private readonly timing = new VoiceDeliveryTiming();
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private lastBatch = -Infinity;
  private offers = new Map<string, { delivery: VoiceDelivery; state: "waiting" | "shared" }>();
  constructor(private readonly options: Options) {}

  enqueue(item: VoiceDelivery) {
    this.discardInvalid();
    if (!this.options.valid(item)) return;
    this.queue.enqueue(item);
    if (item.id && item.completion) {
      const previous = this.offers.get(item.id)?.delivery;
      if (!previous || (item.revision ?? 0) > (previous.revision ?? 0) || item.revision === previous.revision && (item.sequence ?? 0) > (previous.sequence ?? 0)) {
        this.offers.set(item.id, { delivery: item, state: "waiting" }); this.options.onChange?.();
      }
    }
    this.wake();
  }
  status(id: string, revision: number) { const offer = this.offers.get(id); return offer?.delivery.revision === revision ? offer.state : undefined; }
  discardInvalid(valid = this.options.valid) {
    this.queue.discardInvalid(valid);
    let changed = false;
    for (const [id, offer] of this.offers) if (!valid(offer.delivery)) { this.offers.delete(id); changed = true; }
    if (changed) this.options.onChange?.();
  }
  private shared(items: readonly VoiceDelivery[]) {
    let changed = false;
    for (const item of items) {
      if (item.id && item.completion) { this.offers.set(item.id, { delivery: item, state: "shared" }); changed = true; }
    }
    if (changed) this.options.onChange?.();
  }
  transcript(role: "user" | "assistant" = "user", quietForMs = 0) { this.timing.transcript(Date.now(), role, quietForMs); this.wake(); }
  audio(activity: VoiceActivity) { this.timing.audio(activity); this.wake(); }
  clear() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.queue.clear();
    this.offers.clear(); this.lastBatch = -Infinity; this.options.onChange?.();
  }
  reset() { this.clear(); this.timing.reset(); }
  /** Internal audio handoff keeps admitted findings; explicit Stop uses reset. */
  handoff() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.timing.handoff();
  }
  wake() {
    if (this.timer || !this.queue.length || !this.options.enabled()) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (epoch !== this.epoch || !this.options.enabled()) return;
      this.discardInvalid();
      const now = Date.now();
      const eligible = this.queue.eligible(this.options.valid, item => !this.options.correcting(item) &&
        this.timing.canOffer(item.queuedAt, now, item.background, item.completion));
      // Explicit answers and save acknowledgements take precedence. Automatic
      // completions coalesce without waiting for every worker to finish.
      const first = eligible.find(item => !item.background) ?? eligible[0];
      if (first?.background && first.completion && this.options.sendBatch) {
        if (now - first.queuedAt < VOICE_FINDING_BATCH_WINDOW_MS || now - this.lastBatch < VOICE_FINDING_BATCH_GAP_MS) { this.wake(); return; }
        const batch = eligible.filter(item => item.background && item.completion).slice(0, VOICE_FINDING_BATCH_LIMIT);
        let reference = voiceFindingBatch(batch);
        while (!reference && batch.length > 1) { batch.pop(); reference = voiceFindingBatch(batch); }
        if (reference && batch.every(item => this.options.valid(item) && !this.options.correcting(item)) && this.options.sendBatch(reference)) {
          this.queue.remove(batch); this.shared(batch); this.lastBatch = now;
          this.timing.offered(now, true, true);
        }
      } else if (first) this.queue.flush(this.options.valid,
        item => {
          // Other workers may have supplied quiet context since this finding
          // arrived. Re-establish its exact provenance immediately before its
          // prose, and retain both if the new transport cannot accept them.
          if (item.reference !== undefined && (!this.options.sendReference || !this.options.sendReference(item))) return false;
          const sent = this.options.send(item);
          if (sent) { this.timing.offered(Date.now(), item.background, item.completion); this.shared([item]); }
          return sent;
        },
        item => item === first,
      );
      this.wake();
    }, 500);
  }
}
