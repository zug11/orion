/**
 * Presentation-only wave runner. Import keeps its own 6-wide pump.
 *
 * A stage is one kind. Jobs are issued in cohorts of at most six. The next
 * cohort starts only after the live wave has settled. Repair work is appended
 * after remaining jobs so it cannot splice into a live wave or preempt the
 * original plan.
 */

export const PRESENTATION_PHYSICAL_WIDTH = 6;

export type PresentationWaveJobKind = "copy" | "image" | "speech";

export interface PresentationWaveJob {
  id: string;
  kind: string;
}

export type PresentationWaveEvent<J extends PresentationWaveJob> =
  | { type: "wave-started"; waveIndex: number; kind: string; jobIds: string[] }
  | { type: "job-started"; waveIndex: number; job: J }
  | {
      type: "job-settled";
      waveIndex: number;
      job: J;
      status: "completed" | "failed" | "cancelled";
    }
  | { type: "wave-settled"; waveIndex: number; kind: string; jobIds: string[] }
  | { type: "stage-completed"; kind: string };

export class PresentationWaveCancelledError extends Error {
  constructor(message = "The presentation wave was cancelled.") {
    super(message);
    this.name = "PresentationWaveCancelledError";
  }
}

export class PresentationWaveKindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresentationWaveKindError";
  }
}

export class PresentationWaveStageError extends Error {
  readonly failures: ReadonlyArray<{ jobId: string; error: unknown }>;

  constructor(
    message: string,
    failures: ReadonlyArray<{ jobId: string; error: unknown }>,
  ) {
    super(message);
    this.name = "PresentationWaveStageError";
    this.failures = failures;
  }
}

export interface PresentationWaveJobSuccess<
  J extends PresentationWaveJob,
  R,
> {
  job: J;
  result: R;
}

export interface RunPresentationWavesOptions<
  J extends PresentationWaveJob,
  R,
> {
  jobs: readonly J[];
  execute: (job: J, signal: AbortSignal) => Promise<R>;
  physicalWidth?: number;
  signal?: AbortSignal;
  /**
   * Called after a failed job in a settled wave. Returned jobs are queued
   * after any remaining original work, never into the live cohort.
   */
  repair?: (job: J, error: unknown) => readonly J[] | undefined;
  onEvent?: (event: PresentationWaveEvent<J>) => void;
}

export interface PresentationWaveStageResult<
  J extends PresentationWaveJob,
  R,
> {
  kind: string;
  results: PresentationWaveJobSuccess<J, R>[];
  failures: Array<{ job: J; error: unknown }>;
  waveCount: number;
  maxPhysicalWidth: number;
  jobOrder: string[];
  waves: string[][];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof PresentationWaveCancelledError) throw reason;
  throw new PresentationWaveCancelledError(
    reason instanceof Error ? reason.message : undefined,
  );
}

function sameKind<J extends PresentationWaveJob>(jobs: readonly J[]): string {
  const kind = jobs[0]?.kind;
  if (!kind) {
    throw new PresentationWaveKindError(
      "A presentation wave stage needs at least one job.",
    );
  }
  const mixed = jobs.find((job) => job.kind !== kind);
  if (mixed) {
    throw new PresentationWaveKindError(
      `A presentation wave cannot mix ${kind} jobs with ${mixed.kind} jobs.`,
    );
  }
  return kind;
}

async function settleJob<J extends PresentationWaveJob, R>(
  job: J,
  execute: (job: J, signal: AbortSignal) => Promise<R>,
  parent: AbortSignal | undefined,
): Promise<
  | { status: "completed"; result: R }
  | { status: "failed"; error: unknown }
  | { status: "cancelled"; error: unknown }
> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) {
    controller.abort(parent.reason);
  }
  try {
    const result = await execute(job, controller.signal);
    throwIfAborted(parent);
    throwIfAborted(controller.signal);
    return { status: "completed", result };
  } catch (error) {
    if (
      parent?.aborted ||
      controller.signal.aborted ||
      error instanceof PresentationWaveCancelledError
    ) {
      return { status: "cancelled", error };
    }
    return { status: "failed", error };
  } finally {
    parent?.removeEventListener("abort", onAbort);
  }
}

