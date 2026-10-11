import type { VoiceTurn } from "./voiceConversation";
import type { VoiceWorkOrder } from "./voiceResearch";
import { MAX_VOICE_WORKERS_PER_REQUEST } from "./voiceWorkOrders";
import { requestedTaskView, type TaskView } from "./taskWorkingView";
import { voiceWorkOrderSummary } from "./voiceWorkOrderAccess";

export interface VoiceReservationClarification {
  readonly turn: VoiceTurn;
  readonly question: string;
  readonly workerCount?: number;
  /** A captured answer belongs to this question in this call, not its text. */
  readonly epoch: number;
  readonly revision: number;
}
interface TurnJobs { readonly id: string; readonly ids: readonly string[]; readonly prompt: string }
interface ReservationGroup {
  readonly turn: VoiceTurn;
  readonly jobs: readonly VoiceWorkOrder[];
  readonly revision: number;
}

/**
 * Owns only host reservations and their conversational identities. Provider
 * routing, admitted work, audio and React publication remain with their owners.
 * Every mutation replaces a group/question so in-flight answers keep the old
 * revision. A cancelled member cannot return through a same-sized later group.
 */
export class VoiceReservations {
  private readonly groups = new Map<number, ReservationGroup>();
  private readonly aliases = new Map<number, TurnJobs>();
  private readonly cancelled = new Set<number>();
  private question?: VoiceReservationClarification;
  private epoch = 0;
  private revision = 0;

  constructor(private readonly createId = () => "voice-" + crypto.randomUUID()) {}

  get clarification() { return this.question; }
  turn(key: number) { return this.aliases.get(key); }
  isCancelled(key: number) { return this.cancelled.has(key); }
  members(key: number): readonly VoiceWorkOrder[] { return this.groups.get(key)?.jobs ?? []; }
  jobs(excludingKey?: number): VoiceWorkOrder[] {
    return [...this.groups].flatMap(([key, group]) => key === excludingKey ? [] : group.jobs);
  }
  find(id: string, revision?: number) {
    for (const [key, group] of this.groups) {
      const job = group.jobs.find(job => job.id === id && (revision === undefined || job.revision === revision));
      if (job) return { key, job };
    }
  }
  /** Public inventory omits the captured transcript and selection entirely. */
  inventory(taskView: TaskView = "working") {
    return [...this.groups.values()].flatMap(group => group.jobs.map(job => voiceWorkOrderSummary(job, taskView, true)));
  }
  controlVersion(id: string) {
    for (const group of this.groups.values()) if (group.jobs.some(job => job.id === id)) return `reservation:${this.epoch}:${group.revision}`;
  }
  isReplay(turn: VoiceTurn, admitted: readonly VoiceWorkOrder[]) {
    const previous = this.aliases.get(turn.key);
    return previous?.prompt === turn.prompt && (admitted.some(job => previous.ids.includes(job.id))
      || this.members(turn.key).some(job => job.phase === "clarifying"));
  }

  private remember(turn: VoiceTurn, ids: readonly string[]) {
    this.aliases.set(turn.key, { id: ids[0], ids: [...ids], prompt: turn.prompt });
    // VoiceConversation retains the same bounded utterance history. This is not
    // a cap on pending groups or on admitted workers owned by VoiceResearch.
    while (this.aliases.size > 40) this.aliases.delete(this.aliases.keys().next().value!);
  }

