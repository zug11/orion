export const MAX_PROVIDER_CALLS = 6;

export interface ProviderCallOptions {
  /** A run or workload, not source text. FIFO inside each queue, fair between queues. */
  queueKey?: string;
  signal?: AbortSignal;
  /** Start transport deadlines here, so time spent queued is not a provider timeout. */
  onStart?: () => void;
  /** Interrupt an already dispatched transport, if that transport supports it. */
  cancelActive?: () => void;
}

interface QueuedCall {
  queueKey: string;
  started: boolean;
  cancelled: boolean;
  start: () => void;
}

/**
 * One physical budget shared by foreground and background AI work. The task
 * must represent the actual transport lifetime, including response-body reads;
 * never pass a Promise.race that merely stops a caller waiting. Cancelling an
 * active caller rejects promptly but keeps its slot until the transport ends.
 * Local extraction, cache writes, and prompt assembly do not enter this pool.
 */
export class ProviderCallScheduler {
  private active = 0;
  private readonly queues = new Map<string, QueuedCall[]>();
  private readonly turnOrder: string[] = [];

  constructor(private readonly capacity = MAX_PROVIDER_CALLS) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_PROVIDER_CALLS) {
      throw new Error(`Provider concurrency must be between 1 and ${MAX_PROVIDER_CALLS}.`);
    }
  }

  run<T>(task: () => Promise<T>, options: ProviderCallOptions = {}): Promise<T> {
    if (options.signal?.aborted) {
      return Promise.reject(cancellationReason(options.signal));
    }
    return new Promise<T>((resolve, reject) => {
      let callerSettled = false;
      const settle = (error: unknown, value?: T) => {
        if (callerSettled) return;
        callerSettled = true;
        options.signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(value as T);
      };
      const entry: QueuedCall = {
        queueKey: options.queueKey ?? "default",
        started: false,
        cancelled: false,
        start: () => {
          entry.started = true;
          this.active += 1;
          let transport: Promise<T>;
          try {
            options.onStart?.();
            if (options.signal?.aborted) throw cancellationReason(options.signal);
            transport = task();
          } catch (error) {
            transport = Promise.reject(error);
          }
          // Observe both outcomes even after cancellation. In particular, a
          // late rejection must neither leak a slot nor become unhandled.
          void Promise.resolve(transport).then(
            (value) => {
              settle(undefined, value);
              this.release();
            },
            (error) => {
              // A rejected promise may have no reason; it is still a failure.
              settle(error ?? new Error("The provider request failed."));
              this.release();
            },
          );
        },
      };
      const abort = () => {
        entry.cancelled = true;
        if (!entry.started) this.remove(entry);
        settle(cancellationReason(options.signal));
        if (entry.started) {
          try {
            options.cancelActive?.();
          } catch {
            // Failure to interrupt a transport never releases its slot early.
          }
        }
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const queue = this.queues.get(entry.queueKey);
      if (queue) queue.push(entry);
      else {
        this.queues.set(entry.queueKey, [entry]);
        this.turnOrder.push(entry.queueKey);
      }
      this.drain();
    });
  }

  private remove(entry: QueuedCall): void {
    const queue = this.queues.get(entry.queueKey);
    if (!queue) return;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) {
      this.queues.delete(entry.queueKey);
      const turn = this.turnOrder.indexOf(entry.queueKey);
      if (turn >= 0) this.turnOrder.splice(turn, 1);
    }
  }

  private release(): void {
    this.active -= 1;
    this.drain();
  }

  private drain(): void {
    while (this.active < this.capacity && this.turnOrder.length > 0) {
      const queueKey = this.turnOrder.shift()!;
      const queue = this.queues.get(queueKey)!;
      const entry = queue.shift()!;
      if (queue.length > 0) this.turnOrder.push(queueKey);
      else this.queues.delete(queueKey);
      if (!entry.cancelled) entry.start();
    }
  }
}

function cancellationReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new Error("The provider request was cancelled.");
}

/** Orion has one renderer window; all of its AI transports share this instance. */
export const providerCallScheduler = new ProviderCallScheduler();
