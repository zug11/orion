import { nanoid } from "nanoid";
import type {
  AppSnapshot,
  OrganizeContentResult,
  OrganizedWikiArticle,
  ReasoningEffort,
} from "../../types";
import {
  createImportRoutingSynopsis,
  createMandatoryCoverageCall,
  createKnowledgeRunContext,
  createNoteRoutingCacheKey,
  createNoteRoutingCall,
  createRootAssignment,
  createSeededRoutingArtifact,
  createSourceReadingPlan,
  KNOWLEDGE_NOTE_ROUTING_CACHE_VERSION,
  noteVersion,
  stableSnapshotVersion,
  validateCompleteNoteRoutingCoverage,
  type KnowledgeImportSourceInput,
  type KnowledgeRunContext,
} from "./context";
import type {
  KnowledgeAssignmentDriver,
  KnowledgeOrchestrationResult,
} from "./service";
import {
  KnowledgeDeadlineExceededError,
  KnowledgeProviderExecutionError,
  KnowledgeProviderTimeoutError,
  runKnowledgeOrchestration,
} from "./service";
import type {
  KnowledgeArtifact,
  KnowledgeNoteRoutingResult,
  KnowledgeOwnerProposal,
  KnowledgeReference,
  KnowledgeResultProvenance,
  KnowledgeRunResult,
  KnowledgeTelemetry,
} from "./protocol";
import type { KnowledgeRuntimeEvent } from "./runtime";
import {
  FixedBlueprintImportInterruptedError,
  runFixedBlueprintImport,
  type CompletedSourceReading,
  type FixedBlueprintImportCheckpoint,
  type FixedBlueprintImportRecoveryStage,
  type KnowledgeSourceReadingCache,
} from "./blueprintImport";
import {
  assembleDeterministicLanding,
  assembleStructuralLanding,
} from "./deterministicLanding";

export type KnowledgeImportDiagnosticStage =
  | "direct"
  | "reading-plan"
  | FixedBlueprintImportRecoveryStage;

export type KnowledgeImportDiagnosticCode =
  | "import-time-limit"
  | "provider-timeout"
  | "provider-auth"
  | "provider-rate-limit"
  | "provider-network"
  | "provider-response"
  | "coverage"
  | "space-changed"
  | "validation"
  | "cancelled"
  | "unknown";

export interface KnowledgeImportDiagnostic {
  runId: string;
  stage: KnowledgeImportDiagnosticStage;
  code: KnowledgeImportDiagnosticCode;
  summary: string;
  technicalDetail: string;
  completedReadings: number;
  totalReadings: number;
  completedWrites: number;
  totalWrites: number;
  resumable: boolean;
  occurredAt: string;
  model: string;
}

export class KnowledgeImportRunError extends Error {
  readonly diagnostic: KnowledgeImportDiagnostic;
  readonly checkpoint?: FixedBlueprintImportCheckpoint;
  readonly originalError: unknown;

  constructor(
    originalError: unknown,
    diagnostic: KnowledgeImportDiagnostic,
    checkpoint?: FixedBlueprintImportCheckpoint,
  ) {
    // Preserve the exact safe cause for callers and existing error handling;
    // the product-facing summary is carried separately in diagnostic.summary.
    super(diagnostic.technicalDetail);
    this.name = "KnowledgeImportRunError";
    this.originalError = originalError;
    this.diagnostic = diagnostic;
    this.checkpoint = checkpoint ? structuredClone(checkpoint) : undefined;
  }
}

export interface KnowledgeImportBatchOptions {
  snapshot: AppSnapshot;
  sources: readonly KnowledgeImportSourceInput[];
  importGuidance: string;
  model: string;
  effort: ReasoningEffort;
  driver: KnowledgeAssignmentDriver;
  signal?: AbortSignal;
  onTelemetry?: (
    telemetry: KnowledgeTelemetry,
    history: readonly KnowledgeRuntimeEvent[],
  ) => void;
  resume?: FixedBlueprintImportCheckpoint;
  /**
   * Optional fingerprint cache for completed range readings; unchanged
   * material in the fixed pipeline then skips its provider call.
   */
  readingCache?: KnowledgeSourceReadingCache;
  /**
   * Optional fingerprint cache for a validated typed-routing pass; a retried
   * direct import over an unchanged Space and unchanged material then seeds
   * its router artifact without spending a provider call.
   */
  routingCache?: KnowledgeSourceReadingCache;
  /**
   * Landing ladder: when the run fails, deliver deterministic landed notes
   * instead of rethrowing. Cancellation and a changed Space always rethrow.
   */
  landOnFailure?: boolean;
}

export interface KnowledgeImportBatchResult {
  runId: string;
  baseSnapshotVersion: string;
  organized: OrganizeContentResult;
  provenance: KnowledgeResultProvenance[];
  warnings: string[];
  orchestration: KnowledgeOrchestrationResult;
  /** Present only when the result was landed rather than orchestrated. */
  landing?: { tier: 1 | 2; code: KnowledgeImportDiagnosticCode };
}

