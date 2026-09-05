import { nanoid } from "nanoid";
import type { AppSnapshot, Note, ParsedImport, Source } from "../../types";
import type { ImportItem, ImportStudioApplyPayload, OrganizedSource } from "../../components/ImportStudio";
import { isSelectedAIConfigured } from "../ai";
import { reconcileConceptVocabulary, ensureCanonicalConceptPhrase } from "../concepts";
import { createGeneratePlaceholderNote, GENERATE_PENDING_TAG } from "../generate";
import { generateFromSpace } from "../generatePipeline";
import { applyLinkedArticleResult, buildLinkedArticleRequest } from "../linkedArticle";
import { runAutomaticKnowledgeImport } from "../knowledgeOrchestration/automaticImport";
import { runKnowledgeEnrichment } from "../knowledgeOrchestration/enrichment";
import { stableSnapshotVersion } from "../knowledgeOrchestration/context";
import { applyWikiEnrichmentResult } from "../wikiEnrichment";
import { partitionImportSourcesForSynthesis } from "../importBatching";
import { createKnowledgeReadingCache } from "../storage";
import { prepareSpaceKnowledgeIndex, pendingSpaceBlueprints, buildSpaceBlueprintRequest, applySpaceBlueprintResult, buildSpaceRootRequest, applySpaceRootResult } from "../spaceKnowledge";
import { applySpaceOverviewResult, hasSubstantiveOverviewNote, markSpaceOverviewStale } from "../spaceOverview";
import { buildAssistantContext, noteCitation, researchSpace } from "./context";
import type { AssistantRequest, WorkflowDependencies, WorkflowResult } from "./types";

const timestamp = () => new Date().toISOString();
const upsert = <T extends { id: string }>(before: T[], additions: T[]) => {
  const map = new Map(before.map((item) => [item.id, item]));
  additions.forEach((item) => map.set(item.id, item));
  return [...map.values()];
};

export function applyAssistantImport(snapshot: AppSnapshot, payload: ImportStudioApplyPayload): AppSnapshot {
  if (payload.baseSnapshotVersion && payload.baseSnapshotVersion !== stableSnapshotVersion(snapshot)) throw new Error("Import context changed before assembly.");
  const vocabulary = reconcileConceptVocabulary(upsert(snapshot.notes, payload.notes), upsert(snapshot.concepts, payload.concepts));
  return markSpaceOverviewStale({ ...snapshot, ...vocabulary, sources: upsert(snapshot.sources, payload.sources), relationships: upsert(snapshot.relationships, payload.relationships), updatedAt: timestamp() });
}

function sourceInput(source: Source): ParsedImport {
  return { title: source.title, fileName: source.fileName ?? source.title, mimeType: source.mimeType ?? "text/plain", format: source.kind,
    byteSize: source.byteSize ?? new TextEncoder().encode(source.text).byteLength, sourceUrl: source.sourceUrl, text: source.text, warnings: [] };
}

function savedResult(before: AppSnapshot, after: AppSnapshot, extra: Record<string, unknown> = {}): WorkflowResult {
  const originals = new Map(before.notes.map((note) => [note.id, note]));
  const changed = after.notes.filter((note) => JSON.stringify(originals.get(note.id)) !== JSON.stringify(note));
  return { snapshot: after, result: {
    ...extra, spaceId: after.workspace.id, snapshotVersion: stableSnapshotVersion(after),
    notes: changed.slice(0, 60).map((note) => ({ ...noteCitation(after.workspace.id, note), change: originals.has(note.id) ? "updated" : "created" })),
    changedNoteCount: changed.length, notesTruncated: changed.length > 60,
  } };
}

