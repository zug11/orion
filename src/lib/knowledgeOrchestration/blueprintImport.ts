import type { AppSnapshot, ReasoningEffort } from "../../types";
import { defaultSettings } from "../../data/defaults";
import { splitDocumentIntoReadingSections } from "../longDocumentImport";
import { truncateUnicode } from "../text";
import {
  buildAssignmentContextPacket,
  createKnowledgeRunContext,
  createNoteRoutingCall,
  createRoutedFullNoteReferences,
  KnowledgeArtifactRegistry,
  measureSourcePayload,
  noteVersion,
  stableHash,
  validateCompleteNoteRoutingCoverage,
  type KnowledgeAssignmentContextPacket,
  type KnowledgeImportSourceInput,
  type KnowledgeRunContext,
} from "./context";
import {
  parseKnowledgeModelResponse,
  type KnowledgeArtifact,
  type KnowledgeAssignmentContract,
  type KnowledgeCompletionPayload,
  type KnowledgeEvidenceSelection,
  type KnowledgeLensSelection,
  type KnowledgeNoteRoutingResult,
  type KnowledgeOwnerProposal,
  type KnowledgeProviderUsage,
  type KnowledgeReadingBlueprint,
  type KnowledgeReference,
  type KnowledgeRunResult,
  type KnowledgeSourceReading,
  type KnowledgeTelemetry,
  type KnowledgeWriterDraft,
  type KnowledgeWriterResult,
  type KnowledgeWritingBlueprint,
  type KnowledgeWritingBlueprintOutput,
} from "./protocol";
import {
  KnowledgeProviderExecutionError,
  KnowledgeProviderTimeoutError,
  type KnowledgeAssignmentDriver,
  type KnowledgeAssignmentExecutionRequest,
  type KnowledgeOrchestrationResult,
} from "./service";
import type { KnowledgeRuntimeEvent } from "./runtime";
import { planLocalImportConnections } from "./importConnections";
import { scopedImportConnectionPlan, validateImportConnectionPlan } from "./importConnectionPlan";

const TRANSPORT_SAFETY_TIMEOUT_MS = 300_000;
const MIN_CALL_MS = 250;
const MAX_PHYSICAL_WIDTH = 6;
const INITIAL_READING_WIDTH = 4;
const MAX_SOURCE_READINGS = 12;
const MIN_ADAPTIVE_READING_CHARS = 8_000;
const MIN_ADAPTIVE_READING_UTF8_BYTES = 8_000;
const MIN_ADAPTIVE_READING_ESTIMATED_TOKENS = 2_000;
const MAX_ADAPTIVE_LOGICAL_TASKS_PER_CANONICAL = 7;
const MAX_ADAPTIVE_ATTEMPTS_PER_CANONICAL = 12;
const MAX_ADAPTIVE_LOGICAL_TASKS_PER_RUN = 48;
const MAX_ADAPTIVE_ATTEMPTS_PER_RUN = 72;
// Leave enough headroom beneath the native 2.5 MB encoded-request ceiling for
// the assignment, Space orientation, destination directory, and JSON wrapper.
// This is an explicit whole-evidence budget, not a claim-count proxy: many
// small grounded items remain valid while an oversized request fails intact.
const MAX_COMPLETED_SOURCE_READINGS_UTF8_BYTES = 1_500_000;
const MAX_ROUTED_FULL_NOTES_FOR_WRITING_PLAN = 6;
const MAX_ROUTED_FULL_NOTE_CHARACTERS = 240_000;
const MAX_WRITER_CONTRACT_FAILURES = 6;
const MAX_BLUEPRINT_OUTPUTS = 30;

type PipelineStage = NonNullable<KnowledgeTelemetry["pipelineStage"]>;

export type FixedBlueprintImportRecoveryStage =
  | "reading"
  | "writing-plan"
  | "writing"
  | "assembling";

interface SourceRangeTarget {
  sourceId: string;
  rangeId: string;
}

export interface CompletedSourceReading {
  assignment: KnowledgeAssignmentContract;
  artifact: KnowledgeArtifact;
  reading: KnowledgeSourceReading;
}

export interface FixedBlueprintImportCheckpoint {
  kind: "fixed-blueprint-import";
  schemaVersion: 3;
  runId: string;
  runIdentity: string;
  stage: FixedBlueprintImportRecoveryStage;
  readingBlueprint: KnowledgeReadingBlueprint;
  readingBlueprintFallbackWarning?: string;
  completedSourceReadings: CompletedSourceReading[];
  adaptiveReadingProgress: AdaptiveSourceReadingCheckpoint[];
  runAdaptiveLogicalTaskCount: number;
  runAdaptiveAttemptCount: number;
  postReadingRouting?: FixedPostReadingRoutingCheckpoint;
  writingBlueprint?: KnowledgeWritingBlueprint;
  writerResults: KnowledgeWriterResult[];
  writerProgress: FixedWriterProgressCheckpoint;
  attempts: Record<string, number>;
  createdAt: string;
}

interface AdaptiveSourceReadingTaskCheckpoint {
  path: number[];
  repairAttempt: number;
  providerRetryAttempt: number;
  contentFingerprint: string;
}

interface AdaptiveSourceReadingCheckpoint {
  sourceId: string;
  rangeId: string;
  logicalTaskCount: number;
  attemptCount: number;
  leaves: AdaptiveSourceReadingLeaf[];
  pending: AdaptiveSourceReadingTaskCheckpoint[];
}

interface AdaptiveSourceReadingRunProgress {
  logicalTaskCount: number;
  attemptCount: number;
}

interface FixedPostReadingRoutingCheckpoint {
  mode: "routed" | "baseline";
  contextIdentity: string;
  artifacts: KnowledgeArtifact[];
  warning?: string;
}

type FixedRevisionAccess = "validated-routing" | "create-only";

interface FixedWriterSlotProgress {
  writerSlotId: string;
  drafts: KnowledgeWriterDraft[];
  warnings: string[];
}

interface FixedWriterProgressCheckpoint {
  slots: FixedWriterSlotProgress[];
  contractFailures: number;
  circuitOpen: boolean;
}

export class FixedBlueprintImportInterruptedError extends Error {
  readonly checkpoint: FixedBlueprintImportCheckpoint;
  readonly stage: FixedBlueprintImportRecoveryStage;
  readonly completedReadings: number;
  readonly totalReadings: number;
  readonly completedWrites: number;
  readonly totalWrites: number;
  readonly originalError: unknown;

  constructor(
    error: unknown,
    checkpoint: FixedBlueprintImportCheckpoint,
    progress: {
      completedReadings: number;
      totalReadings: number;
      completedWrites: number;
      totalWrites: number;
    },
  ) {
    super(errorMessage(error));
    this.name = "FixedBlueprintImportInterruptedError";
    this.checkpoint = checkpoint;
    this.stage = checkpoint.stage;
    this.completedReadings = progress.completedReadings;
    this.totalReadings = progress.totalReadings;
    this.completedWrites = progress.completedWrites;
    this.totalWrites = progress.totalWrites;
    this.originalError = error;
  }
}

interface AdaptiveSourceReadingTask {
  canonicalReader: KnowledgeReadingBlueprint["readers"][number];
  reader: KnowledgeReadingBlueprint["readers"][number];
  canonicalAssignment: KnowledgeAssignmentContract;
  context: KnowledgeRunContext;
  content: string;
  depth: number;
  path: number[];
  repairAttempt: number;
  providerRetryAttempt: number;
}

interface AdaptiveSourceReadingLeaf {
  path: number[];
  reading: KnowledgeSourceReading;
}

interface AdaptiveSourceReadingState {
  canonicalReader: KnowledgeReadingBlueprint["readers"][number];
  canonicalAssignment: KnowledgeAssignmentContract;
  outstanding: number;
  wasSplit: boolean;
  logicalTaskCount: number;
  attemptCount: number;
  leaves: AdaptiveSourceReadingLeaf[];
  terminalError?: unknown;
}

interface AdaptiveWriterTask {
  originalSlot: KnowledgeWritingBlueprint["writerSlots"][number];
  slot: KnowledgeWritingBlueprint["writerSlots"][number];
  path: number[];
}

interface AdaptiveWriterState {
  originalSlot: KnowledgeWritingBlueprint["writerSlots"][number];
  outstanding: number;
  drafts: KnowledgeWriterDraft[];
  warnings: string[];
  completed: boolean;
}

class AdaptiveSourceReadingInterruptedError extends Error {
  readonly originalError: unknown;
  readonly completed: CompletedSourceReading[];
  readonly progress: AdaptiveSourceReadingCheckpoint[];

  constructor(
    error: unknown,
    completed: readonly CompletedSourceReading[],
    progress: readonly AdaptiveSourceReadingCheckpoint[] = [],
  ) {
    super(errorMessage(error));
    this.name = "AdaptiveSourceReadingInterruptedError";
    this.originalError = error;
    this.completed = structuredClone([...completed]);
    this.progress = structuredClone([...progress]);
  }
}

class AdaptiveSourceReadingSafetyFuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdaptiveSourceReadingSafetyFuseError";
  }
}

class FixedAssignmentContractError extends Error {
  readonly originalError: unknown;

  constructor(error: unknown) {
    super(errorMessage(error));
    this.name = "FixedAssignmentContractError";
    this.originalError = error;
  }
}

interface FixedBlueprintImportOptions {
  compactParallel?: boolean;
  runContext: KnowledgeRunContext;
  rootAssignment: KnowledgeAssignmentContract;
  snapshot: AppSnapshot;
  sources: readonly KnowledgeImportSourceInput[];
  model: string;
  effort: ReasoningEffort;
  driver: KnowledgeAssignmentDriver;
  signal?: AbortSignal;
  validateResult: (
    result: KnowledgeRunResult,
    history: readonly KnowledgeRuntimeEvent[],
  ) => KnowledgeRunResult;
  onTelemetry?: (
    telemetry: KnowledgeTelemetry,
    history: readonly KnowledgeRuntimeEvent[],
  ) => void;
  resume?: FixedBlueprintImportCheckpoint;
  readingCache?: KnowledgeSourceReadingCache;
}

/**
 * Best-effort local store for completed range readings, keyed by content
 * fingerprint. Adapters move opaque strings; correctness never depends on the
 * cache because every hit is rehydrated and revalidated against the current
 * frozen contract, and any failure is treated as a miss.
 */
export interface KnowledgeSourceReadingCache {
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

/** Bump when reader prompts, schemas, cache identity, or reading semantics change. */
export const KNOWLEDGE_READING_CACHE_VERSION = 3;

interface CachedSourceReadingEnvelope {
  contentLength: number;
  contentHash: string;
  reading: KnowledgeSourceReading;
}

/**
 * Space-scoped by design: readings carry Space-lens interpretations, and
 * Spaces are hard boundaries, so a reading never crosses into another Space
 * even when the source text is identical. Source IDs are intentionally
 * excluded so re-importing the same document under a fresh import ID reuses
 * unchanged ranges.
 */
function sourceReadingCacheKey(
  context: KnowledgeRunContext,
  model: string,
  effort: ReasoningEffort,
  blueprint: KnowledgeReadingBlueprint,
  task: AdaptiveSourceReadingTask,
): string {
  const { reader, content } = task;
  const source = context.materials.sources.get(reader.sourceId);
  const range = source?.manifest.ranges.find(
    ({ rangeId }) => rangeId === reader.rangeId,
  );
  const comparisonMaterials = readerSpaceContextMaterials(context, reader);
  return (
    stableHash(
      JSON.stringify({
        version: KNOWLEDGE_READING_CACHE_VERSION,
        model,
        effort,
        spaceId: context.space.spaceId,
        spaceIdentity: {
          name: context.space.name,
          description: context.space.description,
        },
        spaceOverview: context.space.overview,
        importGuidance: context.importGuidance,
        organizationInstructions: context.organizationInstructions,
        runConstraints: context.constraints,
        readingFrame: {
          spaceExplanation: blueprint.spaceExplanation,
          spaceFocusConcepts: blueprint.spaceFocusConcepts,
          spaceQuestions: blueprint.spaceQuestions,
          warnings: blueprint.warnings,
        },
        focusQuestions: reader.focusQuestions,
        focusConcepts: reader.focusConcepts,
        comparisons: reader.comparisons.map(({ noteId, reason }) => ({
          noteId,
          reason,
        })),
        mustPreserve: reader.mustPreserve.filter(
          (value) =>
            value !== `Source range ${reader.sourceId}/${reader.rangeId}`,
        ),
        comparisonMaterials,
        sourceIdentity: {
          title: source?.manifest.title,
          fileName: source?.manifest.fileName,
          pageStart: range?.pageStart,
          pageEnd: range?.pageEnd,
        },
        readingMode:
          task.repairAttempt > 0
            ? "compact-repair"
            : task.depth > 0
              ? "adaptive-child"
              : "canonical",
        content,
      }),
    ) + stableHash(`${content.length}:${content}`)
  );
}

function rehydrateCachedSourceReading(
  envelope: CachedSourceReadingEnvelope,
  reader: KnowledgeReadingBlueprint["readers"][number],
): KnowledgeSourceReading {
  return {
    ...structuredClone(envelope.reading),
    sourceId: reader.sourceId,
    rangeId: reader.rangeId,
    mustPreserve: uniqueStrings([
      `Source range ${reader.sourceId}/${reader.rangeId}`,
      ...reader.mustPreserve,
    ]),
    sourceClaims: envelope.reading.sourceClaims.map((claim) => ({
      ...structuredClone(claim),
      support: claim.support.map(() => ({
        sourceId: reader.sourceId,
        rangeId: reader.rangeId,
      })),
    })),
  };
}

async function readCachedSourceReading(
  cache: KnowledgeSourceReadingCache,
  key: string,
  task: AdaptiveSourceReadingTask,
): Promise<KnowledgeSourceReading | undefined> {
  try {
    const raw = await cache.get(key);
    if (!raw) return undefined;
    const envelope = JSON.parse(raw) as CachedSourceReadingEnvelope;
    if (
      envelope.contentLength !== task.content.length ||
      envelope.contentHash !== stableHash(task.content)
    ) {
      return undefined;
    }
    const reading = rehydrateCachedSourceReading(envelope, task.reader);
    validateSourceReading(reading, task.reader, task.context);
    return reading;
  } catch {
    return undefined;
  }
}

async function storeCachedSourceReading(
  cache: KnowledgeSourceReadingCache,
  key: string,
  content: string,
  reading: KnowledgeSourceReading,
): Promise<void> {
  try {
    const envelope: CachedSourceReadingEnvelope = {
      contentLength: content.length,
      contentHash: stableHash(content),
      reading: structuredClone(reading),
    };
    await cache.put(key, JSON.stringify(envelope));
  } catch {
    // The cache is best-effort; a failed write never affects the import.
  }
}

interface PipelineCounters {
  stage: PipelineStage;
  active: number;
  completed: number;
  readingCompleted: number;
  readingTotal: number;
  writingCompleted: number;
  writingTotal: number;
  writeWidth: number;
}

type RuntimeEventInput = KnowledgeRuntimeEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;

class EventJournal {
  readonly events: KnowledgeRuntimeEvent[] = [];
  private readonly attempts = new Map<string, number>();

  constructor(attempts: Readonly<Record<string, number>> = {}) {
    for (const [assignmentId, attempt] of Object.entries(attempts)) {
      if (Number.isInteger(attempt) && attempt > 0) {
        this.attempts.set(assignmentId, attempt);
      }
    }
  }

  nextAttempt(assignmentId: string): number {
    const attempt = (this.attempts.get(assignmentId) ?? 0) + 1;
    this.attempts.set(assignmentId, attempt);
    return attempt;
  }

  record(event: RuntimeEventInput): void {
    this.events.push({
      ...event,
      sequence: this.events.length,
    } as KnowledgeRuntimeEvent);
  }