export async function runKnowledgeImportBatch(
  options: KnowledgeImportBatchOptions,
): Promise<KnowledgeImportBatchResult> {
  if (options.sources.length === 0) {
    throw new Error("There is no source material in this knowledge run.");
  }
  const runId = options.resume?.runId ?? `knowledge-run:${nanoid(12)}`;
  const needsFixedBlueprintPipeline =
    options.resume !== undefined ||
    [...createSourceReadingPlan(options.sources).values()].some(
      (sections) => sections.length > 0,
    );
  const context = createKnowledgeRunContext(
    runId,
    options.snapshot,
    options.sources,
    options.importGuidance,
    {
      useOverviewLinkedNoteContext: true,
      hybridNoteRouting: !needsFixedBlueprintPipeline,
    },
  );
  const root = createRootAssignment(context);
  const mandatoryCoverage = createMandatoryCoverageCall(
    context,
    root.assignmentId,
  );
  // Cached typed routing: a retried direct import over an unchanged Space and
  // unchanged material seeds the prior validated router artifact instead of
  // repeating its provider call. Every hit is revalidated against the current
  // frozen contract, so any mismatch is an ordinary miss and correctness
  // never depends on the cache. Nothing is cached when routing was not
  // contracted for this run.
  const routingCacheKey =
    options.routingCache &&
    !needsFixedBlueprintPipeline &&
    context.space.noteDigestRanges.length > 0
      ? createNoteRoutingCacheKey(context, options.model, options.effort)
      : undefined;
  const seededRoutingArtifacts =
    options.routingCache && routingCacheKey
      ? await readCachedNoteRouting(options.routingCache, routingCacheKey, context)
      : undefined;
  // Hybrid typed routing: the run context contracts at most one inline digest
  // range, so a direct import performs at most one router assignment before
  // the root call instead of a parallel whole-Space crawl. Once contracted,
  // complete coverage of that range still gates the root result. The fixed
  // long-import pipeline keeps its local destination directory and never
  // triggers an automatic routing pass.
  const noteRouting =
    needsFixedBlueprintPipeline || seededRoutingArtifacts
      ? undefined
      : createNoteRoutingCall(
          context,
          root.assignmentId,
          createImportRoutingSynopsis(context),
        );
  if (noteRouting || seededRoutingArtifacts) {
    root.constraints.rules.push(
      "Host-verified typed routing classifies frozen note digests, and validated routes arrive as metadata-only routedNotes context. Contradicts/extends/uncertain routes may be opened later only through an exact frozen note reference beside the exact router artifact; duplicate routes are merge signals whose body may be opened only by its exact destination owner. Routing is orientation, never source evidence or write authority.",
    );
  }
  // Seeded router artifacts enter the run through the registry, not the
  // runtime, so result validation receives them as pre-run history: duplicate
  // route enforcement and artifact evidence stay identical on a cache hit.
  const seededRoutingHistory: KnowledgeRuntimeEvent[] = (
    seededRoutingArtifacts ?? []
  ).map((artifact) => ({ sequence: 0, type: "artifact-recorded", artifact }));
  const withSeededRoutingHistory = (
    history: readonly KnowledgeRuntimeEvent[],
  ): readonly KnowledgeRuntimeEvent[] =>
    seededRoutingHistory.length > 0
      ? [...seededRoutingHistory, ...history]
      : history;
  const initialCoordinationCalls = [
    ...(mandatoryCoverage ? [mandatoryCoverage] : []),
    ...(noteRouting ? [noteRouting] : []),
  ];
  let latestTelemetry: KnowledgeTelemetry | undefined;
  const onTelemetry = (
    telemetry: KnowledgeTelemetry,
    history: readonly KnowledgeRuntimeEvent[],
  ) => {
    latestTelemetry = telemetry;
    options.onTelemetry?.(telemetry, history);
  };
  let orchestration: KnowledgeOrchestrationResult;
  try {
    orchestration = needsFixedBlueprintPipeline
      ? await runFixedBlueprintImport({
        runContext: context,
        rootAssignment: root,
        snapshot: options.snapshot,
        sources: options.sources,
        model: options.model,
        effort: options.effort,
        driver: options.driver,
        signal: options.signal,
        validateResult: (result, history) =>
          validateAndFinalizeImportResult(
            result,
            options.snapshot,
            options.sources,
            history,
          ),
        onTelemetry,
        resume: options.resume,
        ...(options.readingCache ? { readingCache: options.readingCache } : {}),
      })
      : await runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        model: options.model,
        effort: options.effort,
        driver: options.driver,
        signal: options.signal,
        physicalConcurrency: 6,
        ...(initialCoordinationCalls.length > 0
          ? { initialCoordinationCalls }
          : {}),
        ...(seededRoutingArtifacts
          ? { initialArtifacts: seededRoutingArtifacts }
          : {}),
        validateRootResult: (result, history) =>
          validateAndFinalizeImportResult(
            result,
            options.snapshot,
            options.sources,
            withSeededRoutingHistory(history),
          ),
        onTelemetry,
      });
    const finalized = validateAndFinalizeImportResult(
      orchestration.result,
      options.snapshot,
      options.sources,
      withSeededRoutingHistory(orchestration.history),
    );
    if (options.routingCache && routingCacheKey && noteRouting) {
      storeCachedNoteRouting(
        options.routingCache,
        routingCacheKey,
        context,
        orchestration.artifacts,
      );
    }
    return {
      runId,
      baseSnapshotVersion: context.space.snapshotVersion,
      organized: finalized.result,
      provenance: finalized.provenance,
      warnings: finalized.warnings,
      orchestration: {
        ...orchestration,
        result: finalized,
      },
    };
  } catch (error) {
    const runError =
      error instanceof KnowledgeImportRunError
        ? error
        : createKnowledgeImportRunError(
            error,
            runId,
            options.model,
            latestTelemetry,
          );
    if (
      !options.landOnFailure ||
      runError.diagnostic.code === "cancelled" ||
      runError.diagnostic.code === "space-changed"
    ) {
      throw runError;
    }
    return landKnowledgeImportBatch(
      options.sources,
      runError,
      runId,
      context.space.snapshotVersion,
    );
  }
}