async function importSources(snapshot: AppSnapshot, request: Extract<AssistantRequest, { operation: "import" | "reprocess" }>, deps: WorkflowDependencies): Promise<WorkflowResult> {
  const parsed: Array<{ item: ImportItem; sourceId?: string }> = [];
  const warnings: string[] = [];
  const guidance = request.input.guidance ?? "";
  let totalBytes = 0;
  const count = request.operation === "import" ? request.input.inputs.length : request.input.source_ids.length;
  if (count < 1 || count > 12) throw new Error("Select one to twelve source inputs.");
  if (request.operation === "reprocess" && new Set(request.input.source_ids).size !== count) throw new Error("Source IDs must be unique.");
  for (let index = 0; index < count; index++) {
    await deps.assertCurrent();
    await deps.progress(`Extracting source ${index + 1} of ${count}`);
    const existingId = request.operation === "reprocess" ? request.input.source_ids[index] : undefined;
    const original = existingId ? snapshot.sources.find((source) => source.id === existingId) : undefined;
    if (existingId && !original) throw new Error("The preserved source is not in this exact Space.");
    const value = original ? sourceInput(original) : await deps.readInput(index);
    if (!value.text.trim()) throw new Error("A source contained no readable text. Nothing was saved.");
    totalBytes += new TextEncoder().encode(value.text).byteLength;
    if (totalBytes > 1_800_000) throw new Error("Extracted text exceeds the 1,800,000-byte workflow bound. Import fewer or smaller sources; nothing was saved.");
    warnings.push(...value.warnings);
    parsed.push({ sourceId: original?.id, item: { id: `input_${nanoid(12)}`, fileName: value.fileName, mimeType: value.mimeType, byteSize: value.byteSize, included: true, status: "ready", parsed: value } });
  }
  const local = request.operation === "import" && request.input.mode === "local";
  const batches = partitionImportSourcesForSynthesis(parsed, (value) => value.item.parsed!.text);
  const preservedIds = new Map(parsed.flatMap(({ item, sourceId }) => sourceId ? [[item.id, sourceId] as const] : []));
  let current = snapshot;
  const landings: Array<{ code: string; tier: number }> = [];
  const cache = createKnowledgeReadingCache();
  const sourceIds: string[] = [];
  for (let index = 0; index < batches.length; index++) {
    await deps.assertCurrent();
    await deps.progress(local ? "Preserving local source notes" : `Synthesizing source batch ${index + 1} of ${batches.length}`);
    const batch = batches[index];
    let organized: OrganizedSource[] = batch.map(({ item }) => ({ item }));
    if (!local) {
      const knowledge = await runAutomaticKnowledgeImport({
        snapshot: current, sources: batch.map(({ item }) => ({ sourceId: item.id, parsed: item.parsed! })), importGuidance: guidance,
        model: snapshot.settings.model, effort: snapshot.settings.reasoningEffort, driver: deps.driver, signal: deps.signal,
        readingCache: cache, routingCache: cache,
      });
      await deps.assertCurrent();
      warnings.push(...knowledge.warnings);
      if (knowledge.landing) landings.push({ code: knowledge.landing.code, tier: knowledge.landing.tier });
      organized = batch.map(({ item }, position) => ({ item,
        result: position === 0 ? knowledge.organized : { notes: [], wikiArticles: [], concepts: [], suggestedConnections: [] },
        provenance: position === 0 ? knowledge.provenance : [],
      }));
    }
    const payload = deps.buildImportPayload(organized, current, guidance, preservedIds);
    current = applyAssistantImport(current, payload);
    sourceIds.push(...payload.sources.map((source) => source.id));
  }
  return savedResult(snapshot, current, {
    mode: local ? "local" : "ai", sourceIds, warnings: warnings.slice(0, 30),
    ...(landings.length ? { recovery: { synthesized: false, landings, message: "AI synthesis did not complete for every batch. Orion preserved the sources and its existing local recovery output; this is not a completed AI synthesis." } } : {}),
  });
}

