import type { AppSnapshot, Note, Source } from "../../types";
import { workingTaskSnapshot, workingTaskText, visibleTaskPassages, type TaskView } from "../taskWorkingView";
import { buildGenerationContext } from "../generationContext";
import { spaceNoteVersion } from "../spaceKnowledge";
import { sourceEvidenceVersion } from "../evidenceVersions";
import { stableSnapshotVersion } from "../knowledgeOrchestration/context";
import type { ContextInput } from "./types";

export function noteCitation(spaceId: string, note: Pick<Note, "id" | "title">) {
  const orionUrl = `orion://open?space_id=${encodeURIComponent(spaceId)}&note_id=${encodeURIComponent(note.id)}`;
  const title = note.title.replace(/[\[\]\\\r\n]/g, " ");
  return { id: note.id, title: note.title, orionUrl, citation: `[${title}](${orionUrl})` };
}

interface Passage { start: number; end: number; text: string }
export interface Evidence {
  id: string; kind: "note" | "source"; entityId: string; title: string; version: string;
  passages: Passage[]; offsetUnit: "utf16"; fullTextLength: number; complete: boolean;
  notes: ReturnType<typeof noteCitation>[]; sourceIds?: string[]; sourceUrl?: string;
}

/** Offsets and text always refer to the exact original body, including whitespace. */
export function exactPassages(body: string, query: string, budget = 4_000): Passage[] {
  const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
  if (!limit) return [];
  if (body.length <= limit) return [{ start: 0, end: body.length, text: body }];
  const width = Math.min(1_000, limit);
  const tokens = [...new Set(query.match(/[\p{L}\p{N}]{2,}/gu) ?? [])].slice(0, 80);
  const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const terms = tokens.map((token) => new RegExp(literal(token), "iu"));
  const candidates = new Map<number, Passage & { matchedTerms: number[] }>();
  const add = (position: number) => {
    let start = Math.max(0, Math.min(body.length - width, Math.floor(position)));
    // Original UTF-16 offsets remain authoritative, including case mappings
    // whose lowercase spelling has a different length from the source text.
    if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start])) start -= 1;
    let end = Math.min(body.length, start + width);
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
    if (end <= start || candidates.has(start)) return;
    const text = body.slice(start, end);
    candidates.set(start, { start, end, text,
      matchedTerms: terms.flatMap((term, index) => term.test(text) ? [index] : []) });
  };
  add(0);
  add(body.length - width);
  if (tokens.length) {
    // Find matches in untouched text before selecting windows. Fixed chunk
    // boundaries must never make a term invisible to query-based reading.
    const matcher = new RegExp(tokens.sort((a, b) => b.length - a.length).map(literal).join("|"), "giu");
    const seenBuckets = new Set<string>();
    for (const match of body.matchAll(matcher)) {
      // A frequent term must not suppress a different term in the same region.
      const bucket = `${Math.floor(match.index / width)}:${match[0].toLocaleLowerCase()}`;
      if (seenBuckets.has(bucket)) continue;
      seenBuckets.add(bucket);
      add(match.index - Math.floor(Math.max(0, width - match[0].length) / 2));
    }
  }
  const pending = [...candidates.values()];
  let chosen: Passage[] = [];
  const coveredTerms = new Set<number>();
  let remaining = limit;
  while (pending.length && remaining > 0) {
    const newTerms = (item: typeof pending[number]) => item.matchedTerms.filter((index) => !coveredTerms.has(index)).length;
    pending.sort((a, b) => newTerms(b) - newTerms(a) || b.matchedTerms.length - a.matchedTerms.length || a.start - b.start);
    const chunk = pending.shift()!;
    const overlapping = chosen.filter((item) => chunk.start <= item.end && chunk.end >= item.start);
    const start = Math.min(chunk.start, ...overlapping.map((item) => item.start));
    const end = Math.max(chunk.end, ...overlapping.map((item) => item.end));
    const additional = end - start - overlapping.reduce((sum, item) => sum + item.text.length, 0);
    if (additional > remaining) continue;
    // Merge overlaps instead of discarding the later window or splitting a
    // matched word at the boundary between two saved passages.
    chosen = chosen.filter((item) => !overlapping.includes(item));
    chosen.push({ start, end, text: body.slice(start, end) });
    remaining -= additional;
    chunk.matchedTerms.forEach((index) => coveredTerms.add(index));
  }
  return chosen.sort((a, b) => a.start - b.start);
}

