import type { AppSnapshot } from "../types";
import { voiceNavigationContext, type VoiceReceipt, type VoiceWorkOrder } from "./voiceResearch";
import { voiceSelectionContext, type VoiceSelection } from "./voiceSelection";

interface VoiceContextBaseline {
  snapshot: AppSnapshot;
  focusNoteId?: string;
  jobs: readonly VoiceWorkOrder[];
  receipts?: readonly VoiceContextReceipt[];
  selection?: VoiceSelection;
}
export interface VoiceContextReceipt { id: string; revision: number; prompt: string; receipt: VoiceReceipt }
interface VoiceContextUpdate extends VoiceContextBaseline {
  conversation: string;
  /** Only an accepted user transcript may publish its bound selection. */
  userSpeaking?: boolean;
  /** Validated provider usage only; local estimates must not select pressure mode. */
  usageRatio?: number;
}
interface JobContext {
  id: string;
  revision: number;
  subject: string;
  prompt: string;
  promptTruncated: boolean;
  focusNoteId: string | null;
  state: VoiceWorkOrder["state"];
  phase: VoiceWorkOrder["phase"] | null;
  progress?: string;
  receipt: VoiceReceipt | null;
}

const CHECKPOINT_BYTES = 6_000;
const encoder = new TextEncoder();
const clip = (text: string, length: number) => Array.from(text).slice(0, length).join("");
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const navigationKey = ({ snapshot, focusNoteId }: VoiceContextBaseline) => JSON.stringify([
  snapshot.workspace.id, focusNoteId ?? null, snapshot.notes.some(note => note.id === focusNoteId),
]);
const receiptKey = (item: Pick<VoiceContextReceipt, "id" | "revision">) => JSON.stringify([item.id, item.revision]);
function receiptRecords(input: VoiceContextBaseline) {
  const records = new Map<string, VoiceContextReceipt>();
  for (const job of input.jobs) if (job.receipt) records.set(receiptKey(job), {
    id: job.id, revision: job.revision, prompt: job.prompt, receipt: job.receipt,
  });
  for (const receipt of input.receipts ?? []) records.set(receiptKey(receipt), receipt);
  return [...records.values()].slice(-24);
}
function projectReceipt(item: VoiceContextReceipt) {
  return { id: item.id, revision: item.revision, prompt: clip(item.prompt, 240),
    savedNoteIds: [...item.receipt.savedNoteIds], savedTitles: item.receipt.savedTitles.map(title => clip(title, 120)) };
}
function quotedConversation(text: string) {
  const marker = "Recorded user decisions/corrections (quoted context):\n";
  const start = text.startsWith(marker) ? marker.length : -1;
  const boundary = start >= 0 ? text.slice(start).search(/\n(?:user|assistant):/) : -1;
  const decisions = start >= 0 ? text.slice(start, boundary >= 0 ? start + boundary : undefined).trim() : "";
  const quotedDecisions = clip(decisions, 800);
  const recent = boundary >= 0 ? text.slice(start + boundary) : start >= 0 ? "" : text;
  const remaining = Math.max(0, 1_600 - quotedDecisions.length);
  return { quotedDecisions, decisionsTruncated: decisions !== quotedDecisions,
    quotedConversation: remaining ? recent.slice(-remaining) : "" };
}
function project(job: VoiceWorkOrder): JobContext {
  return { id: job.id, revision: job.revision, subject: clip(job.subject, 120),
    prompt: clip(job.prompt, 600), promptTruncated: Array.from(job.prompt).length > 600,
    focusNoteId: job.focusNoteId ?? null, state: job.state, phase: job.phase ?? null, progress: clip(job.progress, 180),
    receipt: job.receipt ? structuredClone(job.receipt) : null };
}

/** Only successfully appended context becomes a baseline. Results have their
 * own stamped delivery path and are never repeated by ordinary job updates.
 */
export class VoiceContextUpdates {
  private navigation: string | undefined;
  private jobs = new Map<string, JobContext>();
  private receipts = new Map<string, ReturnType<typeof projectReceipt>>();
  private checkpointSent = false;
  private usageRatio: number | undefined;
  private selection = "null";

  /** The connection's initial context already contains this navigation/jobs. */
  reset(input: VoiceContextBaseline) {
    this.navigation = navigationKey(input);
    this.jobs = new Map(input.jobs.map(job => [job.id, project(job)]));
    this.receipts = new Map(receiptRecords(input).map(item => [receiptKey(item), projectReceipt(item)]));
    this.checkpointSent = false;
    this.usageRatio = undefined;
    this.selection = JSON.stringify(voiceSelectionContext(input.selection, input.snapshot));
  }

