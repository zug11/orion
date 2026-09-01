import type { ReasoningEffort } from "../../types";
import {
  buildAssignmentContextPacket,
  KnowledgeArtifactRegistry,
  noteVersion,
  referenceAllowedInRun,
  resolveKnowledgeReference,
  validateCompleteNoteRoutingCoverage,
  type KnowledgeAssignmentContextPacket,
  type KnowledgeRunContext,
} from "./context";
import {
  parseKnowledgeModelResponse,
  type CoordinationCall,
  type KnowledgeArtifact,
  type KnowledgeArtifactPayload,
  type KnowledgeAssignmentContract,
  type KnowledgeAssignmentId,
  type KnowledgeNoteRoutingResult,
  type KnowledgeProviderUsage,
  type KnowledgeReference,
  type KnowledgeRunResult,
  type KnowledgeTelemetry,
} from "./protocol";
import {
  isTerminalAssignmentState,
  KnowledgeRuntime,
  type KnowledgeRuntimeEvent,
} from "./runtime";

export interface KnowledgeAssignmentExecutionRequest {
  assignment: KnowledgeAssignmentContract;
  context: KnowledgeAssignmentContextPacket;
  completedChildArtifacts: KnowledgeArtifact[];
  observations: Array<{ observationId: string; message: string }>;
  model: string;
  effort: ReasoningEffort;
  attempt: number;
  requestId: string;
  timeoutMs: number;
  finalizing: boolean;
  /** Renderer-only dispatch notification; never serialized into provider/IPC data. */
  onProviderStart?: () => void;
}

export interface KnowledgeAssignmentDriverResult {
  response: unknown;
  usage?: KnowledgeProviderUsage;
}

export type KnowledgeAssignmentDriver = ((
  request: KnowledgeAssignmentExecutionRequest,
  signal: AbortSignal,
) => Promise<KnowledgeAssignmentDriverResult>) & {
  /** This driver queues physical transports and invokes request.onProviderStart. */
  schedulesProviderCalls?: true;
};

export interface KnowledgeOrchestrationOptions {
  runContext: KnowledgeRunContext;
  rootAssignment: KnowledgeAssignmentContract;
  model: string;
  effort: ReasoningEffort;
  driver: KnowledgeAssignmentDriver;
  signal?: AbortSignal;
  physicalConcurrency?: number;
  elapsedTimeMs?: number;
  explorationTimeMs?: number;
  maxCallTimeMs?: number;
  maxAssignmentDepth?: number;
  maxTurnsPerAssignment?: number;
  usageBudgetTokens?: number;
  holdFanOutAbove?: number;
  retryLimit?: number;
  initialCoordinationCalls?: readonly CoordinationCall[];
  /**
   * Already-validated artifacts recorded into the registry before scheduling,
   * e.g. a cached typed-routing pass. A routing-bearing seed keeps the root's
   * complete note-routing coverage gate active without a router child.
   */
  initialArtifacts?: readonly KnowledgeArtifact[];
  validateRootResult?: (
    result: KnowledgeRunResult,
    history: readonly KnowledgeRuntimeEvent[],
  ) => KnowledgeRunResult;
  onTelemetry?: (
    telemetry: KnowledgeTelemetry,
    history: readonly KnowledgeRuntimeEvent[],
  ) => void;
}

export interface KnowledgeOrchestrationResult {
  result: KnowledgeRunResult;
  history: readonly KnowledgeRuntimeEvent[];
  artifacts: KnowledgeArtifact[];
  usage: Required<KnowledgeProviderUsage>;
}

export const KNOWLEDGE_TOTAL_BUDGET_MS = 180_000;
export const KNOWLEDGE_EXPLORATION_BUDGET_MS = 120_000;
export const KNOWLEDGE_FINALIZATION_RESERVE_MS = 60_000;
const KNOWLEDGE_MAX_CALL_MS = 90_000;
const KNOWLEDGE_INTERMEDIATE_CALL_MS = 45_000;
const MIN_ATTEMPT_TIME_MS = 1_000;

export class KnowledgeDeadlineExceededError extends Error {
  constructor() {
    super("Orion reached the three-minute knowledge-import limit.");
    this.name = "KnowledgeDeadlineExceededError";
  }
}

class KnowledgeFinalizationCutoffError extends Error {
  constructor() {
    super("Orion reserved the remaining import time for final synthesis.");
    this.name = "KnowledgeFinalizationCutoffError";
  }
}

export class KnowledgeProviderExecutionError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number;

  constructor(
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "KnowledgeProviderExecutionError";
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = Math.max(0, options.retryAfterMs ?? 0);
  }
}

export class KnowledgeProviderTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnowledgeProviderTimeoutError";
  }
}

