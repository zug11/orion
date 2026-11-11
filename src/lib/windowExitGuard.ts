export interface WindowSaveReceipt<T> {
  /** Exact state published after merging this save with any concurrent changes. */
  published: T;
  /** No local changes arrived between capturing and publishing this save. */
  settled: boolean;
}

interface WindowExitGuardOptions<T> {
  read: () => T;
  save: (snapshot: T) => Promise<WindowSaveReceipt<T>>;
  canSave: () => boolean;
  lock: () => void;
  unlock: () => void;
  complete: (attempt: number | null) => Promise<void>;
  cancel: (attempt: number) => Promise<void>;
  onError: (error: unknown, stage: "save" | "complete", attempt: number | null) => void;
}

/**
 * A fresh native quit attempt must flush again even while the editor is locked.
 * Updates use this twice: before installing, and after installation/media drain.
 */
export function createWindowExitGuard<T>(options: WindowExitGuardOptions<T>) {
  let generation = 0;
  let latestQuitAttempt = 0;
  let locked = false;
  let disposed = false;

  async function flushAndComplete(attempt: number | null) {
    const ownGeneration = ++generation;
    const current = () => !disposed && generation === ownGeneration;
    locked = true;
    options.lock();
    let stage: "save" | "complete" = "save";
    try {
      while (current()) {
        if (options.canSave()) {
          const receipt = await options.save(options.read());
          if (!current()) return;
          // A normal save may publish a new revision/object without a new edit.
          // Compare with its publication, not with the pre-save object identity.
          if (!receipt.settled || options.read() !== receipt.published) continue;
        }
        if (!current()) return;
        stage = "complete";
        // No asynchronous gap between the final state check and native ack.
        await options.complete(attempt);
        return;
      }
    } catch (error) {
      if (!current()) return;
      locked = false;
      options.unlock();
      options.onError(error, stage, attempt);
      if (attempt !== null) {
        try { await options.cancel(attempt); } catch { /* Keep the local edits and error visible. */ }
      }
    }
  }

  return {
    close: async () => {
      if (disposed || locked) return;
      await flushAndComplete(null);
    },
    quit: async (attempt: number) => {
      if (disposed || !Number.isSafeInteger(attempt) || attempt <= latestQuitAttempt) return;
      latestQuitAttempt = attempt;
      await flushAndComplete(attempt);
    },
    cancelled: () => {
      generation += 1;
      locked = false;
      options.unlock();
    },
    dispose: () => { disposed = true; generation += 1; },
  };
}