  update(input: VoiceContextUpdate, send: (text: string) => boolean): number {
    const reportedRatio = typeof input.usageRatio === "number" && Number.isFinite(input.usageRatio) &&
      input.usageRatio >= 0 && input.usageRatio <= 1 ? input.usageRatio : undefined;
    if (reportedRatio !== undefined) this.usageRatio = reportedRatio;
    const ratio = this.usageRatio;
    const pressured = ratio !== undefined && ratio >= 0.8;
    if (ratio !== undefined && ratio < 0.75) this.checkpointSent = false;
    let sent = 0;
    const selectedText = voiceSelectionContext(input.selection, input.snapshot);
    const selectionKey = JSON.stringify(selectedText);
    if (input.userSpeaking && selectionKey !== this.selection && send(JSON.stringify({ type: "selection_update", referenceOnly: true,
      instruction: "Reference for the current spoken turn only. Do not speak or start work because this reference arrived. Use it only if the user refers to this passage; unrelated speech is not a request to discuss it.",
      spaceId: input.snapshot.workspace.id, selectedText }))) {
      this.selection = selectionKey; sent++;
    }
    const key = navigationKey(input);
    if (key !== this.navigation) {
      const currentNote = voiceNavigationContext(input.snapshot, input.focusNoteId).currentNote;
      const note = currentNote && pressured
        ? { id: currentNote.id, title: currentNote.title, version: currentNote.version, passages: [],
          complete: false, offsetUnit: currentNote.offsetUnit, taskView: currentNote.taskView, excerptsOmitted: true }
        : currentNote;
      if (send(JSON.stringify({ type: "navigation_update", referenceOnly: true,
        spaceId: input.snapshot.workspace.id, currentNote: note }))) {
        this.navigation = key; sent++;
      }
    }

    const next = new Map(input.jobs.map(job => [job.id, project(job)]));
    const accepted = new Map(this.jobs);
    const changes: Record<string, unknown>[] = [];
    for (const [id, job] of next) {
      const previous = this.jobs.get(id);
      const change: Record<string, unknown> = { id, revision: job.revision };
      const updated = { ...(previous ?? { id, revision: job.revision }) } as JobContext;
      for (const field of Object.keys(job) as (keyof JobContext)[]) {
        if (field === "id" || field === "revision" || (pressured && field === "progress")) continue;
        if (!previous || !equal(previous[field], job[field])) {
          change[field] = job[field];
          Object.assign(updated, { [field]: job[field] });
        }
      }
      if (!previous || previous.revision !== job.revision || Object.keys(change).length > 2) {
        changes.push(change); updated.revision = job.revision; accepted.set(id, updated);
      }
    }
    for (const [id, job] of this.jobs) if (!next.has(id)) {
      changes.push({ id, revision: job.revision, removed: true }); accepted.delete(id);
    }
    if (changes.length && send(JSON.stringify({ type: "work_order_update", referenceOnly: true,
      spaceId: input.snapshot.workspace.id, jobs: changes }))) {
      this.jobs = accepted; sent++;
      for (const change of changes) if (change.receipt) {
        const job = input.jobs.find(item => item.id === change.id && item.revision === change.revision);
        if (job?.receipt) this.receipts.set(receiptKey(job), projectReceipt({ ...job, receipt: job.receipt }));
      }
    }
    const receiptChanges = receiptRecords(input).filter(item => !equal(this.receipts.get(receiptKey(item)), projectReceipt(item)));
    if (receiptChanges.length && send(JSON.stringify({ type: "confirmed_receipt_update", referenceOnly: true,
      spaceId: input.snapshot.workspace.id, receipts: receiptChanges.map(projectReceipt) }))) {
      for (const item of receiptChanges) this.receipts.set(receiptKey(item), projectReceipt(item));
      sent++;
    }
    while (this.receipts.size > 24) this.receipts.delete(this.receipts.keys().next().value!);

    if (ratio !== undefined && ratio >= 0.85 && !this.checkpointSent && send(this.checkpoint(input))) {
      this.checkpointSent = true; sent++;
    }
    return sent;
  }

  private checkpoint(input: VoiceContextUpdate): string {
    const note = input.snapshot.notes.find(item => item.id === input.focusNoteId);
    const active = input.jobs.filter(job => job.state === "running").map(job => ({ id: job.id,
      revision: job.revision, phase: job.phase ?? null, prompt: clip(job.prompt, 240), focusNoteId: job.focusNoteId ?? null }));
    const terminal = input.jobs.filter(job => job.state !== "running").slice(-3).map(job => ({
      id: job.id, revision: job.revision, state: job.state,
      finding: job.state === "completed" && job.result ? clip(job.result.reply, 350) : undefined,
    }));
    const receipts = receiptRecords(input).slice(-6).map(item => ({ id: item.id,
      revision: item.revision, savedNoteIds: item.receipt.savedNoteIds,
      savedTitles: item.receipt.savedTitles.map(title => clip(title, 100)) }));
    const packet = { type: "conversation_checkpoint", referenceOnly: true,
      instruction: "Continue the current conversation. These are existing assignments and confirmed saves, not new requests. Do not rerun jobs, resave notes, reconnect, or announce this checkpoint.",
      spaceId: input.snapshot.workspace.id, currentNoteId: note?.id ?? null,
      ...quotedConversation(input.conversation), activeJobs: active,
      recentJobs: terminal, confirmedReceipts: receipts, omittedRecords: 0 };
    const serialize = () => JSON.stringify(packet);
    while (encoder.encode(serialize()).length > CHECKPOINT_BYTES) {
      if (packet.quotedConversation.length) packet.quotedConversation = packet.quotedConversation.slice(Math.ceil(packet.quotedConversation.length / 2));
      else if (terminal.length) { terminal.shift(); packet.omittedRecords++; }
      else if (receipts.length) { receipts.shift(); packet.omittedRecords++; }
      else if (active.some(job => job.prompt.length > 80)) active.forEach(job => { job.prompt = clip(job.prompt, 80); });
      else if (active.length) { active.shift(); packet.omittedRecords++; }
      else break;
    }
    // Valid vault IDs are bounded; fail closed if malformed caller metadata by
    // itself would exceed the transport budget, preserving exact IDs otherwise.
    return encoder.encode(serialize()).length <= CHECKPOINT_BYTES ? serialize() : JSON.stringify({
      type: "conversation_checkpoint", referenceOnly: true, omittedRecords: input.jobs.length,
      instruction: "Continue the current conversation. Existing work remains unchanged. Metadata exceeded the checkpoint budget; do not restart work or announce this checkpoint.",
    });
  }
}
