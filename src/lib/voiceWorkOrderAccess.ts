import type { ChatReadRequest, ChatCoverage, ChatEvidence, ChatResult } from "../types";
import type { TaskView } from "./taskWorkingView";
import type { ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import type { VoiceWorkOrder } from "./voiceResearch";

export interface VoiceExternalAuthority { grantId: string; taskView: TaskView; assertCurrent: () => Promise<void> }
export interface VoiceWorkOrderSummary {
  id: string; revision: number; state: VoiceWorkOrder["state"]; phase?: VoiceWorkOrder["phase"];
  taskView: TaskView; subject: string; subjectTruncated: boolean;
  stage: "routing" | "clarifying" | "queued" | "researching" | "completed" | "failed" | "cancelled";
  current: boolean; checkpointSequence: number; savedNoteIds: string[]; historyWithheld: boolean;
}
export interface VoicePublicText { fragments: { from: number; to: number; text: string }[]; complete: boolean; omittedChars: number }
export interface VoicePublicEvidence {
  id: string; kind: "note" | "source" | "web"; web?: ChatEvidence["web"]; entityId: string; title: string; version: string;
  start: number; end: number; text: string; offsetUnit: "utf16"; complete: boolean; omittedChars: number;
}
export interface VoicePublicFinding {
  sequence?: number; text: VoicePublicText; evidence: VoicePublicEvidence[]; coverage?: ChatCoverage; omittedEvidence: number;
}
export interface VoicePublicOperation { kind: ChatReadRequest["kind"]; entityId?: string }
export interface VoiceWorkOrderDetail extends VoiceWorkOrderSummary {
  referenceOnly: true; withheld?: "history" | "stale";
  result?: VoicePublicFinding; findings: VoicePublicFinding[];
  decisions: VoicePublicText[]; openQuestions: VoicePublicText[];
  nextSteps: VoicePublicOperation[]; completedOperations: VoicePublicOperation[];
  omissions: { findings: number; decisions: number; openQuestions: number; nextSteps: number; completedOperations: number };
}
export interface VoiceWorkOrderControlReceipt {
  id: string; revision: number; action: "cancel" | "retry" | "steer";
  state: VoiceWorkOrder["state"]; changed: boolean; readOnly?: true;
}
export const MAX_VOICE_PUBLIC_CHARS = 12_000;
const characters = (text: string) => [...text];

export function voiceWorkOrderSummary(job: VoiceWorkOrder, taskView: TaskView, current: boolean): VoiceWorkOrderSummary {
  const historyWithheld = job.taskView === "history" && taskView !== "history";
  const subject = historyWithheld ? "History research" : !current ? "Stale research" : characters(job.subject).slice(0, 120).join("");
  return { id: job.id, revision: job.revision, state: job.state, ...(job.phase ? { phase: job.phase } : {}),
    taskView: job.taskView ?? "working", subject, subjectTruncated: current && !historyWithheld && subject !== job.subject,
    stage: job.phase ?? (job.state === "running" ? "researching" : job.state), current,
    checkpointSequence: job.checkpointSequence ?? 0, savedNoteIds: job.receipt?.savedNoteIds.slice(0, 3) ?? [], historyWithheld };
}

/** Projection consumes a single shared Unicode-character budget. Opaque IDs,
 * finite stage/state values and numerical counts are metadata, never prose.
 * Source titles stay exact; an entry that cannot include its title is omitted. */
export function voiceWorkOrderDetail(job: VoiceWorkOrder, checkpoint: ChatReadingCheckpoint | undefined,
  options: { taskView: TaskView; maxChars: number; current: boolean }): VoiceWorkOrderDetail {
  if (!["working", "history"].includes(options.taskView) || !Number.isSafeInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > MAX_VOICE_PUBLIC_CHARS) {
    throw new Error("Voice work-order detail requires working/history and maxChars from 1 to 12000.");
  }
  const summary = voiceWorkOrderSummary(job, options.taskView, options.current);
  let remaining = options.maxChars;
  // Metadata's authored subject shares the budget, keeping even maxChars=1 honest.
  const subject = characters(summary.subject).slice(0, Math.min(120, Math.max(1, Math.floor(remaining / 8)))).join("");
  remaining -= characters(subject).length;
  const detail: VoiceWorkOrderDetail = { ...summary, subject, subjectTruncated: summary.subjectTruncated || subject !== summary.subject,
    referenceOnly: true, findings: [], decisions: [], openQuestions: [], nextSteps: [], completedOperations: [],
    omissions: { findings: job.updates?.length ?? 0, decisions: checkpoint?.decisions.length ?? 0,
      openQuestions: checkpoint?.openQuestions.length ?? 0, nextSteps: checkpoint?.pendingReads.length ?? 0, completedOperations: checkpoint?.completedOperations.length ?? 0 } };
  if (summary.historyWithheld || !options.current) { detail.withheld = summary.historyWithheld ? "history" : "stale"; return detail; }
  const text = (value: string, limit = remaining): VoicePublicText => {
    const all = characters(value), take = Math.min(all.length, remaining, limit);
    remaining -= take;
    if (take === all.length) return { fragments: value ? [{ from: 0, to: value.length, text: value }] : [], complete: true, omittedChars: 0 };
    const head = all.slice(0, Math.ceil(take / 2)).join(""), tail = take > 1 ? all.slice(-(take - Math.ceil(take / 2))).join("") : "";
    return { fragments: [...(head ? [{ from: 0, to: head.length, text: head }] : []), ...(tail ? [{ from: value.length - tail.length, to: value.length, text: tail }] : [])], complete: false, omittedChars: all.length - take };
  };
  const finding = (result: ChatResult, sequence?: number): VoicePublicFinding => {
    const projected: VoicePublicFinding = { ...(sequence !== undefined ? { sequence } : {}),
      text: text(result.reply, Math.ceil(remaining / 2)), evidence: [], ...(result.coverage ? { coverage: { ...result.coverage } } : {}),
      omittedEvidence: result.evidence?.length ?? 0 };
    for (const entry of (result.evidence ?? []).slice(0, 12)) {
      const titleSize = characters(entry.title).length + (entry.web ? characters(entry.web.url + entry.web.retrievedAt + (entry.web.publishedAt ?? "")).length : 0);
      if (titleSize >= remaining || !validEvidence(entry)) continue;
      remaining -= titleSize;
      const passage = characters(entry.text).slice(0, remaining).join("");
      remaining -= characters(passage).length;
      projected.evidence.push({ id: entry.id, kind: entry.kind, entityId: entry.entityId, title: entry.title,
        ...(entry.web ? { web: entry.web } : {}),
        version: entry.version, start: entry.start, end: entry.start + passage.length, text: passage, offsetUnit: "utf16",
        complete: passage === entry.text, omittedChars: characters(entry.text).length - characters(passage).length });
      projected.omittedEvidence--;
    }
    return projected;
  };
  if (job.result) detail.result = finding(job.result);
  for (const update of (job.updates ?? []).slice(-6)) {
    if (!remaining) break;
    detail.findings.push(finding(update, update.sequence)); detail.omissions.findings--;
  }
  for (const value of checkpoint?.decisions.slice(-8) ?? []) { if (!remaining) break; detail.decisions.push(text(value)); detail.omissions.decisions--; }
  for (const value of checkpoint?.openQuestions.slice(-4) ?? []) { if (!remaining) break; detail.openQuestions.push(text(value)); detail.omissions.openQuestions--; }
  detail.nextSteps = (checkpoint?.pendingReads ?? []).slice(0, 4).map(operation);
  detail.completedOperations = (checkpoint?.completedOperations ?? []).slice(-32).map(item => operation(item.request));
  detail.omissions.nextSteps -= detail.nextSteps.length; detail.omissions.completedOperations -= detail.completedOperations.length;
  return detail;
}
function operation(request: { kind: ChatReadRequest["kind"]; id: string }): VoicePublicOperation {
  return { kind: request.kind, ...(request.id ? { entityId: request.id } : {}) };
}
function validEvidence(entry: ChatEvidence): boolean {
  return Number.isSafeInteger(entry.start) && entry.start >= 0 && Number.isSafeInteger(entry.end) && entry.end === entry.start + entry.text.length;
}