  attemptSnapshot(): Record<string, number> {
    return Object.fromEntries(this.attempts);
  }
}

/**
 * Runs the fixed two-blueprint topology used only when at least one imported
 * source needs bounded parallel ranges. The model plans twice and writes once;
 * final assembly is local and cannot become another serial provider call.
 */
export async function runFixedBlueprintImport(
  options: FixedBlueprintImportOptions,
): Promise<KnowledgeOrchestrationResult> {
  if (options.signal?.aborted) {
    throw (
      options.signal.reason ?? new Error("The knowledge import was cancelled.")
    );
  }
  const startedAt = Date.now();
  const sourceRanges = fixedPipelineSourceRanges(options.runContext);
  const resume = validateResumeCheckpoint(options, sourceRanges);
  const journal = new EventJournal(resume?.attempts);
  const registry = new KnowledgeArtifactRegistry();
  const resumedReadings: CompletedSourceReading[] = structuredClone(
    resume?.completedSourceReadings ?? [],
  );
  const adaptiveReadingProgress: AdaptiveSourceReadingCheckpoint[] =
    structuredClone(resume?.adaptiveReadingProgress ?? []);
  const adaptiveReadingRunProgress: AdaptiveSourceReadingRunProgress = {
    logicalTaskCount: resume?.runAdaptiveLogicalTaskCount ?? 0,
    attemptCount: resume?.runAdaptiveAttemptCount ?? 0,
  };
  const writerProgress: FixedWriterProgressCheckpoint = structuredClone(
    resume?.writerProgress ?? {
      slots: [],
      contractFailures: 0,
      circuitOpen: false,
    },
  );
  for (const completed of resumedReadings) {
    registry.record(completed.artifact);
    journal.record({ type: "artifact-recorded", artifact: completed.artifact });
  }
  const usage: Required<KnowledgeProviderUsage> = {
    inputTokens: 0,
    outputTokens: 0,
  };
  const counters: PipelineCounters = {
    stage: "reading-plan",
    active: 0,
    completed:
      resumedReadings.length + (resume?.writerResults.length ?? 0),
    readingCompleted: resumedReadings.length,
    readingTotal: sourceRanges.length,
    writingCompleted:
      resume?.writerResults.reduce(
        (total, result) => total + result.drafts.length,
        0,
      ) ?? 0,
    writingTotal: resume?.writingBlueprint?.outputs.length ?? 0,
    writeWidth: 0,
  };
  journal.record({
    type: "run-created",
    runId: options.runContext.runId,
    root: options.rootAssignment,
  });

  const emit = (status: KnowledgeTelemetry["status"] = "running") => {
    options.onTelemetry?.(
      {
        runId: options.runContext.runId,
        logicalWidth:
          counters.stage === "reading"
            ? counters.readingTotal - counters.readingCompleted
            : counters.stage === "writing"
              ? counters.writingTotal - counters.writingCompleted
              : counters.active,
        physicalWidth: counters.active,
        writeWidth: counters.writeWidth,
        completedAssignments: counters.completed,
        failedAssignments: status === "failed" ? 1 : 0,
        activeAssignments: counters.active,
        waitingAssignments: 0,
        currentPrimitives:
          counters.stage === "reading" ||
          counters.stage === "writing" ||
          (counters.stage === "reading-plan" && counters.active > 0)
            ? ["fan_out"]
            : [],
        phase:
          counters.stage === "writing" || counters.stage === "assembling"
            ? "finalizing"
            : "exploring",
        elapsedMs: Math.max(0, Date.now() - startedAt),
        // The fixed pipeline is cancellation-bound rather than governed by a
        // shrinking wall-clock. Progress remains indeterminate and honest.
        remainingMs: 0,
        sourceSummaryTotal: counters.readingTotal,
        sourceSummaryCompleted: counters.readingCompleted,
        pipelineStage: counters.stage,
        readingCompleted: counters.readingCompleted,
        readingTotal: counters.readingTotal,
        writingCompleted: counters.writingCompleted,
        writingTotal: counters.writingTotal,
        status,
      },
      journal.events,
    );
  };
  const readingBlueprintAssignment = createReadingBlueprintAssignment(
    options.runContext,
    sourceRanges,
  );
  emit();

  let readingBlueprint: KnowledgeReadingBlueprint;
  let readingBlueprintFallbackWarning =
    resume?.readingBlueprintFallbackWarning;
  if (resume) {
    readingBlueprint = structuredClone(resume.readingBlueprint);
  } else if (options.compactParallel) {
    // Complete short sources already have exact host-owned ranges. Reuse
    // Space orientation without paying for a separate provider planning pass.
    readingBlueprint = deterministicReadingBlueprint(options.runContext, sourceRanges);
  } else try {
    readingBlueprint = await executeTypedAssignment<KnowledgeReadingBlueprint>(
      options,
      readingBlueprintAssignment,
      registry,
      journal,
      usage,
      TRANSPORT_SAFETY_TIMEOUT_MS,
      readingBlueprintSpaceMaterials(options.runContext),
      false,
      "reading-blueprint",
      (payload) =>
        validateReadingBlueprint(payload, options.runContext, sourceRanges),
    );
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    if (!canRecoverLocallyFromFixedStageError(error, options.signal)) {
      // Keep a deterministic, checkpoint-safe reading map, but do not fan out
      // source calls when the provider has already reported an account,
      // network, rate, availability, or model-wide execution failure.
      const recoveryBlueprint = deterministicReadingBlueprint(
        options.runContext,
        sourceRanges,
      );
      counters.stage = "reading";
      counters.readingTotal = recoveryBlueprint.readers.length;
      emit("failed");
      throw interruptedImportError(
        error,
        options,
        journal,
        "reading",
        recoveryBlueprint,
        "Orion prepared a local reading map without starting source readers after the AI connection failed.",
          [],
          undefined,
          [],
          counters,
          adaptiveReadingProgress,
          adaptiveReadingRunProgress,
          undefined,
          writerProgress,
      );
    }
    readingBlueprint = deterministicReadingBlueprint(
      options.runContext,
      sourceRanges,
    );
    readingBlueprintFallbackWarning =
      "Orion used its local reading map because the first organization pass was unavailable.";
  }

  counters.stage = "reading";
  const sourceAssignments = createSourceReaderAssignments(
    options.runContext,
    readingBlueprint,
    readingBlueprintAssignment.assignmentId,
  );
  counters.readingTotal = sourceAssignments.length;
  emit();

  let completedSourceReadings = resumedReadings;
  try {
    completedSourceReadings = await readSourcesAdaptively({
      options,
      readingBlueprint,
      sourceAssignments,
      registry,
      journal,
      usage,
      counters,
      emit,
      completed: resumedReadings,
      progress: adaptiveReadingProgress,
      runProgress: adaptiveReadingRunProgress,
    });
  } catch (error) {
    const partial =
      error instanceof AdaptiveSourceReadingInterruptedError
        ? error.completed
        : completedSourceReadings;
    if (error instanceof AdaptiveSourceReadingInterruptedError) {
      adaptiveReadingProgress.splice(
        0,
        adaptiveReadingProgress.length,
        ...error.progress,
      );
    }
    emit("failed");
    throw interruptedImportError(
      error instanceof AdaptiveSourceReadingInterruptedError
        ? error.originalError
        : error,
      options,
      journal,
      "reading",
      readingBlueprint,
      readingBlueprintFallbackWarning,
      partial,
      undefined,
      [],
      counters,
      adaptiveReadingProgress,
      adaptiveReadingRunProgress,
      undefined,
      writerProgress,
    );
  }

  const sourceRangeOrder = new Map(
    sourceRanges.map((range, index) => [sourceRangeKey(range), index]),
  );
  completedSourceReadings.sort(
    (left, right) =>
      (sourceRangeOrder.get(sourceRangeKey(left.reading)) ?? 0) -
      (sourceRangeOrder.get(sourceRangeKey(right.reading)) ?? 0),
  );
  assertExactSourceRangeCompletion(sourceRanges, completedSourceReadings);
  assertCompletedSourceReadingsWithinAggregateBudget(completedSourceReadings);

  counters.stage = "writing-plan";
  emit();
  let postReadingRouting: Awaited<ReturnType<typeof runPostReadingRouting>>;
  let postReadingRoutingWarning = resume?.postReadingRouting?.warning;
  let postReadingRoutingCheckpoint = resume?.postReadingRouting
    ? structuredClone(resume.postReadingRouting)
    : undefined;
  if (postReadingRoutingCheckpoint) {
    postReadingRouting = restorePostReadingRouting(
      options,
      completedSourceReadings,
      postReadingRoutingCheckpoint,
    );
    for (const artifact of postReadingRouting.artifacts) {
      registry.record(artifact);
      journal.record({ type: "artifact-recorded", artifact });
    }
  } else {
    try {
      postReadingRouting = await runPostReadingRouting(
        options,
        completedSourceReadings,
        registry,
        journal,
        usage,
      );
      postReadingRoutingCheckpoint = createPostReadingRoutingCheckpoint(
        "routed",
        postReadingRouting.context,
        postReadingRouting.artifacts,
      );
    } catch (error) {
      if (!canRecoverLocallyFromFixedStageError(error, options.signal)) {
        emit("failed");
        throw interruptedImportError(
          error,
          options,
          journal,
          "writing-plan",
          readingBlueprint,
          readingBlueprintFallbackWarning,
          completedSourceReadings,
          undefined,
          [],
          counters,
          adaptiveReadingProgress,
          adaptiveReadingRunProgress,
          postReadingRoutingCheckpoint,
          writerProgress,
        );
      }
      // Routing enriches editorial context but never establishes source
      // evidence or write authority. If its typed response remains malformed
      // after correction, continue safely with new notes instead of making the
      // user resume or discarding the completed source readings.
      postReadingRouting = { context: options.runContext, artifacts: [] };
      postReadingRoutingWarning =
        "Orion could not safely match this import to existing notes, so it created new source-grounded notes without revising prior writing.";
      postReadingRoutingCheckpoint = createPostReadingRoutingCheckpoint(
        "baseline",
        options.runContext,
        [],
        postReadingRoutingWarning,
      );
    }
  }
  const synthesisContext = postReadingRouting.context;
  const routingArtifacts = postReadingRouting.artifacts;
  const revisionAccess = fixedRevisionAccess(
    postReadingRoutingCheckpoint,
    routingArtifacts,
  );

  const writingBlueprintAssignment = createWritingBlueprintAssignment(
    synthesisContext,
    readingBlueprintAssignment.assignmentId,
    completedSourceReadings,
    routingArtifacts,
    revisionAccess,
  );
  let writingBlueprint = resume?.writingBlueprint
    ? structuredClone(resume.writingBlueprint)
    : undefined;
  // Small imports into a fresh Space have no revision owners to route. When
  // readers already proposed a small set of distinct knowledge objects, the
  // host can preserve those boundaries instead of adding another model round.
  if (!writingBlueprint && options.compactParallel &&
      canPlanCompactImportLocally(options, completedSourceReadings)) {
    const localPlan = createDeterministicWritingBlueprint(
      options.snapshot, completedSourceReadings, [],
    );
    try {
      validateWritingBlueprint(localPlan, synthesisContext, options.snapshot,
        completedSourceReadings, [], "create-only");
      writingBlueprint = localPlan;
    } catch {
      // Ambiguous/invalid local plans take the ordinary shared planning path.
    }
  }
  if (writingBlueprint) {
    validateWritingBlueprint(
      writingBlueprint,
      synthesisContext,
      options.snapshot,
      completedSourceReadings,
      routingArtifacts,
      revisionAccess,
    );
  }
  if (!writingBlueprint) {
    try {
      writingBlueprint = await executeTypedAssignment<KnowledgeWritingBlueprint>(
        { ...options, runContext: synthesisContext },
        writingBlueprintAssignment,
        registry,
        journal,
        usage,
        TRANSPORT_SAFETY_TIMEOUT_MS,
        [
          {
            kind: "reading-blueprint",
            trust: "untrusted-context",
            payload: readingBlueprint,
          },
          ...completedSourceReadings.map(({ artifact, reading }) => ({
            kind: "source-reading" as const,
            trust: "source-evidence" as const,
            payload: { artifactId: artifact.artifactId, reading },
          })),
          {
            kind: "space-orientation",
            trust: "untrusted-context",
            payload: destinationSpaceDirectory(
              options.snapshot,
              synthesisContext,
              routingArtifacts,
              revisionAccess,
            ),
          },
        ],
        false,
        "writing-blueprint",
        (payload) =>
          validateWritingBlueprint(
            payload,
            synthesisContext,
            options.snapshot,
            completedSourceReadings,
            routingArtifacts,
            revisionAccess,
          ),
        1,
      );
    } catch (error) {
      if (!canRecoverLocallyFromFixedStageError(error, options.signal)) {
        emit("failed");
        throw interruptedImportError(
          error,
          options,
          journal,
          "writing-plan",
          readingBlueprint,
          readingBlueprintFallbackWarning,
          completedSourceReadings,
          undefined,
          [],
          counters,
          adaptiveReadingProgress,
          adaptiveReadingRunProgress,
          postReadingRoutingCheckpoint,
          writerProgress,
        );
      }
      writingBlueprint = createDeterministicWritingBlueprint(
        options.snapshot,
        completedSourceReadings,
        [
          postReadingRoutingWarning,
          "Orion repaired the note plan locally from the completed readings before writing the notes.",
        ].filter((warning): warning is string => Boolean(warning)),
      );
      validateWritingBlueprint(
        writingBlueprint,
        synthesisContext,
        options.snapshot,
        completedSourceReadings,
        [],
        "create-only",
      );
    }
  }
  if (
    postReadingRoutingWarning &&
    !writingBlueprint.warnings.includes(postReadingRoutingWarning)
  ) {
    writingBlueprint = {
      ...writingBlueprint,
      warnings: [...writingBlueprint.warnings, postReadingRoutingWarning],
    };
  }

  if (options.compactParallel && !resume?.writingBlueprint && writingBlueprint.outputs.length > 1) {
    const width = Math.min(6, writingBlueprint.outputs.length);
    const outputs = writingBlueprint.outputs.map((output, index) => ({
      ...output, writerSlotId: `compact-writer-${index % width + 1}`,
    }));
    writingBlueprint = {
      ...writingBlueprint,
      outputs,
      writerSlots: Array.from({ length: width }, (_, index) => ({
        writerSlotId: `compact-writer-${index + 1}`,
        objective: "Write only these disjoint planned knowledge objects from their assigned evidence.",
        outputIds: outputs.filter((output) => output.writerSlotId === `compact-writer-${index + 1}`).map(({ outputId }) => outputId),
      })),
    };
  }
  counters.stage = "writing";
  counters.writeWidth = writingBlueprint.writerSlots.length;
  counters.writingTotal = writingBlueprint.outputs.length;
  emit();
  let writerResults: KnowledgeWriterResult[] = structuredClone(
    resume?.writerResults ?? [],
  );
  try {
    writerResults = await writeNotesAdaptively({
      options: { ...options, runContext: synthesisContext },
      readingBlueprint,
      writingBlueprint,
      parentAssignmentId: writingBlueprintAssignment.assignmentId,
      completedSourceReadings,
      routingArtifacts,
      registry,
      journal,
      usage,
      counters,
      emit,
      completed: writerResults,
      progress: writerProgress,
    });
  } catch (error) {
    emit("failed");
    throw interruptedImportError(
      error,
      options,
      journal,
      "writing",
      readingBlueprint,
      readingBlueprintFallbackWarning,
      completedSourceReadings,
      writingBlueprint,
      writerResults,
      counters,
      adaptiveReadingProgress,
      adaptiveReadingRunProgress,
      postReadingRoutingCheckpoint,
      writerProgress,
    );
  }

  counters.stage = "assembling";
  emit();
  let validated: KnowledgeRunResult;
  try {
    const assembled = assembleWriterResults(
      writingBlueprint,
      writerResults,
      completedSourceReadings,
      readingBlueprintFallbackWarning,
    );
    recordOwnerArtifacts(
      assembled,
      writingBlueprint,
      completedSourceReadings,
      journal,
      registry,
      options.runContext.runId,
    );
    validated = options.validateResult(assembled, journal.events);
  } catch (error) {
    emit("failed");
    throw interruptedImportError(
      error,
      options,
      journal,
      "assembling",
      readingBlueprint,
      readingBlueprintFallbackWarning,
      completedSourceReadings,
      writingBlueprint,
      writerResults,
      counters,
      adaptiveReadingProgress,
      adaptiveReadingRunProgress,
      postReadingRoutingCheckpoint,
      writerProgress,
    );
  }
  journal.record({
    type: "assignment-completed",
    assignmentId: options.rootAssignment.assignmentId,
  });
  journal.record({ type: "run-completed", result: validated });
  counters.completed += 1;
  emit("completed");
  return {
    result: validated,
    history: journal.events,
    artifacts: registry.values(),
    usage,
  };
}

async function readSourcesAdaptively({
  options,
  readingBlueprint,
  sourceAssignments,
  registry,
  journal,
  usage,
  counters,
  emit,
  completed: resumedCompleted,
  progress,
  runProgress,
}: {
  options: FixedBlueprintImportOptions;
  readingBlueprint: KnowledgeReadingBlueprint;
  sourceAssignments: readonly KnowledgeAssignmentContract[];
  registry: KnowledgeArtifactRegistry;
  journal: EventJournal;
  usage: Required<KnowledgeProviderUsage>;
  counters: PipelineCounters;
  emit: (status?: KnowledgeTelemetry["status"]) => void;
  completed: readonly CompletedSourceReading[];
  progress: AdaptiveSourceReadingCheckpoint[];
  runProgress: AdaptiveSourceReadingRunProgress;
}): Promise<CompletedSourceReading[]> {
  const states = new Map<string, AdaptiveSourceReadingState>();
  const resumedKeys = new Set(
    resumedCompleted.map(({ reading }) => sourceRangeKey(reading)),
  );
  const queue: AdaptiveSourceReadingTask[] = [];
  // New logical work caused by a failure belongs to the next settled frontier,
  // never the live one. Original readers may continue filling idle slots.
  const deferredTasks: AdaptiveSourceReadingTask[] = [];
  const pendingCheckpoints = new Map(
    progress.map((entry) => [sourceRangeKey(entry), entry] as const),
  );
  for (const canonicalAssignment of sourceAssignments
    .filter((assignment) => {
      const reader = readerForAssignment(readingBlueprint, assignment);
      return !resumedKeys.has(sourceRangeKey(reader));
    })) {
      const canonicalReader = readerForAssignment(
        readingBlueprint,
        canonicalAssignment,
      );
      const content = sourceRangeContent(
        options.runContext,
        canonicalReader.sourceId,
        canonicalReader.rangeId,
      );
      const saved = pendingCheckpoints.get(sourceRangeKey(canonicalReader));
      const leaves = structuredClone(saved?.leaves ?? []);
      const pending = saved?.pending.length
        ? saved.pending.map((task) =>
            restoreAdaptiveSourceReadingTask(
              options.runContext,
              canonicalReader,
              canonicalAssignment,
              task,
            ),
          )
        : [
            {
              canonicalReader,
              reader: canonicalReader,
              canonicalAssignment,
              context: options.runContext,
              content,
              depth: 0,
              path: [],
              repairAttempt: 0,
              providerRetryAttempt: 0,
            },
          ];
      states.set(sourceRangeKey(canonicalReader), {
        canonicalReader,
        canonicalAssignment,
        outstanding: pending.length,
        wasSplit: leaves.some(({ path }) => path.length > 0) ||
          pending.some(({ path }) => path.length > 0),
        logicalTaskCount: saved?.logicalTaskCount ?? 1,
        attemptCount: saved?.attemptCount ?? 0,
        leaves,
      });
      if (!saved) runProgress.logicalTaskCount += 1;
      queue.push(...pending);
  }
  const completed: CompletedSourceReading[] = structuredClone([
    ...resumedCompleted,
  ]);
  const readingStage = linkedStageController(options.signal);
  const sourceOrder = [...new Set(
    readingBlueprint.readers.map(({ sourceId }) => sourceId),
  )];
  let nextSource = 0;
  const takeNextSourceTask = () => {
    // Source manifests are grouped by document. Round robin prevents a book's
    // first six ranges from delaying every short companion source in a batch.
    for (let offset = 0; offset < sourceOrder.length; offset += 1) {
      const sourceIndex = (nextSource + offset) % sourceOrder.length;
      const taskIndex = queue.findIndex(
        ({ reader }) => reader.sourceId === sourceOrder[sourceIndex],
      );
      if (taskIndex === -1) continue;
      nextSource = (sourceIndex + 1) % sourceOrder.length;
      return queue.splice(taskIndex, 1)[0];
    }
    return queue.shift()!;
  };
  let physicalWidth = INITIAL_READING_WIDTH;
  let healthEpoch = 0;
  const markReaderUnhealthy = () => {
    physicalWidth = INITIAL_READING_WIDTH;
    healthEpoch += 1;
  };
  const activeTasks = new Map<string, AdaptiveSourceReadingTask>();
  const interruptedTasks = new Map<string, AdaptiveSourceReadingTask>();
  const taskFingerprints = new WeakMap<AdaptiveSourceReadingTask, string>();
  const adaptiveTaskIdentity = (task: AdaptiveSourceReadingTask) =>
    `${sourceRangeKey(task.canonicalReader)}:${task.path.join(".") || "root"}`;
  const syncProgress = () => {
    const pending = new Map<string, AdaptiveSourceReadingTask>();
    for (const task of [
      ...queue,
      ...deferredTasks,
      ...activeTasks.values(),
      ...interruptedTasks.values(),
    ]) {
      pending.set(adaptiveTaskIdentity(task), task);
    }
    const next = adaptiveSourceReadingProgress(
      states,
      [...pending.values()],
      taskFingerprints,
    );
    progress.splice(0, progress.length, ...next);
  };
  syncProgress();

  const settleTask = async (task: AdaptiveSourceReadingTask): Promise<boolean> => {
    let clean = true;
    let providerCalled = false;
    const state = states.get(sourceRangeKey(task.canonicalReader));
    if (!state) throw new Error("A source section lost its adaptive reading state.");
    if (
      state.attemptCount >= MAX_ADAPTIVE_ATTEMPTS_PER_CANONICAL ||
      runProgress.attemptCount >= MAX_ADAPTIVE_ATTEMPTS_PER_RUN
    ) {
      throw new AdaptiveSourceReadingSafetyFuseError(
        `The adaptive source-reading safety fuse stopped repeated attempts for ${task.canonicalReader.sourceId}/${task.canonicalReader.rangeId}.`,
      );
    }
    state.attemptCount += 1;
    runProgress.attemptCount += 1;
    try {
      const cacheKey = options.readingCache
        ? sourceReadingCacheKey(
            task.context,
            options.model,
            options.effort,
            readingBlueprint,
            task,
          )
        : undefined;
      let reading =
        options.readingCache && cacheKey
          ? await readCachedSourceReading(options.readingCache, cacheKey, task)
          : undefined;
      if (!reading) {
        providerCalled = true;
        const assignment =
          task.depth === 0
            ? task.canonicalAssignment
            : createAdaptiveSourceReaderAssignment(
                task.context,
                task.reader,
                `assignment:${task.context.runId}:reading-blueprint`,
              );
        reading = await executeTypedAssignment<KnowledgeSourceReading>(
          {
            ...options,
            runContext: task.context,
            signal: readingStage.controller.signal,
          },
          assignment,
          registry,
          journal,
          usage,
          TRANSPORT_SAFETY_TIMEOUT_MS,
          [
            {
              kind: "reading-blueprint",
              trust: "untrusted-context",
              payload: scopedReadingBlueprintForReader(
                readingBlueprint,
                task.reader,
              ),
            },
            ...readerSpaceContextMaterials(task.context, task.reader),
            ...(task.depth > 0
              ? [
                  {
                    kind: "space-orientation" as const,
                    trust: "untrusted-context" as const,
                    payload: {
                      instruction:
                        "This is a narrower follow-up for a source range that could not be represented faithfully in one pass. Read only this child range; do not infer or repeat claims from its failed parent response.",
                    },
                  },
                ]
              : []),
            ...(task.repairAttempt > 0
              ? [
                  {
                    kind: "space-orientation" as const,
                    trust: "untrusted-context" as const,
                    payload: {
                      instruction:
                        "This is the one repair reading for an indivisible source range. Return a compact complete reading of the supplied text and satisfy the exact typed contract; do not infer content from the earlier failed response.",
                    },
                  },
                ]
              : []),
          ],
          false,
          "source-reading",
          (payload) => validateSourceReading(payload, task.reader, task.context),
        );
        if (options.readingCache && cacheKey) {
          await storeCachedSourceReading(
            options.readingCache,
            cacheKey,
            task.content,
            reading,
          );
        }
      }
      state.leaves.push({ path: [...task.path], reading });
      state.outstanding -= 1;
      counters.completed += 1;
      counters.readingCompleted += 1;
      syncProgress();
    } catch (error) {
      clean = false;
      markReaderUnhealthy();
      if (readingStage.controller.signal.aborted) {
        throw readingStage.controller.signal.reason ?? error;
      }
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (
        error instanceof KnowledgeProviderExecutionError &&
        error.retryable &&
        task.providerRetryAttempt === 0
      ) {
        await adaptiveRetryDelay(
          error.retryAfterMs,
          readingStage.controller.signal,
        );
        deferredTasks.push({
          ...task,
          providerRetryAttempt: 1,
        });
        syncProgress();
        return false;
      }
      if (isProviderWideReadingFailure(error)) throw error;
      const children = splitAdaptiveSourceReadingTask(task);
      if (children.length > 0) {
        if (
          state.logicalTaskCount + children.length >
            MAX_ADAPTIVE_LOGICAL_TASKS_PER_CANONICAL ||
          runProgress.logicalTaskCount + children.length >
            MAX_ADAPTIVE_LOGICAL_TASKS_PER_RUN
        ) {
          throw new AdaptiveSourceReadingSafetyFuseError(
            `The adaptive source-reading safety fuse stopped excessive subdivision for ${task.canonicalReader.sourceId}/${task.canonicalReader.rangeId}.`,
          );
        }
        state.wasSplit = true;
        state.logicalTaskCount += children.length;
        runProgress.logicalTaskCount += children.length;
        state.outstanding += children.length - 1;
        counters.readingTotal += children.length - 1;
        deferredTasks.push(...children);
        syncProgress();
      } else if (task.repairAttempt === 0) {
        deferredTasks.push({
          ...task,
          repairAttempt: 1,
        });
        syncProgress();
      } else {
        state.outstanding -= 1;
        state.terminalError ??= error;
        interruptedTasks.set(adaptiveTaskIdentity(task), task);
        syncProgress();
      }
    }

    if (state.outstanding !== 0 || state.terminalError) return clean && providerCalled;
    const reading = mergeAdaptiveSourceReading(
      state.canonicalReader,
      state.leaves,
    );
    const artifact = sourceReadingArtifact(
      options.runContext.runId,
      state.canonicalAssignment,
      reading,
    );
    registry.record(artifact);
    journal.record({ type: "artifact-recorded", artifact });
    completed.push({
      assignment: state.canonicalAssignment,
      artifact,
      reading,
    });
    states.delete(sourceRangeKey(state.canonicalReader));
    syncProgress();
    return clean && providerCalled;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let settled = false;
      let fatalError: unknown;
      interface HealthCohort {
        epoch: number;
        width: number;
        launched: number;
        pending: number;
        clean: boolean;
        sealed: boolean;
      }
      let cohort: HealthCohort | undefined;
      const pump = () => {
        if (settled) return;
        if (!fatalError && active === 0 && queue.length === 0) {
          queue.push(...deferredTasks.splice(0));
          // A repair frontier starts its own health cohort. It cannot inherit
          // a partial cohort containing a failed parent.
          cohort = undefined;
        }
        while (!fatalError && active < physicalWidth && queue.length > 0) {
          if (!cohort || cohort.sealed || cohort.epoch !== healthEpoch) {
            cohort = {
              epoch: healthEpoch,
              width: physicalWidth,
              launched: 0,
              pending: 0,
              clean: true,
              sealed: false,
            };
          }
          const taskCohort = cohort;
          taskCohort.launched += 1;
          taskCohort.pending += 1;
          taskCohort.sealed = taskCohort.launched === taskCohort.width;
          const task = takeNextSourceTask();
          activeTasks.set(adaptiveTaskIdentity(task), task);
          syncProgress();
          active += 1;
          counters.active += 1;
          emit();
          void settleTask(task)
            .then((clean) => {
              taskCohort.clean &&= clean;
            })
            .catch((error) => {
              taskCohort.clean = false;
              markReaderUnhealthy();
              // A rejected provider task is still part of the exact logical
              // frontier. Keep it alongside never-started work so Resume can
              // retry only this path while preserving accepted sibling leaves.
              interruptedTasks.set(adaptiveTaskIdentity(task), task);
              if (fatalError === undefined) {
                fatalError = error;
                if (isProviderWideReadingFailure(error)) {
                  readingStage.controller.abort(error);
                }
              }
            })
            .finally(() => {
              taskCohort.pending -= 1;
              // Widen only after a complete cohort validated cleanly. This is
              // a health barrier, not a work barrier: already pending original
              // ranges keep using idle slots while slower siblings finish.
              if (
                taskCohort.sealed && taskCohort.pending === 0 &&
                taskCohort.clean && taskCohort.epoch === healthEpoch
              ) {
                physicalWidth = MAX_PHYSICAL_WIDTH;
              }
              activeTasks.delete(adaptiveTaskIdentity(task));
              active -= 1;
              counters.active -= 1;
              emit();
              pump();
            });
        }
        if (active > 0) return;
        if (fatalError) {
          settled = true;
          syncProgress();
          reject(
            new AdaptiveSourceReadingInterruptedError(
              fatalError,
              completed,
              progress,
            ),
          );
          return;
        }
        if (queue.length === 0) {
          settled = true;
          resolve();
        }
      };
      pump();
    });
  } finally {
    readingStage.dispose();
  }

  const terminalFailure = [...states.values()].find(
    ({ terminalError }) => terminalError !== undefined,
  )?.terminalError;
  if (terminalFailure !== undefined) {
    throw new AdaptiveSourceReadingInterruptedError(
      terminalFailure,
      completed,
      progress,
    );
  }
  progress.splice(0);
  return completed;
}

