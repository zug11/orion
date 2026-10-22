import { VoiceDeliveryQueue, type VoiceDelivery, type QueuedVoiceDelivery } from "./voiceConversation";
import { VoiceDeliveryTiming } from "./voiceDeliveryTiming";
import type { VoiceActivity } from "./liveVoice";
import { preparedFindingReference, type PreparedVoiceFinding, type VoiceFindingSynthesizer, type VoiceSynthesisConversation } from "./voiceFindingSynthesis";

const COLLECTION_MS = 1_200;
const OFFER_GAP_MS = 8_000;
const SYNTHESIS_TIMEOUT_MS = 45_000;
type OfferState = "preparing" | "waiting" | "deferred" | "failed" | "shared";
interface Options {
  enabled: () => boolean;
  valid: (item: VoiceDelivery) => boolean;
  correcting: (item: VoiceDelivery) => boolean;
  sendReference?: (item: VoiceDelivery) => boolean;
  send: (item: VoiceDelivery) => boolean;
  synthesize?: VoiceFindingSynthesizer;
  conversation?: () => VoiceSynthesisConversation;
  sendPrepared?: (reference: string) => boolean;
  flushContext?: () => void;
  onChange?: () => void;
}
interface Preparation {
  items: QueuedVoiceDelivery[]; conversation: VoiceSynthesisConversation; controller: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
}
interface Prepared { items: QueuedVoiceDelivery[]; key: string; finding: PreparedVoiceFinding }

/** One inbox and background synthesis slot per main conversation. Worker
 * checkpoints continue independently; only prepared contributions reach voice. */
export class VoiceFindingScheduler {
  private readonly queue = new VoiceDeliveryQueue();
  private readonly timing = new VoiceDeliveryTiming();
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private lastOffer = -Infinity;
  private offers = new Map<string, { delivery: VoiceDelivery; state: OfferState }>();
  private preparation?: Preparation;
  private prepared?: Prepared;
  private suppressed = new WeakMap<VoiceDelivery, string>();
  private previousOffers: string[] = [];
  private contextPending = false;
  private references = new Map<string, VoiceDelivery>();
  constructor(private readonly options: Options) {}

