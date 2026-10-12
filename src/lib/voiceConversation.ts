import type { VoiceEvent } from "./liveVoice";
import type { VoiceSelection } from "./voiceSelection";
import { explicitVoiceAssignment, type VoiceFocusedWorker } from "./voiceWorkOrders";
import { unfinishedVoiceThought, voiceTurnSettleMs, VOICE_THOUGHT_CONTINUATION_MS, VOICE_TURN_SETTLE_MS } from "./voiceUtterance";

interface Fragment { id: number; role: "user" | "assistant"; text: string; start: number; end: number; focusNoteId?: string; selection?: VoiceSelection; focusedWorker?: VoiceFocusedWorker }
export interface VoiceTurn { key: number; prompt: string; delegationId: string | null; delegated: boolean; focusNoteId?: string; selection?: VoiceSelection; focusedWorker?: VoiceFocusedWorker }

/** Transcripts are fragments on a session timeline, not complete work orders. */
export class VoiceConversation {
  private fragments: Fragment[] = [];
  private nextId = 0;
  private carry = "";
  private delegations = new Map<string, number | null>();
  private handled = new Map<number, { text: string; delegated: boolean }>();
  private seen = new Set<string>();
  private seenDelegations = new Set<string>();
  private decisions: string[] = [];
  private opened = false;

  text() { return [this.decisions.length ? `Recorded user decisions/corrections (quoted context):\n${this.decisions.join("\n")}` : "", [this.carry, ...this.fragments.map(item => `${item.role}: ${item.text}`)].join("\n").slice(-6_000)].join("\n").slice(-8_000); }
  remember(prompt: string, correction = false) {
    if (!correction && !/\b(?:we agreed|let'?s (?:use|keep|make|go with)|i (?:want|prefer)|that'?s (?:right|what i mean))\b/i.test(prompt)) return;
    this.decisions = [...this.decisions.filter(item => item !== prompt), prompt.slice(0, 250)].slice(-6);
  }
  reconnect() {
    const welcome = !this.opened && !this.text().trim();
    this.opened = true;
    this.carry = [this.carry, ...this.fragments.map(item => `${item.role}: ${item.text}`)].join("\n").slice(-6_000); this.fragments = []; this.delegations.clear();
    this.handled.clear(); this.seen.clear(); this.seenDelegations.clear();
    return welcome;
  }
  clear() { this.carry = ""; this.fragments = []; this.delegations.clear(); this.handled.clear(); this.seen.clear(); this.seenDelegations.clear(); this.decisions = []; this.opened = false; }
  stop() { this.delegations.clear(); }
  /** The first fragment owns this reference throughout the utterance. */
  get userSelection() { return [...this.fragments].reverse().find(item => item.role === "user")?.selection; }
  get settleMs() { return voiceTurnSettleMs([...this.fragments].reverse().find(item => item.role === "user")?.text ?? ""); }
  /** Bounded exact user text for suppressing a cancelled delayed delegation. */
  recentTurns(): Pick<VoiceTurn, "key" | "prompt" | "delegated">[] {
    return this.fragments.filter(item => item.role === "user" && item.text.trim())
      .sort((a, b) => a.start - b.start || a.id - b.id)
      .map(item => ({ key: item.id, prompt: item.text.trim(), delegated: this.handled.get(item.id)?.delegated ?? false }));
  }
  receive(event: VoiceEvent, focusNoteId?: string, selection?: VoiceSelection, focusedWorker?: VoiceFocusedWorker): boolean {
    if (event.event_id) {
      if (this.seen.has(event.event_id)) return false;
      this.seen.add(event.event_id);
      if (this.seen.size > 1_000) this.seen.delete(this.seen.values().next().value!);
    }
    if (event.type === "session.delegation.created" && typeof event.delegation?.id === "string") {
      const id = event.delegation.id;
      if (!id || id.length > 200 || this.seenDelegations.has(id)) return false;
      this.seenDelegations.add(id);
      if (this.seenDelegations.size > 1_000) this.seenDelegations.delete(this.seenDelegations.values().next().value!);
      this.delegations.set(id, Number.isFinite(event.offset_ms) ? event.offset_ms! : null);
      if (this.delegations.size > 12) this.delegations.delete(this.delegations.keys().next().value!);
      return true;
    }
    if (!["session.input_transcript.delta", "session.output_transcript.delta"].includes(event.type) ||
        typeof event.delta !== "string" || !event.delta || event.delta.length > 100_000 ||
        !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms) || event.start_ms! < 0 || event.end_ms! < event.start_ms!) return false;
    const role = event.type === "session.input_transcript.delta" ? "user" : "assistant";
    const start = event.start_ms!, end = event.end_ms!;
    // Full-duplex assistant backchannels must not split one user's utterance.
    const recent = [...this.fragments].reverse().find(item => item.role === role);
    // Use the same silence boundary for live and batched transcripts. Once
    // dispatched, a new explicit assignment also starts its own turn.
    const continuation = role === "user" && recent && unfinishedVoiceThought(recent.text) &&
      start - recent.end < VOICE_THOUGHT_CONTINUATION_MS && !explicitVoiceAssignment(event.delta);
    const separate = role === "user" && recent && !continuation && (start - recent.end >= VOICE_TURN_SETTLE_MS ||
      this.handled.has(recent.id) && explicitVoiceAssignment(event.delta));
    if (recent?.role === role && !separate && start >= recent.start && (continuation || start - recent.end < 1_500)) {
      // Preserve the opening qualifications. The extra character triggers the
      // router's explicit overlength clarification instead of authorizing a tail.
      const separator = continuation && start - recent.end >= VOICE_TURN_SETTLE_MS && !/\s$/.test(recent.text) && !/^\s|^[,.!?]/.test(event.delta) ? " " : "";
      recent.text = (recent.text + separator + event.delta).slice(0, 4_001); recent.end = Math.max(recent.end, end);
    } else this.fragments.push({ id: ++this.nextId, role, text: event.delta.slice(0, 4_001), start, end, focusNoteId,
      ...(role === "user" && selection ? { selection: structuredClone(selection) } : {}),
      ...(role === "user" && focusedWorker ? { focusedWorker: { ...focusedWorker } } : {}) });
    this.fragments = this.fragments.slice(-40);
    const retained = new Set(this.fragments.map(item => item.id));
    for (const key of this.handled.keys()) if (!retained.has(key)) this.handled.delete(key);
    return true;
  }
  /** Called after a silence/debounce window; an early delegation remains pending. */
  takeTurns(): VoiceTurn[] {
    // Keep unfinished text and its captured target for a later continuation.
    // A provider delegation is not proof that the person finished the sentence.
    const users = this.fragments.filter(item => item.role === "user" && !unfinishedVoiceThought(item.text));
    const turns = new Map<number, VoiceTurn>();
    for (const [id, offset] of this.delegations) {
      const target = [...users].reverse().find(item => offset === null || (item.start <= offset && item.end >= offset - 1_500));
      if (!target) continue;
      const handled = this.handled.get(target.id);
      this.delegations.delete(id);
      if (handled?.delegated && handled.text === target.text.trim()) continue;
      if (!turns.has(target.id)) turns.set(target.id, { key: target.id, prompt: target.text.trim(), delegationId: id, delegated: true, focusNoteId: target.focusNoteId, ...(target.selection ? { selection: target.selection } : {}), ...(target.focusedWorker ? { focusedWorker: target.focusedWorker } : {}) });
    }
    // Several complete utterances can arrive before the debounce fires. Keep
    // every unseen turn, including local controls that have no delegation.
    for (const user of users) {
      if (user.text.trim() && this.handled.get(user.id)?.text !== user.text.trim() && !turns.has(user.id)) {
        turns.set(user.id, { key: user.id, prompt: user.text.trim(), delegationId: null, delegated: this.handled.get(user.id)?.delegated ?? false, focusNoteId: user.focusNoteId, ...(user.selection ? { selection: user.selection } : {}), ...(user.focusedWorker ? { focusedWorker: user.focusedWorker } : {}) });
      }
    }
    for (const turn of turns.values()) this.handled.set(turn.key, { text: turn.prompt, delegated: turn.delegated || this.handled.get(turn.key)?.delegated === true });
    // Delegation events may arrive out of order. Their arrival order must not
    // reorder corrections or cancellations relative to the user's speech.
    return users.sort((a, b) => a.start - b.start || a.id - b.id).flatMap(user => {
      const turn = turns.get(user.id);
      return turn ? [turn] : [];
    });
  }
}