function splitAdaptiveSourceReadingTask(
  task: AdaptiveSourceReadingTask,
): AdaptiveSourceReadingTask[] {
  const sections = splitDocumentIntoReadingSections(task.content, 2);
  if (
    sections.length !== 2 ||
    sections.some(({ content }) => !content.trim()) ||
    sections.map(({ content }) => content).join("") !== task.content ||
    sections.some(({ content }) => !isMeaningfulAdaptiveReadingLeaf(content))
  ) {
    return [];
  }
  return sections.map((section, index) => {
    const path = [...task.path, index + 1];
    const suffix = path.join("-");
    const reader: KnowledgeReadingBlueprint["readers"][number] = {
      ...structuredClone(task.canonicalReader),
      readerId: `${task.canonicalReader.readerId}.part-${suffix}`,
      rangeId: `${task.canonicalReader.rangeId}.part-${suffix}`,
    };
    return {
      canonicalReader: task.canonicalReader,
      reader,
      canonicalAssignment: task.canonicalAssignment,
      context: contextWithAdaptiveSourceRange(
        task.context,
        reader.sourceId,
        reader.rangeId,
        section.content,
        section.pageStart,
        section.pageEnd,
      ),
      content: section.content,
      depth: task.depth + 1,
      path,
      repairAttempt: 0,
      providerRetryAttempt: 0,
    };
  });
}

function adaptiveSourceTaskFromPath(
  context: KnowledgeRunContext,
  canonicalReader: KnowledgeReadingBlueprint["readers"][number],
  canonicalAssignment: KnowledgeAssignmentContract,
  path: readonly number[],
): AdaptiveSourceReadingTask {
  let task: AdaptiveSourceReadingTask = {
    canonicalReader,
    reader: canonicalReader,
    canonicalAssignment,
    context,
    content: sourceRangeContent(
      context,
      canonicalReader.sourceId,
      canonicalReader.rangeId,
    ),
    depth: 0,
    path: [],
    repairAttempt: 0,
    providerRetryAttempt: 0,
  };
  for (const part of path) {
    if (part !== 1 && part !== 2) {
      throw new Error("This import recovery state contains an invalid child path.");
    }
    const child = splitAdaptiveSourceReadingTask(task)[part - 1];
    if (!child) {
      throw new Error("This import recovery state contains an impossible source split.");
    }
    task = child;
  }
  return task;
}

function adaptiveSourceTaskCheckpoint(
  task: AdaptiveSourceReadingTask,
  fingerprints: WeakMap<AdaptiveSourceReadingTask, string>,
): AdaptiveSourceReadingTaskCheckpoint {
  // Tasks hold immutable source slices. Frequent progress snapshots must not
  // hash every pending book range again while provider calls are in flight.
  let contentFingerprint = fingerprints.get(task);
  if (contentFingerprint === undefined) {
    contentFingerprint = stableTextFingerprint(task.content);
    fingerprints.set(task, contentFingerprint);
  }
  return {
    path: [...task.path],
    repairAttempt: task.repairAttempt,
    providerRetryAttempt: task.providerRetryAttempt,
    contentFingerprint,
  };
}

function restoreAdaptiveSourceReadingTask(
  context: KnowledgeRunContext,
  canonicalReader: KnowledgeReadingBlueprint["readers"][number],
  canonicalAssignment: KnowledgeAssignmentContract,
  checkpoint: AdaptiveSourceReadingTaskCheckpoint,
): AdaptiveSourceReadingTask {
  const task = adaptiveSourceTaskFromPath(
    context,
    canonicalReader,
    canonicalAssignment,
    checkpoint.path,
  );
  if (
    checkpoint.repairAttempt < 0 ||
    checkpoint.repairAttempt > 1 ||
    checkpoint.providerRetryAttempt < 0 ||
    checkpoint.providerRetryAttempt > 1 ||
    checkpoint.contentFingerprint !== stableTextFingerprint(task.content)
  ) {
    throw new Error("This import recovery state contains stale source work.");
  }
  return {
    ...task,
    repairAttempt: checkpoint.repairAttempt,
    providerRetryAttempt: checkpoint.providerRetryAttempt,
  };
}

function adaptiveSourceReadingProgress(
  states: ReadonlyMap<string, AdaptiveSourceReadingState>,
  pending: readonly AdaptiveSourceReadingTask[],
  fingerprints: WeakMap<AdaptiveSourceReadingTask, string>,
): AdaptiveSourceReadingCheckpoint[] {
  const pendingByRange = new Map<string, AdaptiveSourceReadingTaskCheckpoint[]>();
  for (const task of pending) {
    const key = sourceRangeKey(task.canonicalReader);
    const values = pendingByRange.get(key) ?? [];
    values.push(adaptiveSourceTaskCheckpoint(task, fingerprints));
    pendingByRange.set(key, values);
  }
  return [...states.values()].flatMap((state) => {
    const acceptedPaths = new Set(
      state.leaves.map(({ path }) => path.join(".") || "root"),
    );
    const pendingTasks = (
      pendingByRange.get(sourceRangeKey(state.canonicalReader)) ?? []
    ).filter(({ path }) => !acceptedPaths.has(path.join(".") || "root"));
    return state.leaves.length > 0 || pendingTasks.length > 0
      ? [
          {
            sourceId: state.canonicalReader.sourceId,
            rangeId: state.canonicalReader.rangeId,
            logicalTaskCount: state.logicalTaskCount,
            attemptCount: state.attemptCount,
            leaves: structuredClone(state.leaves),
            pending: pendingTasks,
          },
        ]
      : [];
  });
}

function isMeaningfulAdaptiveReadingLeaf(content: string): boolean {
  const measure = measureSourcePayload(content);
  return (
    measure.characterCount >= MIN_ADAPTIVE_READING_CHARS ||
    measure.utf8Bytes >= MIN_ADAPTIVE_READING_UTF8_BYTES ||
    measure.estimatedTokens >= MIN_ADAPTIVE_READING_ESTIMATED_TOKENS
  );
}

function contextWithAdaptiveSourceRange(
  context: KnowledgeRunContext,
  sourceId: string,
  rangeId: string,
  text: string,
  pageStart?: number,
  pageEnd?: number,
): KnowledgeRunContext {
  const source = context.materials.sources.get(sourceId);
  if (!source) throw new Error(`Unknown adaptive source: ${sourceId}`);
  const ranges = new Map(source.ranges);
  ranges.set(rangeId, text);
  const rangeManifest = {
    rangeId,
    characterCount: text.length,
    ...(pageStart === undefined ? {} : { pageStart }),
    ...(pageEnd === undefined ? {} : { pageEnd }),
  };
  const material = {
    manifest: {
      ...source.manifest,
      ranges: [
        ...source.manifest.ranges.filter((range) => range.rangeId !== rangeId),
        rangeManifest,
      ],
    },
    ranges,
  };
  const sources = new Map(context.materials.sources);
  sources.set(sourceId, material);
  return {
    ...context,
    materials: { ...context.materials, sources },
  };
}

function sourceRangeContent(
  context: KnowledgeRunContext,
  sourceId: string,
  rangeId: string,
): string {
  const content = context.materials.sources.get(sourceId)?.ranges.get(rangeId);
  if (content === undefined) {
    throw new Error(`Unknown source range in this run: ${sourceId}/${rangeId}`);
  }
  return content;
}

function createAdaptiveSourceReaderAssignment(
  context: KnowledgeRunContext,
  reader: KnowledgeReadingBlueprint["readers"][number],
  parentAssignmentId: string,
): KnowledgeAssignmentContract {
  return createSourceReaderAssignments(
    context,
    {
      spaceExplanation: "Narrow source-range follow-up.",
      spaceFocusConcepts: [],
      spaceQuestions: [],
      readers: [reader],
      warnings: [],
    },
    parentAssignmentId,
  )[0];
}

function scopedReadingBlueprintForReader(
  blueprint: KnowledgeReadingBlueprint,
  reader: KnowledgeReadingBlueprint["readers"][number],
): KnowledgeReadingBlueprint {
  return {
    ...structuredClone(blueprint),
    readers: [structuredClone(reader)],
  };
}

function mergeAdaptiveSourceReading(
  canonicalReader: KnowledgeReadingBlueprint["readers"][number],
  leaves: readonly AdaptiveSourceReadingLeaf[],
): KnowledgeSourceReading {
  if (leaves.length === 0) {
    throw new Error("A source section has no completed adaptive readings.");
  }
  const ordered = [...leaves].sort((left, right) =>
    compareNumberPaths(left.path, right.path),
  );
  assertCompleteAdaptiveLeafPaths(ordered.map(({ path }) => path));
  const sourceClaims: KnowledgeSourceReading["sourceClaims"] = [];
  const spaceInterpretations: KnowledgeSourceReading["spaceInterpretations"] = [];
  const synthesisSeeds: KnowledgeSourceReading["synthesisSeeds"] = [];
  const renumberMergedIds =
    ordered.length > 1 || ordered.some(({ path }) => path.length > 0);
  for (let leafIndex = 0; leafIndex < ordered.length; leafIndex += 1) {
    const { reading } = ordered[leafIndex];
    const claimIds = new Map<string, string>();
    for (let claimIndex = 0; claimIndex < reading.sourceClaims.length; claimIndex += 1) {
      const claim = reading.sourceClaims[claimIndex];
      const claimId = renumberMergedIds
        ? `claim-${leafIndex + 1}-${claimIndex + 1}`
        : claim.claimId;
      claimIds.set(claim.claimId, claimId);
      sourceClaims.push({
        ...structuredClone(claim),
        claimId,
        support: [
          {
            sourceId: canonicalReader.sourceId,
            rangeId: canonicalReader.rangeId,
          },
        ],
      });
    }
    for (
      let interpretationIndex = 0;
      interpretationIndex < reading.spaceInterpretations.length;
      interpretationIndex += 1
    ) {
      const interpretation = reading.spaceInterpretations[interpretationIndex];
      spaceInterpretations.push({
        ...structuredClone(interpretation),
        interpretationId: renumberMergedIds
          ? `interpretation-${leafIndex + 1}-${interpretationIndex + 1}`
          : interpretation.interpretationId,
        sourceClaimIds: interpretation.sourceClaimIds.map((claimId) => {
          const mapped = claimIds.get(claimId);
          if (!mapped) {
            throw new Error(
              "An adaptive source interpretation lost its source claim.",
            );
          }
          return mapped;
        }),
      });
    }
    for (let seedIndex = 0; seedIndex < reading.synthesisSeeds.length; seedIndex += 1) {
      const seed = reading.synthesisSeeds[seedIndex];
      synthesisSeeds.push({
        ...structuredClone(seed),
        seedId: renumberMergedIds
          ? `seed-${leafIndex + 1}-${seedIndex + 1}`
          : seed.seedId,
        claimIds: seed.claimIds.map((claimId) => {
          const mapped = claimIds.get(claimId);
          if (!mapped) {
            throw new Error("An adaptive synthesis seed lost its source claim.");
          }
          return mapped;
        }),
      });
    }
  }
  return {
    sourceId: canonicalReader.sourceId,
    rangeId: canonicalReader.rangeId,
    summary: truncateUnicode(
      ordered
        .map(({ reading }) => reading.summary)
        .join("\n\n"),
      8_000,
    ),
    coverage: {
      complete: true,
      limitations: uniqueStrings(
        ordered.flatMap(({ reading }) => reading.coverage.limitations),
      ).slice(0, 40),
    },
    sourceAssessment: {
      importance: strongestAssessment(
        ordered.map(({ reading }) => reading.sourceAssessment.importance),
      ),
      rationale: truncateUnicode(
        ordered
          .map(({ reading }) => reading.sourceAssessment.rationale)
          .join(" "),
        4_000,
      ),
    },
    spaceAssessment: {
      relevance: strongestAssessment(
        ordered.map(({ reading }) => reading.spaceAssessment.relevance),
      ),
      novelty: strongestAssessment(
        ordered.map(({ reading }) => reading.spaceAssessment.novelty),
      ),
      focusConcepts: uniqueStrings(
        ordered.flatMap(({ reading }) => reading.spaceAssessment.focusConcepts),
      ).slice(0, 40),
      deprioritizedConcepts: uniqueStrings(
        ordered.flatMap(
          ({ reading }) => reading.spaceAssessment.deprioritizedConcepts,
        ),
      ).slice(0, 40),
      reviewedNoteIds: uniqueStrings(
        ordered.flatMap(
          ({ reading }) => reading.spaceAssessment.reviewedNoteIds,
        ),
      ),
      rationale: truncateUnicode(
        ordered
          .map(({ reading }) => reading.spaceAssessment.rationale)
          .join(" "),
        4_000,
      ),
    },
    sourceClaims,
    spaceInterpretations,
    synthesisSeeds,
    mustPreserve: uniqueStrings([
      `Source range ${canonicalReader.sourceId}/${canonicalReader.rangeId}`,
      ...canonicalReader.mustPreserve,
      ...ordered.flatMap(({ reading }) => reading.mustPreserve.filter(
        (required) => !required.startsWith(`Source range ${canonicalReader.sourceId}/`),
      )),
    ]),
  };
}

function strongestAssessment(
  values: readonly ("low" | "medium" | "high")[],
): "low" | "medium" | "high" {
  if (values.includes("high")) return "high";
  return values.includes("medium") ? "medium" : "low";
}

function isProviderWideReadingFailure(error: unknown): boolean {
  if (error instanceof KnowledgeProviderTimeoutError) return true;
  if (error instanceof KnowledgeProviderExecutionError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:api key|invalid[_ -]?api[_ -]?key|authenticat|unauthori[sz]ed|forbidden|billing|quota|insufficient[_ -]?quota|rate(?: or usage)? limit|too many requests|temporarily unavailable|service unavailable|provider unavailable|overloaded|could not reach|network|connection|connection reset|socket|dns|fetch failed|gateway|request failed|server error|internal server error|http (?:401|403|408|409|429|5\d\d)|status(?: code)?[ :=]+(?:401|403|408|409|429|5\d\d)|invalid schema|response_format|unsupported output contract|model .*?(?:not found|unavailable|access)|model_not_found)/i.test(
    message,
  );
}

