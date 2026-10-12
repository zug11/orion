import type { VoiceTurn } from "./voiceConversation";
import type { VoiceReservationClarification } from "./voiceReservations";
import type { VoiceTurnDecision } from "./voiceWorkOrders";
import { VOICE_TURN_SETTLE_MS } from "./voiceUtterance";

export type RoutingVoiceTurn = VoiceTurn & { clarification?: VoiceReservationClarification };
interface Options {
  enabled: () => boolean;
  budget: (turn: RoutingVoiceTurn) => number;
  route: (turn: RoutingVoiceTurn, signal: AbortSignal) => Promise<VoiceTurnDecision>;
  decide: (turn: RoutingVoiceTurn, decision: VoiceTurnDecision) => void;
  failed: (reason: unknown) => void;
  expired: (turn: RoutingVoiceTurn) => void;
  settled: (turn: RoutingVoiceTurn) => void;
}
interface Running {
  turn: RoutingVoiceTurn;
  controller: AbortController;
  deadline: ReturnType<typeof setTimeout>;
}

/** One ordered interpretation stream; admitted research runs elsewhere. */
export class VoiceTurnRouter {
  private queue: RoutingVoiceTurn[] = [];
  private running?: Running;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  constructor(private readonly options: Options) {}

  get hasCapacity() { return this.queue.length < 8; }
  get pending(): readonly RoutingVoiceTurn[] { return [...this.queue, ...(this.running ? [this.running.turn] : [])]; }

  debounce(consider: () => void, delay = VOICE_TURN_SETTLE_MS) {
    clearTimeout(this.debounceTimer);
    const epoch = this.epoch;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      if (epoch === this.epoch && this.options.enabled()) consider();
    }, delay);
  }
  enqueue(turn: RoutingVoiceTurn) {
    if (!this.hasCapacity) return false;
    this.queue.push(turn); return true;
  }
  private abortWhere(matches: (turn: RoutingVoiceTurn) => boolean) {
    const removed = this.queue.filter(matches);
    this.queue = this.queue.filter(turn => !matches(turn));
    if (this.running && matches(this.running.turn)) {
      const active = this.running; this.running = undefined;
      clearTimeout(active.deadline); active.controller.abort(); removed.push(active.turn);
    }
    return removed;
  }
  replace(key: number) { this.abortWhere(turn => turn.key === key); }
  cancelReservation(key: number) {
    const removed = this.abortWhere(turn => turn.key === key || turn.clarification?.turn.key === key);
    // Let the owner update sibling reservations before the next interpretation.
    // An aborted provider that never settles must not block unrelated requests.
    const epoch = this.epoch;
    queueMicrotask(() => { if (epoch === this.epoch) this.pump(); });
    return removed.filter(turn => turn.key !== key).map(turn => turn.key);
  }
  clear() {
    this.epoch++; clearTimeout(this.debounceTimer); this.debounceTimer = undefined;
    this.abortWhere(() => true);
  }

  pump() {
    if (this.running || !this.queue.length || !this.options.enabled()) return;
    const turn = this.queue.shift()!, controller = new AbortController(), epoch = this.epoch;
    const current = () => this.running === active && epoch === this.epoch && !controller.signal.aborted;
    const active: Running = { turn, controller, deadline: setTimeout(() => {
      if (!current()) return;
      this.running = undefined; controller.abort();
      this.options.expired(turn); this.pump();
    }, this.options.budget(turn)) };
    this.running = active;
    // The microtask also turns synchronous driver failures into this route's
    // bounded error path, without capturing a new note or selection.
    void Promise.resolve().then(() => {
      if (current()) return this.options.route(turn, controller.signal);
    }).then(decision => {
      if (decision && current() && this.options.enabled()) this.options.decide(turn, decision);
    }).catch(reason => {
      if (current() && this.options.enabled()) this.options.failed(reason);
    }).finally(() => {
      clearTimeout(active.deadline);
      if (!current()) return;
      this.running = undefined; this.options.settled(turn); this.pump();
    });
  }
}