export async function runKnowledgeOrchestration(
  options: KnowledgeOrchestrationOptions,
): Promise<KnowledgeOrchestrationResult> {
  const physicalConcurrency = clampInteger(
    options.physicalConcurrency ?? 6,
    1,
    6,
  );
  const elapsedTimeMs = clampInteger(
    options.elapsedTimeMs ?? KNOWLEDGE_TOTAL_BUDGET_MS,
    100,
    KNOWLEDGE_TOTAL_BUDGET_MS,
  );
  const explorationTimeMs = clampInteger(
    options.explorationTimeMs ?? Math.min(
      KNOWLEDGE_EXPLORATION_BUDGET_MS,
      Math.max(50, elapsedTimeMs - KNOWLEDGE_FINALIZATION_RESERVE_MS),
    ),
    50,
    Math.max(50, elapsedTimeMs - 50),
  );
  const maxCallTimeMs = clampInteger(
    options.maxCallTimeMs ?? KNOWLEDGE_MAX_CALL_MS,
    MIN_ATTEMPT_TIME_MS,
    KNOWLEDGE_MAX_CALL_MS,
  );
  const maxAssignmentDepth = clampInteger(
    options.maxAssignmentDepth ?? 12,
    1,
    32,
  );
  const maxTurnsPerAssignment = clampInteger(
    options.maxTurnsPerAssignment ?? 8,
    1,
    32,
  );
  const retryLimit = clampInteger(options.retryLimit ?? 2, 0, 5);
  const runtime = new KnowledgeRuntime(
    options.runContext.runId,
    options.rootAssignment,
  );
  const registry = new KnowledgeArtifactRegistry();
  for (const artifact of options.initialArtifacts ?? []) {
    // Defensive: a repeated seed must not abort the run before it starts.
    if (!registry.has(artifact.artifactId)) registry.record(artifact);
  }
  const controller = new AbortController();
  const attemptControllers = new Map<KnowledgeAssignmentId, AbortController>();
  const ready: KnowledgeAssignmentId[] = [];
  const queued = new Set<KnowledgeAssignmentId>();
  const observations = new Map<
    KnowledgeAssignmentId,
    Array<{ observationId: string; message: string }>
  >();
  const usage = { inputTokens: 0, outputTokens: 0 };
  const requiresCompleteNoteRoutingCoverage =
    (options.initialCoordinationCalls?.some((call) =>
      assignmentsForCoverageCheck(call).some(
        ({ output }) => output.kind === "note-routing",
      ),
    ) ??
      false) ||
    (options.initialArtifacts?.some(
      ({ routing }) => routing !== undefined,
    ) ??
      false);
  let active = 0;
  let settled = false;
  let timeoutId: number | undefined;
  let cutoffId: number | undefined;
  let phase: "exploring" | "finalizing" = "exploring";
  let finalizationRootDeferred = false;
  const startedAt = Date.now();
  const explorationDeadline = startedAt + explorationTimeMs;
  const hardDeadline = startedAt + elapsedTimeMs;

  const externalAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new Error("The knowledge run was cancelled.");
  }

  if (options.initialCoordinationCalls?.length) {
    const created = runtime.acceptCoordination(
      options.rootAssignment.assignmentId,
      options.initialCoordinationCalls,
      {
        referenceAllowed: (assignment) =>
          referenceAllowedInRun(options.runContext, registry, assignment),
      },
    );
    if (created.length === 0) {
      throw new Error("Orion could not schedule mandatory source coverage.");
    }
    runtime.waitAssignment(options.rootAssignment.assignmentId);
    ready.push(...created);
  } else {
    ready.push(options.rootAssignment.assignmentId);
  }
  ready.forEach((assignmentId) => queued.add(assignmentId));

  const emit = () => {
    const projection = runtime.projection();
    const projectedAssignments = [...projection.assignments.values()];
    const sourceSummaries = projectedAssignments.filter(
      ({ contract }) =>
        contract.purpose === "evidence" &&
        contract.references.some(
          (reference) =>
            reference.kind === "source-range" && reference.rangeId !== "full",
        ),
    );
    const spaceSummaries = projectedAssignments.filter(({ contract }) =>
      contract.references.some(({ kind }) => kind === "note-digest-range"),
    );
    options.onTelemetry?.(
      {
        ...projection.telemetry,
        phase,
        elapsedMs: Math.max(0, Date.now() - startedAt),
        remainingMs: Math.max(0, hardDeadline - Date.now()),
        sourceSummaryTotal: sourceSummaries.length,
        sourceSummaryCompleted: sourceSummaries.filter(
          ({ state }) => state === "completed",
        ).length,
        spaceSummaryTotal: spaceSummaries.length,
        spaceSummaryCompleted: spaceSummaries.filter(
          ({ state }) => state === "completed",
        ).length,
      },
      runtime.history(),
    );
  };
  emit();

  return new Promise<KnowledgeOrchestrationResult>((resolve, reject) => {
    const finish = (
      outcome:
        | { ok: true; value: KnowledgeOrchestrationResult }
        | { ok: false; error: unknown },
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) globalThis.clearTimeout(timeoutId);
      if (cutoffId !== undefined) globalThis.clearTimeout(cutoffId);
      options.signal?.removeEventListener("abort", externalAbort);
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    };

    const abortRunImmediately = (reason: unknown) => {
      if (settled) return;
      const error =
        reason instanceof Error
          ? reason
          : new Error("The knowledge run was cancelled.");
      controller.abort(error);
      for (const attemptController of attemptControllers.values()) {
        attemptController.abort(error);
      }
      runtime.cancelRun();
      emit();
      finish({ ok: false, error });
    };

    options.signal?.addEventListener("abort", externalAbort, { once: true });
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!settled) abortRunImmediately(controller.signal.reason);
      },
      { once: true },
    );

    const enqueue = (assignmentId: KnowledgeAssignmentId) => {
      const assignment = runtime.projection().assignments.get(assignmentId);
      if (
        !assignment ||
        !["accepted", "waiting"].includes(assignment.state) ||
        queued.has(assignmentId)
      ) {
        return;
      }
      ready.push(assignmentId);
      queued.add(assignmentId);
    };

    const resumeParentWhenReady = (assignmentId: KnowledgeAssignmentId) => {
      const projection = runtime.projection();
      const assignment = projection.assignments.get(assignmentId);
      if (!assignment || assignment.contract.parent.kind !== "assignment") return;
      const parent = projection.assignments.get(
        assignment.contract.parent.assignmentId,
      );
      if (!parent || parent.state !== "waiting") return;
      const childrenSettled = parent.childAssignmentIds.every((childId) => {
        const child = projection.assignments.get(childId);
        return child ? isTerminalAssignmentState(child.state) : false;
      });
      if (childrenSettled) enqueue(parent.contract.assignmentId);
    };

    const noteObservation = (
      assignmentId: KnowledgeAssignmentId,
      message: string,
    ) => {
      const observationId = `observation:${assignmentId}:${
        (observations.get(assignmentId)?.length ?? 0) + 1
      }`;
      const values = observations.get(assignmentId) ?? [];
      values.push({ observationId, message });
      observations.set(assignmentId, values);
      runtime.observe(observationId, message, assignmentId);
    };

    const beginFinalization = () => {
      if (settled || phase === "finalizing") return;
      phase = "finalizing";
      const cutoffError = new KnowledgeFinalizationCutoffError();
      noteObservation(
        options.rootAssignment.assignmentId,
        "The finalization reserve has begun. Use completed summaries, focus on relevant, important, or novel material, and return the best grounded final result now. Do not create more assignments.",
      );
      ready.splice(0, ready.length);
      queued.clear();
      const projection = runtime.projection();
      for (const [assignmentId, assignment] of projection.assignments) {
        if (
          assignmentId !== options.rootAssignment.assignmentId &&
          !isTerminalAssignmentState(assignment.state)
        ) {
          runtime.cancelAssignment(assignmentId);
        }
      }
      for (const attemptController of attemptControllers.values()) {
        attemptController.abort(cutoffError);
      }
      const root = runtime
        .projection()
        .assignments.get(options.rootAssignment.assignmentId);
      if (root?.state === "running") {
        runtime.waitAssignment(options.rootAssignment.assignmentId);
        finalizationRootDeferred = true;
      } else {
        enqueue(options.rootAssignment.assignmentId);
      }
      emit();
    };

    const failOrResumeParent = (
      assignmentId: KnowledgeAssignmentId,
      error: unknown,
    ) => {
      const message = errorMessage(error);
      runtime.failAssignment(assignmentId, message);
      const projection = runtime.projection();
      const assignment = projection.assignments.get(assignmentId);
      if (assignment?.contract.parent.kind === "assignment") {
        noteObservation(assignment.contract.parent.assignmentId, message);
        resumeParentWhenReady(assignmentId);
      } else {
        runtime.failRun(message);
      }
      emit();
    };

    const execute = async (assignmentId: KnowledgeAssignmentId) => {
      const projectionBefore = runtime.projection();
      const projected = projectionBefore.assignments.get(assignmentId);
      if (!projected) return;
      if (
        phase === "finalizing" &&
        projected.contract.purpose !== "root"
      ) {
        runtime.cancelAssignment(assignmentId);
        resumeParentWhenReady(assignmentId);
        emit();
        return;
      }
      if (assignmentDepth(projected.contract, projectionBefore.assignments) > maxAssignmentDepth) {
        failOrResumeParent(
          assignmentId,
          new Error("The knowledge run exceeded its assignment-depth safety fuse."),
        );
        return;
      }
      if (projected.attempts >= maxTurnsPerAssignment) {
        failOrResumeParent(
          assignmentId,
          new Error("The knowledge run exceeded its per-assignment turn safety fuse."),
        );
        return;
      }
      if (!runtime.startAssignment(assignmentId)) return;
      emit();
      const running = runtime.projection().assignments.get(assignmentId);
      if (!running) return;
      const childArtifacts = running.childAssignmentIds.flatMap((childId) => {
        const artifactId = runtime.projection().assignments.get(childId)?.artifactId;
        const artifact = artifactId ? registry.get(artifactId) : undefined;
        return artifact ? [artifact] : [];
      });
      let driverAttempt = 0;
      while (driverAttempt <= retryLimit) {
        if (controller.signal.aborted) throw controller.signal.reason;
        try {
          if (phase === "exploring" && Date.now() >= explorationDeadline) {
            beginFinalization();
            throw new KnowledgeFinalizationCutoffError();
          }
          const phaseDeadline =
            phase === "exploring" ? explorationDeadline : hardDeadline;
          const remainingMs = Math.max(0, phaseDeadline - Date.now());
          if (remainingMs < MIN_ATTEMPT_TIME_MS) {
            if (phase === "exploring") {
              beginFinalization();
              throw new KnowledgeFinalizationCutoffError();
            }
            throw new KnowledgeDeadlineExceededError();
          }
          const timeoutMs = Math.max(
            MIN_ATTEMPT_TIME_MS,
            Math.min(
              maxCallTimeMs,
              assignmentCallTimeCap(running.contract),
              remainingMs - 100,
            ),
          );
          const baseContext = buildAssignmentContextPacket(
            options.runContext,
            running.contract,
            registry,
          );
          const context: KnowledgeAssignmentContextPacket = {
            ...baseContext,
            timeBudget: {
              phase,
              remainingMs: Math.max(0, hardDeadline - Date.now()),
              coordinationAllowed: phase === "exploring",
              finalizationReserveMs: Math.max(
                0,
                hardDeadline - explorationDeadline,
              ),
            },
          };
          const attemptController = new AbortController();
          const abortAttempt = () =>
            attemptController.abort(controller.signal.reason);
          controller.signal.addEventListener("abort", abortAttempt, {
            once: true,
          });
          attemptControllers.set(assignmentId, attemptController);
          const requestId = `${options.runContext.runId}:${assignmentId}:${running.attempts}:${driverAttempt + 1}`;
          let providerResult: KnowledgeAssignmentDriverResult;
          try {
            providerResult = await options.driver(
              {
                assignment: running.contract,
                context,
                completedChildArtifacts: childArtifacts,
                observations: observations.get(assignmentId) ?? [],
                model: options.model,
                effort: assignmentReasoningEffort(
                  options.effort,
                  running.contract,
                ),
                attempt: running.attempts,
                requestId,
                timeoutMs,
                finalizing: phase === "finalizing",
              },
              attemptController.signal,
            );
          } catch (error) {
            if (attemptController.signal.aborted) {
              throw (
                attemptController.signal.reason ??
                new Error("The knowledge assignment was cancelled.")
              );
            }
            throw error;
          } finally {
            controller.signal.removeEventListener("abort", abortAttempt);
            if (attemptControllers.get(assignmentId) === attemptController) {
              attemptControllers.delete(assignmentId);
            }
          }
          if (attemptController.signal.aborted) {
            throw (
              attemptController.signal.reason ??
              new Error("The knowledge assignment was cancelled.")
            );
          }
          if (controller.signal.aborted) {
            throw controller.signal.reason ?? new Error("The knowledge run was cancelled.");
          }
          usage.inputTokens += providerResult.usage?.inputTokens ?? 0;
          usage.outputTokens += providerResult.usage?.outputTokens ?? 0;
          if (
            options.usageBudgetTokens !== undefined &&
            usage.inputTokens + usage.outputTokens > options.usageBudgetTokens
          ) {
            throw new Error("The knowledge run reached its configured token budget.");
          }
          let response: ReturnType<typeof parseKnowledgeModelResponse>;
          try {
            response = parseKnowledgeModelResponse(
              providerResult.response,
              running.contract.output,
            );
          } catch (error) {
            if (running.contract.purpose !== "root") throw error;
            noteObservation(
              assignmentId,
              `The proposed final response did not match Orion's knowledge contract: ${errorMessage(error)}`,
            );
            if (phase === "finalizing" && running.attempts >= 2) {
              throw error;
            }
            runtime.waitAssignment(assignmentId);
            enqueue(assignmentId);
            emit();
            return;
          }
          if (response.kind === "complete") {
            let completion = response.payload;
            if (running.contract.purpose === "root") {
              if (requiresCompleteNoteRoutingCoverage) {
                validateCompleteNoteRoutingCoverage(
                  options.runContext,
                  registry.values(),
                );
              }
            }
            if (running.contract.purpose === "root" && options.validateRootResult) {
              try {
                completion = options.validateRootResult(
                  completion as KnowledgeRunResult,
                  runtime.history(),
                );
              } catch (error) {
                noteObservation(
                  assignmentId,
                  `The proposed final result was not complete: ${errorMessage(error)}`,
                );
                if (phase === "finalizing" && running.attempts >= 2) {
                  throw error;
                }
                runtime.waitAssignment(assignmentId);
                enqueue(assignmentId);
                emit();
                return;
              }
            } else if (running.contract.output.kind === "note-routing") {
              validateNoteRoutingCompletion(
                running.contract,
                completion as KnowledgeNoteRoutingResult,
                options.runContext,
              );
            } else if (running.contract.purpose !== "root") {
              validateArtifactCompletion(
                running.contract,
                completion as KnowledgeArtifactPayload,
                options.runContext,
                registry,
              );
            }
            runtime.completeAssignment(assignmentId, completion);
            const completed = runtime.projection().assignments.get(assignmentId);
            if (completed?.artifactId) {
              const artifact = runtime
                .projection()
                .artifacts.get(completed.artifactId);
              if (artifact && !registry.has(artifact.artifactId)) {
                registry.record(artifact);
              }
            }
            resumeParentWhenReady(assignmentId);
            emit();
            return;
          }
          if (phase === "finalizing") {
            noteObservation(
              assignmentId,
              "The import is in its finalization reserve; return a complete result from available summaries without creating more assignments.",
            );
            if (running.contract.purpose !== "root" || running.attempts >= 2) {
              throw new Error(
                "The model attempted to create more work during finalization.",
              );
            }
            runtime.waitAssignment(assignmentId);
            enqueue(assignmentId);
            emit();
            return;
          }
          const historyLength = runtime.history().length;
          const created = runtime.acceptCoordination(
            assignmentId,
            response.calls,
            {
              ...(options.holdFanOutAbove === undefined
                ? {}
                : {
                    hold: (call: CoordinationCall) =>
                      call.primitive === "fan_out" &&
                      call.assignments.length > options.holdFanOutAbove!
                        ? `This fan-out requests ${call.assignments.length} assignments and needs explicit acceptance.`
                        : undefined,
                  }),
              referenceAllowed: (assignment) =>
                referenceAllowedInRun(
                  options.runContext,
                  registry,
                  assignment,
                ),
            },
          );
          const projectionAfterCoordination = runtime.projection();
          const coordinationEvents = runtime.history().slice(historyLength);
          const acceptedCallIds = new Set(
            coordinationEvents.flatMap((event) =>
              event.type === "coordination-accepted" ? [event.call.callId] : [],
            ),
          );
          for (const call of response.calls) {
            if (
              call.primitive !== "re_evaluate" ||
              !acceptedCallIds.has(call.callId)
            ) {
              continue;
            }
            const inherited = call.observationIds.flatMap((observationId) => {
              const observation =
                projectionAfterCoordination.observations.get(observationId);
              return observation
                ? [{ observationId, message: observation.message }]
                : [];
            });
            observations.set(call.assignment.assignmentId, inherited);
          }
          for (const event of coordinationEvents) {
            if (
              event.type === "coordination-rejected" ||
              event.type === "coordination-held"
            ) {
              noteObservation(
                assignmentId,
                event.type === "coordination-rejected"
                  ? `Coordination call ${event.callId} was rejected: ${event.reason}`
                  : `Coordination call ${event.call.callId} was held: ${event.reason}`,
              );
            }
          }
          runtime.waitAssignment(assignmentId);
          if (created.length === 0) {
            const held = runtime.projection().heldCalls.size > 0;
            noteObservation(
              assignmentId,
              held
                ? "A requested coordination call is held for explicit acceptance."
                : "No new assignment was accepted; inspect rejected or duplicate calls and choose another explicit response.",
            );
            if (!held) enqueue(assignmentId);
          } else {
            created.forEach(enqueue);
          }
          emit();
          return;
        } catch (error) {
          if (
            error instanceof KnowledgeFinalizationCutoffError &&
            phase === "finalizing"
          ) {
            if (
              assignmentId === options.rootAssignment.assignmentId &&
              finalizationRootDeferred
            ) {
              finalizationRootDeferred = false;
              enqueue(options.rootAssignment.assignmentId);
            }
            return;
          }
          if (
            error instanceof KnowledgeProviderTimeoutError &&
            running.contract.purpose === "root"
          ) {
            if (phase === "exploring") {
              noteObservation(
                assignmentId,
                "The earlier root attempt timed out. Use the imported material and every completed summary to return a grounded final result now without creating more assignments.",
              );
              beginFinalization();
              if (finalizationRootDeferred) {
                finalizationRootDeferred = false;
                enqueue(options.rootAssignment.assignmentId);
              }
              return;
            }
            abortRunImmediately(new KnowledgeDeadlineExceededError());
            return;
          }
          const providerError =
            error instanceof KnowledgeProviderExecutionError ? error : undefined;
          const nextAttemptBudgetMs = Math.min(
            maxCallTimeMs,
            assignmentCallTimeCap(running.contract),
          );
          if (
            providerError?.retryable &&
            driverAttempt < retryLimit &&
            !controller.signal.aborted &&
            phase === "exploring" &&
            Date.now() + providerError.retryAfterMs + nextAttemptBudgetMs <=
              explorationDeadline
          ) {
            runtime.observe(
              `observation:${assignmentId}:retry:${driverAttempt + 1}`,
              providerError.message,
              assignmentId,
            );
            emit();
            if (providerError.retryAfterMs > 0) {
              await abortableDelay(providerError.retryAfterMs, controller.signal);
            }
            driverAttempt += 1;
            continue;
          }
          throw error;
        }
      }
    };

    const settleIfIdle = () => {
      if (settled || active > 0 || ready.length > 0) return;
      const projection = runtime.projection();
      if (projection.status === "completed" && projection.result) {
        finish({
          ok: true,
          value: {
            result: projection.result,
            history: runtime.history(),
            artifacts: registry.values(),
            usage,
          },
        });
        return;
      }
      if (controller.signal.aborted) {
        runtime.cancelRun();
        emit();
        finish({
          ok: false,
          error:
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new Error("The knowledge run was cancelled."),
        });
        return;
      }
      if (projection.heldCalls.size > 0) {
        finish({
          ok: false,
          error: new Error(
            "The knowledge run is waiting for explicit acceptance of a held coordination call.",
          ),
        });
        return;
      }
      finish({
        ok: false,
        error: new Error(
          projection.error ||
            "The knowledge run stopped without a validated final result.",
        ),
      });
    };

    const pump = () => {
      if (settled) return;
      if (controller.signal.aborted && active === 0) {
        settleIfIdle();
        return;
      }
      while (
        !controller.signal.aborted &&
        active < physicalConcurrency &&
        ready.length > 0
      ) {
        const assignmentId = ready.shift()!;
        queued.delete(assignmentId);
        active += 1;
        void execute(assignmentId)
          .catch((error) => {
            if (!controller.signal.aborted) failOrResumeParent(assignmentId, error);
          })
          .finally(() => {
            active -= 1;
            pump();
            settleIfIdle();
          });
      }
      settleIfIdle();
    };

    cutoffId = globalThis.setTimeout(() => {
      beginFinalization();
      pump();
    }, Math.max(0, explorationDeadline - Date.now())) as unknown as number;
    timeoutId = globalThis.setTimeout(() => {
      abortRunImmediately(new KnowledgeDeadlineExceededError());
    }, Math.max(0, hardDeadline - Date.now())) as unknown as number;
    pump();
  });
}

