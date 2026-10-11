import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceFlow, beginFlowComposition, changeFlow, createFlowSession, createWritingTimerStore,
  endFlowComposition, flowOpacity, flowRemaining, formatWritingTime, stopFlow, writingDuration,
} from "./writingSession";

afterEach(() => vi.useRealTimers());

describe("Flow deadlines", () => {
  it("waits for actual text, then fades smoothly and restores opacity when writing resumes", () => {
    const ready = createFlowSession(60_000, 10);
    expect(advanceFlow(ready, 999_999)).toBe(ready);
    expect(changeFlow(ready, "", 100)).toBe(ready);
    const writing = changeFlow(ready, "First thought", 1000);
    expect(flowRemaining(writing, 1000)).toBe(60_000);
    expect(flowOpacity(writing, 1000)).toBe(1);
    expect(flowOpacity(writing, 8000)).toBeGreaterThan(0);
    expect(flowOpacity(writing, 8000)).toBeLessThan(0.5);
    expect(changeFlow(writing, writing.text, 8000)).toBe(writing);
    const resumed = changeFlow(writing, "First thought continues", 8000);
    expect(flowOpacity(resumed, 8000)).toBe(1);
    expect(resumed.endsAt).toBe(writing.endsAt);
  });

  it("irreversibly clears the draft at the idle deadline, including late input and Stop", () => {
    const writing = changeFlow(createFlowSession(60_000, 5), "Temporary words", 1000);
    expect(stopFlow(writing, 5999)).toMatchObject({ phase: "complete", text: "Temporary words" });
    expect(advanceFlow(writing, 6000)).toMatchObject({ phase: "lost", text: "" });
    expect(changeFlow(writing, "Trying to rescue it", 6000)).toMatchObject({ phase: "lost", text: "" });
    expect(stopFlow(writing, 9000)).toMatchObject({ phase: "lost", text: "" });
  });

  it("uses the first deadline after background throttling instead of silently saving an expired draft", () => {
    const writing = changeFlow(createFlowSession(60_000, 10), "Temporary words", 0);
    expect(advanceFlow(writing, 120_000)).toMatchObject({ phase: "lost", text: "" });
    let continuous = writing;
    for (let time = 9000; time <= 54_000; time += 9000) continuous = changeFlow(continuous, String(time), time);
    expect(advanceFlow(continuous, 120_000)).toMatchObject({ phase: "complete", text: "54000" });
    expect(stopFlow(continuous, 120_000)).toMatchObject({ phase: "complete", text: "54000" });
  });

  it("keeps a session when its finish and inactivity deadlines coincide", () => {
    const writing = { ...changeFlow(createFlowSession(60_000, 10), "Final words", 0), lastInputAt: 50_000 };
    expect(advanceFlow(writing, 60_000).phase).toBe("complete");
  });

  it("pauses both clocks during IME composition, then grants the full typing interval", () => {
    const writing = changeFlow(createFlowSession(60_000, 5), "文字", 1000);
    const composing = beginFlowComposition(writing, 4000);
    expect(advanceFlow(composing, 70_000).phase).toBe("writing");
    expect(flowRemaining(composing, 70_000)).toBe(57_000);
    expect(flowOpacity(composing, 70_000)).toBe(1);
    const committed = endFlowComposition(composing, "文字を書きます", 70_000);
    expect(committed.endsAt).toBe(127_000);
    expect(advanceFlow(committed, 74_999).phase).toBe("writing");
    expect(advanceFlow(committed, 75_000).phase).toBe("lost");
  });

  it("does not grant extra session time before the first composed character", () => {
    const composing = beginFlowComposition(createFlowSession(60_000, 10), 1000);
    const writing = changeFlow(composing, "字", 3000);
    expect(flowRemaining(writing, 20_000)).toBe(60_000);
    expect(flowRemaining(endFlowComposition(writing, "字", 20_000), 20_000)).toBe(60_000);
  });

  it("validates limits and displays remaining time without negative or premature zero values", () => {
    for (const value of [0, -1, NaN, Infinity, 181, 1.5]) expect(writingDuration(value)).toBeNull();
    expect(writingDuration(180)).toBe(10_800_000);
    expect(() => createFlowSession(60_000, 0)).toThrow();
    expect(formatWritingTime(60_000)).toBe("1:00");
    expect(formatWritingTime(1)).toBe("0:01");
    expect(formatWritingTime(-100)).toBe("0:00");
  });
});

describe("General writing timer", () => {
  it("pauses and resumes from real deadlines without counting paused time", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const timer = createWritingTimerStore();
    timer.start(60_000);
    vi.advanceTimersByTime(20_000); timer.pause();
    expect(timer.getSnapshot()).toMatchObject({ status: "paused", remainingMs: 40_000 });
    vi.advanceTimersByTime(120_000); timer.resume();
    vi.advanceTimersByTime(39_000);
    expect(timer.getSnapshot()).toMatchObject({ status: "running", remainingMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(timer.getSnapshot()).toMatchObject({ status: "complete", remainingMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
    timer.stop();
  });

  it("survives subscriber removal and catches up after sleep or background throttling", () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const timer = createWritingTimerStore();
    const listener = vi.fn(); const unsubscribe = timer.subscribe(listener);
    timer.start(60_000); unsubscribe();
    vi.setSystemTime(70_000); timer.pause();
    expect(timer.getSnapshot()).toMatchObject({ status: "complete", remainingMs: 0 });
    timer.resume(); expect(timer.getSnapshot().status).toBe("complete");
    timer.stop(); expect(vi.getTimerCount()).toBe(0);
  });
});
