import { describe, expect, it, vi } from "vitest";
import { createWindowExitGuard, type WindowSaveReceipt } from "./windowExitGuard";

interface Snapshot { text: string; revision: number }

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  let latest: Snapshot = { text: "Original note", revision: 0 };
  let locked = false;
  const disk: Snapshot[] = [];
  const save = vi.fn(async (before: Snapshot): Promise<WindowSaveReceipt<Snapshot>> => {
    const publication = { ...before, revision: before.revision + 1 };
    latest = publication;
    disk.push(publication);
    return { published: publication, settled: true };
  });
  const complete = vi.fn(async (_attempt: number | null) => {});
  const cancel = vi.fn(async (_attempt: number) => {});
  const onError = vi.fn();
  const unlock = vi.fn(() => { locked = false; });
  const read = vi.fn(() => latest);
  const guard = createWindowExitGuard({
    read, save, complete, cancel, onError,
    canSave: () => true,
    lock: () => { locked = true; },
    unlock,
  });
  return { guard, save, disk, complete, cancel, onError, unlock, read, get latest() { return latest; }, set latest(value) { latest = value; }, get locked() { return locked; } };
}

describe("window exit save rounds", () => {
  it("finishes an ordinary save that publishes a new revision without looping on object identity", async () => {
    const f = fixture();
    const original = f.latest;
    await f.guard.quit(1);
    expect(f.latest).not.toBe(original);
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.locked).toBe(true);
  });

  it("flushes async results arriving during installation on a fresh attempt while keeping the window locked", async () => {
    const f = fixture();
    await f.guard.quit(1);
    expect(f.disk[f.disk.length - 1]?.text).toBe("Original note");
    // Simulate an AI/import result while the long native installer runs.
    f.latest = { text: "Original note\nLate research result", revision: 1 };
    expect(f.locked).toBe(true);
    await f.guard.quit(1); // duplicate first-round delivery
    expect(f.save).toHaveBeenCalledOnce();
    await f.guard.quit(2);
    expect(f.disk[f.disk.length - 1]?.text).toContain("Late research result");
    expect(f.complete.mock.calls).toEqual([[1], [2]]);
    expect(f.unlock).not.toHaveBeenCalled();
  });

  it("keeps saving results that arrive during a flush until the published state is settled", async () => {
    const f = fixture();
    const first = deferred<WindowSaveReceipt<Snapshot>>();
    f.save.mockReturnValueOnce(first.promise);
    const finished = f.guard.quit(1);
    expect(f.locked).toBe(true);
    const newResult = { text: "Result arrived during write", revision: 1 };
    f.latest = newResult;
    first.resolve({ published: newResult, settled: false });
    await finished;
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.save).toHaveBeenLastCalledWith(newResult);
    expect(f.disk[f.disk.length - 1]?.text).toBe(newResult.text);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("flushes queued state discovered after a settled publication before sending acknowledgement", async () => {
    const f = fixture();
    const ordinarySave = f.save.getMockImplementation()!;
    f.save.mockImplementationOnce(async (before) => {
      const receipt = await ordinarySave(before);
      const queued = { text: "React-queued import result", revision: 2 };
      // App.read synchronously drains React's pending vault updates.
      f.read.mockImplementationOnce(() => { f.latest = queued; return queued; });
      return receipt;
    });
    await f.guard.quit(1);
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.disk[f.disk.length - 1]?.text).toBe("React-queued import result");
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it("accepts the post-install round even before the initial native acknowledgement promise resolves", async () => {
    const f = fixture();
    const initialAck = deferred<void>();
    f.complete.mockReturnValueOnce(initialAck.promise);
    const first = f.guard.quit(1);
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledWith(1));
    f.latest = { text: "Final result", revision: 1 };
    await f.guard.quit(2);
    initialAck.resolve();
    await first;
    expect(f.complete.mock.calls).toEqual([[1], [2]]);
    expect(f.disk[f.disk.length - 1]?.text).toBe("Final result");
    expect(f.unlock).not.toHaveBeenCalled();
  });

  it("cancels a failed final save, leaves edits available, and allows a later fresh retry", async () => {
    const f = fixture();
    await f.guard.quit(1);
    f.latest = { text: "Unsaved final result", revision: 2 };
    f.save.mockRejectedValueOnce(new Error("Disk full"));
    await f.guard.quit(2);
    expect(f.complete.mock.calls).toEqual([[1]]);
    expect(f.cancel).toHaveBeenCalledExactlyOnceWith(2);
    expect(f.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "Disk full" }), "save", 2);
    expect(f.locked).toBe(false);
    expect(f.latest.text).toBe("Unsaved final result");
    f.guard.cancelled();
    await f.guard.quit(2); // old failed delivery remains stale
    expect(f.save).toHaveBeenCalledTimes(2);
    await f.guard.quit(3);
    expect(f.complete.mock.calls).toEqual([[1], [3]]);
    expect(f.disk[f.disk.length - 1]?.text).toBe("Unsaved final result");
  });

  it("does not acknowledge an obsolete attempt after cancellation while its save was running", async () => {
    const f = fixture();
    const first = deferred<WindowSaveReceipt<Snapshot>>();
    f.save.mockReturnValueOnce(first.promise);
    const request = f.guard.quit(1);
    f.guard.cancelled();
    first.resolve({ published: f.latest, settled: true });
    await request;
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.locked).toBe(false);
    await f.guard.quit(2);
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("retains close deduplication and permits a normal retry after a failed close save", async () => {
    const f = fixture();
    const first = deferred<WindowSaveReceipt<Snapshot>>();
    f.save.mockReturnValueOnce(first.promise);
    const close = f.guard.close();
    await f.guard.close();
    expect(f.save).toHaveBeenCalledOnce();
    first.reject(new Error("Save failed"));
    await close;
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.locked).toBe(false);
    await f.guard.close();
    expect(f.complete).toHaveBeenCalledExactlyOnceWith(null);
  });
});