async function adaptiveRetryDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const boundedDelay = Math.min(5_000, Math.max(0, delayMs));
  if (boundedDelay === 0) return;
  await new Promise<void>((resolve, reject) => {
    let timeout: number | undefined;
    const onAbort = () => {
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      reject(signal?.reason ?? new Error("The knowledge import was cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, boundedDelay) as unknown as number;
  });
}

function compareNumberPaths(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? -1) - (right[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Defends the local evidence merge independently of scheduler bookkeeping.
 * A valid adaptive result is either the unsplit root, or a complete binary
 * leaf frontier such as 1, 2.1, 2.2. Missing, duplicate, overlapping, or
 * invented child paths must never be accepted as canonical range coverage.
 */
function assertCompleteAdaptiveLeafPaths(paths: readonly (readonly number[])[]): void {
  if (paths.length === 1 && paths[0].length === 0) return;
  if (paths.length === 0 || paths.some((path) => path.length === 0)) {
    throw new Error("Adaptive source evidence has incomplete child coverage.");
  }
  const keys = new Set<string>();
  for (const path of paths) {
    if (path.some((part) => part !== 1 && part !== 2)) {
      throw new Error("Adaptive source evidence has an invalid child path.");
    }
    const key = path.join(".");
    if (keys.has(key)) {
      throw new Error("Adaptive source evidence contains a duplicate child reading.");
    }
    keys.add(key);
  }

  const covers = (prefix: readonly number[]): boolean => {
    const key = prefix.join(".");
    if (keys.has(key)) {
      const descendantPrefix = `${key}.`;
      if ([...keys].some((candidate) => candidate.startsWith(descendantPrefix))) {
        throw new Error("Adaptive source evidence contains overlapping child readings.");
      }
      return true;
    }
    const descendantPrefix = key ? `${key}.` : "";
    const hasDescendant = [...keys].some((candidate) =>
      candidate.startsWith(descendantPrefix),
    );
    if (!hasDescendant) return false;
    return covers([...prefix, 1]) && covers([...prefix, 2]);
  };

  if (!covers([])) {
    throw new Error("Adaptive source evidence has incomplete child coverage.");
  }
}

export function fixedPipelineSourceRanges(
  context: KnowledgeRunContext,
): SourceRangeTarget[] {
  const ranges = context.sources.flatMap((source) =>
    source.ranges.map(({ rangeId }) => ({
      sourceId: source.sourceId,
      rangeId,
    })),
  );
  if (ranges.length > MAX_SOURCE_READINGS) {
    throw new Error(
      `This mixed import needs ${ranges.length} canonical evidence groups, exceeding Orion's bounded synthesis input. Import fewer sources together.`,
    );
  }
  if (ranges.length === 0) {
    throw new Error("Orion could not find any readable source sections.");
  }
  return ranges;
}

function createReadingBlueprintAssignment(
  context: KnowledgeRunContext,
  ranges: readonly SourceRangeTarget[],
): KnowledgeAssignmentContract {
  return {
    assignmentId: `assignment:${context.runId}:reading-blueprint`,
    parent: { kind: "assignment", assignmentId: `assignment:${context.runId}:root` },
    purpose: "reading-blueprint",
    objective:
      "Create one Space-aware reading plan from source manifests and bounded Space orientation. Explain the active Space, then assign every declared range exactly once. The plan is an interpretive lens, not evidence about source prose.",
    references: context.sources.map(({ sourceId }) => ({
      kind: "source" as const,
      sourceId,
    })),
    constraints: {
      rules: [
        ...context.constraints,
        "Do not claim to have read source prose: this stage receives manifests only.",
        "Assign every contracted source range exactly once and keep comparisons inside the active Space.",
        "Focus questions may be eisegetic—reading through the Space's concerns—but may not predetermine what the source says.",
      ],
      mustPreserve: ranges.map(
        ({ sourceId, rangeId }) => `Source range ${sourceId}/${rangeId}`,
      ),
    },
    authority: { kind: "read-only" },
    output: {
      kind: "reading-blueprint",
      sourceRanges: ranges.map((range) => ({ ...range })),
    },
    termination: {
      condition:
        "Stop after one exact, complete range partition and a concise Space explanation; do not read or summarize source prose.",
    },
  };
}

function deterministicReadingBlueprint(
  context: KnowledgeRunContext,
  ranges: readonly SourceRangeTarget[],
): KnowledgeReadingBlueprint {
  const focusConcepts = context.space.concepts
    .map(({ label }) => label)
    .slice(0, 16);
  const noteDigests = [
    ...context.space.notes,
    ...[...context.materials.noteDigestRanges.values()].flatMap(
      (values) => values,
    ),
  ];
  const comparisonNotes = noteDigests.slice(0, 3);
  const spaceExplanation =
    context.targetedSpaceContext?.spaceBlueprint?.root.body.trim() ||
    context.space.overview?.body.trim() ||
    context.space.description.trim() ||
    (focusConcepts.length > 0
      ? `This Space is organized around ${focusConcepts.join(", ")}.`
      : `This is the “${context.space.name}” Space.`);
  return {
    spaceExplanation,
    spaceFocusConcepts: focusConcepts,
    spaceQuestions: [
      "Which source claims materially extend, challenge, or clarify this Space?",
      "Which distinctions are important within the source even when they are not yet represented in the Space?",
    ],
    readers: ranges.map(({ sourceId, rangeId }, index) => ({
      readerId: `reader-${index + 1}`,
      sourceId,
      rangeId,
      focusQuestions: [
        "What arguments, distinctions, evidence, examples, and uncertainty appear in this complete range?",
        "What is relevant or novel relative to the Space, without treating that lens as source evidence?",
      ],
      focusConcepts,
      comparisons: comparisonNotes.map(({ noteId, title }) => ({
        noteId,
        reason: `Compare the source's own claims with the existing Space topic “${title}”.`,
      })),
      mustPreserve: [`Source range ${sourceId}/${rangeId}`],
    })),
    warnings: [],
  };
}

function validateReadingBlueprint(
  blueprint: KnowledgeReadingBlueprint,
  context: KnowledgeRunContext,
  ranges: readonly SourceRangeTarget[],
): void {
  const expected = new Set(ranges.map(sourceRangeKey));
  const actual = new Set(
    blueprint.readers.map(({ sourceId, rangeId }) =>
      sourceRangeKey({ sourceId, rangeId }),
    ),
  );
  if (
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key))
  ) {
    throw new Error("The initial reading plan did not cover every source section exactly once.");
  }
  const noteIds = new Set(context.materials.notes.keys());
  for (const reader of blueprint.readers) {
    if (
      reader.comparisons.length > 8 ||
      new Set(reader.comparisons.map(({ noteId }) => noteId)).size !==
        reader.comparisons.length
    ) {
      throw new Error(
        "The initial reading plan returned too many or repeated Space comparisons.",
      );
    }
    if (reader.comparisons.some(({ noteId }) => !noteIds.has(noteId))) {
      throw new Error("The initial reading plan referenced a note outside the active Space.");
    }
  }
}

function createSourceReaderAssignments(
  context: KnowledgeRunContext,
  blueprint: KnowledgeReadingBlueprint,
  parentAssignmentId: string,
): KnowledgeAssignmentContract[] {
  return blueprint.readers.map((reader) => ({
    assignmentId: `assignment:${context.runId}:source-reader:${reader.readerId}`,
    parent: { kind: "assignment" as const, assignmentId: parentAssignmentId },
    purpose: "source-reader" as const,
    objective:
      "Read the entire assigned range. First extract source-grounded claims; then separately interpret those claims through the supplied Space lens. Identify distinct synthesis seeds: evidence-bound theses, mechanisms, distinctions, tensions, or combinations that could become durable Space knowledge. The private range summary is for coverage and must never be written as a user note. Cover the range completely even when part of it is tangential to the lens. If the range's breadth or density would force material omission, set coverage.complete to false so Orion can assign narrower exact ranges instead of pretending the compressed reading is complete.",
    references: [
      {
        kind: "source-range" as const,
        sourceId: reader.sourceId,
        rangeId: reader.rangeId,
      },
    ],
    constraints: {
      rules: [
        ...context.constraints,
        "Source claims may cite only the assigned source range.",
        "Space interpretations are eisegetic lenses, not statements that the source itself made.",
        "Preserve the source's epistemic status in every claim and seed: a question, hypothesis, possibility, recollection, or first-person experience must not become an established general fact. Keep attribution and qualifications when they change what the source actually supports.",
        "Each synthesis seed must name an idea rather than this source, chapter, page, or range; cite only exact claim IDs from this reading; and state whether the idea is new, extends, contradicts, connects, or qualifies Space knowledge.",
        "Write sourceClaims at atomic conceptual grain, then partition every sourceClaim into exactly one synthesis seed. A seed may combine at most four mutually supporting claims. Never leave a substantive claim unseeded or reuse one across seeds.",
        "Keep seed titles and theses distinct. A dense range may yield several seeds; a repetitive range may yield one. Never collapse unrelated ideas or split one idea merely to reach a target count.",
        "Do not omit low-relevance prose from coverage; assess it separately from importance within the source.",
        "When a faithful complete representation is not possible in this pass, set coverage.complete to false, explain the limitation, and do not present partial claims as accepted complete-range evidence.",
      ],
      mustPreserve: uniqueStrings([
        `Source range ${reader.sourceId}/${reader.rangeId}`,
        ...reader.mustPreserve,
      ]),
    },
    authority: { kind: "read-only" as const },
    output: {
      kind: "source-reading" as const,
      sourceId: reader.sourceId,
      rangeId: reader.rangeId,
    },
    termination: {
      condition:
        "Return either a faithful complete reading whose claims have exact range support, or an explicit coverage.complete false result requesting a narrower pass. Never silently omit dense material.",
    },
  }));
}

function validateSourceReading(
  reading: KnowledgeSourceReading,
  reader: KnowledgeReadingBlueprint["readers"][number],
  context: KnowledgeRunContext,
): void {
  if (!reading.coverage.complete) {
    throw new Error(
      `A source section was not read completely: ${reader.sourceId}/${reader.rangeId}.`,
    );
  }
  if (reading.sourceClaims.length === 0) {
    throw new Error(
      `A non-empty source section returned no grounded claims: ${reader.sourceId}/${reader.rangeId}.`,
    );
  }
  if (reading.synthesisSeeds.length === 0) {
    throw new Error(
      `A non-empty source section returned no durable knowledge candidates: ${reader.sourceId}/${reader.rangeId}.`,
    );
  }
  const preserved = new Set(reading.mustPreserve);
  for (const required of uniqueStrings([
    `Source range ${reader.sourceId}/${reader.rangeId}`,
    ...reader.mustPreserve,
  ])) {
    if (!preserved.has(required)) {
      throw new Error("A source reading lost its required section identity.");
    }
  }
  const validNoteIds = new Set(context.materials.notes.keys());
  const claimIds = new Set(reading.sourceClaims.map(({ claimId }) => claimId));
  const seededClaimIds = reading.synthesisSeeds.flatMap(
    ({ claimIds: selectedClaimIds }) => selectedClaimIds,
  );
  if (
    seededClaimIds.length !== claimIds.size ||
    new Set(seededClaimIds).size !== seededClaimIds.length ||
    seededClaimIds.some((claimId) => !claimIds.has(claimId))
  ) {
    throw new Error(
      "Synthesis seeds must partition every source claim exactly once.",
    );
  }
  for (const seed of reading.synthesisSeeds) {
    if (seed.claimIds.length > 4) {
      throw new Error(
        "One synthesis seed selected more than four atomic source claims.",
      );
    }
    if (seed.claimIds.some((claimId) => !claimIds.has(claimId))) {
      throw new Error("A synthesis seed selected an unknown source claim.");
    }
    if (seed.relatedNoteIds.some((noteId) => !validNoteIds.has(noteId))) {
      throw new Error("A synthesis seed referenced a note outside the active Space.");
    }
    if (sourceShapedKnowledgeTitle(seed.proposedTitle, context)) {
      throw new Error(
        `A synthesis seed used a source-shaped title instead of naming its idea: ${seed.proposedTitle}.`,
      );
    }
  }
  const reviewed = new Set(reading.spaceAssessment.reviewedNoteIds);
  for (const { noteId } of reader.comparisons) {
    if (!reviewed.has(noteId)) {
      throw new Error("A source reading did not review its declared comparison note.");
    }
  }
  for (const noteId of [
    ...reading.spaceAssessment.reviewedNoteIds,
    ...reading.spaceInterpretations.flatMap(({ relatedNoteIds }) => relatedNoteIds),
  ]) {
    if (!validNoteIds.has(noteId)) {
      throw new Error("A source reading used a note outside the active Space.");
    }
  }
}

function createWritingBlueprintAssignment(
  context: KnowledgeRunContext,
  parentAssignmentId: string,
  readings: readonly CompletedSourceReading[],
  routingArtifacts: readonly KnowledgeArtifact[],
  revisionAccess: FixedRevisionAccess,
): KnowledgeAssignmentContract {
  const readingArtifactIds = readings.map(({ artifact }) => artifact.artifactId);
  const routedNoteReferences =
    revisionAccess === "validated-routing"
      ? selectRoutedFullNoteReferences(context, routingArtifacts)
      : [];
  return {
    assignmentId: `assignment:${context.runId}:writing-blueprint`,
    parent: { kind: "assignment", assignmentId: parentAssignmentId },
    purpose: "writing-blueprint",
    objective:
      "Design the complete nonredundant set of durable knowledge objects supported by all completed readings. Organize outputs around reusable theses, concepts, distinctions, mechanisms, tensions, and syntheses—not around files, chapters, pages, ranges, or source order. Reconcile every synthesis seed into an output, a justified merge, or an explicit omission; select source claims exactly, use Space interpretations only as editorial lenses, and partition disjoint outputs across one to six writers.",
    // Wide source readings stay solely in pipelineMaterials. Exact routed
    // notes and their router artifacts are the narrow exception: those refs
    // are required to authorize selective full-note reads and are never source
    // evidence.
    references: [
      ...routingArtifacts.map(({ artifactId }) => ({
        kind: "artifact" as const,
        artifactId,
      })),
      ...routedNoteReferences,
    ],
    constraints: {
      rules: [
        ...context.constraints,
        "Every output must select at least one exact source claim; Space interpretations never establish provenance.",
        "Every imported source must contribute to at least one useful output, but a generic source-summary note is not required. The preserved Source record already carries document order and complete text.",
        "Infer knowledge objects across all readings: combine supporting claims from distant ranges or sources when they establish one thesis, and split adjacent claims when they establish different ideas.",
        "Give each clear, distinct thesis its own output. Merge seeds only when they support the same thesis, and explain that exact shared thesis in each merge rationale; shared vocabulary, source, or topic is not enough. Do not compress ideas to a target note count or manufacture filler. The thirty-output and aggregate-token limits are safety bounds: if the complete idea set does not fit, return the boundary honestly instead of disguising unrelated ideas as one note.",
        "Each output must make a distinct contribution that is new to, extends, contradicts, connects, or qualifies the Space. Its title must name that contribution directly, never a source title plus Part N, a range/page/chapter label, Notes on, Introduction to, or a generic summary unless the document itself is the genuine subject.",
        "A source index note may provide navigation only when useful; it cannot replace the durable knowledge objects it links.",
        "Discard low-value repetition and tangents from outputs without claiming they were absent from the preserved source.",
        revisionAccess === "validated-routing"
          ? "Revision destinations must be exact, current wiki articles listed in revisionCandidates and authorized by validated post-reading routing. collisionTitles exist only for title collision safety and never grant revision authority."
          : "Post-reading routing did not establish revision authority. Plan create operations only: revisionCandidates is empty, and Across this Space context or collisionTitles never authorize a revision.",
        "Writers own disjoint outputs and receive no sibling prose.",
        "Plan readable ordinary prose and structured links; final note bodies must never contain literal [[wiki]] syntax.",
        "Plan the link vocabulary before writing. Full-sentence argument titles are valid, but durable synthesis-seed linkPhrases need one appropriate canonical destination. Return concepts with exact canonicalTitle references to planned or available existing notes; retain only meaningful phrases, never tags or a keyword inventory. Do not manufacture a duplicate article when an argument note already explains the phrase.",
        "Plan suggestedConnections between exact titles with kind supports, qualifies, conflicts, or related and a specific reason. Direction runs from the supporting or qualifying argument to the argument it bears on. Preserve disagreement as conflicts; never connect notes merely because they share a source or word. Connections are a semantic plan resolved locally after all output IDs exist, not instructions to copy sibling prose.",
        "Keep explicit action items in source-grounded project notes as Markdown tasks (- [ ]). Never invent tasks or copy them into canonical wiki articles.",
        "Canonical articles should be definitional, integrate new evidence into coherent existing prose, explain Space relevance, and preserve genuine uncertainty.",
        "Use the frozen destination directory for exact existing-note IDs and versions; it is Space context, never source evidence.",
      ],
      mustPreserve: context.sources.map(
        ({ sourceId, title }) => `Source ${sourceId}: ${title}`,
      ),
    },
    authority: { kind: "read-only" },
    output: { kind: "writing-blueprint", readingArtifactIds },
    termination: {
      condition:
        "Stop after every synthesis seed is assigned exactly once to an output, justified merge, or explicit omission; every output has exact claim selections; and the one-to-six-slot partition is exact. Do not write final note prose.",
    },
  };
}

function selectRoutedFullNoteReferences(
  context: KnowledgeRunContext,
  routingArtifacts: readonly KnowledgeArtifact[],
): Array<Extract<KnowledgeReference, { kind: "note" }>> {
  const relationPriority = new Map([
    ["contradicts", 0],
    ["extends", 1],
    ["uncertain", 2],
  ]);
  const relationByNoteId = new Map(
    validateCompleteNoteRoutingCoverage(context, routingArtifacts).flatMap(
      ({ routes }) =>
        routes.map(({ noteId, relation }) => [noteId, relation] as const),
    ),
  );
  const candidates = createRoutedFullNoteReferences(context, routingArtifacts).sort(
    (left, right) =>
      (relationPriority.get(relationByNoteId.get(left.noteId) ?? "") ?? 3) -
        (relationPriority.get(relationByNoteId.get(right.noteId) ?? "") ?? 3) ||
      left.noteId.localeCompare(right.noteId),
  );
  const selected: typeof candidates = [];
  let characters = 0;
  for (const reference of candidates) {
    if (selected.length >= MAX_ROUTED_FULL_NOTES_FOR_WRITING_PLAN) break;
    const note = context.materials.notes.get(reference.noteId);
    if (!note) continue;
    if (
      selected.length > 0 &&
      characters + note.body.length > MAX_ROUTED_FULL_NOTE_CHARACTERS
    ) {
      continue;
    }
    selected.push(reference);
    characters += note.body.length;
  }
  return selected;
}

function assertCompletedSourceReadingsWithinAggregateBudget(
  readings: readonly CompletedSourceReading[],
): void {
  const serializedReadings = JSON.stringify(
    readings.map(({ artifact, reading }) => ({
      artifactId: artifact.artifactId,
      reading,
    })),
  );
  const utf8Bytes = new TextEncoder().encode(serializedReadings).byteLength;
  if (utf8Bytes > MAX_COMPLETED_SOURCE_READINGS_UTF8_BYTES) {
    throw new Error(
      `The completed source readings need ${utf8Bytes.toLocaleString()} bytes, exceeding Orion's ${MAX_COMPLETED_SOURCE_READINGS_UTF8_BYTES.toLocaleString()}-byte writing-plan evidence budget. Import fewer sources together or divide this source into separate imports.`,
    );
  }
}

async function runPostReadingRouting(
  options: FixedBlueprintImportOptions,
  readings: readonly CompletedSourceReading[],
  registry: KnowledgeArtifactRegistry,
  journal: EventJournal,
  usage: Required<KnowledgeProviderUsage>,
): Promise<{
  context: KnowledgeRunContext;
  artifacts: KnowledgeArtifact[];
}> {
  if (!options.snapshot.settings.includeExistingNotesInAIContext) {
    return { context: options.runContext, artifacts: [] };
  }
  const synopsis = postReadingRoutingSynopsis(readings);
  const context = postReadingRoutingContext(options, readings);
  const call = createNoteRoutingCall(
    context,
    `assignment:${context.runId}:reading-blueprint`,
    synopsis,
  );
  if (!call) return { context, artifacts: [] };
  if (call.primitive !== "fan_out") {
    throw new Error("Post-reading routing must use one host-owned fan-out.");
  }

  const artifacts: KnowledgeArtifact[] = [];
  for (const assignment of call.assignments) {
    const routing = await executeTypedAssignment<KnowledgeNoteRoutingResult>(
      { ...options, runContext: context },
      assignment,
      registry,
      journal,
      usage,
      TRANSPORT_SAFETY_TIMEOUT_MS,
      [],
      false,
      "note-routing",
      () => undefined,
      1,
    );
    const artifact = noteRoutingArtifact(assignment, routing);
    registry.record(artifact);
    journal.record({ type: "artifact-recorded", artifact });
    artifacts.push(artifact);
  }
  validateCompleteNoteRoutingCoverage(context, artifacts);
  return { context, artifacts };
}

function postReadingRoutingSynopsis(
  readings: readonly CompletedSourceReading[],
): string {
  return truncateUnicode(
    readings
      .flatMap(({ reading }) => [
        ...reading.synthesisSeeds.flatMap(({ proposedTitle, thesis }) => [
          proposedTitle,
          thesis,
        ]),
        ...reading.sourceClaims.map(({ text }) => text),
        ...reading.spaceInterpretations.map(({ text }) => text),
      ])
      .join("\n"),
    24_000,
  );
}

function postReadingRoutingContext(
  options: FixedBlueprintImportOptions,
  readings: readonly CompletedSourceReading[],
): KnowledgeRunContext {
  if (!options.snapshot.settings.includeExistingNotesInAIContext) {
    return options.runContext;
  }
  return createKnowledgeRunContext(
    options.runContext.runId,
    options.snapshot,
    options.sources,
    options.runContext.importGuidance,
    {
      includeExistingNotes: true,
      useOverviewLinkedNoteContext: true,
      hybridNoteRouting: true,
      hybridRoutingMatchText: postReadingRoutingSynopsis(readings),
    },
  );
}

function postReadingRoutingContextIdentity(context: KnowledgeRunContext): string {
  const identity = JSON.stringify({
    runId: context.runId,
    spaceId: context.space.spaceId,
    snapshotVersion: context.space.snapshotVersion,
    noteAccess: context.noteAccess,
    sources: context.sources.map(({ sourceId, ranges }) => ({
      sourceId,
      ranges: ranges.map(({ rangeId, characterCount }) => ({
        rangeId,
        characterCount,
      })),
    })),
    noteDigestRanges: context.space.noteDigestRanges,
    candidateNotes: [...context.materials.notes.values()].map((note) => ({
      noteId: note.id,
      version: noteVersion(note),
    })),
    importGuidance: context.importGuidance,
    organizationInstructions: context.organizationInstructions,
  });
  return stableHash(identity) + stableHash(`${identity.length}:${identity}`);
}

function createPostReadingRoutingCheckpoint(
  mode: FixedPostReadingRoutingCheckpoint["mode"],
  context: KnowledgeRunContext,
  artifacts: readonly KnowledgeArtifact[],
  warning?: string,
): FixedPostReadingRoutingCheckpoint {
  if (mode === "routed") {
    validatePostReadingRoutingArtifacts(context, artifacts);
  } else if (artifacts.length > 0) {
    throw new Error("Baseline recovery cannot retain typed routing artifacts.");
  }
  return {
    mode,
    contextIdentity: postReadingRoutingContextIdentity(context),
    artifacts: structuredClone([...artifacts]),
    ...(warning ? { warning } : {}),
  };
}

function fixedRevisionAccess(
  checkpoint: FixedPostReadingRoutingCheckpoint | undefined,
  artifacts: readonly KnowledgeArtifact[],
): FixedRevisionAccess {
  return checkpoint?.mode === "routed" && artifacts.length > 0
    ? "validated-routing"
    : "create-only";
}

function restorePostReadingRouting(
  options: FixedBlueprintImportOptions,
  readings: readonly CompletedSourceReading[],
  checkpoint: FixedPostReadingRoutingCheckpoint,
): { context: KnowledgeRunContext; artifacts: KnowledgeArtifact[] } {
  const context =
    checkpoint.mode === "baseline"
      ? options.runContext
      : postReadingRoutingContext(options, readings);
  if (
    checkpoint.contextIdentity !== postReadingRoutingContextIdentity(context)
  ) {
    throw new Error("This import recovery state contains stale Space routing.");
  }
  const artifacts = structuredClone(checkpoint.artifacts);
  if (checkpoint.mode === "routed") {
    validatePostReadingRoutingArtifacts(context, artifacts);
  } else if (artifacts.length > 0) {
    throw new Error("This import recovery state widened baseline Space access.");
  }
  return { context, artifacts };
}

function validatePostReadingRoutingArtifacts(
  context: KnowledgeRunContext,
  artifacts: readonly KnowledgeArtifact[],
): void {
  validateCompleteNoteRoutingCoverage(context, artifacts);
  const call = createNoteRoutingCall(
    context,
    `assignment:${context.runId}:reading-blueprint`,
  );
  const assignments = call?.primitive === "fan_out" ? call.assignments : [];
  if (
    artifacts.length !== assignments.length ||
    artifacts.some(({ routing }) => routing === undefined)
  ) {
    throw new Error("This import recovery state contains extra Space routing artifacts.");
  }
  const artifactsByRange = new Map(
    artifacts.map((artifact) => [artifact.routing!.rangeId, artifact] as const),
  );
  for (const assignment of assignments) {
    if (assignment.output.kind !== "note-routing") {
      throw new Error("Post-reading routing restored a non-routing assignment.");
    }
    const artifact = artifactsByRange.get(assignment.output.rangeId);
    if (!artifact?.routing) {
      throw new Error("This import recovery state omitted a Space routing artifact.");
    }
    const expected = noteRoutingArtifact(assignment, artifact.routing);
    if (JSON.stringify(artifact) !== JSON.stringify(expected)) {
      throw new Error("This import recovery state contains stale Space routing provenance.");
    }
  }
}

function noteRoutingArtifact(
  assignment: KnowledgeAssignmentContract,
  routing: KnowledgeNoteRoutingResult,
): KnowledgeArtifact {
  return {
    artifactId: `artifact:${assignment.assignmentId}:fixed`,
    assignmentId: assignment.assignmentId,
    purpose: "router",
    summary: `Routed ${routing.routes.length} note digest${routing.routes.length === 1 ? "" : "s"} in ${routing.rangeId}.`,
    body: "",
    assessment: {
      spaceRelevance: "medium",
      sourceImportance: "medium",
      novelty: "medium",
      focusConcepts: [],
      deprioritizedConcepts: [],
      reviewedNoteIds: routing.routes.map(({ noteId }) => noteId),
      rationale: "Typed post-reading routing coverage.",
    },
    claims: [],
    references: structuredClone(assignment.references),
    mustPreserve: [...assignment.constraints.mustPreserve],
    ownerProposals: [],
    routing: structuredClone(routing),
  };
}

function canRecoverLocallyFromFixedStageError(
  error: unknown,
  signal?: AbortSignal,
): boolean {
  if (signal?.aborted) return false;
  // A contract-invalid planner may be repaired locally. An unhealthy provider
  // must not gain another fan-out merely because the host can build a plan.
  if (error instanceof KnowledgeProviderTimeoutError) return false;
  if (error instanceof KnowledgeProviderExecutionError) return false;
  if (error instanceof FixedAssignmentContractError) return true;
  const message = errorMessage(error);
  // Only contract failures may fall back to local planning. Transport failures
  // stop the stage; they must not fan out more work against an unhealthy provider.
  return !/timed? ?out|timeout|api key|unauthori[sz]ed|forbidden|billing|quota|rate limit|too many requests|could not reach|network|connection|socket|dns|fetch failed|gateway|service unavailable|provider unavailable|overloaded|server error|http (?:401|403|408|409|429|5\d\d)|does not have access|model (?:is )?(?:unavailable|not found)/i.test(
    message,
  );
}

/**
 * Last-resort synthesis planning after the source readers have already
 * succeeded. This is deliberately host-owned: it cannot revise existing
 * notes, invent evidence, or widen access to the Space. It groups the readers'
 * typed semantic seeds instead of physical ranges, so recovery retains the
 * same knowledge-object grain as the generated plan and never becomes Part-N
 * source commentary.
 */
function canPlanCompactImportLocally(
  options: FixedBlueprintImportOptions,
  readings: readonly CompletedSourceReading[],
): boolean {
  if (options.snapshot.notes.length || options.runContext.importGuidance.trim() || options.sources.length > 6 ||
      options.sources.reduce((total, { parsed }) => total + new TextEncoder().encode(parsed.text).byteLength, 0) > 24_000) return false;
  const preference = options.snapshot.settings.organizationInstructions.trim();
  if (preference && preference !== defaultSettings.organizationInstructions.trim()) return false;
  // Task allocation and deliberate cross-source merges still need the shared
  // planner. Keep this optimization conservative and purely creation-only.
  if (options.sources.some(({ parsed }) => /^\s*[-*+]\s+\[[ xX]\]/m.test(parsed.text))) return false;
  if (readings.some(({ assignment, reading }) => reading.mustPreserve.some(
    (required) => !assignment.constraints.mustPreserve.includes(required),
  ))) return false;
  const seeds = readings.flatMap(({ reading }) => reading.synthesisSeeds);
  if (!seeds.length || seeds.length > 6 || seeds.some((seed) =>
    seed.importance === "low" || seed.contribution !== "new" || seed.relatedNoteIds.length > 0)) return false;
  const titles = seeds.map(({ proposedTitle }) => normalizedTitle(proposedTitle));
  if (new Set(titles).size !== titles.length) return false;
  const terms = seeds.map(({ proposedTitle, thesis }) => semanticTerms(`${proposedTitle} ${thesis}`));
  return terms.every((entry, index) => terms.slice(index + 1).every((other) => semanticOverlap(entry, other) < 0.5));
}

function createDeterministicWritingBlueprint(
  snapshot: AppSnapshot,
  readings: readonly CompletedSourceReading[],
  warnings: readonly string[],
): KnowledgeWritingBlueprint {
  const seeds = readings.flatMap((completed) =>
    completed.reading.synthesisSeeds.map((seed) => ({ completed, seed })),
  );
  if (seeds.length === 0) {
    throw new Error("No semantic synthesis seeds were available for note planning.");
  }
  const seedGroups = groupSemanticSeeds(seeds);
  // Recovery is not authorized to invent a common thesis. Retain every
  // distinct seed; exact title-and-thesis duplicates can share provenance.
  // Resource overflow must fail intact instead of forcing unrelated merges.
  if (seedGroups.length > MAX_BLUEPRINT_OUTPUTS) {
    throw new Error(
      `The completed readings contain ${seedGroups.length} distinct knowledge objects, exceeding the ${MAX_BLUEPRINT_OUTPUTS}-output safety limit. No ideas were merged or discarded to fit.`,
    );
  }
  const reservedTitles = new Set(
    snapshot.notes.map(({ title }) => normalizedTitle(title)),
  );
  const seedDispositions: KnowledgeWritingBlueprint["seedDispositions"] = [];
  const outputs: KnowledgeWritingBlueprintOutput[] = seedGroups.map((group, index) => {
    const ordinal = index + 1;
    const outputId = `output-local-${ordinal}`;
    const writerSlotId = `writer-local-${((ordinal - 1) % 6) + 1}`;
    const entries = group.entries;
    const primary = entries[0].seed;
    const selectedClaimsByArtifact = new Map<string, Set<string>>();
    for (const { completed, seed } of entries) {
      const selected = selectedClaimsByArtifact.get(completed.artifact.artifactId) ??
        new Set<string>();
      seed.claimIds.forEach((claimId) => selected.add(claimId));
      selectedClaimsByArtifact.set(completed.artifact.artifactId, selected);
    }
    const claimSelections = [...selectedClaimsByArtifact].map(
      ([artifactId, claimIds]) => ({ artifactId, claimIds: [...claimIds] }),
    );
    const lensSelections = entries.flatMap(({ completed }) => {
      const selectedClaimIds = selectedClaimsByArtifact.get(
        completed.artifact.artifactId,
      );
      const interpretationIds = completed.reading.spaceInterpretations
        .filter(({ sourceClaimIds }) =>
          sourceClaimIds.every((claimId) => selectedClaimIds?.has(claimId)),
        )
        .map(({ interpretationId }) => interpretationId);
      return interpretationIds.length > 0
        ? [{ artifactId: completed.artifact.artifactId, interpretationIds }]
        : [];
    });
    entries.forEach(({ completed, seed }, seedIndex) => {
      seedDispositions.push({
        artifactId: completed.artifact.artifactId,
        seedId: seed.seedId,
        disposition: seedIndex === 0 ? "output" : "merged",
        outputId,
        rationale:
          seedIndex === 0
            ? "This seed defines the output's durable knowledge object."
            : "This seed has the same exact title and thesis as the primary seed and contributes its source evidence.",
      });
    });
    const title = uniqueDeterministicTitle(primary.proposedTitle, reservedTitles);
    return {
      outputId,
      operation: "create" as const,
      kind: "note" as const,
      title,
      editorialBrief: truncateUnicode(
        "Preserve the reading requirements when interpreting only this output's selected claims. Those requirements never authorize copying unselected prose or tasks. Thesis: " +
          uniqueStrings(entries.map(({ seed }) => seed.thesis)).join(" "),
        4_000,
      ),
      sourceIds: uniqueStrings(
        entries.map(({ completed }) => completed.reading.sourceId),
      ),
      claimSelections,
      lensSelections: mergeLensSelections(lensSelections),
      // Readers currently scope requirements to a reading, not a claim. Carry
      // that immutable context for every output using the reading, but retain
      // the exact selected-claim boundary as its only authority to copy prose.
      mustPreserve: uniqueStrings(
        entries.flatMap(({ completed }) => completed.reading.mustPreserve),
      ),
      estimatedTokens: 700,
      writerSlotId,
      existingDestination: null,
    };
  });

  const writerSlots = uniqueStrings(
    outputs.map(({ writerSlotId }) => writerSlotId),
  ).map((writerSlotId) => ({
    writerSlotId,
    objective:
      "Write each assigned output as a focused, finished Orion note from its exact evidence.",
    outputIds: outputs
      .filter((output) => output.writerSlotId === writerSlotId)
      .map(({ outputId }) => outputId),
  }));

  return {
    spaceThesis: truncateUnicode(
      seedGroups.map(({ entries }) => entries[0].seed.thesis).join(" "),
      1_200,
    ),
    outputs,
    writerSlots,
    seedDispositions,
    ...planLocalImportConnections({
      outputs,
      seedDispositions,
      readings,
      notes: snapshot.notes,
      existingVocabulary: snapshot,
    }),
    warnings: uniqueStrings(warnings),
  };
}

type SemanticSeedEntry = {
  completed: CompletedSourceReading;
  seed: KnowledgeSourceReading["synthesisSeeds"][number];
};

type SemanticSeedGroup = {
  entries: SemanticSeedEntry[];
  importance: number;
  order: number;
};

function groupSemanticSeeds(entries: readonly SemanticSeedEntry[]): SemanticSeedGroup[] {
  const groups = new Map<string, SemanticSeedGroup>();
  entries.forEach((entry, order) => {
    const key = `${normalizedTitle(entry.seed.proposedTitle)}\u0000${normalizedProse(entry.seed.thesis)}`;
    const existing = groups.get(key);
    const importance = semanticImportance(entry.seed.importance);
    if (existing) {
      existing.entries.push(entry);
      existing.importance = Math.max(existing.importance, importance);
      return;
    }
    groups.set(key, {
      entries: [entry],
      importance,
      order,
    });
  });
  return [...groups.values()].sort(
    (left, right) => right.importance - left.importance || left.order - right.order,
  );
}

function semanticImportance(value: "low" | "medium" | "high"): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

function semanticTerms(value: string): Set<string> {
  const stop = new Set([
    "about", "after", "again", "against", "also", "because", "between",
    "from", "into", "only", "that", "their", "there", "these", "this",
    "through", "under", "with", "without",
  ]);
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((term) => term.length > 2 && !stop.has(term)) ?? [],
  );
}

function semanticOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  left.forEach((term) => {
    if (right.has(term)) shared += 1;
  });
  return shared / Math.min(left.size, right.size);
}