function assignmentsForCoverageCheck(
  call: CoordinationCall,
): readonly KnowledgeAssignmentContract[] {
  if (call.primitive === "fan_out" || call.primitive === "re_expand") {
    return call.assignments;
  }
  return [call.assignment];
}

function assignmentDepth(
  assignment: KnowledgeAssignmentContract,
  assignments: Map<KnowledgeAssignmentId, { contract: KnowledgeAssignmentContract }>,
): number {
  let depth = 0;
  let parent = assignment.parent;
  const seen = new Set<string>();
  while (parent.kind === "assignment") {
    if (seen.has(parent.assignmentId)) return Number.POSITIVE_INFINITY;
    seen.add(parent.assignmentId);
    depth += 1;
    const next = assignments.get(parent.assignmentId);
    if (!next) break;
    parent = next.contract.parent;
  }
  return depth;
}

function assignmentCallTimeCap(
  assignment: KnowledgeAssignmentContract,
): number {
  if (
    assignment.output.kind === "reconciliation" ||
    assignment.output.kind === "compression"
  ) {
    return KNOWLEDGE_INTERMEDIATE_CALL_MS;
  }
  return KNOWLEDGE_MAX_CALL_MS;
}

function assignmentReasoningEffort(
  selected: ReasoningEffort,
  assignment: KnowledgeAssignmentContract,
): ReasoningEffort {
  if (
    assignment.output.kind !== "note-routing" &&
    assignment.output.kind !== "evidence" &&
    assignment.output.kind !== "validation"
  ) {
    return selected;
  }
  if (selected === "none" || selected === "low" || selected === "medium") {
    return selected;
  }
  // Parallel readers extract and classify bounded evidence. Medium reasoning
  // preserves that judgment while preventing high/max hidden reasoning from
  // consuming their compact structured-output budget and latency window.
  return "medium";
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The knowledge assignment failed.";
}