function exactIds<T extends { id: string }>(items: T[], ids: string[], label: string): T[] {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${label} IDs.`);
  return ids.map((id) => {
    const item = items.find((item) => item.id === id);
    if (!item) throw new Error(`The selected ${label} does not exist in this exact Space.`);
    return item;
  });
}

export function assistantContextTargets(snapshot: AppSnapshot, input: Pick<ContextInput, "depth" | "note_ids" | "source_ids">) {
  const noteLimit = input.depth === "deep" ? 16 : 8;
  const sourceLimit = input.depth === "deep" ? 8 : 4;
  if ((input.note_ids?.length ?? 0) > noteLimit || (input.source_ids?.length ?? 0) > sourceLimit) {
    throw new Error("Use deep context for more than eight notes or four sources.");
  }
  return { notes: exactIds(snapshot.notes, input.note_ids ?? [], "note"),
    sources: exactIds(snapshot.sources, input.source_ids ?? [], "source"), noteLimit, sourceLimit };
}

export function buildAssistantContext(snapshot: AppSnapshot, input: ContextInput) {
  const { notes: explicitNotes, sources: explicitSources, noteLimit, sourceLimit } = assistantContextTargets(snapshot, input);
  const taskView = input.task_view ?? "working";
  const context = buildGenerationContext(taskView === "working" ? workingTaskSnapshot(snapshot) : snapshot, input.query, true);
  const notes = [...new Map([...explicitNotes, ...context.candidates.map(note => snapshot.notes.find(original => original.id === note.id)!)].map((note) => [note.id, note])).values()].slice(0, noteLimit);
  const linkedSources = notes.flatMap((note) => snapshot.sources.filter((source) => note.sourceIds.includes(source.id)));
  const tokens = input.query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const rankedSources = snapshot.sources.map((source) => ({ source, score: tokens.reduce((n, word) => n + (source.title.toLocaleLowerCase().includes(word) ? 1 : 0), 0) }))
    .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id)).map(({ source }) => source);
  const sources = [...new Map([...explicitSources, ...linkedSources, ...rankedSources].map((source) => [source.id, source])).values()].slice(0, sourceLimit);
  const evidence: Evidence[] = [
    ...notes.map((note) => makeEvidence(snapshot, note, "note", input.query, taskView)),
    ...sources.map((source) => makeEvidence(snapshot, source, "source", input.query, taskView)),
  ];
  return {
    spaceId: snapshot.workspace.id,
    snapshotVersion: stableSnapshotVersion(snapshot),
    taskView,
    orientation: context.orientation,
    directory: context.directory,
    evidence,
    coverage: {
      availableNotes: context.availableNoteCount, directoryNotes: context.directory.length, openedNotes: notes.length,
      availableSources: snapshot.sources.length, openedSources: sources.length,
      bounded: true, exhaustive: false,
      selection: "Validated hierarchy and locally ranked note digests; exact IDs take priority. Exact passages are selected within the stated bounds.",
      note: "Orientation and digests route retrieval; they are not source evidence. Unselected text and sources have not been assessed.",
    },
  };
}

function makeEvidence(snapshot: AppSnapshot, value: Note | Source, kind: "note" | "source", query: string, taskView: TaskView): Evidence {
  const body = "body" in value ? value.body : value.text;
  const selected = exactPassages(taskView === "working" ? workingTaskText(body) : body, query);
  const passages = taskView === "working" ? visibleTaskPassages(body, selected) : selected;
  const note = kind === "note" ? value as Note : undefined;
  const source = kind === "source" ? value as Source : undefined;
  return {
    id: `${kind}:${value.id}`, kind, entityId: value.id, title: value.title,
    version: note ? spaceNoteVersion(note) : sourceEvidenceVersion(source!),
    passages, offsetUnit: "utf16", fullTextLength: body.length,
    complete: passages.reduce((n, passage) => n + passage.text.length, 0) === body.length,
    notes: (note ? [note] : snapshot.notes.filter((item) => source!.noteIds.includes(item.id)).slice(0, 5)).map((item) => noteCitation(snapshot.workspace.id, item)),
    ...(note ? { sourceIds: note.sourceIds } : {}),
    ...(source?.sourceUrl?.startsWith("https://") ? { sourceUrl: source.sourceUrl } : {}),
  };
}

function strings(value: unknown, maximum: number, width: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every((item) => typeof item === "string" && item.length <= width);
}

export function validateResearchResult(value: unknown, evidence: Evidence[]) {
  if (!value || typeof value !== "object") throw new Error("Invalid research result.");
  const result = value as Record<string, unknown>;
  const known = new Set(evidence.map((item) => item.id));
  if (typeof result.answer !== "string" || result.answer.length > 12_000 ||
      !strings(result.gaps, 12, 1_000) || !strings(result.followUpQuestions, 8, 600) ||
      !Array.isArray(result.findings) || result.findings.length > 24) throw new Error("Research exceeded its bounded result contract.");
  const findings = result.findings.map((value: unknown) => {
    if (!value || typeof value !== "object") throw new Error("Invalid research finding.");
    const finding = value as Record<string, unknown>;
    if (typeof finding.claim !== "string" || !finding.claim.trim() || finding.claim.length > 2_000 ||
        !["fact", "inference"].includes(String(finding.kind)) || !strings(finding.evidenceIds, 8, 300) ||
        finding.evidenceIds.length === 0 || new Set(finding.evidenceIds).size !== finding.evidenceIds.length ||
        !finding.evidenceIds.every((id) => known.has(id))) throw new Error("Research cited evidence outside its exact context packet.");
    const citations = [...new Map(evidence.filter((item) => (finding.evidenceIds as string[]).includes(item.id)).flatMap((item) => item.notes).map((note) => [note.id, note])).values()];
    return { claim: finding.claim, kind: finding.kind, evidenceIds: finding.evidenceIds, citations };
  });
  return { answer: result.answer, findings, gaps: result.gaps, followUpQuestions: result.followUpQuestions };
}