  reserve(turn: VoiceTurn, count: number, phase: "routing" | "clarifying") {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_VOICE_WORKERS_PER_REQUEST || this.isCancelled(turn.key)) return false;
    const previous = this.groups.get(turn.key);
    // A fuller transcript may replace its prompt, never its original reference.
    const source = previous ? { ...previous.turn, prompt: turn.prompt } : structuredClone(turn);
    const revision = ++this.revision;
    const jobs = Array.from({ length: count }, (_, index): VoiceWorkOrder => ({
      id: previous?.jobs[index]?.id ?? this.createId(), revision: 1, prompt: source.prompt,
      subject: count > 1 ? `Worker ${index + 1}` : source.prompt.slice(0, 120), state: "running", phase,
      taskView: requestedTaskView(source.prompt),
      progress: phase === "clarifying" ? "Waiting for details" : "Understanding request", focusNoteId: source.focusNoteId,
      ...(source.selection ? { selection: source.selection } : {}),
    }));
    this.groups.set(turn.key, { turn: source, jobs, revision });
    this.remember(source, jobs.map(job => job.id));
    if (this.question?.turn.key === turn.key) {
      this.question = { ...this.question, turn: source, workerCount: count, revision };
    }
    return true;
  }

  ask(turn: VoiceTurn, question: string, workerCount?: number) {
    const group = this.groups.get(turn.key), revision = ++this.revision;
    const source = group?.turn ?? structuredClone(turn);
    if (group) this.groups.set(turn.key, { ...group, revision });
    this.question = { turn: source, question, workerCount, epoch: this.epoch, revision };
    return this.question;
  }
  clearClarification() { this.question = undefined; }
  isCurrent(answer: VoiceReservationClarification) {
    const group = this.groups.get(answer.turn.key);
    return answer.epoch === this.epoch && answer.revision === this.question?.revision
      && answer.turn.key === this.question?.turn.key && !this.isCancelled(answer.turn.key)
      && (!group || group.revision === answer.revision);
  }

  /** Returns the captured source only after atomically consuming a valid group. */
  handoff(turn: VoiceTurn, ids: readonly string[], answer?: VoiceReservationClarification, requireReservedCount = false): VoiceTurn | undefined {
    const sourceKey = answer?.turn.key ?? turn.key;
    const group = this.groups.get(sourceKey);
    if (!ids.length || ids.length > MAX_VOICE_WORKERS_PER_REQUEST || new Set(ids).size !== ids.length
      || this.isCancelled(turn.key) || this.isCancelled(sourceKey)) return;
    if (answer) {
      const reservedCount = group?.jobs.length ?? 0;
      if (!this.isCurrent(answer) || (requireReservedCount || reservedCount > 0) && reservedCount !== ids.length) return;
    }
    const source = group?.turn ?? answer?.turn ?? turn;
    this.remember(source, ids); this.remember(turn, ids);
    this.groups.delete(sourceKey); this.groups.delete(turn.key);
    if (answer || this.question?.turn.key === sourceKey) this.clearClarification();
    return source;
  }

  /** Cancelling/reassigning one member never changes the siblings' identities. */
  removeMember(id: string, reason: "cancel" | "correct") {
    const found = this.find(id);
    if (!found) return;
    const { key } = found, group = this.groups.get(key)!;
    // A member change invalidates the group's planner. Its siblings still own
    // their identities, but cannot remain labelled as actively understanding.
    const jobs = group.jobs.filter(job => job.id !== id).map(job => ({ ...job, phase: "clarifying" as const, progress: "Waiting for details" }));
    if (!jobs.length) {
      this.groups.delete(key); this.markCancelled(key);
      if (this.question?.turn.key === key) this.clearClarification();
    } else {
      const revision = ++this.revision;
      this.groups.set(key, { ...group, jobs, revision });
      this.remember(group.turn, jobs.map(job => job.id));
      if (reason === "cancel" || this.question?.turn.key !== key) {
        this.question = { turn: group.turn, question: "What should the remaining workers research?", workerCount: jobs.length, epoch: this.epoch, revision };
      } else if (this.question?.turn.key === key) {
        this.question = { ...this.question, workerCount: jobs.length, revision };
      }
    }
    return found;
  }

  markCancelled(key: number) { this.cancelled.add(key); }
  finishRoute(key: number) {
    if (!this.members(key).some(job => job.phase === "clarifying")) this.groups.delete(key);
  }
  expire(key: number) {
    this.groups.delete(key); this.markCancelled(key);
    if (this.question?.turn.key === key) this.clearClarification();
  }
  clearPending() {
    this.groups.clear(); this.clearClarification(); this.epoch++;
  }
  reset() {
    this.clearPending(); this.aliases.clear(); this.cancelled.clear();
  }
}