export interface VoiceDelivery { text: string; delegationId: string | null; id?: string; revision?: number; sequence?: number; reference?: string; background?: boolean; completion?: boolean }
export type QueuedVoiceDelivery = VoiceDelivery & { queuedAt: number };

/** Buffer a whole update before transport chunking; never interpret an ACK as speech. */
export class VoiceDeliveryQueue {
  private queue: QueuedVoiceDelivery[] = [];
  private newest = new Map<string, VoiceDelivery & { revision: number; sequence: number }>();
  enqueue(delivery: VoiceDelivery) {
    if (delivery.id && delivery.revision !== undefined && delivery.sequence !== undefined) {
      const previous = this.newest.get(delivery.id);
      if (previous && (previous.revision > delivery.revision ||
        previous.revision === delivery.revision && previous.sequence >= delivery.sequence)) return;
      this.newest.set(delivery.id, { ...delivery, revision: delivery.revision, sequence: delivery.sequence });
    }
    // Coalescing new findings must not keep restarting the maximum delivery wait.
    const queuedAt = this.queue.find(item => item.id && item.id === delivery.id && item.revision === delivery.revision)?.queuedAt ?? Date.now();
    if (delivery.id) this.queue = this.queue.filter(item => item.id !== delivery.id);
    // Job retention is owned by research (24 terminal + active workers), not a
    // smaller speech limit. Only the latest unscoped conversational prompt lives
    // here; it carries no retained work result.
    else this.queue = this.queue.filter(item => item.id);
    this.queue.push({ ...delivery, queuedAt });
  }
  discardInvalid(valid: (delivery: VoiceDelivery) => boolean) {
    this.queue = this.queue.filter(valid);
    for (const [id, item] of this.newest) if (!valid(item)) this.newest.delete(id);
  }
  eligible(valid: (delivery: VoiceDelivery) => boolean, eligible: (delivery: QueuedVoiceDelivery) => boolean) {
    this.discardInvalid(valid);
    return this.queue.filter(eligible);
  }
  remove(items: readonly VoiceDelivery[]) { this.queue = this.queue.filter(item => !items.includes(item)); }
  flush(
    valid: (delivery: VoiceDelivery) => boolean,
    send: (delivery: VoiceDelivery) => boolean,
    eligible: (delivery: QueuedVoiceDelivery) => boolean = () => true,
  ) {
    this.discardInvalid(valid);
    // A correction holds only its own finding. Keep it in order while offering
    // the oldest eligible queued update from another worker.
    const next = this.queue.find(eligible);
    if (next && send(next)) this.queue = this.queue.filter(item => item !== next);
    return this.queue.length;
  }
  clear() { this.queue = []; this.newest.clear(); }
  get next() { return this.queue[0]; }
  get length() { return this.queue.length; }
}