function mergeLensSelections(
  selections: readonly KnowledgeLensSelection[],
): KnowledgeLensSelection[] {
  const byArtifact = new Map<string, Set<string>>();
  for (const { artifactId, interpretationIds } of selections) {
    const ids = byArtifact.get(artifactId) ?? new Set<string>();
    interpretationIds.forEach((interpretationId) => ids.add(interpretationId));
    byArtifact.set(artifactId, ids);
  }
  return [...byArtifact].map(([artifactId, interpretationIds]) => ({
    artifactId,
    interpretationIds: [...interpretationIds],
  }));
}

function uniqueDeterministicTitle(
  requested: string,
  reserved: Set<string>,
): string {
  const base = truncateUnicode(requested.trim() || "Imported notes", 120);
  let candidate = base;
  let suffix = 2;
  while (reserved.has(normalizedTitle(candidate))) {
    candidate = `${truncateUnicode(base, 108)} (${suffix})`;
    suffix += 1;
  }
  reserved.add(normalizedTitle(candidate));
  return candidate;
}

function validateWritingBlueprint(
  blueprint: KnowledgeWritingBlueprint,
  context: KnowledgeRunContext,
  snapshot: AppSnapshot,
  readings: readonly CompletedSourceReading[],
  routingArtifacts: readonly KnowledgeArtifact[],
  revisionAccess: FixedRevisionAccess,
): void {
  const readingByArtifact = new Map(
    readings.map((reading) => [reading.artifact.artifactId, reading] as const),
  );
  const importedSourceIds = new Set(context.sources.map(({ sourceId }) => sourceId));
  // AI-context preferences control disclosure, never the local safety check.
  // Collisions and base versions are always resolved against the full frozen
  // Space snapshot.
  const existingNotes = new Map(snapshot.notes.map((note) => [note.id, note]));
  const existingTitleKeys = new Set(
    [...existingNotes.values()].map(({ title }) => normalizedTitle(title)),
  );
  const revisionDestinations = new Set<string>();
  const routedRevisionCandidates = new Set(
    revisionAccess === "validated-routing"
      ? validateCompleteNoteRoutingCoverage(context, routingArtifacts).flatMap(
          ({ routes }) =>
            routes
              .filter(({ relation }) => relation !== "unrelated")
              .map(({ noteId }) => noteId),
        )
      : [],
  );
  const outputSourceCoverage = new Set<string>();
  if (blueprint.outputs.length > MAX_BLUEPRINT_OUTPUTS) {
    throw new Error(
      `One import may contain at most ${MAX_BLUEPRINT_OUTPUTS} planned outputs in total. This safety limit must not be met by merging unrelated ideas.`,
    );
  }
  if (
    blueprint.outputs.reduce(
      (total, { estimatedTokens }) => total + estimatedTokens,
      0,
    ) > 24_000
  ) {
    throw new Error("The planned notes exceed Orion's bounded output limit.");
  }
  validateSeedDispositions(blueprint, context, readings);
  const sourceIdByArtifact = new Map(
    readings.map(({ artifact, reading }) => [
      artifact.artifactId,
      reading.sourceId,
    ] as const),
  );
  const retainedSeedSourceIds = new Set(
    blueprint.seedDispositions.flatMap((disposition) => {
      if (disposition.disposition === "omitted") return [];
      const sourceId = sourceIdByArtifact.get(disposition.artifactId);
      return sourceId ? [sourceId] : [];
    }),
  );
  // A single writing pass may legitimately carry several small notes; the
  // per-slot output and token caps below are the real division contract.
  for (const slot of blueprint.writerSlots) {
    const slotOutputs = slot.outputIds.map((outputId) =>
      blueprintOutput(blueprint, outputId),
    );
    if (slotOutputs.length > 5) {
      throw new Error("One note-writing pass was assigned more than five notes.");
    }
    if (
      slotOutputs.reduce(
        (total, { estimatedTokens }) => total + estimatedTokens,
        0,
      ) > 4_000
    ) {
      throw new Error(
        "One note-writing pass exceeds Orion's bounded output limit.",
      );
    }
  }

  for (const output of blueprint.outputs) {
    if (
      output.operation === "create" &&
      sourceShapedKnowledgeTitle(output.title, context)
    ) {
      throw new Error(
        `A planned note used a source-shaped title instead of naming its idea: ${output.title}.`,
      );
    }
    if (new Set(output.mustPreserve).size !== output.mustPreserve.length) {
      throw new Error(`A planned note repeated required material: ${output.outputId}.`);
    }
    const selectedSourceIds = selectedClaimSourceIds(output, readingByArtifact);
    if (!sameUniqueSet(output.sourceIds, selectedSourceIds)) {
      throw new Error(
        `Blueprint output ${output.outputId} source IDs do not exactly match its selected source claims.`,
      );
    }
    if (output.sourceIds.some((sourceId) => !importedSourceIds.has(sourceId))) {
      throw new Error(`Blueprint output ${output.outputId} cited another import batch.`);
    }
    validateLensSelections(
      output.lensSelections,
      output.claimSelections,
      readingByArtifact,
    );
    output.sourceIds.forEach((sourceId) => outputSourceCoverage.add(sourceId));
    if (output.operation === "revise") {
      if (revisionAccess !== "validated-routing") {
        throw new Error(
          "The note plan cannot revise existing articles without validated post-reading routing.",
        );
      }
      if (output.kind !== "wikiArticle" || !output.existingDestination) {
        throw new Error("Only a canonical wiki article may be revised.");
      }
      if (!context.materials.notes.has(output.existingDestination.noteId)) {
        throw new Error(
          "The note plan tried to revise an article that Across this Space did not link.",
        );
      }
      const existing = existingNotes.get(output.existingDestination.noteId);
      if (!existing || existing.kind !== "wiki") {
        throw new Error("The note plan targeted an unavailable wiki article.");
      }
      if (!routedRevisionCandidates.has(existing.id)) {
        throw new Error(
          `The note plan targeted an article outside validated routing: ${existing.id}.`,
        );
      }
      if (noteVersion(existing) !== output.existingDestination.baseVersion) {
        throw new Error(`A planned article revision is stale: ${existing.id}`);
      }
      if (normalizedTitle(existing.title) !== normalizedTitle(output.title)) {
        throw new Error(`A planned revision cannot rename article ${existing.id}.`);
      }
      if (revisionDestinations.has(existing.id)) {
        throw new Error(`The note plan repeated article revision ${existing.id}.`);
      }
      revisionDestinations.add(existing.id);
    } else if (existingTitleKeys.has(normalizedTitle(output.title))) {
      throw new Error(
        `The note plan tried to recreate an existing Space title: ${output.title}.`,
      );
    }
  }
  for (const sourceId of importedSourceIds) {
    if (
      retainedSeedSourceIds.has(sourceId) &&
      !outputSourceCoverage.has(sourceId)
    ) {
      throw new Error(
        `The note plan did not use source ${sourceId} in any durable knowledge object.`,
      );
    }
  }
  const titles = resolvableTitles(blueprint, snapshot);
  validateImportConnectionPlan(blueprint, snapshot);
  for (const concept of blueprint.concepts) {
    requireUniqueTitle(concept.canonicalTitle, titles, "concept canonical title");
    concept.relatedTitles.forEach((title) =>
      requireUniqueTitle(title, titles, "concept related title"),
    );
  }
  for (const connection of blueprint.suggestedConnections) {
    requireUniqueTitle(connection.fromTitle, titles, "connection source title");
    requireUniqueTitle(connection.toTitle, titles, "connection target title");
  }
}

function validateSeedDispositions(
  blueprint: KnowledgeWritingBlueprint,
  context: KnowledgeRunContext,
  readings: readonly CompletedSourceReading[],
): void {
  const expected = new Map<string, {
    artifactId: string;
    seed: KnowledgeSourceReading["synthesisSeeds"][number];
  }>();
  for (const { artifact, reading } of readings) {
    for (const seed of reading.synthesisSeeds) {
      expected.set(`${artifact.artifactId}\u0000${seed.seedId}`, {
        artifactId: artifact.artifactId,
        seed,
      });
    }
  }
  const dispositions = new Map<
    string,
    KnowledgeWritingBlueprint["seedDispositions"][number]
  >(
    blueprint.seedDispositions.map((disposition) => [
      `${disposition.artifactId}\u0000${disposition.seedId}`,
      disposition,
    ] as const),
  );
  if (
    expected.size !== dispositions.size ||
    [...expected.keys()].some((key) => !dispositions.has(key))
  ) {
    throw new Error(
      "The note plan did not disposition every synthesis seed exactly once.",
    );
  }

  const outputs = new Map(
    blueprint.outputs.map((output) => [output.outputId, output] as const),
  );
  const primarySeedsByOutput = new Map<string, number>();
  for (const [key, { artifactId, seed }] of expected) {
    const disposition = dispositions.get(key)!;
    if (disposition.disposition === "omitted") {
      if (seed.importance !== "low") {
        throw new Error(
          `The note plan omitted a ${seed.importance}-importance knowledge object: ${seed.proposedTitle}.`,
        );
      }
      continue;
    }
    const output = disposition.outputId
      ? outputs.get(disposition.outputId)
      : undefined;
    if (!output) {
      throw new Error("A retained synthesis seed lost its planned output.");
    }
    const selection = output.claimSelections.find(
      (candidate) => candidate.artifactId === artifactId,
    );
    if (
      !selection ||
      seed.claimIds.some((claimId) => !selection.claimIds.includes(claimId))
    ) {
      throw new Error(
        `The output for “${seed.proposedTitle}” omitted its supporting claims.`,
      );
    }
    if (disposition.disposition === "output") {
      primarySeedsByOutput.set(
        output.outputId,
        (primarySeedsByOutput.get(output.outputId) ?? 0) + 1,
      );
    }
  }
  for (const output of blueprint.outputs) {
    if (primarySeedsByOutput.get(output.outputId) !== 1) {
      throw new Error(
        `Blueprint output ${output.outputId} must own exactly one primary synthesis seed.`,
      );
    }
  }
  for (const output of blueprint.outputs) {
    if (
      output.operation === "create" &&
      sourceShapedKnowledgeTitle(output.title, context)
    ) {
      throw new Error(
        `Blueprint output ${output.outputId} is titled like a source chunk instead of a knowledge object.`,
      );
    }
  }
}