  enqueue(item: VoiceDelivery) {
    this.discardInvalid();
    if (!this.options.valid(item)) return;
    this.queue.enqueue(item);
    if (item.id && item.completion) {
      const previous = this.offers.get(item.id)?.delivery;
      if (!previous || (item.revision ?? 0) > (previous.revision ?? 0) || item.revision === previous.revision && (item.sequence ?? 0) > (previous.sequence ?? 0)) {
        this.offers.set(item.id, { delivery: item, state: item.background && this.options.synthesize ? "preparing" : "waiting" }); this.options.onChange?.();
      }
    }
    this.wake();
  }
  status(id: string, revision: number) { const offer = this.offers.get(id); return offer?.delivery.revision === revision ? offer.state : undefined; }
  private mark(items: readonly VoiceDelivery[], state: OfferState) {
    let changed = false;
    for (const item of items) if (item.id && item.completion) {
      this.offers.set(item.id, { delivery: item, state }); changed = true;
    }
    if (changed) this.options.onChange?.();
  }
  discardInvalid(valid = this.options.valid) {
    this.queue.discardInvalid(valid);
    for (const [key, item] of this.references) if (!valid(item)) this.references.delete(key);
    if (this.preparation?.items.some(item => !valid(item) || this.options.correcting(item))) this.abortPreparation();
    if (this.prepared?.items.some(item => !valid(item) || this.options.correcting(item))) this.prepared = undefined;
    let changed = false;
    for (const [id, offer] of this.offers) if (!valid(offer.delivery)) { this.offers.delete(id); changed = true; }
    if (changed) this.options.onChange?.();
  }
  retrySummary(id: string) {
    const items = this.queue.eligible(this.options.valid, item => item.id === id);
    for (const item of items) this.suppressed.delete(item);
    this.mark(items, "preparing"); this.wake();
  }
  transcript(role: "user" | "assistant" = "user", quietForMs = 0, delta?: string) {
    this.timing.transcript(Date.now(), role, quietForMs, delta);
    this.wake();
  }
  audio(activity: VoiceActivity) { this.timing.audio(activity); this.wake(); }
  canUpdateContext() { return this.timing.contextSafe(); }
  contextChanged() { this.contextPending = true; this.wake(); }
  reference(item: VoiceDelivery) {
    if (!this.options.valid(item)) return;
    this.references.set(item.id ?? "conversation", item); this.contextChanged();
  }
  private abortPreparation() {
    const pending = this.preparation; this.preparation = undefined;
    if (pending) { clearTimeout(pending.timeout); pending.controller.abort(); }
  }
  clear() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined;
    this.abortPreparation(); this.prepared = undefined; this.queue.clear();
    this.offers.clear(); this.suppressed = new WeakMap(); this.previousOffers = [];
    this.lastOffer = -Infinity; this.contextPending = false; this.references.clear(); this.options.onChange?.();
  }
  reset() { this.clear(); this.timing.reset(); }
  /** Keep admitted findings, but never send an old recipient's prepared speech. */
  handoff() {
    this.epoch++; clearTimeout(this.timer); this.timer = undefined; this.timing.handoff();
    this.abortPreparation(); this.prepared = undefined;
  }
  private context() { return this.options.conversation?.() ?? { key: "", text: "" }; }
  private available(key: string) {
    return this.queue.eligible(this.options.valid, item => !this.options.correcting(item) && this.suppressed.get(item) !== key);
  }
  private startPreparation(items: QueuedVoiceDelivery[], conversation: VoiceSynthesisConversation) {
    const pending: Preparation = { items, conversation, controller: new AbortController() };
    this.preparation = pending; this.mark(items, "preparing");
    const failed = () => {
      if (this.preparation !== pending) return;
      this.abortPreparation();
      if (conversation.key === this.context().key) {
        const current = items.filter(item => this.options.valid(item));
        for (const item of current) this.suppressed.set(item, conversation.key);
        this.mark(current, "failed");
      }
      this.wake();
    };
    pending.timeout = setTimeout(failed, SYNTHESIS_TIMEOUT_MS);
    void Promise.resolve().then(() => this.options.synthesize!(items, conversation, this.previousOffers, pending.controller.signal)).then(finding => {
      if (this.preparation !== pending) return;
      clearTimeout(pending.timeout); this.preparation = undefined;
      // User steering, cancellation and newer checkpoints win even if transport
      // cancellation failed or the synthesiser completed on the same tick.
      if (conversation.key === this.context().key && items.every(item => this.options.valid(item) && !this.options.correcting(item))) {
        const captured = items.slice(0, finding.context.findings.length);
        this.prepared = { items: captured, key: conversation.key, finding };
        this.mark(captured, "waiting");
      }
      this.wake();
    }, failed);
  }
  private tick() {
    this.discardInvalid();
    const now = Date.now(), conversation = this.context();
    if (this.preparation && this.preparation.conversation.key !== conversation.key && this.timing.inputSettled(now)) this.abortPreparation();
    if (this.contextPending && this.canUpdateContext()) {
      this.contextPending = false; this.options.flushContext?.();
      for (const [key, item] of this.references) {
        if (this.options.correcting(item)) { this.contextPending = true; continue; }
        if (this.options.sendReference?.(item)) this.references.delete(key);
        else this.contextPending = true;
      }
    }
    if (this.prepared && this.prepared.key !== conversation.key) { this.mark(this.prepared.items, "preparing"); this.prepared = undefined; }
    const available = this.available(conversation.key);
    const explicit = available.find(item => !item.background);
    if (explicit && this.timing.canOffer(explicit.queuedAt, now, false, explicit.completion)) {
      this.offerDirect(explicit); return;
    }
    if (this.prepared) {
      const prepared = this.prepared;
      const included = prepared.items.filter((_, i) => prepared.finding.result.included.includes(`f${i + 1}`));
      if (!included.length) {
        for (const item of prepared.items) this.suppressed.set(item, conversation.key);
        this.mark(prepared.items, "deferred"); this.prepared = undefined;
      } else if (now - this.lastOffer >= OFFER_GAP_MS && this.timing.canOffer(Math.min(...included.map(item => item.queuedAt)), now, true, included.some(item => item.completion))) {
        if (this.options.sendPrepared?.(preparedFindingReference(prepared.finding))) {
          this.queue.remove(included); this.mark(included, "shared");
          const deferred = prepared.items.filter(item => !included.includes(item));
          for (const item of deferred) this.suppressed.set(item, conversation.key);
          this.mark(deferred, "deferred"); this.prepared = undefined;
          this.previousOffers = [...this.previousOffers, prepared.finding.result.reply].slice(-3);
          this.lastOffer = now; this.timing.offered(now, true, included.some(item => item.completion));
        }
      }
    }
    if (this.options.synthesize && !this.preparation && !this.prepared && this.timing.inputSettled(now)) {
      // An interim contribution with no renewed speech allowance must not occupy
      // the only preparation slot and strand later completions behind it.
      const items = this.available(conversation.key).filter(item => item.background)
        .sort((a, b) => Number(Boolean(b.completion)) - Number(Boolean(a.completion)) || a.queuedAt - b.queuedAt);
      if (items.length && this.timing.backgroundEligible(now, items.some(item => item.completion)) &&
        now - Math.min(...items.map(item => item.queuedAt)) >= COLLECTION_MS) this.startPreparation(items.slice(0, 4), conversation);
    } else if (!this.options.synthesize) {
      const first = available.find(item => this.timing.canOffer(item.queuedAt, now, item.background, item.completion));
      if (first) this.offerDirect(first);
    }
  }
  private offerDirect(item: QueuedVoiceDelivery) {
    if (item.reference !== undefined && !this.options.sendReference?.(item)) return;
    if (!this.options.send(item)) return;
    this.queue.remove([item]); this.mark([item], "shared");
    this.timing.offered(Date.now(), item.background, item.completion);
  }
  wake() {
    if (this.timer || !this.options.enabled()) return;
    // Deferred/failed summaries sleep until a new turn, newer finding or Retry.
    if (!this.contextPending && !this.prepared && !this.available(this.context().key).length) return;
    const epoch = this.epoch;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (epoch !== this.epoch || !this.options.enabled()) return;
      this.tick(); this.wake();
    }, 500);
  }
}
