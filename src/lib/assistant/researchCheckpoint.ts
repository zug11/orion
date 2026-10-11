import type { AppSnapshot } from "../../types";
import { chatEvidenceIsCurrent, chatResearchContextVersion } from "../chatReading";
import type { ChatReadingCheckpoint } from "../chatReadingCheckpoint";
import { isChatCoverage, isChatEvidence, parseChatReadRequests, parseChatReadingFinding } from "../chatReadingProtocol";
import { stableSnapshotVersion } from "../knowledgeOrchestration/context";
import { spaceNoteVersion } from "../spaceKnowledge";
import { sourceEvidenceVersion } from "../evidenceVersions";
import type { TaskView } from "../taskWorkingView";

// Leave room for the public answer, exact cited excerpts and execution metadata
// inside the native 2 MiB result limit. This is transient native job memory.
export const MAX_RESEARCH_CHECKPOINT_BYTES = 1_000_000;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, limit: number, width: number): value is string[] => Array.isArray(value) && value.length <= limit &&
  value.every(item => typeof item === "string" && [...item].length <= width);

/** Keep host-produced memory bounded; omissions mean a future run may reread. */
export function retainResearchCheckpoint(checkpoint: ChatReadingCheckpoint) {
  const retained = structuredClone(checkpoint);
  const omitted = { evidence: 0, completedOperations: 0, findings: 0, findingKeys: 0, dependencies: 0, discovered: 0 };
  const trim = <T>(items: T[], maximum: number, key: keyof typeof omitted) => {
    const count = Math.max(0, items.length - maximum);
    items.splice(0, count); omitted[key] += count;
  };
  trim(retained.dependencies, 256, "dependencies");
  for (const items of Object.values(retained.discovered)) trim(items, 1_024, "discovered");
  while (bytes(retained) > MAX_RESEARCH_CHECKPOINT_BYTES) {
    if (retained.completedOperations.length) { retained.completedOperations.shift(); omitted.completedOperations++; }
    else if (retained.findings.length) { retained.findings.shift(); omitted.findings++; }
    else if (retained.findingKeys?.length) { retained.findingKeys.shift(); omitted.findingKeys++; }
    else if (retained.evidence.length) { retained.evidence.shift(); omitted.evidence++; }
    else if (Object.values(retained.discovered).some(items => items.length)) {
      Object.values(retained.discovered).find(items => items.length)!.shift(); omitted.discovered++;
    } else if (retained.dependencies.length) { retained.dependencies.shift(); omitted.dependencies++; }
    else throw new Error("Research continuity exceeded its bounded result contract.");
  }
  return { checkpoint: retained, omitted };
}

/** Previous results come only from native succeeded jobs, never model output. */
export function validatedResearchCheckpoint(value: unknown, snapshot: AppSnapshot, taskView: TaskView): ChatReadingCheckpoint | undefined {
  if (value === undefined) return; // Completed jobs from the older reader may continue afresh.
  const fail = () => { throw new Error("The prior research checkpoint is invalid or no longer matches this Space. Start fresh research."); };
  if (!record(value) || bytes(value) > MAX_RESEARCH_CHECKPOINT_BYTES || value.schema !== 1 ||
      value.spaceId !== snapshot.workspace.id || value.snapshotVersion !== stableSnapshotVersion(snapshot) ||
      value.contextVersion !== chatResearchContextVersion(snapshot) || value.taskView !== taskView ||
      typeof value.prompt !== "string" || [...value.prompt].length > 8_000 || typeof value.query !== "string" || [...value.query].length > 600 ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !Number.isSafeInteger(value.nextEvidence) || Number(value.nextEvidence) < 1 ||
      !Array.isArray(value.evidence) || value.evidence.length > 96 || !value.evidence.every(isChatEvidence) ||
      !chatEvidenceIsCurrent(snapshot, value.evidence) || new Set(value.evidence.map(item => item.id)).size !== value.evidence.length ||
      !record(value.discovered) || !strings(value.discovered.notes, 1_024, 200) || !strings(value.discovered.sources, 1_024, 200) || !strings(value.discovered.clusters, 1_024, 200) ||
      !Array.isArray(value.dependencies) || value.dependencies.length > 256 ||
      !Array.isArray(value.completedOperations) || value.completedOperations.length > 32 ||
      !Array.isArray(value.findings) || value.findings.length > 6 ||
      !strings(value.decisions, 8, 240) || !strings(value.openQuestions, 4, 240) ||
      (value.findingKeys !== undefined && !strings(value.findingKeys, 128, 64_000))) return fail();
  const checkpoint = value as unknown as ChatReadingCheckpoint;
  if (checkpoint.discovered.notes.some(id => !snapshot.notes.some(note => note.id === id)) ||
      checkpoint.discovered.sources.some(id => !snapshot.sources.some(source => source.id === id)) ||
      checkpoint.dependencies.some(item => !record(item) || typeof item.id !== "string" || typeof item.version !== "string" ||
        !(item.kind === "note" ? snapshot.notes.some(note => note.id === item.id && spaceNoteVersion(note) === item.version)
          : item.kind === "source" && snapshot.sources.some(source => source.id === item.id && sourceEvidenceVersion(source) === item.version)))) return fail();
  try {
    parseChatReadRequests(checkpoint.pendingReads);
    for (const operation of checkpoint.completedOperations) {
      if (!record(operation) || !record(operation.result)) return fail();
      parseChatReadRequests([operation.request]);
    }
    for (const finding of checkpoint.findings) {
      if (!record(finding) || typeof finding.key !== "string" || !record(finding.result) || typeof finding.result.reply !== "string" ||
          !Array.isArray(finding.result.evidence) || finding.result.evidence.length > 12 || !finding.result.evidence.every(isChatEvidence) ||
          !chatEvidenceIsCurrent(snapshot, finding.result.evidence) || !isChatCoverage(finding.result.coverage) ||
          Object.keys(finding.result).some(key => !["reply", "evidence", "coverage"].includes(key))) return fail();
      const summary = parseChatReadingFinding(finding.summary);
      const ids = new Set(finding.result.evidence.map(item => item.id));
      const cited = [...(summary?.finding.matchAll(/\[\[(e\d+)\]\]/g) ?? [])].map(match => match[1]);
      if (!summary || !cited.length || cited.some(id => !ids.has(id))) return fail();
    }
  } catch { return fail(); }
  return structuredClone(checkpoint);
}