function createWriterAssignments(
  context: KnowledgeRunContext,
  blueprint: KnowledgeWritingBlueprint,
  parentAssignmentId: string,
  readings: readonly CompletedSourceReading[],
  routingArtifacts: readonly KnowledgeArtifact[] = [],
  slots: readonly KnowledgeWritingBlueprint["writerSlots"][number][] =
    blueprint.writerSlots,
): Array<{
  assignment: KnowledgeAssignmentContract;
  slot: KnowledgeWritingBlueprint["writerSlots"][number];
}> {
  const artifactIdByOutput = new Map(
    blueprint.outputs.map((output) => [
      output.outputId,
      uniqueStrings([
        ...output.claimSelections.map(({ artifactId }) => artifactId),
        ...output.lensSelections.map(({ artifactId }) => artifactId),
      ]),
    ]),
  );
  const knownReadingIds = new Set(
    readings.map(({ artifact }) => artifact.artifactId),
  );
  return slots.map((slot) => {
    const outputs = slot.outputIds.map((outputId) =>
      blueprintOutput(blueprint, outputId),
    );
    const artifactIds = uniqueStrings(
      slot.outputIds.flatMap((outputId) => artifactIdByOutput.get(outputId) ?? []),
    );
    if (artifactIds.some((artifactId) => !knownReadingIds.has(artifactId))) {
      throw new Error("A note-writing pass selected unavailable evidence.");
    }
    const revisions = outputs.flatMap(({ existingDestination }) =>
      existingDestination ? [existingDestination] : [],
    );
    // Source prose reaches a writer only through the scoped pipeline material
    // below. Keeping full reading artifacts out of resolvedMaterials prevents
    // a writer from silently using claims its output did not select.
    const references: KnowledgeReference[] = [
      ...revisions.map(({ noteId, baseVersion }) => ({
        kind: "note" as const,
        noteId,
        version: baseVersion,
      })),
      ...routingArtifacts.map(({ artifactId }) => ({
        kind: "artifact" as const,
        artifactId,
      })),
    ];
    return {
      slot,
      assignment: {
        assignmentId: `assignment:${context.runId}:writer:${slot.writerSlotId}`,
        parent: { kind: "assignment", assignmentId: parentAssignmentId },
        purpose: "writer",
        objective:
          "Write each assigned output as a standalone durable knowledge object from its selected claims. Lead with the idea itself, synthesize evidence into explanatory prose, and integrate an exact Space relationship naturally. Preserve useful existing prose in revisions and return finished Orion Markdown without source-tour or process commentary.",
        references,
        constraints: {
          rules: [
            ...context.constraints,
            "Use only selected source claims as evidence; an interpretation may shape explanation but never establish a factual source claim.",
            "Preserve the exact epistemic status of the evidence: hypotheses, questions, possibilities, and personal or diary experiences remain qualified and attributed. Distinguish your interpretation from what the source asserts; do not turn a tentative explanation into an established fact.",
            "State the thesis once, then add distinct supporting details. Do not repeat the summary or opening paragraph, and do not add a heading that merely repeats the note title. Editorial briefs are instructions, never prose to copy into the note.",
            "Return every assigned output exactly once and no sibling output.",
            "Write the idea, not a report about the import. Do not organize prose by source, chapter, page, range, or reading order; do not copy an intermediate reading summary or enumerate selected claims.",
            "Do not mention an assigned range, supplied lens, pipeline stage, import ID, or that material is merely relevant to the Space. State the substantive extension, contradiction, clarification, qualification, or connection instead.",
            "Use attribution only when authorship, disagreement, or source reliability is epistemically important. Otherwise begin directly with the thesis rather than 'the source says', 'the chapter discusses', or similar scaffolding.",
            "Keep tasks, citations, links, and useful prior prose coherent; never append mechanical Context from sections.",
            "Write ordinary readable Markdown and return link targets through the structured links field; never put literal [[wiki]] syntax in body prose.",
            "Render only explicit source-grounded action items as - [ ] tasks in project notes. Never invent a task and never copy tasks into a wiki article.",
            "A canonical wiki article is definitional and Space-aware: integrate new evidence naturally, preserve useful existing prose, and state uncertainty without process commentary.",
          ],
          mustPreserve: uniqueStrings(outputs.flatMap(({ mustPreserve }) => mustPreserve)),
        },
        authority:
          revisions.length > 0
            ? {
                kind: "destination-owner",
                destinationNoteIds: revisions.map(({ noteId }) => noteId),
                baseVersions: revisions.map(({ noteId, baseVersion }) => ({
                  noteId,
                  version: baseVersion,
                })),
              }
            : { kind: "read-only" },
        output: {
          kind: "writer-result",
          writerSlotId: slot.writerSlotId,
          outputIds: [...slot.outputIds],
        },
        termination: {
          condition:
            "Stop after every owned output is complete, provenance selections are unchanged, and no unassigned prose or destination is returned.",
        },
      },
    };
  });
}

async function writeNotesAdaptively({
  options,
  readingBlueprint,
  writingBlueprint,
  parentAssignmentId,
  completedSourceReadings,
  routingArtifacts,
  registry,
  journal,
  usage,
  counters,
  emit,
  completed: resumedCompleted,
  progress,
}: {
  options: FixedBlueprintImportOptions;
  readingBlueprint: KnowledgeReadingBlueprint;
  writingBlueprint: KnowledgeWritingBlueprint;
  parentAssignmentId: string;
  completedSourceReadings: readonly CompletedSourceReading[];
  routingArtifacts: readonly KnowledgeArtifact[];
  registry: KnowledgeArtifactRegistry;
  journal: EventJournal;
  usage: Required<KnowledgeProviderUsage>;
  counters: PipelineCounters;
  emit: (status?: KnowledgeTelemetry["status"]) => void;
  completed: KnowledgeWriterResult[];
  progress: FixedWriterProgressCheckpoint;
}): Promise<KnowledgeWriterResult[]> {
  // Keep one shared sink with the caller so a later transport-wide failure can
  // checkpoint already accepted sibling slots without rerunning them.
  const results = resumedCompleted;
  const resumedSlotIds = new Set(results.map(({ writerSlotId }) => writerSlotId));
  const resumedProgressBySlot = new Map(
    progress.slots.map((slot) => [slot.writerSlotId, slot] as const),
  );
  const states = new Map<string, AdaptiveWriterState>();
  const queue: AdaptiveWriterTask[] = [];
  for (const slot of writingBlueprint.writerSlots) {
    if (resumedSlotIds.has(slot.writerSlotId)) continue;
    const resumedProgress = resumedProgressBySlot.get(slot.writerSlotId);
    const drafts = structuredClone(resumedProgress?.drafts ?? []);
    const completedOutputIds = new Set(drafts.map(({ outputId }) => outputId));
    const remainingOutputIds = slot.outputIds.filter(
      (outputId) => !completedOutputIds.has(outputId),
    );
    const state: AdaptiveWriterState = {
      originalSlot: slot,
      outstanding: remainingOutputIds.length > 0 ? 1 : 0,
      drafts,
      warnings: structuredClone(resumedProgress?.warnings ?? []),
      completed: false,
    };
    states.set(slot.writerSlotId, state);
    if (remainingOutputIds.length > 0) {
      queue.push({
        originalSlot: slot,
        slot: { ...slot, outputIds: remainingOutputIds },
        path: [],
      });
    }
  }
  const deferred: AdaptiveWriterTask[] = [];
  const writingStage = linkedStageController(options.signal);

  const syncProgress = (state: AdaptiveWriterState) => {
    const index = progress.slots.findIndex(
      ({ writerSlotId }) => writerSlotId === state.originalSlot.writerSlotId,
    );
    if (state.completed || state.drafts.length === 0) {
      if (index >= 0) progress.slots.splice(index, 1);
      return;
    }
    const value: FixedWriterSlotProgress = {
      writerSlotId: state.originalSlot.writerSlotId,
      drafts: structuredClone(state.drafts),
      warnings: uniqueStrings(state.warnings),
    };
    if (index >= 0) progress.slots[index] = value;
    else progress.slots.push(value);
  };

  const finalizeState = (state: AdaptiveWriterState) => {
    if (state.outstanding !== 0 || state.completed) return;
    const outputOrder = new Map(
      state.originalSlot.outputIds.map((outputId, index) => [outputId, index]),
    );
    const result: KnowledgeWriterResult = {
      writerSlotId: state.originalSlot.writerSlotId,
      drafts: [...state.drafts].sort(
        (left, right) =>
          (outputOrder.get(left.outputId) ?? 0) -
          (outputOrder.get(right.outputId) ?? 0),
      ),
      warnings: uniqueStrings(state.warnings),
    };
    validateWriterResult(
      result,
      writingBlueprint,
      state.originalSlot.outputIds,
      options.snapshot,
    );
    state.completed = true;
    results.push(result);
    syncProgress(state);
  };

  const completeLocally = (task: AdaptiveWriterTask) => {
    const state = states.get(task.originalSlot.writerSlotId);
    if (!state) throw new Error("A note-writing pass lost its adaptive state.");
    for (const outputId of task.slot.outputIds) {
      const output = blueprintOutput(writingBlueprint, outputId);
      const result = createGroundedWriterResult(
        task.slot,
        output,
        writingBlueprint,
        completedSourceReadings,
        options.snapshot,
      );
      validateWriterResult(
        result,
        writingBlueprint,
        [outputId],
        options.snapshot,
      );
      state.drafts.push(...result.drafts);
      state.warnings.push(...result.warnings);
    }
    state.outstanding -= 1;
    counters.completed += 1;
    counters.writingCompleted += task.slot.outputIds.length;
    syncProgress(state);
    finalizeState(state);
  };

  for (const state of states.values()) {
    syncProgress(state);
    finalizeState(state);
  }

  const settleTask = async (task: AdaptiveWriterTask) => {
    const state = states.get(task.originalSlot.writerSlotId);
    if (!state) throw new Error("A note-writing pass lost its adaptive state.");
    const { assignment } = createWriterAssignments(
      options.runContext,
      writingBlueprint,
      parentAssignmentId,
      completedSourceReadings,
      routingArtifacts,
      [task.slot],
    )[0];
    const selectedReadings = sourceReadingsForOutputs(
      task.slot.outputIds.map((outputId) =>
        blueprintOutput(writingBlueprint, outputId),
      ),
      completedSourceReadings,
    );

    try {
      const result = await executeTypedAssignment<KnowledgeWriterResult>(
        { ...options, signal: writingStage.controller.signal },
        assignment,
        registry,
        journal,
        usage,
        TRANSPORT_SAFETY_TIMEOUT_MS,
        writerPipelineMaterials(
          readingBlueprint,
          writingBlueprint,
          task.slot,
          selectedReadings,
        ),
        true,
        "writer-result",
        (payload) =>
          validateWriterResult(
            payload,
            writingBlueprint,
            task.slot.outputIds,
            options.snapshot,
          ),
        1,
      );
      state.drafts.push(...result.drafts);
      state.warnings.push(...result.warnings);
      state.outstanding -= 1;
      counters.completed += 1;
      counters.writingCompleted += result.drafts.length;
      syncProgress(state);
    } catch (error) {
      if (
        options.signal?.aborted ||
        !(error instanceof FixedAssignmentContractError)
      ) {
        throw options.signal?.reason ?? error;
      }
      progress.contractFailures = Math.min(
        MAX_WRITER_CONTRACT_FAILURES,
        progress.contractFailures + 1,
      );
      progress.circuitOpen =
        progress.circuitOpen ||
        progress.contractFailures >= MAX_WRITER_CONTRACT_FAILURES;
      const children = splitAdaptiveWriterTask(task);
      if (children.length > 0 && !progress.circuitOpen) {
        state.outstanding += children.length - 1;
        deferred.push(...children);
      } else {
        completeLocally(task);
        return;
      }
    }
    syncProgress(state);
    finalizeState(state);
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let settled = false;
      let fatalError: unknown;
      const pump = () => {
        if (settled) return;
        if (active === 0 && fatalError !== undefined) {
          settled = true;
          reject(fatalError);
          return;
        }
        if (active === 0 && progress.circuitOpen) {
          const remaining = [...queue.splice(0), ...deferred.splice(0)];
          for (const task of remaining) completeLocally(task);
        } else if (active === 0 && queue.length === 0 && deferred.length > 0) {
          queue.push(...deferred.splice(0));
        }
        while (
          !fatalError &&
          !progress.circuitOpen &&
          active < MAX_PHYSICAL_WIDTH &&
          queue.length > 0
        ) {
          const task = queue.shift()!;
          active += 1;
          counters.active += 1;
          emit();
          void settleTask(task)
            .catch((error) => {
              if (fatalError === undefined) {
                fatalError = error;
                writingStage.controller.abort(error);
              }
            })
            .finally(() => {
              active -= 1;
              counters.active -= 1;
              emit();
              pump();
            });
        }
        if (active > 0) return;
        if (queue.length === 0 && deferred.length === 0) {
          settled = true;
          resolve();
        }
      };
      pump();
    });
  } finally {
    writingStage.dispose();
  }

  return results;
}

function splitAdaptiveWriterTask(
  task: AdaptiveWriterTask,
): AdaptiveWriterTask[] {
  if (task.slot.outputIds.length < 2) return [];
  const midpoint = Math.ceil(task.slot.outputIds.length / 2);
  return [
    task.slot.outputIds.slice(0, midpoint),
    task.slot.outputIds.slice(midpoint),
  ].map((outputIds, index) => {
    const path = [...task.path, index + 1];
    return {
      originalSlot: task.originalSlot,
      path,
      slot: {
        writerSlotId: `writer-recovery:${stableHash(
          `${task.originalSlot.writerSlotId}:${path.join("-")}`,
        )}`,
        objective: task.originalSlot.objective,
        outputIds,
      },
    };
  });
}

function createGroundedWriterResult(
  slot: KnowledgeWritingBlueprint["writerSlots"][number],
  output: KnowledgeWritingBlueprintOutput,
  blueprint: KnowledgeWritingBlueprint,
  readings: readonly CompletedSourceReading[],
  snapshot: AppSnapshot,
): KnowledgeWriterResult {
  const readingsByArtifact = new Map(
    readings.map((completed) => [completed.artifact.artifactId, completed] as const),
  );
  const selected = output.claimSelections.map((selection) => {
    const completed = readingsByArtifact.get(selection.artifactId);
    if (!completed) {
      throw new Error(`A local note repair lost evidence ${selection.artifactId}.`);
    }
    const claims = new Map(
      completed.reading.sourceClaims.map((claim) => [claim.claimId, claim] as const),
    );
    return {
      completed,
      claims: selection.claimIds.map((claimId) => {
        const claim = claims.get(claimId);
        if (!claim) {
          throw new Error(`A local note repair lost claim ${claimId}.`);
        }
        return claim;
      }),
    };
  });
  const selectedInterpretations = output.lensSelections.flatMap((selection) => {
    const completed = readingsByArtifact.get(selection.artifactId);
    if (!completed) return [];
    const interpretations = new Map(
      completed.reading.spaceInterpretations.map((interpretation) => [
        interpretation.interpretationId,
        interpretation,
      ] as const),
    );
    return selection.interpretationIds.flatMap((interpretationId) => {
      const interpretation = interpretations.get(interpretationId);
      return interpretation ? [interpretation] : [];
    });
  });
  const selectedSeedKeys = new Set(
    blueprint.seedDispositions
      .filter(
        (disposition) =>
          disposition.outputId === output.outputId &&
          disposition.disposition !== "omitted",
      )
      .map(({ artifactId, seedId }) => `${artifactId}\u0000${seedId}`),
  );
  const selectedSeeds = readings.flatMap(({ artifact, reading }) =>
    reading.synthesisSeeds.filter(({ seedId }) =>
      selectedSeedKeys.has(`${artifact.artifactId}\u0000${seedId}`),
    ),
  );
  const primarySeed = blueprint.seedDispositions.find(
    (disposition) => disposition.outputId === output.outputId &&
      disposition.disposition === "output",
  );
  const thesis = primarySeed
    ? readingsByArtifact.get(primarySeed.artifactId)?.reading.synthesisSeeds
      .find(({ seedId }) => seedId === primarySeed.seedId)?.thesis.trim()
    : undefined;
  const groundedDetails = distinctProse(
    selected.flatMap(({ claims }) => claims.map(({ text }) => text.trim())),
  );
  // Editorial briefs are instructions, not source evidence or note prose.
  // Keep one supported thesis and verbatim claim statements so qualifications,
  // first-person attribution, questions, and counterexamples remain intact.
  const opening = thesis || groundedDetails[0] || output.title;
  const sourceDetails = distinctProse(groundedDetails, [opening]);
  const spaceInsights = distinctProse(
    selectedInterpretations.map(({ text }) => text.trim()),
    [opening, ...sourceDetails],
  );
  const knowledgeBody = [
    opening,
    sourceDetails.length > 0
      ? `## Source statements\n\n${sourceDetails.join("\n\n")}`
      : "",
    spaceInsights.length > 0
      ? `## Interpretation\n\n${spaceInsights.join("\n\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
  const prior = output.existingDestination
    ? snapshot.notes.find(({ id }) => id === output.existingDestination?.noteId)
    : undefined;
  if (output.operation === "revise" && !prior) {
    throw new Error("A local note repair could not find its frozen destination.");
  }
  const body = output.operation === "revise"
    ? `${prior!.body.trim()}\n\n${knowledgeBody}`.trim()
    : knowledgeBody;
  if (!body || body.length > 100_000) {
    throw new Error("A local note repair could not fit every selected source claim safely.");
  }
  const summary = truncateUnicode(
    (prior?.summary.trim() || opening).trim(),
    2_000,
  );
  const links = uniqueStrings(
    [
      ...selectedSeeds.flatMap(({ relatedNoteIds }) => relatedNoteIds),
      ...selectedInterpretations.flatMap(({ relatedNoteIds }) => relatedNoteIds),
    ],
  ).flatMap((noteId) => {
    const note = snapshot.notes.find(({ id }) => id === noteId);
    return note
      ? [{
          targetTitle: note.title,
          context: "This knowledge object materially connects to the existing Space note.",
        }]
      : [];
  });
  const draft: KnowledgeWriterDraft = {
    outputId: output.outputId,
    operation: output.operation,
    kind: output.kind,
    title: output.title,
    summary,
    body,
    tags: [...(prior?.tags ?? [])],
    aliases: [...(prior?.aliases ?? [])],
    links,
    overview: output.kind === "wikiArticle" ? summary : "",
    spaceRelevance: output.kind === "wikiArticle" ? spaceInsights.join(" ") : "",
    sourceGroundedDetails:
      output.kind === "wikiArticle" ? groundedDetails : [],
    uncertainties:
      output.kind === "wikiArticle"
        ? uniqueStrings(
            selected.flatMap(({ completed }) =>
              completed.reading.coverage.limitations,
            ),
          )
        : [],
    sourceIds: [...output.sourceIds],
    claimSelections: structuredClone(output.claimSelections),
    lensSelections: structuredClone(output.lensSelections),
    mustPreserve: [...output.mustPreserve],
    existingDestination: structuredClone(output.existingDestination),
  };
  return {
    writerSlotId: slot.writerSlotId,
    drafts: [draft],
    warnings: [
      `Orion completed “${output.title}” directly from its validated source readings after the generated draft could not be used.`,
    ],
  };
}

function normalizedProse(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function distinctProse(values: readonly string[], excluded: readonly string[] = []): string[] {
  const seen = new Set(excluded.map(normalizedProse));
  return values.flatMap((value) => {
    const text = value.trim();
    const key = normalizedProse(text);
    if (!key || seen.has(key)) return [];
    seen.add(key);
    return [text];
  });
}

function hasRepeatedProseParagraph(body: string): boolean {
  const seen = new Set<string>();
  let fenced = false;
  for (const block of body.split(/\n\s*\n/u)) {
    const text = block.trim();
    // Repeated code, quotations, tables, and list items may be intentional.
    const fences = text.match(/^\s*(?:```|~~~)/gmu)?.length ?? 0;
    const containsFence = fenced || fences > 0;
    if (fences % 2 !== 0) fenced = !fenced;
    if (containsFence || /^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/u.test(text)) continue;
    const key = normalizedProse(text);
    if (key.length < 40) continue;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function destinationSpaceDirectory(
  snapshot: AppSnapshot,
  context: KnowledgeRunContext,
  routingArtifacts: readonly KnowledgeArtifact[],
  revisionAccess: FixedRevisionAccess,
): {
  revisionCandidates: Array<{
    noteId: string;
    title: string;
    kind: string;
    version: string;
  }>;
  collisionTitles: string[];
} {
  if (
    context.targetedSpaceContext?.basis === "disabled" ||
    !snapshot.settings.includeExistingNotesInAIContext
  ) {
    return { revisionCandidates: [], collisionTitles: [] };
  }
  const routedRelations = new Map(
    revisionAccess === "validated-routing"
      ? validateCompleteNoteRoutingCoverage(context, routingArtifacts).flatMap(
          ({ routes }) =>
            routes.map(({ noteId, relation }) => [noteId, relation] as const),
        )
      : [],
  );
  const revisionCandidates =
    revisionAccess === "validated-routing"
      ? snapshot.notes
          .filter(
            (note) =>
              note.kind === "wiki" &&
              context.materials.notes.has(note.id) &&
              routedRelations.get(note.id) !== "unrelated",
          )
          .map((note) => ({
            noteId: note.id,
            title: note.title,
            kind: note.kind,
            version: noteVersion(note),
          }))
      : [];
  const maximumBytes = 48 * 1_024;
  let usedBytes = new TextEncoder().encode(
    JSON.stringify({ revisionCandidates }),
  ).byteLength;
  const collisionTitles: string[] = [];
  for (const note of snapshot.notes.slice(0, 500)) {
    const title = note.title.slice(0, 300);
    const titleBytes = new TextEncoder().encode(JSON.stringify(title)).byteLength;
    if (usedBytes + titleBytes > maximumBytes) break;
    collisionTitles.push(title);
    usedBytes += titleBytes;
  }
  while (
    collisionTitles.length > 0 &&
    new TextEncoder().encode(
      JSON.stringify({ revisionCandidates, collisionTitles }),
    ).byteLength > maximumBytes
  ) {
    collisionTitles.pop();
  }
  return { revisionCandidates, collisionTitles };
}