export function validateArtifactCompletion(
  assignment: KnowledgeAssignmentContract,
  payload: KnowledgeArtifactPayload,
  context: KnowledgeRunContext,
  registry: KnowledgeArtifactRegistry,
): void {
  // Validate the assignment as a complete capability set. In particular, an
  // exact note reference is authorized by the router artifact declared beside
  // it; validating the note in isolation would incorrectly discard that
  // causal authorization.
  const assignmentReferenceError = referenceAllowedInRun(
    context,
    registry,
    assignment,
  );
  if (assignmentReferenceError) throw new Error(assignmentReferenceError);
  const allowedReferences = new Set(
    assignment.references.map(referenceIdentity),
  );
  const references = [
    ...payload.references,
    ...payload.claims.flatMap((claim) => claim.references),
  ];
  for (const reference of references) {
    if (!allowedReferences.has(referenceIdentity(reference))) {
      throw new Error(
        "A knowledge artifact cited material outside its assignment context.",
      );
    }
    // Resolution checks Space/run membership and immutable versions again at
    // the moment the artifact enters causal history.
    if (reference.kind === "artifact") {
      if (!registry.has(reference.artifactId)) {
        throw new Error(`A knowledge artifact cited an unavailable artifact: ${reference.artifactId}`);
      }
    } else {
      // Assignment-level authorization above retains any companion routing
      // artifact while resolution here rechecks the individual immutable
      // source/note/concept handle at artifact-record time.
      resolveKnowledgeReference(context, reference, registry);
    }
  }
  const mandatorySourceRanges = assignment.references.filter(
    (
      reference,
    ): reference is Extract<
      KnowledgeAssignmentContract["references"][number],
      { kind: "source-range" }
    > =>
      reference.kind === "source-range" &&
      assignment.constraints.mustPreserve.includes(
        `Mandatory source range ${reference.sourceId}/${reference.rangeId}`,
      ),
  );
  for (const reference of mandatorySourceRanges) {
    if (!references.some((candidate) => referenceIdentity(candidate) === referenceIdentity(reference))) {
      throw new Error(
        `A mandatory coverage artifact did not cite its source range: ${reference.sourceId}/${reference.rangeId}`,
      );
    }
  }
  const digestRanges = assignment.references.filter(
    (
      reference,
    ): reference is Extract<
      KnowledgeAssignmentContract["references"][number],
      { kind: "note-digest-range" }
    > => reference.kind === "note-digest-range",
  );
  for (const reference of digestRanges) {
    if (
      !references.some(
        (candidate) =>
          referenceIdentity(candidate) === referenceIdentity(reference),
      )
    ) {
      throw new Error(
        `A Space-context artifact did not cite its digest range: ${reference.rangeId}`,
      );
    }
    const expected = new Set(
      context.materials.noteDigestRanges
        .get(reference.rangeId)
        ?.map(({ noteId }) => noteId) ?? [],
    );
    const reviewedIds = payload.assessment.reviewedNoteIds;
    const reviewed = new Set(reviewedIds);
    if (
      expected.size === 0 ||
      reviewed.size !== reviewedIds.length ||
      reviewed.size !== expected.size ||
      [...expected].some((noteId) => !reviewed.has(noteId))
    ) {
      throw new Error(
        `A Space-context artifact did not review every note in ${reference.rangeId}.`,
      );
    }
  }
  for (const noteId of payload.assessment.reviewedNoteIds) {
    if (!context.materials.notes.has(noteId)) {
      throw new Error("A knowledge assessment reviewed a note outside this Space.");
    }
  }
  const retained = new Set(payload.mustPreserve);
  for (const value of assignment.constraints.mustPreserve) {
    if (!retained.has(value)) {
      throw new Error(`A knowledge artifact dropped required material: ${value}`);
    }
  }
  if (assignment.output.kind === "validation") {
    const checkedArtifactIds = payload.validation?.checkedArtifactIds;
    if (
      !checkedArtifactIds ||
      !haveSameUniqueIdentifiers(
        checkedArtifactIds,
        assignment.output.proposalArtifactIds,
      )
    ) {
      throw new Error(
        "A validator must report exactly the proposal artifacts in its output contract.",
      );
    }
  }
  if (assignment.authority.kind === "destination-owner") {
    const destinations = new Set(assignment.authority.destinationNoteIds);
    const versions = new Map(
      assignment.authority.baseVersions.map(({ noteId, version }) => [
        noteId,
        version,
      ]),
    );
    const proposedDestinations = payload.ownerProposals.map(
      ({ destinationNoteId }) => destinationNoteId,
    );
    if (
      proposedDestinations.length !== destinations.size ||
      [...destinations].some(
        (noteId) =>
          proposedDestinations.filter((candidate) => candidate === noteId)
            .length !== 1,
      )
    ) {
      throw new Error(
        "A knowledge owner must return exactly one proposal for every owned destination.",
      );
    }
    for (const proposal of payload.ownerProposals) {
      if (
        !destinations.has(proposal.destinationNoteId) ||
        versions.get(proposal.destinationNoteId) !== proposal.baseVersion
      ) {
        throw new Error("A knowledge owner proposal exceeded its exact authority.");
      }
      for (const sourceId of proposal.sourceIds) {
        if (
          !referencesReachSource(
            assignment.references,
            sourceId,
            registry,
            new Set(),
          )
        ) {
          throw new Error(
            "A knowledge owner proposal cited a source outside its declared evidence.",
          );
        }
      }
    }
  }
}