/** Envelope for one cached validated typed-routing pass. */
interface CachedNoteRoutingEnvelope {
  version: number;
  results: KnowledgeNoteRoutingResult[];
}

/**
 * Rehydrates a cached routing pass into seeded router artifacts and validates
 * complete coverage against the current frozen contract. Any damaged, stale,
 * or mismatched entry is an ordinary miss; the cache can never fail an import.
 */
async function readCachedNoteRouting(
  cache: KnowledgeSourceReadingCache,
  key: string,
  context: KnowledgeRunContext,
): Promise<KnowledgeArtifact[] | undefined> {
  try {
    const raw = await cache.get(key);
    if (!raw) return undefined;
    const envelope = JSON.parse(raw) as CachedNoteRoutingEnvelope;
    if (envelope.version !== KNOWLEDGE_NOTE_ROUTING_CACHE_VERSION) {
      return undefined;
    }
    const artifacts = createSeededRoutingArtifact(context, envelope.results);
    validateCompleteNoteRoutingCoverage(context, artifacts);
    return artifacts;
  } catch {
    // The cache is best-effort; a damaged entry is an ordinary miss.
    return undefined;
  }
}

function storeCachedNoteRouting(
  cache: KnowledgeSourceReadingCache,
  key: string,
  context: KnowledgeRunContext,
  artifacts: readonly KnowledgeArtifact[],
): void {
  try {
    const results = validateCompleteNoteRoutingCoverage(context, artifacts);
    if (results.length === 0) return;
    const envelope: CachedNoteRoutingEnvelope = {
      version: KNOWLEDGE_NOTE_ROUTING_CACHE_VERSION,
      results,
    };
    void cache.put(key, JSON.stringify(envelope)).catch(() => undefined);
  } catch {
    // The cache is best-effort; a failed write never affects the import.
  }
}

/**
 * Lands an already-failed run for callers that first exhausted their own
 * recovery (the import surface auto-resumes before landing). Cancellation and
 * a changed Space never land, so landing cannot mask user intent or a stale
 * base; those return undefined and the caller keeps its failure handling.
 */
export function landFailedKnowledgeImport(
  runError: KnowledgeImportRunError,
  sources: readonly KnowledgeImportSourceInput[],
  snapshot: AppSnapshot,
): KnowledgeImportBatchResult | undefined {
  if (
    runError.diagnostic.code === "cancelled" ||
    runError.diagnostic.code === "space-changed"
  ) {
    return undefined;
  }
  return landKnowledgeImportBatch(
    sources,
    runError,
    runError.diagnostic.runId,
    stableSnapshotVersion(snapshot),
  );
}

/**
 * The landing ladder's always-lands guarantee: a failed run with landing
 * enabled still returns notes. Tier 1 assembles bounded idea-first notes from
 * the checkpoint's validated semantic seeds and exact claims; tier 2 preserves
 * parsed source text.
 * Cancellation and a changed Space never reach this path, so landing cannot
 * mask user intent or a stale base.
 */