function validateWriterResult(
  result: KnowledgeWriterResult,
  blueprint: KnowledgeWritingBlueprint,
  expectedOutputIds: readonly string[],
  snapshot: AppSnapshot,
): void {
  if (!sameUniqueSet(result.drafts.map(({ outputId }) => outputId), expectedOutputIds)) {
    throw new Error("A note-writing pass did not return its exact planned notes.");
  }
  for (const draft of result.drafts) {
    const planned = blueprintOutput(blueprint, draft.outputId);
    if (
      draft.operation !== planned.operation ||
      draft.kind !== planned.kind ||
      draft.title !== planned.title ||
      !sameUniqueSet(draft.sourceIds, planned.sourceIds) ||
      !sameEvidenceSelections(draft.claimSelections, planned.claimSelections) ||
      !sameLensSelections(draft.lensSelections, planned.lensSelections) ||
      !sameUniqueSet(draft.mustPreserve, planned.mustPreserve) ||
      !sameDestination(draft.existingDestination, planned.existingDestination)
    ) {
      throw new Error(
        `A note draft changed its planned ownership or evidence: ${draft.outputId}.`,
      );
    }
    if (!draft.body.trim()) {
      throw new Error("A note-writing pass returned an empty draft.");
    }
    if (draft.operation === "create" && hasRepeatedProseParagraph(draft.body)) {
      throw new Error("A note-writing pass repeated a prose paragraph instead of adding distinct supporting detail.");
    }
    if (/\[\[[^\]]+\]\]/u.test(draft.body)) {
      throw new Error("A finished draft returned literal wiki-link syntax.");
    }
    if (
      /\bassigned range\b|\bsupplied (?:space )?lens\b|\bthrough the .{0,80} space lens\b|\bimport_[a-z0-9_-]+\b|^#{1,6}\s+.*\b(?:part|range|pages?|chapters?)\s*[- ]?\d+\b|\b(?:the|this) (?:source|chapter|section|document|author) (?:discusses|describes|explains|examines|outlines|presents|summarizes)\b/imu.test(
        draft.body,
      )
    ) {
      throw new Error(
        "A finished draft exposed source-reading or import-process scaffolding.",
      );
    }
    if (
      draft.kind === "wikiArticle" &&
      /^\s*[-*+]\s+\[[ xX]\]\s+/mu.test(draft.body)
    ) {
      throw new Error("A canonical wiki article cannot contain copied tasks.");
    }
    if (
      draft.kind === "note" &&
      (draft.overview ||
        draft.spaceRelevance ||
        draft.sourceGroundedDetails.length > 0 ||
        draft.uncertainties.length > 0)
    ) {
      throw new Error("An ordinary note returned wiki-only fields.");
    }
    const titles = resolvableTitles(blueprint, snapshot);
    for (const link of draft.links) {
      requireUniqueTitle(link.targetTitle, titles, "draft link target");
    }
  }
}

function assembleWriterResults(
  blueprint: KnowledgeWritingBlueprint,
  results: readonly KnowledgeWriterResult[],
  readings: readonly CompletedSourceReading[],
  readingBlueprintFallbackWarning?: string,
): KnowledgeRunResult {
  const draftByOutput = new Map(
    results.flatMap(({ drafts }) =>
      drafts.map((draft) => [draft.outputId, draft] as const),
    ),
  );
  const notes = [];
  const wikiArticles = [];
  const provenance = [];
  const ownerProposals: KnowledgeOwnerProposal[] = [];
  for (const output of blueprint.outputs) {
    const draft = draftByOutput.get(output.outputId);
    if (!draft) {
      throw new Error(`No note draft completed planned output ${output.outputId}.`);
    }
    if (draft.kind === "note") {
      notes.push({
        title: draft.title,
        summary: draft.summary,
        body: draft.body,
        tags: [...draft.tags],
        aliases: [...draft.aliases],
        links: structuredClone(draft.links),
      });
    } else {
      wikiArticles.push({
        title: draft.title,
        summary: draft.summary,
        body: draft.body,
        overview: draft.overview,
        spaceRelevance: draft.spaceRelevance,
        sourceGroundedDetails: [...draft.sourceGroundedDetails],
        uncertainties: [...draft.uncertainties],
        tags: [...draft.tags],
        aliases: [...draft.aliases],
        links: structuredClone(draft.links),
      });
    }
    provenance.push({
      kind: draft.kind,
      title: draft.title,
      sourceIds: [...draft.sourceIds],
      evidenceReferences: draft.claimSelections.map(({ artifactId }) => ({
        kind: "artifact" as const,
        artifactId,
      })),
    });
    if (draft.operation === "revise" && draft.existingDestination) {
      ownerProposals.push({
        destinationNoteId: draft.existingDestination.noteId,
        baseVersion: draft.existingDestination.baseVersion,
        title: draft.title,
        summary: draft.summary,
        body: draft.body,
        aliases: [...draft.aliases],
        tags: [...draft.tags],
        sourceIds: [...draft.sourceIds],
      });
    }
  }
  const warnings = uniqueStrings([
    ...(readingBlueprintFallbackWarning ? [readingBlueprintFallbackWarning] : []),
    ...blueprint.warnings,
    ...results.flatMap(({ warnings: values }) => values),
    ...readings.flatMap(({ reading }) => reading.coverage.limitations),
  ]);
  return {
    result: {
      notes,
      wikiArticles,
      concepts: structuredClone(blueprint.concepts),
      suggestedConnections: structuredClone(blueprint.suggestedConnections),
    },
    provenance,
    ownerProposals,
    warnings,
  };
}

function recordOwnerArtifacts(
  result: KnowledgeRunResult,
  blueprint: KnowledgeWritingBlueprint,
  readings: readonly CompletedSourceReading[],
  journal: EventJournal,
  registry: KnowledgeArtifactRegistry,
  runId: string,
): void {
  const readingByArtifact = new Map(
    readings.map((reading) => [reading.artifact.artifactId, reading] as const),
  );
  for (const proposal of result.ownerProposals) {
    const output = blueprint.outputs.find(
      ({ existingDestination }) =>
        existingDestination?.noteId === proposal.destinationNoteId,
    );
    if (!output) {
      throw new Error(`No planned note owns revision ${proposal.destinationNoteId}.`);
    }
    const assignmentId = `assignment:${runId}:owner:${output.outputId}`;
    journal.record({
      type: "destination-owner-granted",
      assignmentId,
      destinationNoteIds: [proposal.destinationNoteId],
    });
    const selectedReadings = output.claimSelections.map(({ artifactId }) => {
      const reading = readingByArtifact.get(artifactId);
      if (!reading) throw new Error(`Revision ${output.outputId} lost source evidence.`);
      return reading;
    });
    const artifact: KnowledgeArtifact = {
      artifactId: `artifact:${runId}:owner:${output.outputId}`,
      assignmentId,
      purpose: "owner",
      summary: proposal.summary,
      body: proposal.body,
      assessment: mergedAssessment(selectedReadings.map(({ reading }) => reading)),
      claims: [],
      references: output.claimSelections.map(({ artifactId }) => ({
        kind: "artifact" as const,
        artifactId,
      })),
      mustPreserve: [...output.mustPreserve],
      ownerProposals: [structuredClone(proposal)],
    };
    registry.record(artifact);
    journal.record({ type: "artifact-recorded", artifact });
  }
}

async function executeTypedAssignment<T extends KnowledgeCompletionPayload>(
  options: FixedBlueprintImportOptions,
  assignment: KnowledgeAssignmentContract,
  registry: KnowledgeArtifactRegistry,
  journal: EventJournal,
  usage: Required<KnowledgeProviderUsage>,
  timeoutMs: number,
  pipelineMaterials: NonNullable<KnowledgeAssignmentContextPacket["pipelineMaterials"]>,
  finalizing: boolean,
  expected:
    | "reading-blueprint"
    | "source-reading"
    | "writing-blueprint"
    | "writer-result"
    | "note-routing"
    | "artifact",
  validate: (payload: T) => void,
  correctiveValidationRetries = 0,
): Promise<T> {
  let observations: Array<{ observationId: string; message: string }> = [];
  for (let corrective = 0; ; corrective += 1) {
    if (options.signal?.aborted) {
      throw (
        options.signal.reason ?? new Error("The knowledge import was cancelled.")
      );
    }
    if (timeoutMs < MIN_CALL_MS) {
      throw new Error("The provider transport window is too short to start.");
    }
    const attempt = journal.nextAttempt(assignment.assignmentId);
    journal.record({
      type: "assignment-created",
      callId: `call:${assignment.assignmentId}:${attempt}`,
      primitive: "fan_out",
      assignment,
    });
    journal.record({
      type: "assignment-started",
      assignmentId: assignment.assignmentId,
      attempt,
    });
    const baseContext = buildAssignmentContextPacket(
      options.runContext,
      assignment,
      registry,
    );
    const request: KnowledgeAssignmentExecutionRequest = {
      assignment,
      context: {
        ...baseContext,
        pipelineMaterials: structuredClone(pipelineMaterials),
        timeBudget: {
          phase: finalizing ? "finalizing" : "exploring",
          remainingMs: timeoutMs,
          coordinationAllowed: false,
          finalizationReserveMs: 0,
        },
      },
      completedChildArtifacts: assignment.references.flatMap((reference) => {
        if (reference.kind !== "artifact") return [];
        const artifact = registry.get(reference.artifactId);
        return artifact ? [artifact] : [];
      }),
      observations: structuredClone(observations),
      model: options.model,
      effort: boundedEffort(options.effort, assignment),
      attempt,
      requestId: `${options.runContext.runId}:${assignment.assignmentId}:${attempt}`,
      timeoutMs,
      finalizing,
    };
    try {
      const providerResult = await callDriverWithTimeout(
        options.driver,
        request,
        options.signal,
      );
      usage.inputTokens += providerResult.usage?.inputTokens ?? 0;
      usage.outputTokens += providerResult.usage?.outputTokens ?? 0;
      let payload: T;
      try {
        const response = parseKnowledgeModelResponse(
          providerResult.response,
          assignment.output,
        );
        if (response.kind !== "complete") {
          throw new Error("This import step attempted unexpected extra AI work.");
        }
        if (!completionMatchesExpected(response.payload, expected)) {
          throw new Error(
            `The provider returned the wrong result for ${assignmentStageLabel(assignment)}.`,
          );
        }
        payload = response.payload as T;
        validate(payload);
      } catch (contractError) {
        // One immediate corrective pass keeps a malformed or semantically
        // invalid fixed-stage response from pausing a long import: the model
        // sees its exact contract violation and the same frozen materials.
        // Provider and transport failures still propagate.
        if (corrective < correctiveValidationRetries && !options.signal?.aborted) {
          journal.record({
            type: "assignment-failed",
            assignmentId: assignment.assignmentId,
            error: errorMessage(contractError),
          });
          observations = [
            {
              observationId: `observation:${assignment.assignmentId}:${corrective + 1}`,
              message: `The previous response violated Orion's exact contract and was rejected: ${errorMessage(contractError)} Return a corrected complete result using only identifiers present in the supplied materials.`,
            },
          ];
          continue;
        }
        throw new FixedAssignmentContractError(contractError);
      }
      journal.record({
        type: "assignment-completed",
        assignmentId: assignment.assignmentId,
      });
      return payload;
    } catch (error) {
      journal.record({
        type: "assignment-failed",
        assignmentId: assignment.assignmentId,
        error: errorMessage(error),
      });
      throw error;
    }
  }
}

async function callDriverWithTimeout(
  driver: KnowledgeAssignmentDriver,
  request: KnowledgeAssignmentExecutionRequest,
  externalSignal?: AbortSignal,
) {
  const controller = new AbortController();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const onAbort = () => {
    const reason =
      externalSignal?.reason ?? new Error("The knowledge import was cancelled.");
    controller.abort(reason);
    rejectAbort?.(reason);
  };
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  const timeoutError = new KnowledgeProviderTimeoutError(
    `Orion did not receive ${assignmentStageLabel(request.assignment)} within ${Math.ceil(request.timeoutMs / 1_000)} seconds.`,
  );
  let timeout: number | undefined;
  let rejectTimeout: (error: unknown) => void = () => undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const startProviderDeadline = () => {
    if (timeout !== undefined || controller.signal.aborted) return;
    timeout = globalThis.setTimeout(() => {
      controller.abort(timeoutError);
      rejectTimeout(timeoutError);
    }, request.timeoutMs) as unknown as number;
  };
  if (!driver.schedulesProviderCalls) startProviderDeadline();
  const driverPromise = driver({ ...request, onProviderStart: startProviderDeadline }, controller.signal);
  // A provider that ignores abort must never hold the product deadline open.
  void driverPromise.catch(() => undefined);
  try {
    return await Promise.race([driverPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onAbort);
  }
}

function linkedStageController(externalSignal?: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(
      externalSignal?.reason ?? new Error("The knowledge import was cancelled."),
    );
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => externalSignal?.removeEventListener("abort", onAbort),
  };
}

function sourceReadingArtifact(
  runId: string,
  assignment: KnowledgeAssignmentContract,
  reading: KnowledgeSourceReading,
): KnowledgeArtifact {
  return {
    artifactId: `artifact:${runId}:source-reading:${reading.sourceId}:${reading.rangeId}`,
    assignmentId: assignment.assignmentId,
    // The typed reading stays scheduler-local. This evidence-only adapter is
    // deliberately legacy-shaped so provenance traversal can see source
    // claims without ever seeing Space interpretations.
    purpose: "evidence",
    summary: reading.summary,
    body: reading.summary,
    assessment: {
      spaceRelevance: reading.spaceAssessment.relevance,
      sourceImportance: reading.sourceAssessment.importance,
      novelty: reading.spaceAssessment.novelty,
      focusConcepts: [...reading.spaceAssessment.focusConcepts],
      deprioritizedConcepts: [...reading.spaceAssessment.deprioritizedConcepts],
      reviewedNoteIds: [...reading.spaceAssessment.reviewedNoteIds],
      rationale: reading.spaceAssessment.rationale,
    },
    claims: reading.sourceClaims.map(({ text, support }) => ({
      text,
      references: support.map(({ sourceId, rangeId }) => ({
        kind: "source-range" as const,
        sourceId,
        rangeId,
      })),
    })),
    references: [
      {
        kind: "source-range",
        sourceId: reading.sourceId,
        rangeId: reading.rangeId,
      },
    ],
    mustPreserve: [...reading.mustPreserve],
    ownerProposals: [],
  };
}

function mergedAssessment(
  readings: readonly KnowledgeSourceReading[],
): KnowledgeArtifact["assessment"] {
  const level = (key: "relevance" | "novelty") =>
    readings.some(({ spaceAssessment }) => spaceAssessment[key] === "high")
      ? ("high" as const)
      : readings.some(({ spaceAssessment }) => spaceAssessment[key] === "medium")
        ? ("medium" as const)
        : ("low" as const);
  const importance = readings.some(
    ({ sourceAssessment }) => sourceAssessment.importance === "high",
  )
    ? ("high" as const)
    : readings.some(
          ({ sourceAssessment }) => sourceAssessment.importance === "medium",
        )
      ? ("medium" as const)
      : ("low" as const);
  return {
    spaceRelevance: level("relevance"),
    sourceImportance: importance,
    novelty: level("novelty"),
    focusConcepts: uniqueStrings(
      readings.flatMap(({ spaceAssessment }) => spaceAssessment.focusConcepts),
    ),
    deprioritizedConcepts: uniqueStrings(
      readings.flatMap(
        ({ spaceAssessment }) => spaceAssessment.deprioritizedConcepts,
      ),
    ),
    reviewedNoteIds: uniqueStrings(
      readings.flatMap(({ spaceAssessment }) => spaceAssessment.reviewedNoteIds),
    ),
    rationale: readings
      .map(({ spaceAssessment }) => spaceAssessment.rationale)
      .filter(Boolean)
      .join(" "),
  };
}

function readerForAssignment(
  blueprint: KnowledgeReadingBlueprint,
  assignment: KnowledgeAssignmentContract,
) {
  const output = assignment.output;
  if (output.kind !== "source-reading") {
    throw new Error("Orion expected a source-section result.");
  }
  const reader = blueprint.readers.find(
    ({ sourceId, rangeId }) =>
      sourceId === output.sourceId && rangeId === output.rangeId,
  );
  if (!reader) throw new Error("A source section lost its reading-plan entry.");
  return reader;
}

function readerSpaceContextMaterials(
  context: KnowledgeRunContext,
  reader: KnowledgeReadingBlueprint["readers"][number],
): NonNullable<KnowledgeAssignmentContextPacket["pipelineMaterials"]> {
  const comparisonIds = new Set(
    reader.comparisons.map(({ noteId }) => noteId),
  );
  const linkedNotes = (context.targetedSpaceContext?.linkedNotes ?? [])
    .filter(({ noteId }) => comparisonIds.has(noteId))
    .map((note) => ({
      noteId: note.noteId,
      title: note.title,
      summary: note.summary.slice(0, 700),
      body: note.body.slice(0, 2_000),
      updatedAt: note.updatedAt,
    }));
  return linkedNotes.length > 0
    ? [
        {
          kind: "space-orientation",
          trust: "untrusted-context",
          payload: {
            linkedComparisonNotes: linkedNotes,
            instruction:
              "These notes are a non-evidentiary Space lens. They may guide comparison but cannot support claims about the imported source.",
          },
        },
      ]
    : [];
}

function readingBlueprintSpaceMaterials(
  context: KnowledgeRunContext,
): NonNullable<KnowledgeAssignmentContextPacket["pipelineMaterials"]> {
  const blueprint = context.targetedSpaceContext?.spaceBlueprint;
  return blueprint
    ? [
        {
          kind: "space-blueprint",
          trust: "untrusted-context",
          payload: structuredClone(blueprint),
        },
      ]
    : [];
}

function sourceReadingsForOutputs(
  outputs: readonly KnowledgeWritingBlueprintOutput[],
  readings: readonly CompletedSourceReading[],
): CompletedSourceReading[] {
  const selectedIds = new Set(
    outputs.flatMap((output) => [
      ...output.claimSelections.map(({ artifactId }) => artifactId),
      ...output.lensSelections.map(({ artifactId }) => artifactId),
    ]),
  );
  return readings.filter(({ artifact }) => selectedIds.has(artifact.artifactId));
}

function writerPipelineMaterials(
  readingBlueprint: KnowledgeReadingBlueprint,
  writingBlueprint: KnowledgeWritingBlueprint,
  slot: KnowledgeWritingBlueprint["writerSlots"][number],
  readings: readonly CompletedSourceReading[],
): NonNullable<KnowledgeAssignmentContextPacket["pipelineMaterials"]> {
  const assignedOutputs = slot.outputIds.map((outputId) =>
    structuredClone(blueprintOutput(writingBlueprint, outputId)),
  );
  return [
    {
      kind: "reading-blueprint",
      trust: "untrusted-context",
      payload: {
        spaceExplanation: readingBlueprint.spaceExplanation,
        spaceFocusConcepts: readingBlueprint.spaceFocusConcepts,
        spaceQuestions: readingBlueprint.spaceQuestions,
      },
    },
    {
      kind: "writing-blueprint",
      trust: "untrusted-context",
      payload: {
        spaceThesis: writingBlueprint.spaceThesis,
        assignedOutputs,
        ...scopedImportConnectionPlan(writingBlueprint, slot.outputIds),
      },
    },
    ...readings.map(({ artifact, reading }) => ({
      kind: "source-reading" as const,
      trust: "source-evidence" as const,
      payload: scopedSourceReadingForWriter(
        artifact.artifactId,
        reading,
        assignedOutputs,
        writingBlueprint.seedDispositions,
      ),
    })),
  ];
}

function scopedSourceReadingForWriter(
  artifactId: string,
  reading: KnowledgeSourceReading,
  outputs: readonly KnowledgeWritingBlueprintOutput[],
  seedDispositions: Readonly<KnowledgeWritingBlueprint["seedDispositions"]>,
) {
  const assignedOutputIds = new Set(outputs.map(({ outputId }) => outputId));
  const selectedSeedIds = new Set(
    seedDispositions
      .filter(
        (disposition) =>
          disposition.artifactId === artifactId &&
          disposition.outputId !== null &&
          assignedOutputIds.has(disposition.outputId),
      )
      .map(({ seedId }) => seedId),
  );
  const selectedClaimIds = new Set(
    outputs.flatMap(({ claimSelections }) =>
      claimSelections
        .filter((selection) => selection.artifactId === artifactId)
        .flatMap(({ claimIds }) => claimIds),
    ),
  );
  const selectedInterpretationIds = new Set(
    outputs.flatMap(({ lensSelections }) =>
      lensSelections
        .filter((selection) => selection.artifactId === artifactId)
        .flatMap(({ interpretationIds }) => interpretationIds),
    ),
  );
  return {
    artifactId,
    sourceId: reading.sourceId,
    rangeId: reading.rangeId,
    sourceAssessment: reading.sourceAssessment,
    spaceAssessment: reading.spaceAssessment,
    selectedSourceClaims: reading.sourceClaims.filter(({ claimId }) =>
      selectedClaimIds.has(claimId),
    ),
    selectedSynthesisSeeds: reading.synthesisSeeds.filter(({ seedId }) =>
      selectedSeedIds.has(seedId),
    ),
    selectedSpaceInterpretations: reading.spaceInterpretations.filter(
      ({ interpretationId }) => selectedInterpretationIds.has(interpretationId),
    ),
  };
}