export function validateNoteRoutingCompletion(
  assignment: KnowledgeAssignmentContract,
  result: KnowledgeNoteRoutingResult,
  context: KnowledgeRunContext,
): void {
  if (assignment.purpose !== "router" || assignment.output.kind !== "note-routing") {
    throw new Error("Typed note routing requires a host-created router assignment.");
  }
  const digestReferences = assignment.references.filter(
    (reference): reference is Extract<KnowledgeReference, { kind: "note-digest-range" }> =>
      reference.kind === "note-digest-range",
  );
  if (
    assignment.references.length !== 1 ||
    digestReferences.length !== 1 ||
    digestReferences[0].rangeId !== assignment.output.rangeId ||
    result.rangeId !== assignment.output.rangeId
  ) {
    throw new Error("A note router must reference exactly its contracted digest range.");
  }
  const digests = context.materials.noteDigestRanges.get(result.rangeId);
  if (!digests) {
    throw new Error(`Unknown note-routing range in this Space: ${result.rangeId}`);
  }
  const expectedFromContext = new Map(
    digests.map(({ noteId, version }) => [noteId, version] as const),
  );
  const expectedFromContract = new Map(
    assignment.output.expectedNotes.map(({ noteId, noteVersion }) => [
      noteId,
      noteVersion,
    ] as const),
  );
  if (
    expectedFromContract.size !== assignment.output.expectedNotes.length ||
    expectedFromContract.size !== expectedFromContext.size ||
    [...expectedFromContext].some(
      ([noteId, version]) => expectedFromContract.get(noteId) !== version,
    )
  ) {
    throw new Error("The note-routing contract does not match the frozen digest range.");
  }
  const routedIds = result.routes.map(({ noteId }) => noteId);
  if (
    routedIds.length !== expectedFromContext.size ||
    new Set(routedIds).size !== routedIds.length
  ) {
    throw new Error("Note routing must classify every contracted note exactly once.");
  }
  for (const route of result.routes) {
    if (expectedFromContext.get(route.noteId) !== route.noteVersion) {
      throw new Error(`Note routing used a stale or substituted note: ${route.noteId}`);
    }
    const current = context.materials.notes.get(route.noteId);
    if (!current || noteVersion(current) !== route.noteVersion) {
      throw new Error(`Note routing reviewed a note outside this Space: ${route.noteId}`);
    }
    if (new Set(route.candidateNoteIds).size !== route.candidateNoteIds.length) {
      throw new Error(`Note routing repeated a candidate for ${route.noteId}.`);
    }
    if (route.candidateNoteIds.includes(route.noteId)) {
      throw new Error(`Note routing selected ${route.noteId} as its own candidate.`);
    }
    if (route.relation === "unrelated" && route.candidateNoteIds.length > 0) {
      throw new Error(`An unrelated route named candidates for ${route.noteId}.`);
    }
    for (const candidateNoteId of route.candidateNoteIds) {
      if (!context.materials.notes.has(candidateNoteId)) {
        throw new Error(
          `Note routing named a candidate outside this Space: ${candidateNoteId}`,
        );
      }
    }
  }
}

