import type { ChatEvidence, ChatReadRequest, ChatReadingFinding, ChatResult, WebResearchDepth } from "../types";
import type { TaskView } from "./taskWorkingView";
import type { WebResearchResult } from "./webResearch";

/** Session-local worker memory. Never stored in the vault or sent to live audio. */
export interface ChatReadingCheckpoint {
  schema: 1;
  spaceId: string;
  contextVersion: string;
  snapshotVersion: string;
  taskView: TaskView;
  prompt: string;
  query: string;
  sequence: number;
  webAttempts?: number;
  webSearches?: number;
  webErrors?: string[];
  /** Bounded receipts outlive full-result eviction; never a paid-lookup quota. */
  webLookups?: Array<{ query: string; depth: WebResearchDepth; responseId?: string; error?: string }>;
  webEvidenceKeys?: string[];
  webUnproductiveLookups?: number;
  /** Complete provider results stay local; model packets contain exact pages. */
  webResults?: Array<{ query: string; depth?: WebResearchDepth; result: WebResearchResult }>;
  nextEvidence: number;
  evidence: ChatEvidence[];
  dependencies: Array<{ kind: "note" | "source"; id: string; version: string }>;
  discovered: { notes: string[]; sources: string[]; clusters: string[] };
  completedOperations: ChatCompletedRead[];
  pendingReads: ChatReadRequest[];
  findings: ChatCheckpointFinding[];
  /** Host-only deduplication journal, independent of the six displayed findings. */
  findingKeys?: string[];
  decisions: string[];
  openQuestions: string[];
}

export interface ChatCompletedRead {
  request: ChatReadRequest;
  /** Host-built routing result, not an invented model progress report. */
  result: unknown;
}

export interface ChatCheckpointFinding {
  key: string;
  summary: ChatReadingFinding;
  result: ChatResult;
}

/** Citation numbering may change; the exact supported ranges define identity. */
export function checkpointFindingKey(finding: string, evidence: readonly ChatEvidence[]): string {
  return JSON.stringify({ text: finding.replace(/\[\[e\d+\]\]/g, "").replace(/\s+/g, " ").trim(),
    evidence: evidence.map(item => [item.kind, item.entityId, item.version, item.start, item.end]).sort() });
}

export const MAX_CHECKPOINT_FINDING_KEYS = 128;
export const MAX_CHECKPOINT_FINDING_KEY_BYTES = 64_000;

/** Preserve recent distinct identities without retaining unbounded quoted prose. */
export function boundedCheckpointFindingKeys(keys: readonly string[]): string[] {
  const retained: string[] = [], seen = new Set<string>();
  const encoder = new TextEncoder();
  let remaining = MAX_CHECKPOINT_FINDING_KEY_BYTES;
  for (let index = keys.length - 1; index >= 0 && retained.length < MAX_CHECKPOINT_FINDING_KEYS; index--) {
    const key = keys[index];
    if (seen.has(key)) continue;
    seen.add(key);
    const bytes = encoder.encode(key).length;
    if (bytes > remaining) continue;
    retained.push(key); remaining -= bytes;
  }
  return retained.reverse();
}