function selectedClaimSourceIds(
  output: KnowledgeWritingBlueprintOutput,
  readings: ReadonlyMap<string, CompletedSourceReading>,
): string[] {
  const sourceIds: string[] = [];
  for (const selection of output.claimSelections) {
    const completed = readings.get(selection.artifactId);
    if (!completed) {
      throw new Error(`Blueprint output ${output.outputId} selected unknown evidence.`);
    }
    const claims = new Map(
      completed.reading.sourceClaims.map((claim) => [claim.claimId, claim]),
    );
    for (const claimId of selection.claimIds) {
      const claim = claims.get(claimId);
      if (!claim) {
        throw new Error(
          `Blueprint output ${output.outputId} selected unknown claim ${claimId}.`,
        );
      }
      claim.support.forEach(({ sourceId }) => sourceIds.push(sourceId));
    }
  }
  return uniqueStrings(sourceIds);
}

function validateLensSelections(
  selections: readonly KnowledgeLensSelection[],
  claimSelections: readonly KnowledgeEvidenceSelection[],
  readings: ReadonlyMap<string, CompletedSourceReading>,
): void {
  const selectedClaimsByArtifact = new Map(
    claimSelections.map(({ artifactId, claimIds }) => [
      artifactId,
      new Set(claimIds),
    ]),
  );
  for (const selection of selections) {
    const reading = readings.get(selection.artifactId)?.reading;
    if (!reading) throw new Error("The note plan selected an unavailable Space lens.");
    const known = new Map(
      reading.spaceInterpretations.map((interpretation) => [
        interpretation.interpretationId,
        interpretation,
      ]),
    );
    const selectedClaims = selectedClaimsByArtifact.get(selection.artifactId);
    for (const interpretationId of selection.interpretationIds) {
      const interpretation = known.get(interpretationId);
      if (!interpretation) {
        throw new Error("The note plan selected an unknown Space interpretation.");
      }
      if (
        !selectedClaims ||
        interpretation.sourceClaimIds.some((claimId) => !selectedClaims.has(claimId))
      ) {
        throw new Error(
          "A Space lens cannot introduce source claims its output did not select as evidence.",
        );
      }
    }
  }
}

function resolvableTitles(
  blueprint: KnowledgeWritingBlueprint,
  snapshot: AppSnapshot,
): Map<string, Set<string>> {
  const titles = new Map<string, Set<string>>();
  const add = (title: string, identity: string) => {
    const key = normalizedTitle(title);
    const values = titles.get(key) ?? new Set<string>();
    values.add(identity);
    titles.set(key, values);
  };
  for (const note of snapshot.notes) add(note.title, note.id);
  for (const output of blueprint.outputs) {
    add(
      output.title,
      output.existingDestination?.noteId ?? `output:${output.outputId}`,
    );
  }
  return titles;
}

function requireUniqueTitle(
  title: string,
  titles: ReadonlyMap<string, ReadonlySet<string>>,
  label: string,
): void {
  const matches = titles.get(normalizedTitle(title));
  if (!matches || matches.size !== 1) {
    throw new Error(`A ${label} did not resolve uniquely inside this Space: ${title}.`);
  }
}

function assertExactSourceRangeCompletion(
  ranges: readonly SourceRangeTarget[],
  readings: readonly CompletedSourceReading[],
): void {
  if (
    !sameUniqueSet(
      ranges.map(sourceRangeKey),
      readings.map(({ reading }) => sourceRangeKey(reading)),
    )
  ) {
    throw new Error("Orion did not complete every planned source section.");
  }
}

function blueprintOutput(
  blueprint: KnowledgeWritingBlueprint,
  outputId: string,
): KnowledgeWritingBlueprintOutput {
  const output = blueprint.outputs.find((candidate) => candidate.outputId === outputId);
  if (!output) throw new Error(`Unknown planned note: ${outputId}`);
  return output;
}

function completionMatchesExpected(
  payload: KnowledgeCompletionPayload,
  expected:
    | "reading-blueprint"
    | "source-reading"
    | "writing-blueprint"
    | "writer-result"
    | "note-routing"
    | "artifact",
): boolean {
  if (expected === "reading-blueprint") return "readers" in payload;
  if (expected === "source-reading") return "sourceClaims" in payload;
  if (expected === "writing-blueprint") return "writerSlots" in payload;
  if (expected === "writer-result") return "drafts" in payload;
  if (expected === "note-routing") {
    return "rangeId" in payload && "routes" in payload;
  }
  return "assessment" in payload && "claims" in payload;
}

function sameEvidenceSelections(
  left: readonly KnowledgeEvidenceSelection[],
  right: readonly KnowledgeEvidenceSelection[],
): boolean {
  const identity = ({ artifactId, claimIds }: KnowledgeEvidenceSelection) =>
    `${artifactId}:${[...claimIds].sort().join(",")}`;
  return sameUniqueSet(left.map(identity), right.map(identity));
}

function sameLensSelections(
  left: readonly KnowledgeLensSelection[],
  right: readonly KnowledgeLensSelection[],
): boolean {
  const identity = ({ artifactId, interpretationIds }: KnowledgeLensSelection) =>
    `${artifactId}:${[...interpretationIds].sort().join(",")}`;
  return sameUniqueSet(left.map(identity), right.map(identity));
}

function sameDestination(
  left: KnowledgeWriterDraft["existingDestination"],
  right: KnowledgeWritingBlueprintOutput["existingDestination"],
): boolean {
  return (
    left?.noteId === right?.noteId && left?.baseVersion === right?.baseVersion
  );
}

function sameUniqueSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((value) => rightSet.has(value))
  );
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function sourceShapedKnowledgeTitle(
  title: string,
  context: KnowledgeRunContext,
): boolean {
  const normalized = normalizedTitle(title);
  if (context.sources.some((source) => normalized === normalizedTitle(source.title))) {
    return true;
  }
  return (
    /(?:^|\s[—–:-]\s*)part\s+\d+$/iu.test(title) ||
    /\b(?:source[- ]?)?range[- ]?\d+\b/iu.test(title) ||
    /\bpages?\s+\d+(?:\s*[–-]\s*\d+)?\b/iu.test(title) ||
    /^(?:notes?|summary|overview)\s+(?:on|of)\b/iu.test(title) ||
    /^introduction\s+to\b/iu.test(title)
  );
}

function sourceRangeKey(value: SourceRangeTarget): string {
  return `${value.sourceId}/${value.rangeId}`;
}

function validateResumeCheckpoint(
  options: FixedBlueprintImportOptions,
  sourceRanges: readonly SourceRangeTarget[],
): FixedBlueprintImportCheckpoint | undefined {
  const checkpoint = options.resume;
  if (!checkpoint) return undefined;
  if (
    checkpoint.kind !== "fixed-blueprint-import" ||
    checkpoint.schemaVersion !== 3
  ) {
    throw new Error("This saved import recovery state is not supported.");
  }
  if (
    checkpoint.runId !== options.runContext.runId ||
    checkpoint.runIdentity !== fixedRunIdentity(options)
  ) {
    throw new Error(
      "This import can no longer resume because its source, Space context, model, or instructions changed.",
    );
  }
  validateReadingBlueprint(
    checkpoint.readingBlueprint,
    options.runContext,
    sourceRanges,
  );
  const sourceAssignments = createSourceReaderAssignments(
    options.runContext,
    checkpoint.readingBlueprint,
    `assignment:${options.runContext.runId}:reading-blueprint`,
  );
  const assignmentsByRange = new Map(
    sourceAssignments.map((assignment) => {
      const reader = readerForAssignment(
        checkpoint.readingBlueprint,
        assignment,
      );
      return [sourceRangeKey(reader), { assignment, reader }] as const;
    }),
  );
  const completedKeys = new Set<string>();
  for (const completed of checkpoint.completedSourceReadings) {
    const key = sourceRangeKey(completed.reading);
    const expected = assignmentsByRange.get(key);
    if (!expected || completedKeys.has(key)) {
      throw new Error("This import recovery state contains invalid source coverage.");
    }
    completedKeys.add(key);
    validateSourceReading(
      completed.reading,
      expected.reader,
      options.runContext,
    );
    const expectedArtifact = sourceReadingArtifact(
      options.runContext.runId,
      expected.assignment,
      completed.reading,
    );
    if (
      completed.assignment.assignmentId !== expected.assignment.assignmentId ||
      completed.artifact.artifactId !== expectedArtifact.artifactId ||
      completed.artifact.assignmentId !== expectedArtifact.assignmentId ||
      completed.artifact.purpose !== "evidence"
    ) {
      throw new Error("This import recovery state contains stale source evidence.");
    }
  }
  const progressRangeKeys = new Set<string>();
  let minimumAdaptiveAttempts = completedKeys.size;
  let minimumAdaptiveLogicalTasks = completedKeys.size;
  for (const progress of checkpoint.adaptiveReadingProgress) {
    const key = sourceRangeKey(progress);
    const expected = assignmentsByRange.get(key);
    if (
      !expected ||
      completedKeys.has(key) ||
      progressRangeKeys.has(key) ||
      progress.pending.length === 0
    ) {
      throw new Error("This import recovery state contains invalid adaptive source work.");
    }
    if (
      !Number.isInteger(progress.logicalTaskCount) ||
      progress.logicalTaskCount < progress.leaves.length + progress.pending.length ||
      progress.logicalTaskCount > MAX_ADAPTIVE_LOGICAL_TASKS_PER_CANONICAL ||
      !Number.isInteger(progress.attemptCount) ||
      progress.attemptCount < progress.leaves.length ||
      progress.attemptCount > MAX_ADAPTIVE_ATTEMPTS_PER_CANONICAL
    ) {
      throw new Error("This import recovery state contains invalid adaptive source counters.");
    }
    progressRangeKeys.add(key);
    minimumAdaptiveAttempts += progress.attemptCount;
    minimumAdaptiveLogicalTasks += progress.logicalTaskCount;
    const paths = [
      ...progress.leaves.map(({ path }) => path),
      ...progress.pending.map(({ path }) => path),
    ];
    assertCompleteAdaptiveLeafPaths(paths);
    for (const leaf of progress.leaves) {
      const task = adaptiveSourceTaskFromPath(
        options.runContext,
        expected.reader,
        expected.assignment,
        leaf.path,
      );
      validateSourceReading(leaf.reading, task.reader, task.context);
    }
    for (const pending of progress.pending) {
      restoreAdaptiveSourceReadingTask(
        options.runContext,
        expected.reader,
        expected.assignment,
        pending,
      );
    }
  }
  if (
    checkpoint.adaptiveReadingProgress.length > 0 &&
    completedKeys.size + progressRangeKeys.size !== assignmentsByRange.size
  ) {
    throw new Error("This import recovery state lost part of its adaptive source frontier.");
  }
  if (
    !Number.isInteger(checkpoint.runAdaptiveLogicalTaskCount) ||
    checkpoint.runAdaptiveLogicalTaskCount < minimumAdaptiveLogicalTasks ||
    checkpoint.runAdaptiveLogicalTaskCount > MAX_ADAPTIVE_LOGICAL_TASKS_PER_RUN ||
    !Number.isInteger(checkpoint.runAdaptiveAttemptCount) ||
    checkpoint.runAdaptiveAttemptCount < minimumAdaptiveAttempts ||
    checkpoint.runAdaptiveAttemptCount > MAX_ADAPTIVE_ATTEMPTS_PER_RUN
  ) {
    throw new Error("This import recovery state contains invalid adaptive run counters.");
  }
  if (
    !Number.isInteger(checkpoint.writerProgress.contractFailures) ||
    checkpoint.writerProgress.contractFailures < 0 ||
    checkpoint.writerProgress.contractFailures > MAX_WRITER_CONTRACT_FAILURES ||
    checkpoint.writerProgress.circuitOpen !==
      (checkpoint.writerProgress.contractFailures >= MAX_WRITER_CONTRACT_FAILURES)
  ) {
    throw new Error("This import recovery state contains invalid writer recovery state.");
  }
  const partialWriterSlotIds = new Set<string>();
  const partialWriterOutputIds = new Set<string>();
  for (const progress of checkpoint.writerProgress.slots) {
    const blueprint = checkpoint.writingBlueprint;
    const slot = blueprint?.writerSlots.find(
      ({ writerSlotId }) => writerSlotId === progress.writerSlotId,
    );
    if (
      !blueprint ||
      !slot ||
      partialWriterSlotIds.has(progress.writerSlotId) ||
      progress.drafts.length === 0 ||
      progress.drafts.length >= slot.outputIds.length
    ) {
      throw new Error("This import recovery state contains an invalid partial writer slot.");
    }
    partialWriterSlotIds.add(progress.writerSlotId);
    if (!sameUniqueSet(progress.warnings, uniqueStrings(progress.warnings))) {
      throw new Error("This import recovery state repeated a writer warning.");
    }
    for (const draft of progress.drafts) {
      if (
        !slot.outputIds.includes(draft.outputId) ||
        partialWriterOutputIds.has(draft.outputId)
      ) {
        throw new Error("This import recovery state repeated a partial note draft.");
      }
      validateWriterResult(
        {
          writerSlotId: progress.writerSlotId,
          drafts: [draft],
          warnings: [],
        },
        blueprint,
        [draft.outputId],
        options.snapshot,
      );
      partialWriterOutputIds.add(draft.outputId);
    }
  }
  let restoredRouting:
    | { context: KnowledgeRunContext; artifacts: KnowledgeArtifact[] }
    | undefined;
  if (checkpoint.postReadingRouting) {
    assertExactSourceRangeCompletion(
      sourceRanges,
      checkpoint.completedSourceReadings,
    );
    assertCompletedSourceReadingsWithinAggregateBudget(
      checkpoint.completedSourceReadings,
    );
    restoredRouting = restorePostReadingRouting(
      options,
      checkpoint.completedSourceReadings,
      checkpoint.postReadingRouting,
    );
  }
  if (checkpoint.writingBlueprint) {
    if (!checkpoint.postReadingRouting) {
      throw new Error("This import recovery state lost its accepted Space routing state.");
    }
    assertExactSourceRangeCompletion(
      sourceRanges,
      checkpoint.completedSourceReadings,
    );
    assertCompletedSourceReadingsWithinAggregateBudget(
      checkpoint.completedSourceReadings,
    );
    validateWritingBlueprint(
      checkpoint.writingBlueprint,
      restoredRouting?.context ?? options.runContext,
      options.snapshot,
      checkpoint.completedSourceReadings,
      restoredRouting?.artifacts ?? [],
      fixedRevisionAccess(
        checkpoint.postReadingRouting,
        restoredRouting?.artifacts ?? [],
      ),
    );
  } else if (checkpoint.writerResults.length > 0) {
    throw new Error("This import recovery state lost its note plan.");
  }
  const writerSlotIds = new Set<string>();
  for (const result of checkpoint.writerResults) {
    const blueprint = checkpoint.writingBlueprint;
    const slot = blueprint?.writerSlots.find(
      ({ writerSlotId }) => writerSlotId === result.writerSlotId,
    );
    if (!blueprint || !slot || writerSlotIds.has(result.writerSlotId)) {
      throw new Error("This import recovery state contains an invalid writer slot.");
    }
    writerSlotIds.add(result.writerSlotId);
    if (partialWriterSlotIds.has(result.writerSlotId)) {
      throw new Error("This import recovery state repeated a finished writer slot.");
    }
    validateWriterResult(
      result,
      blueprint,
      slot.outputIds,
      options.snapshot,
    );
  }
  if (checkpoint.postReadingRouting) {
    if (
      checkpoint.writingBlueprint &&
      checkpoint.postReadingRouting.mode !== "routed" &&
      checkpoint.writingBlueprint.outputs.some(
        ({ operation }) => operation === "revise",
      )
    ) {
      throw new Error("This import recovery state lost revision routing authority.");
    }
  } else if (
    checkpoint.writingBlueprint?.outputs.some(
      ({ operation }) => operation === "revise",
    )
  ) {
    throw new Error("This import recovery state lost revision routing authority.");
  }
  for (const attempt of Object.values(checkpoint.attempts)) {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new Error("This import recovery state contains an invalid attempt counter.");
    }
  }
  return structuredClone(checkpoint);
}

function interruptedImportError(
  error: unknown,
  options: FixedBlueprintImportOptions,
  journal: EventJournal,
  stage: FixedBlueprintImportRecoveryStage,
  readingBlueprint: KnowledgeReadingBlueprint,
  readingBlueprintFallbackWarning: string | undefined,
  completedSourceReadings: readonly CompletedSourceReading[],
  writingBlueprint: KnowledgeWritingBlueprint | undefined,
  writerResults: readonly KnowledgeWriterResult[],
  counters: PipelineCounters,
  adaptiveReadingProgress: readonly AdaptiveSourceReadingCheckpoint[] = [],
  adaptiveReadingRunProgress: AdaptiveSourceReadingRunProgress = {
    logicalTaskCount: 0,
    attemptCount: 0,
  },
  postReadingRouting?: FixedPostReadingRoutingCheckpoint,
  writerProgress: FixedWriterProgressCheckpoint = {
    slots: [],
    contractFailures: 0,
    circuitOpen: false,
  },
): FixedBlueprintImportInterruptedError {
  const checkpoint: FixedBlueprintImportCheckpoint = {
    kind: "fixed-blueprint-import",
    schemaVersion: 3,
    runId: options.runContext.runId,
    runIdentity: fixedRunIdentity(options),
    stage,
    readingBlueprint: structuredClone(readingBlueprint),
    ...(readingBlueprintFallbackWarning
      ? { readingBlueprintFallbackWarning }
      : {}),
    completedSourceReadings: structuredClone([...completedSourceReadings]),
    adaptiveReadingProgress: structuredClone([...adaptiveReadingProgress]),
    runAdaptiveLogicalTaskCount: adaptiveReadingRunProgress.logicalTaskCount,
    runAdaptiveAttemptCount: adaptiveReadingRunProgress.attemptCount,
    ...(postReadingRouting
      ? { postReadingRouting: structuredClone(postReadingRouting) }
      : {}),
    ...(writingBlueprint
      ? { writingBlueprint: structuredClone(writingBlueprint) }
      : {}),
    writerResults: structuredClone([...writerResults]),
    writerProgress: structuredClone(writerProgress),
    attempts: journal.attemptSnapshot(),
    createdAt: new Date().toISOString(),
  };
  return new FixedBlueprintImportInterruptedError(error, checkpoint, {
    completedReadings: completedSourceReadings.length,
    // Adaptive narrowing widens the logical queue at runtime. Report that
    // real total instead of snapping diagnostics back to the initial
    // canonical-reader count after a child branch fails.
    totalReadings: counters.readingTotal,
    completedWrites: writerResults.reduce(
      (total, result) => total + result.drafts.length,
      0,
    ),
    totalWrites: writingBlueprint?.outputs.length ?? counters.writingTotal,
  });
}

function fixedRunIdentity(options: FixedBlueprintImportOptions): string {
  const rangeFingerprints = options.runContext.sources.flatMap((source) =>
    source.ranges.map(({ rangeId }) => {
      const content = sourceRangeContent(
        options.runContext,
        source.sourceId,
        rangeId,
      );
      return {
        sourceId: source.sourceId,
        rangeId,
        characters: content.length,
        content: stableTextFingerprint(content),
      };
    }),
  );
  return stableTextFingerprint(
    JSON.stringify({
      snapshotVersion: options.runContext.space.snapshotVersion,
      model: options.model,
      effort: options.effort,
      importGuidance: options.runContext.importGuidance,
      organizationInstructions: options.runContext.organizationInstructions,
      constraints: options.runContext.constraints,
      rangeFingerprints,
    }),
  );
}

function stableTextFingerprint(value: string): string {
  // Two independent 32-bit lanes make accidental collisions sufficiently
  // unlikely for an in-memory resume guard without introducing async crypto.
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ (code + index), 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function boundedEffort(
  effort: ReasoningEffort,
  assignment: KnowledgeAssignmentContract,
): ReasoningEffort {
  if (
    assignment.purpose !== "reading-blueprint" &&
    assignment.purpose !== "source-reader" &&
    assignment.purpose !== "writing-blueprint" &&
    assignment.purpose !== "router" &&
    !(
      assignment.purpose === "evidence" &&
      assignment.references.some(({ kind }) => kind === "note-digest-range")
    )
  ) {
    return effort;
  }
  return effort === "high" || effort === "xhigh" || effort === "max"
    ? "medium"
    : effort;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assignmentStageLabel(assignment: KnowledgeAssignmentContract): string {
  if (assignment.purpose === "reading-blueprint") return "the initial reading plan";
  if (assignment.purpose === "source-reader") return "a source section";
  if (assignment.purpose === "writing-blueprint") return "the note plan";
  if (assignment.purpose === "writer") return "a note draft";
  if (assignment.references.some(({ kind }) => kind === "note-digest-range")) {
    return "the Space context";
  }
  return "this import step";
}
