import { describe, expect, it, vi } from "vitest";
import { MAX_PROVIDER_CALLS, ProviderCallScheduler } from "./providerScheduler";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("shared physical provider scheduler", () => {
  it("caps mixed runs and foreground/background workloads at six actual transports", async () => {
    const scheduler = new ProviderCallScheduler();
    const gates = Array.from({ length: 20 }, () => deferred());
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const jobs = gates.map((gate, index) => scheduler.run(async () => {
      started.push(index);
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      active -= 1;
    }, { queueKey: ["import-a", "import-b", "overview", "chat"][index % 4] }));
    expect(started).toHaveLength(MAX_PROVIDER_CALLS);
    gates.forEach((gate) => gate.resolve());
    await Promise.all(jobs);
    expect(peak).toBe(MAX_PROVIDER_CALLS);
    expect(started).toHaveLength(20);
  });

  it("serves queued workloads round-robin while keeping each workload FIFO", async () => {
    const scheduler = new ProviderCallScheduler(1);
    const hold = deferred();
    const blocker = scheduler.run(() => hold.promise);
    const order: string[] = [];
    const jobs = ["book-1", "book-2", "book-3", "chat-1", "chat-2"].map((id) =>
      scheduler.run(async () => { order.push(id); }, { queueKey: id.split("-")[0] }),
    );
    hold.resolve();
    await Promise.all([blocker, ...jobs]);
    expect(order).toEqual(["book-1", "chat-1", "book-2", "chat-2", "book-3"]);
  });

  it("removes queued cancellation without dispatching either work or native cancellation", async () => {
    const scheduler = new ProviderCallScheduler(1);
    const hold = deferred();
    const blocker = scheduler.run(() => hold.promise);
    const controller = new AbortController();
    const task = vi.fn(async () => undefined);
    const cancelActive = vi.fn();
    const cancelled = scheduler.run(task, { signal: controller.signal, cancelActive });
    controller.abort(new Error("Space changed"));
    await expect(cancelled).rejects.toThrow("Space changed");
    hold.resolve();
    await blocker;
    expect(task).not.toHaveBeenCalled();
    expect(cancelActive).not.toHaveBeenCalled();
    await expect(scheduler.run(async () => "next")).resolves.toBe("next");
  });

  it("rejects active cancellation promptly but holds the slot through a late transport rejection", async () => {
    const scheduler = new ProviderCallScheduler(1);
    const native = deferred();
    const controller = new AbortController();
    const cancelActive = vi.fn();
    const cancelled = scheduler.run(() => native.promise, { signal: controller.signal, cancelActive });
    const next = vi.fn(async () => "next");
    const queued = scheduler.run(next);
    controller.abort(new Error("timed out while waiting"));
    await expect(cancelled).rejects.toThrow("timed out while waiting");
    expect(cancelActive).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    native.reject(new Error("native cancellation acknowledged later"));
    await expect(queued).resolves.toBe("next");
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not retry or expand concurrency on provider failures", async () => {
    const scheduler = new ProviderCallScheduler(1);
    for (const message of ["unauthorized", "billing", "429", "timeout"]) {
      const task = vi.fn(async () => { throw new Error(message); });
      await expect(scheduler.run(task)).rejects.toThrow(message);
      expect(task).toHaveBeenCalledTimes(1);
    }
    await expect(scheduler.run(async () => "healthy")).resolves.toBe("healthy");
  });

  it("does not start already aborted work and recovers a synchronous transport failure", async () => {
    const scheduler = new ProviderCallScheduler(1);
    const controller = new AbortController();
    controller.abort();
    const task = vi.fn(async () => undefined);
    await expect(scheduler.run(task, { signal: controller.signal })).rejects.toBeDefined();
    expect(task).not.toHaveBeenCalled();
    await expect(scheduler.run(() => { throw new Error("bridge failed"); })).rejects.toThrow("bridge failed");
    await expect(scheduler.run(async () => 42)).resolves.toBe(42);
  });
});