/**
 * Run one homogeneous presentation stage as sequential waves of at most six.
 */
export async function runPresentationWaves<
  J extends PresentationWaveJob,
  R,
>(
  options: RunPresentationWavesOptions<J, R>,
): Promise<PresentationWaveStageResult<J, R>> {
  throwIfAborted(options.signal);
  if (options.jobs.length === 0) {
    return {
      kind: "",
      results: [],
      failures: [],
      waveCount: 0,
      maxPhysicalWidth: 0,
      jobOrder: [],
      waves: [],
    };
  }

  const physicalWidth = Math.max(
    1,
    Math.min(
      PRESENTATION_PHYSICAL_WIDTH,
      Math.floor(options.physicalWidth ?? PRESENTATION_PHYSICAL_WIDTH),
    ),
  );
  const kind = sameKind(options.jobs);
  const queue: J[] = [...options.jobs];
  const results: PresentationWaveJobSuccess<J, R>[] = [];
  const failures: Array<{ job: J; error: unknown }> = [];
  const waves: string[][] = [];
  const jobOrder: string[] = [];
  let maxPhysicalWidth = 0;
  let waveIndex = 0;

  while (queue.length > 0) {
    throwIfAborted(options.signal);
    const wave = queue.splice(0, physicalWidth);
    const jobIds = wave.map((job) => job.id);
    waves.push(jobIds);
    maxPhysicalWidth = Math.max(maxPhysicalWidth, wave.length);
    options.onEvent?.({
      type: "wave-started",
      waveIndex,
      kind,
      jobIds,
    });

    const pendingRepairs: J[] = [];
    const settled = await Promise.all(
      wave.map(async (job) => {
        options.onEvent?.({ type: "job-started", waveIndex, job });
        const outcome = await settleJob(job, options.execute, options.signal);
        options.onEvent?.({
          type: "job-settled",
          waveIndex,
          job,
          status: outcome.status,
        });
        return { job, outcome };
      }),
    );

    throwIfAborted(options.signal);

    for (const { job, outcome } of settled) {
      jobOrder.push(job.id);
      if (outcome.status === "completed") {
        results.push({ job, result: outcome.result });
        continue;
      }
      if (outcome.status === "cancelled") {
        throw new PresentationWaveCancelledError(
          outcome.error instanceof Error
            ? outcome.error.message
            : undefined,
        );
      }
      failures.push({ job, error: outcome.error });
      const repairs = options.repair?.(job, outcome.error) ?? [];
      for (const child of repairs) {
        if (child.kind !== kind) {
          throw new PresentationWaveKindError(
            `Repair jobs must stay ${kind}; received ${child.kind}.`,
          );
        }
        pendingRepairs.push(child);
      }
    }

    options.onEvent?.({
      type: "wave-settled",
      waveIndex,
      kind,
      jobIds,
    });
    // Repairs trail remaining original work so they cannot preempt the plan.
    queue.push(...pendingRepairs);
    waveIndex += 1;
  }

  options.onEvent?.({ type: "stage-completed", kind });
  return {
    kind,
    results,
    failures,
    waveCount: waves.length,
    maxPhysicalWidth,
    jobOrder,
    waves,
  };
}

export interface PresentationStage<J extends PresentationWaveJob> {
  jobs: readonly J[];
}

/**
 * Run ordered homogeneous stages. A later stage does not start until every
 * job in the previous stage has settled, including repairs from that stage.
 */
export async function runPresentationStages<
  J extends PresentationWaveJob,
  R,
>(
  stages: readonly PresentationStage<J>[],
  options: Omit<RunPresentationWavesOptions<J, R>, "jobs">,
): Promise<Array<PresentationWaveStageResult<J, R>>> {
  const completed: Array<PresentationWaveStageResult<J, R>> = [];
  for (const stage of stages) {
    throwIfAborted(options.signal);
    if (stage.jobs.length === 0) continue;
    completed.push(
      await runPresentationWaves({
        ...options,
        jobs: stage.jobs,
      }),
    );
  }
  return completed;
}
