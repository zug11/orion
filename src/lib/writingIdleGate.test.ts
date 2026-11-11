import { afterEach, describe, expect, it, vi } from "vitest";
import { WritingIdleGate } from "./writingIdleGate";

afterEach(() => vi.useRealTimers());

describe("writing idle gate", () => {
  it("shares one quiet deadline across waiting summary steps and moves it on input", async () => {
    vi.useFakeTimers();
    const gate = new WritingIdleGate();
    await expect(gate.wait()).resolves.toBe(true);
    gate.activity();
    const first = vi.fn();
    const second = vi.fn();
    void gate.wait().then(first);
    void gate.wait().then(second);
    await vi.advanceTimersByTimeAsync(2_900);
    gate.activity();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(first).toHaveBeenCalledWith(true);
    expect(second).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases pending work as cancelled when its window unmounts", async () => {
    vi.useFakeTimers();
    const gate = new WritingIdleGate();
    gate.activity();
    const waiting = gate.wait();
    gate.dispose();
    await expect(waiting).resolves.toBe(false);
    gate.activity();
    await expect(gate.wait()).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