function haveSameUniqueIdentifiers(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === left.length &&
    rightSet.size === right.length &&
    leftSet.size === rightSet.size &&
    [...leftSet].every((identifier) => rightSet.has(identifier))
  );
}

function referencesReachSource(
  references: readonly KnowledgeReference[],
  sourceId: string,
  registry: KnowledgeArtifactRegistry,
  visitedArtifactIds: Set<string>,
): boolean {
  for (const reference of references) {
    if (
      (reference.kind === "source" || reference.kind === "source-range") &&
      reference.sourceId === sourceId
    ) {
      return true;
    }
    if (
      reference.kind !== "artifact" ||
      visitedArtifactIds.has(reference.artifactId)
    ) {
      continue;
    }
    visitedArtifactIds.add(reference.artifactId);
    const artifact = registry.get(reference.artifactId);
    if (
      artifact &&
      referencesReachSource(
        [
          ...artifact.references,
          ...artifact.claims.flatMap((claim) => claim.references),
        ],
        sourceId,
        registry,
        visitedArtifactIds,
      )
    ) {
      return true;
    }
  }
  return false;
}

function referenceIdentity(
  reference: KnowledgeAssignmentContract["references"][number],
): string {
  if (reference.kind === "source") return `source:${reference.sourceId}`;
  if (reference.kind === "source-range") {
    return `source-range:${reference.sourceId}:${reference.rangeId}`;
  }
  if (reference.kind === "note-digest-range") {
    return `note-digest-range:${reference.rangeId}`;
  }
  if (reference.kind === "note") {
    return `note:${reference.noteId}:${reference.version}`;
  }
  if (reference.kind === "concept") return `concept:${reference.conceptId}`;
  return `artifact:${reference.artifactId}`;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