export async function executeAssistantWorkflow(snapshot: AppSnapshot, request: AssistantRequest, deps: WorkflowDependencies): Promise<WorkflowResult> {
  if (request.space_id !== snapshot.workspace.id) throw new Error("Workflow Space mismatch.");
  const grant = snapshot.settings.assistantAccess;
  const usesAI = request.operation !== "context" && !(request.operation === "import" && request.input.mode === "local");
  const writes = !["context", "research"].includes(request.operation);
  if (!grant?.enabled || !grant.spaceIds.includes(request.space_id)) throw new Error("Desktop workflows are disabled for this Space.");
  if (writes && !grant.allowWrites) throw new Error("Workflow writes are disabled.");
  if (usesAI && (!grant.allowAI || !isSelectedAIConfigured(snapshot.settings))) throw new Error("Enable Orion AI for desktop workflows and configure the selected provider in Settings.");
  if (["research", "develop_concept", "enrich_knowledge", "refresh_overview"].includes(request.operation) && !snapshot.settings.includeExistingNotesInAIContext) throw new Error("Existing-note AI context is off in Orion.");
  await deps.assertCurrent();
  switch (request.operation) {
    case "context": return { result: { ...buildAssistantContext(snapshot, request.input), providerCalls: 0 } };
    case "research": return { result: await researchSpace(snapshot, request.input, deps) };
    case "import": case "reprocess": return importSources(snapshot, request, deps);
    case "generate": {
      const now = timestamp();
      const note = createGeneratePlaceholderNote({ id: `note_${nanoid(12)}`, title: request.input.title ?? request.input.instruction.slice(0, 80), kind: request.input.kind, now });
      const pending = { ...snapshot, notes: [...snapshot.notes, note] };
      await deps.progress("Generating from Space context");
      let body = await generateFromSpace(pending, { originNoteId: note.id, ...request.input, useSpaceNotes: snapshot.settings.includeExistingNotesInAIContext }, deps.chat, { signal: deps.signal });
      const warnings: string[] = [];
      if (request.input.kind.startsWith("slide-deck")) {
        if (snapshot.settings.apiKeyConfigured) {
          await deps.progress("Illustrating slides");
          const illustrated = await deps.illustrate(body, note.title); body = illustrated.body; warnings.push(...illustrated.warnings);
        } else warnings.push("Slide text was generated. Add an OpenAI key in Orion for slide images.");
      }
      await deps.assertCurrent();
      const finished: Note = { ...note, body, summary: "", tags: note.tags.filter((tag) => tag !== GENERATE_PENDING_TAG), updatedAt: timestamp() };
      const vocabulary = reconcileConceptVocabulary([...snapshot.notes, finished], snapshot.concepts);
      return savedResult(snapshot, markSpaceOverviewStale({ ...snapshot, ...vocabulary, updatedAt: timestamp() }), { kind: request.input.kind, warnings });
    }
    case "develop_concept": {
      const origin = snapshot.notes.find((note) => note.id === request.input.origin_note_id);
      if (!origin) throw new Error("The origin note is not in this Space.");
      const now = timestamp();
      const candidate = { ...createGeneratePlaceholderNote({ id: `note_${nanoid(12)}`, title: request.input.title, kind: "note", now }), body: "", tags: [], sourceIds: [...origin.sourceIds] };
      const vocabulary = ensureCanonicalConceptPhrase(snapshot.notes, snapshot.concepts, { phrase: request.input.title, candidateArticle: candidate });
      const concept = vocabulary.concepts.find((item) => item.id === vocabulary.conceptId);
      const target = vocabulary.notes.find((note) => note.id === concept?.canonicalNoteId);
      if (!target) throw new Error("This phrase does not have an unambiguous canonical destination.");
      if (target.body.length > 24_000) throw new Error("This canonical article exceeds the bounded development size. Use targeted editing of its existing text.");
      const input = buildLinkedArticleRequest(snapshot, origin, target.title, request.input.instruction);
      if (target.body.trim()) {
        input.content += `\n\nExisting canonical article to preserve and develop:\n${target.body}`;
        input.taskInstructions += " Preserve the existing canonical article's supported details while integrating the requested development.";
      }
      await deps.progress("Developing the canonical article");
      const result = await deps.organize(input);
      await deps.assertCurrent();
      const finished = { ...applyLinkedArticleResult(target, result, target.title, snapshot.workspace.name, timestamp()),
        sourceIds: [...new Set([...target.sourceIds, ...origin.sourceIds])],
      };
      const reconciled = reconcileConceptVocabulary(vocabulary.notes.map((note) => note.id === target.id ? finished : note), vocabulary.concepts);
      const sources = snapshot.sources.map((source) => finished.sourceIds.includes(source.id) ? { ...source, noteIds: [...new Set([...source.noteIds, finished.id])] } : source);
      return savedResult(snapshot, markSpaceOverviewStale({ ...snapshot, ...reconciled, sources, updatedAt: timestamp() }), { canonicalNote: noteCitation(snapshot.workspace.id, finished) });
    }
    case "enrich_knowledge": {
      const origin = snapshot.notes.find((note) => note.id === request.input.note_id);
      if (!origin) throw new Error("The selected note is not in this Space.");
      await deps.progress("Enriching related Space knowledge");
      const enrichment = await runKnowledgeEnrichment({ snapshot, originNote: origin, model: snapshot.settings.model, effort: snapshot.settings.reasoningEffort, driver: deps.driver, signal: deps.signal });
      await deps.assertCurrent();
      const applied = applyWikiEnrichmentResult(snapshot, origin, enrichment.result, timestamp());
      return savedResult(snapshot, markSpaceOverviewStale(applied.snapshot));
    }
    case "refresh_overview": {
      if (!snapshot.notes.some(hasSubstantiveOverviewNote)) return savedResult(snapshot, { ...snapshot, spaceOverview: undefined, spaceKnowledge: undefined, updatedAt: timestamp() }, { message: "This Space has no substantive notes to summarize." });
      let knowledge = prepareSpaceKnowledgeIndex(snapshot, timestamp());
      const pending = pendingSpaceBlueprints(knowledge);
      for (let index = 0; index < pending.length; index++) {
        await deps.assertCurrent(); await deps.progress(`Refreshing knowledge cluster ${index + 1} of ${pending.length}`);
        const result = await deps.organize(buildSpaceBlueprintRequest(snapshot, knowledge, pending[index].id));
        knowledge = applySpaceBlueprintResult(knowledge, pending[index].id, result, timestamp());
      }
      await deps.assertCurrent(); await deps.progress("Refreshing Across this Space");
      const result = await deps.organize(buildSpaceRootRequest(snapshot, knowledge));
      await deps.assertCurrent();
      const now = timestamp();
      const overview = applySpaceOverviewResult(snapshot, result, now);
      const completed = applySpaceRootResult(knowledge, result, now);
      return savedResult(snapshot, { ...snapshot, spaceOverview: overview, spaceKnowledge: completed, updatedAt: now }, { overview });
    }
  }
}