function landKnowledgeImportBatch(
  sources: readonly KnowledgeImportSourceInput[],
  runError: KnowledgeImportRunError,
  runId: string,
  baseSnapshotVersion: string,
): KnowledgeImportBatchResult {
  const readings: readonly CompletedSourceReading[] =
    runError.checkpoint?.completedSourceReadings ?? [];
  const tier = readings.length > 0 ? 1 : 2;
  const landed =
    tier === 1
      ? assembleDeterministicLanding(sources, readings)
      : assembleStructuralLanding(sources);
  const warnings = [
    tier === 1
      ? "Orion landed this import plainly from validated source readings as bounded idea-first notes; the complete source remains available for regeneration."
      : "Orion landed this import plainly as an editable source preview; the complete text remains on the Source record for regeneration.",
    ...landed.warnings,
  ];
  const landedRunResult: KnowledgeRunResult = {
    result: landed.result,
    provenance: landed.provenance,
    ownerProposals: [],
    warnings,
  };
  return {
    runId,
    baseSnapshotVersion,
    organized: landed.result,
    provenance: landed.provenance,
    warnings,
    orchestration: {
      result: landedRunResult,
      history: [],
      artifacts: readings.map(({ artifact }) => structuredClone(artifact)),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    landing: { tier, code: runError.diagnostic.code },
  };
}

export function createKnowledgeImportRunError(
  error: unknown,
  runId: string,
  model: string,
  telemetry?: KnowledgeTelemetry,
  stageOverride?: KnowledgeImportDiagnosticStage,
): KnowledgeImportRunError {
  const interrupted =
    error instanceof FixedBlueprintImportInterruptedError ? error : undefined;
  const underlying = interrupted?.originalError ?? error;
  const code = classifyKnowledgeImportError(underlying);
  const stage = interrupted?.stage ?? stageOverride ?? telemetryStage(telemetry);
  const checkpoint = interrupted?.checkpoint;
  const diagnostic: KnowledgeImportDiagnostic = {
    runId,
    stage,
    code,
    summary: diagnosticSummary(stage, code),
    technicalDetail: sanitizeDiagnosticDetail(underlying),
    completedReadings:
      interrupted?.completedReadings ?? telemetry?.readingCompleted ?? 0,
    totalReadings: interrupted?.totalReadings ?? telemetry?.readingTotal ?? 0,
    completedWrites:
      interrupted?.completedWrites ?? telemetry?.writingCompleted ?? 0,
    totalWrites: interrupted?.totalWrites ?? telemetry?.writingTotal ?? 0,
    resumable:
      checkpoint !== undefined &&
      interrupted?.stage !== "assembling" &&
      code !== "cancelled" &&
      code !== "space-changed",
    occurredAt: new Date().toISOString(),
    model,
  };
  return new KnowledgeImportRunError(underlying, diagnostic, checkpoint);
}

function telemetryStage(
  telemetry?: KnowledgeTelemetry,
): KnowledgeImportDiagnosticStage {
  const stage = telemetry?.pipelineStage;
  if (
    stage === "reading-plan" ||
    stage === "reading" ||
    stage === "writing-plan" ||
    stage === "writing" ||
    stage === "assembling"
  ) {
    return stage;
  }
  return "direct";
}

function classifyKnowledgeImportError(
  error: unknown,
): KnowledgeImportDiagnosticCode {
  const message = diagnosticErrorMessage(error);
  if (/cancel(?:led|ed)|aborted/i.test(message)) return "cancelled";
  if (
    error instanceof KnowledgeDeadlineExceededError ||
    /knowledge[- ]import limit|three-minute knowledge[- ]import/i.test(message)
  ) {
    return "import-time-limit";
  }
  if (
    error instanceof KnowledgeProviderTimeoutError ||
    /timed? out|did not respond within|timeout/i.test(message)
  ) {
    return "provider-timeout";
  }
  if (/api key|authenticat|unauthori[sz]ed|forbidden|credential/i.test(message)) {
    return "provider-auth";
  }
  if (/rate limit|rate or usage|too many requests|quota|billing/i.test(message)) {
    return "provider-rate-limit";
  }
  if (
    /could not reach|network|connection|offline|temporarily unavailable|dns/i.test(
      message,
    )
  ) {
    return "provider-network";
  }
  if (/Space context.*changed|snapshot|stale destination|base version/i.test(message)) {
    return "space-changed";
  }
  if (
    /source section|source range|coverage|read completely|every planned|every part|note routing|digest range/i.test(
      message,
    )
  ) {
    return "coverage";
  }
  if (
    error instanceof KnowledgeProviderExecutionError ||
    /schema|response_format|malformed|invalid json|could not parse|output contract/i.test(
      message,
    )
  ) {
    return "provider-response";
  }
  if (
    /validat|provenance|ownership|evidence|planned output|planned note|writing pass|writer slot|note draft|blueprint|source reading|safety fuse/i.test(
      message,
    )
  ) {
    return "validation";
  }
  return "unknown";
}

function diagnosticSummary(
  stage: KnowledgeImportDiagnosticStage,
  code: KnowledgeImportDiagnosticCode,
): string {
  if (code === "import-time-limit") return "Orion reached the import time limit.";
  if (code === "provider-auth") return "Orion needs a working AI connection.";
  if (code === "provider-rate-limit") return "The AI provider paused this import.";
  if (code === "space-changed") return "The Space changed while Orion was importing.";
  if (code === "cancelled") return "The import was cancelled.";
  if (stage === "reading" || stage === "reading-plan") {
    return "Orion paused while reading the source.";
  }
  if (stage === "writing-plan") return "Orion paused while planning the notes.";
  if (stage === "writing") return "Orion paused while writing the notes.";
  if (stage === "assembling") return "Orion could not safely assemble the notes.";
  return "Orion could not finish this import.";
}

function sanitizeDiagnosticDetail(error: unknown): string {
  const detail = diagnosticErrorMessage(error)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/(["']?(?:api[_-]?key|token|authorization)["']?\s*[:=]\s*)["'][^"']+["']/gi, "$1[redacted]")
    .replace(/\/Users\/[^/\s]+/g, "~")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return detail.slice(0, 1_200) || "The import stopped without a provider detail.";
}

function diagnosticErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateAndFinalizeImportResult(
  value: KnowledgeRunResult,
  snapshot: AppSnapshot,
  sources: readonly KnowledgeImportSourceInput[],
  history: readonly KnowledgeRuntimeEvent[],
): KnowledgeRunResult {
  const sourceIds = new Set(sources.map(({ sourceId }) => sourceId));
  const noteIds = new Set(snapshot.notes.map(({ id }) => id));
  const conceptIds = new Set(snapshot.concepts.map(({ id }) => id));
  const artifactsById = new Map(
    history.flatMap((event) =>
      event.type === "artifact-recorded"
        ? [[event.artifact.artifactId, event.artifact] as const]
        : [],
    ),
  );
  const allowedSourceRanges = new Set<string>();
  const readingPlan = createSourceReadingPlan(sources);
  for (const { sourceId } of sources) {
    const sections = readingPlan.get(sourceId) ?? [];
    if (sections.length === 0) {
      allowedSourceRanges.add(`${sourceId}/full`);
    } else {
      sections.forEach(({ index }) =>
        allowedSourceRanges.add(`${sourceId}/range-${index + 1}`),
      );
    }
  }
  validateMandatorySourceCoverage(value, sources, history);
  const expectedOutputKeys = [
    ...value.result.notes.map(({ title }) => outputKey("note", title)),
    ...value.result.wikiArticles.map(({ title }) =>
      outputKey("wikiArticle", title),
    ),
  ];
  if (new Set(expectedOutputKeys).size !== expectedOutputKeys.length) {
    throw new Error("The knowledge result returned duplicate output titles.");
  }
  const expectedOutputs = new Set(expectedOutputKeys);
  const provenanceByOutput = new Map<string, KnowledgeResultProvenance>();
  for (const provenance of value.provenance) {
    const key = outputKey(provenance.kind, provenance.title);
    if (!expectedOutputs.has(key)) {
      throw new Error(
        `The knowledge result returned provenance for an unknown output: ${provenance.title}.`,
      );
    }
    if (provenanceByOutput.has(key)) {
      throw new Error(`The knowledge result repeated provenance for ${provenance.title}.`);
    }
    if (provenance.sourceIds.length === 0) {
      throw new Error(`The knowledge result omitted source provenance for ${provenance.title}.`);
    }
    if (new Set(provenance.sourceIds).size !== provenance.sourceIds.length) {
      throw new Error(`The knowledge result repeated source provenance for ${provenance.title}.`);
    }
    for (const sourceId of provenance.sourceIds) {
      if (!sourceIds.has(sourceId)) {
        throw new Error(`The knowledge result referenced another import source: ${sourceId}`);
      }
    }
    const evidencedSourceIds = collectEvidenceSourceIds(
      provenance.evidenceReferences,
      artifactsById,
      snapshot,
      sourceIds,
      allowedSourceRanges,
      noteIds,
      conceptIds,
    );
    if (evidencedSourceIds.size === 0) {
      throw new Error(
        `The knowledge result contains no source evidence for ${provenance.title}.`,
      );
    }
    const missingEvidence = provenance.sourceIds.find(
      (sourceId) => !evidencedSourceIds.has(sourceId),
    );
    if (missingEvidence) {
      throw new Error(
        `The knowledge result did not evidence claimed source ${missingEvidence} for ${provenance.title}.`,
      );
    }
    const unclaimedEvidence = [...evidencedSourceIds].find(
      (sourceId) => !provenance.sourceIds.includes(sourceId),
    );
    if (unclaimedEvidence) {
      throw new Error(
        `The knowledge result cited unclaimed source ${unclaimedEvidence} for ${provenance.title}.`,
      );
    }
    provenanceByOutput.set(key, provenance);
  }
  for (const key of expectedOutputs) {
    if (!provenanceByOutput.has(key)) {
      throw new Error(`Missing source provenance for ${key}.`);
    }
  }

  const noteSourceCoverage = new Set<string>();
  for (const note of value.result.notes) {
    const provenance = provenanceByOutput.get(outputKey("note", note.title));
    provenance?.sourceIds.forEach((sourceId) => noteSourceCoverage.add(sourceId));
  }
  for (const sourceId of sourceIds) {
    if (!noteSourceCoverage.has(sourceId)) {
      throw new Error(
        `The knowledge result did not create a source-grounded project note for ${sourceId}.`,
      );
    }
  }

  const ownerGrantsByAssignment = new Map<string, Set<string>>();
  for (const event of history) {
    if (event.type !== "destination-owner-granted") continue;
    ownerGrantsByAssignment.set(
      event.assignmentId,
      new Set(event.destinationNoteIds),
    );
  }
  const completedOwnerArtifacts = history.flatMap((event) =>
    event.type === "artifact-recorded" && event.artifact.purpose === "owner"
      ? [event.artifact]
      : [],
  );
  const completedOwnerDestinations = new Set<string>();
  const completedOwnerArtifactByDestination = new Map<string, KnowledgeArtifact>();
  const proposedDestinations = new Set<string>();
  for (const proposal of value.ownerProposals) {
    if (proposedDestinations.has(proposal.destinationNoteId)) {
      throw new Error(
        `The knowledge result repeated an owner proposal for ${proposal.destinationNoteId}.`,
      );
    }
    proposedDestinations.add(proposal.destinationNoteId);
    const matchingArtifact = completedOwnerArtifacts.find(
      (artifact) =>
        ownerGrantsByAssignment
          .get(artifact.assignmentId)
          ?.has(proposal.destinationNoteId) &&
        artifact.ownerProposals.some((candidate) =>
          ownerProposalsEqual(candidate, proposal),
        ),
    );
    if (!matchingArtifact) {
      throw new Error(
        `An existing article revision was returned without a completed exact owner proposal: ${proposal.destinationNoteId}`,
      );
    }
    completedOwnerDestinations.add(proposal.destinationNoteId);
    completedOwnerArtifactByDestination.set(
      proposal.destinationNoteId,
      matchingArtifact,
    );
  }
  const articles = new Map(
    value.result.wikiArticles.map((article) => [
      normalizedTitle(article.title),
      article,
    ]),
  );
  for (const article of value.result.wikiArticles) {
    const existing = resolveExistingCanonicalArticle(snapshot, article.title);
    if (
      existing &&
      !value.ownerProposals.some(
        ({ destinationNoteId }) => destinationNoteId === existing.id,
      )
    ) {
      throw new Error(
        `An existing article revision was returned without an exclusive owner: ${existing.id}`,
      );
    }
  }
  const duplicateWarnings = enforceDuplicateRoutes(value, snapshot, history);
  const provenance = [...value.provenance];
  for (const proposal of value.ownerProposals) {
    validateOwnerProposal(
      proposal,
      snapshot,
      sourceIds,
      completedOwnerDestinations,
    );
    const existing = snapshot.notes.find(
      ({ id }) => id === proposal.destinationNoteId,
    )!;
    const article = articleFromOwnerProposal(
      proposal,
      articles.get(normalizedTitle(existing.title)),
    );
    articles.set(normalizedTitle(existing.title), article);
    const key = outputKey("wikiArticle", article.title);
    const entry: KnowledgeResultProvenance = {
      kind: "wikiArticle",
      title: article.title,
      sourceIds: [...proposal.sourceIds],
      evidenceReferences: [
        {
          kind: "artifact" as const,
          artifactId: completedOwnerArtifactByDestination.get(
            proposal.destinationNoteId,
          )!.artifactId,
        },
      ],
    };
    const ownerEvidenceSourceIds = collectEvidenceSourceIds(
      entry.evidenceReferences,
      artifactsById,
      snapshot,
      sourceIds,
      allowedSourceRanges,
      noteIds,
      conceptIds,
    );
    if (
      proposal.sourceIds.some((sourceId) =>
        !ownerEvidenceSourceIds.has(sourceId),
      ) ||
      [...ownerEvidenceSourceIds].some(
        (sourceId) => !proposal.sourceIds.includes(sourceId),
      )
    ) {
      throw new Error(
        `The completed owner artifact does not support the source provenance for ${proposal.title}.`,
      );
    }
    const index = provenance.findIndex(
      (candidate) => outputKey(candidate.kind, candidate.title) === key,
    );
    if (index >= 0) provenance[index] = entry;
    else provenance.push(entry);
  }

  const result = {
    ...value.result,
    wikiArticles: [...articles.values()],
  };
  for (const article of result.wikiArticles) {
    if (
      !provenance.some(
        (entry) =>
          outputKey(entry.kind, entry.title) ===
          outputKey("wikiArticle", article.title),
      )
    ) {
      throw new Error(`Missing source provenance for wikiArticle:${article.title}.`);
    }
  }
  const warnings = [
    ...value.warnings,
    ...duplicateWarnings.filter(
      (warning) => !value.warnings.includes(warning),
    ),
  ];
  return { ...value, result, provenance, warnings };
}

/**
 * Enforces duplicate routes from validated typed routing. A duplicate-routed
 * note marks imported material the Space already covers: a new canonical
 * article may not silently replace it under the same name, and every
 * duplicate match surfaces as a stable result warning for the import surface.
 */
function enforceDuplicateRoutes(
  value: KnowledgeRunResult,
  snapshot: AppSnapshot,
  history: readonly KnowledgeRuntimeEvent[],
): string[] {
  const duplicateRoutes = history.flatMap((event) =>
    event.type === "artifact-recorded" && event.artifact.routing
      ? event.artifact.routing.routes.filter(
          ({ relation }) => relation === "duplicate",
        )
      : [],
  );
  if (duplicateRoutes.length === 0) return [];
  const noteById = new Map(snapshot.notes.map((note) => [note.id, note]));
  const ownedDestinations = new Set(
    value.ownerProposals.map(({ destinationNoteId }) => destinationNoteId),
  );
  const warnings: string[] = [];
  for (const route of duplicateRoutes) {
    const note = noteById.get(route.noteId);
    if (!note || noteVersion(note) !== route.noteVersion) continue;
    const duplicateTitles = new Set(
      [note.title, ...note.aliases].map(normalizedTitle),
    );
    const replacement = value.result.wikiArticles.find((article) =>
      duplicateTitles.has(normalizedTitle(article.title)),
    );
    if (replacement && !ownedDestinations.has(note.id)) {
      throw new Error(
        `A duplicate-routed note must gain an exact owner revision or a genuinely distinct article, not a replacement copy: ${note.id}`,
      );
    }
    const warning = `Imported material appears already covered by “${note.title}”.`;
    if (!warnings.includes(warning)) warnings.push(warning);
  }
  return warnings;
}

function validateMandatorySourceCoverage(
  _value: KnowledgeRunResult,
  sources: readonly KnowledgeImportSourceInput[],
  history: readonly KnowledgeRuntimeEvent[],
): void {
  const requiredRanges = new Set(
    [...createSourceReadingPlan(sources)].flatMap(([sourceId, sections]) =>
      sections.map(({ index }) => `${sourceId}/range-${index + 1}`),
    ),
  );
  if (requiredRanges.size === 0) return;

  const artifacts = new Map(
    history.flatMap((event) =>
      event.type === "artifact-recorded"
        ? [[event.artifact.artifactId, event.artifact] as const]
        : [],
    ),
  );
  const successfullyRead = new Set<string>();
  for (const artifact of artifacts.values()) {
    const groundedReferences = [
      ...artifact.references,
      ...artifact.claims.flatMap((claim) => claim.references),
    ];
    for (const reference of groundedReferences) {
      if (reference.kind === "source-range") {
        successfullyRead.add(`${reference.sourceId}/${reference.rangeId}`);
      }
    }
  }
  for (const range of requiredRanges) {
    if (!successfullyRead.has(range)) {
      throw new Error(`Orion did not successfully read mandatory source range ${range}.`);
    }
  }

}

export function snapshotStillMatchesImportBase(
  snapshot: AppSnapshot,
  baseSnapshotVersion: string,
): boolean {
  return stableSnapshotVersion(snapshot) === baseSnapshotVersion;
}

function ownerProposalsEqual(
  left: KnowledgeOwnerProposal,
  right: KnowledgeOwnerProposal,
): boolean {
  return (
    left.destinationNoteId === right.destinationNoteId &&
    left.baseVersion === right.baseVersion &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.body === right.body &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((value, index) => value === right.aliases[index]) &&
    left.tags.length === right.tags.length &&
    left.tags.every((value, index) => value === right.tags[index]) &&
    left.sourceIds.length === right.sourceIds.length &&
    left.sourceIds.every((value, index) => value === right.sourceIds[index])
  );
}

function collectEvidenceSourceIds(
  references: readonly KnowledgeReference[],
  artifactsById: ReadonlyMap<string, KnowledgeArtifact>,
  snapshot: AppSnapshot,
  importedSourceIds: ReadonlySet<string>,
  allowedSourceRanges: ReadonlySet<string>,
  noteIds: ReadonlySet<string>,
  conceptIds: ReadonlySet<string>,
  visitedArtifacts = new Set<string>(),
): Set<string> {
  const evidenced = new Set<string>();
  for (const reference of references) {
    if (reference.kind === "source" || reference.kind === "source-range") {
      if (!importedSourceIds.has(reference.sourceId)) {
        throw new Error("The knowledge result cited a source outside this import batch.");
      }
      if (
        reference.kind === "source-range" &&
        !allowedSourceRanges.has(`${reference.sourceId}/${reference.rangeId}`)
      ) {
        throw new Error(
          `The knowledge result cited an unavailable source range: ${reference.sourceId}/${reference.rangeId}.`,
        );
      }
      evidenced.add(reference.sourceId);
      continue;
    }
    if (reference.kind === "note") {
      if (!noteIds.has(reference.noteId)) {
        throw new Error("The knowledge result cited a note outside this Space.");
      }
      const note = snapshot.notes.find(({ id }) => id === reference.noteId)!;
      if (noteVersion(note) !== reference.version) {
        throw new Error(`The knowledge result cited a stale note: ${reference.noteId}.`);
      }
      continue;
    }
    if (reference.kind === "concept") {
      if (!conceptIds.has(reference.conceptId)) {
        throw new Error("The knowledge result cited a concept outside this Space.");
      }
      continue;
    }
    if (reference.kind === "note-digest-range") continue;
    const artifact = artifactsById.get(reference.artifactId);
    if (!artifact) {
      throw new Error("The knowledge result cited an unavailable run artifact.");
    }
    if (visitedArtifacts.has(artifact.artifactId)) continue;
    visitedArtifacts.add(artifact.artifactId);
    const nested = collectEvidenceSourceIds(
      [
        ...artifact.references,
        ...artifact.claims.flatMap((claim) => claim.references),
      ],
      artifactsById,
      snapshot,
      importedSourceIds,
      allowedSourceRanges,
      noteIds,
      conceptIds,
      visitedArtifacts,
    );
    nested.forEach((sourceId) => evidenced.add(sourceId));
  }
  return evidenced;
}

function validateOwnerProposal(
  proposal: KnowledgeOwnerProposal,
  snapshot: AppSnapshot,
  sourceIds: Set<string>,
  ownerGrants: Set<string>,
): void {
  const note = snapshot.notes.find(({ id }) => id === proposal.destinationNoteId);
  if (!note || note.kind !== "wiki") {
    throw new Error(
      `An owner proposal targeted an unavailable canonical article: ${proposal.destinationNoteId}`,
    );
  }
  if (!ownerGrants.has(note.id)) {
    throw new Error(`A note revision was returned without exclusive ownership: ${note.id}`);
  }
  if (normalizedTitle(note.title) !== normalizedTitle(proposal.title)) {
    throw new Error(`A note owner cannot rename its destination: ${note.id}`);
  }
  if (noteVersion(note) !== proposal.baseVersion) {
    throw new Error(`A note revision is stale and cannot be applied: ${note.id}`);
  }
  if (proposal.sourceIds.length === 0) {
    throw new Error(`A note revision has no imported-source provenance: ${note.id}`);
  }
  for (const sourceId of proposal.sourceIds) {
    if (!sourceIds.has(sourceId)) {
      throw new Error(`A note revision referenced another import source: ${sourceId}`);
    }
  }
}

function articleFromOwnerProposal(
  proposal: KnowledgeOwnerProposal,
  plannedArticle?: OrganizedWikiArticle,
): OrganizedWikiArticle {
  return {
    title: proposal.title,
    summary: proposal.summary,
    body: proposal.body,
    overview: plannedArticle?.overview ?? proposal.summary,
    spaceRelevance: plannedArticle?.spaceRelevance ?? "",
    sourceGroundedDetails: [
      ...(plannedArticle?.sourceGroundedDetails ?? []),
    ],
    uncertainties: [...(plannedArticle?.uncertainties ?? [])],
    tags: [...proposal.tags],
    aliases: [...proposal.aliases],
    links: structuredClone(plannedArticle?.links ?? []),
  };
}

function outputKey(
  kind: KnowledgeResultProvenance["kind"],
  title: string,
): string {
  return `${kind}:${normalizedTitle(title)}`;
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function resolveExistingCanonicalArticle(
  snapshot: AppSnapshot,
  title: string,
) {
  const key = normalizedTitle(title);
  const canonicalIds = snapshot.concepts.flatMap((concept) => {
    const matches =
      normalizedTitle(concept.label) === key ||
      concept.aliases.some((alias) => normalizedTitle(alias) === key);
    return matches && concept.canonicalNoteId ? [concept.canonicalNoteId] : [];
  });
  const canonical = snapshot.notes.filter((note) => canonicalIds.includes(note.id));
  if (canonical.length === 1) return canonical[0];
  const exactWiki = snapshot.notes.filter(
    (note) => note.kind === "wiki" && normalizedTitle(note.title) === key,
  );
  return exactWiki.length === 1 ? exactWiki[0] : undefined;
}
