import { autoResumeBackoffMs, shouldAutoResume } from "../providerHealth";
import {
  createKnowledgeImportRunError,
  KnowledgeImportRunError,
  landFailedKnowledgeImport,
  runKnowledgeImportBatch,
  type KnowledgeImportBatchOptions,
  type KnowledgeImportBatchResult,
} from "./import";

export interface AutomaticImportRecovery {
  kind: "planned-reading" | "resume";
  attempt: number;
  completedReadings: number;
  completedWrites: number;
}

export interface AutomaticKnowledgeImportOptions extends KnowledgeImportBatchOptions {
  /** Recheck the live Space before dispatch, after backoff, and before accepting. */
  isCurrent?: () => boolean;
  onRecovery?: (recovery: AutomaticImportRecovery) => void;
}

// Request/account errors cannot be repaired by repeating the same request or
// subdividing the source. In particular, insufficient quota is not a 429 burst.
export function requiresProviderAction(detail: string): boolean {
  return /api key|authenticat|unauthori[sz]ed|forbidden|credential|billing|quota|payment|credits|invalid.*(?:schema|request)|schema.*(?:unsupported|invalid)|response_format|model.*(?:not found|does not exist|access|unsupported)|HTTP (?:400|401|403|404|422)\b/i.test(detail);
}

function canRecoverDirect(error: KnowledgeImportRunError): boolean {
  return error.diagnostic.stage === "direct" &&
    ["import-time-limit", "provider-timeout", "provider-response", "validation", "coverage"]
      .includes(error.diagnostic.code);
}

/**
 * A single recovery owner for each batch. A failed direct synthesis may enter
 * the compact staged pipeline once, using the same provider and source. Fixed
 * stages resume only their validated unfinished work, at most twice. Exhaustion
 * returns explicitly labelled local results, never a Retry/Resume obligation.
 */
export async function runAutomaticKnowledgeImport(
  options: AutomaticKnowledgeImportOptions,
): Promise<KnowledgeImportBatchResult> {
  let checkpoint = options.resume;
  let plannedRecovery = options.recoverDirectWithPlan === true;
  let resumeAttempts = 0;
  const assertCurrent = () => {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("The import was cancelled.");
    if (options.isCurrent && !options.isCurrent()) {
      throw new Error("The Space context changed while Orion was importing.");
    }
  };

  for (;;) {
    assertCurrent();
    try {
      const result = await runKnowledgeImportBatch({
        ...options,
        resume: checkpoint,
        recoverDirectWithPlan: plannedRecovery,
        landOnFailure: false,
      });
      assertCurrent();
      return result;
    } catch (error) {
      assertCurrent();
      const failure = error instanceof KnowledgeImportRunError
        ? error
        : createKnowledgeImportRunError(error, checkpoint?.runId ?? "import-recovery", options.model);
      if (failure.diagnostic.code === "cancelled" || failure.diagnostic.code === "space-changed") throw failure;

      const providerAction = requiresProviderAction(failure.diagnostic.technicalDetail);
      const usePlan = !providerAction && !plannedRecovery && !checkpoint && canRecoverDirect(failure);
      const resume = !providerAction && failure.diagnostic.resumable && failure.checkpoint &&
        shouldAutoResume(failure.diagnostic.code, resumeAttempts);
      if (!usePlan && !resume) {
        const landed = landFailedKnowledgeImport(failure, options.sources, options.snapshot);
        if (!landed) throw failure;
        return landed;
      }

      options.onRecovery?.({
        kind: usePlan ? "planned-reading" : "resume",
        attempt: usePlan ? 1 : resumeAttempts + 1,
        completedReadings: failure.diagnostic.completedReadings,
        completedWrites: failure.diagnostic.completedWrites,
      });
      await waitForImportRecovery(autoResumeBackoffMs(usePlan ? 0 : resumeAttempts), options.signal);
      assertCurrent();
      if (usePlan) plannedRecovery = true;
      else {
        checkpoint = failure.checkpoint;
        resumeAttempts += 1;
      }
    }
  }
}

export function waitForImportRecovery(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("The import was cancelled."));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("The import was cancelled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
