import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatReadRequest, ChatRequest, ChatResult } from "../types";
import { runChatReading } from "./chatReading";
import type { ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import type { WebResearchResult } from "./webResearch";

const state = () => createEmptySnapshot("Parallel research", "2026-11-16", "parallel-space");
const read = (query: string): ChatReadRequest => ({ kind: "web", id: "", query, start: null });
const result = (index: number): WebResearchResult => ({ responseId: `response_${index}`, retrievedAt: "2026-11-16T00:00:00Z",
  answer: `Finding ${index} [1].`, sources: [{ id: 1, title: `Study ${index}`, url: `https://example.org/${index}`, snippet: `Evidence ${index}.` }] });
const packet = (request: ChatRequest) => JSON.parse(request.readingContext!);

describe("automatic bounded parallel research reads", () => {
  it("overlaps two independent requests at a time and merges reverse finishes in input order", async () => {
    const pending = new Map<string, (value: WebResearchResult) => void>();
    const research = vi.fn((query: string) => new Promise<WebResearchResult>(resolve => pending.set(query, resolve)));
    let turns = 0;
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      if (!turns++) return { reply: "", readRequests: [1, 2, 3, 4].map(n => read(`Question ${n}`)) };
      const context = packet(request);
      expect(context.evidence.map((item: { id: string; title: string }) => [item.id, item.title])).toEqual([
        ["e1", "Study 1"], ["e2", "Study 2"], ["e3", "Study 3"], ["e4", "Study 4"],
      ]);
      expect(context.results.map((item: { query: string }) => item.query)).toEqual([1, 2, 3, 4].map(n => `Question ${n}`));
      return { reply: "Four complementary findings [[e1]] [[e2]] [[e3]] [[e4]]." };
    });
    const running = runChatReading(state(), "Compare four independent questions", driver, { webResearch: research });
    await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(2));
    pending.get("Question 2")!(result(2));
    await Promise.resolve(); expect(research).toHaveBeenCalledTimes(2);
    pending.get("Question 1")!(result(1));
    await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(4));
    pending.get("Question 4")!(result(4)); pending.get("Question 3")!(result(3));
    const finished = await running;
    expect(finished.webResearch).toEqual({ attempted: 4, completed: 4 });
    expect(driver).toHaveBeenCalledTimes(2); // no additional decomposition/planner request
  });

  it("retains successful evidence when an independent sibling fails", async () => {
    let first!: (value: WebResearchResult) => void, second!: (reason: Error) => void;
    const research = vi.fn((query: string) => query === "First"
      ? new Promise<WebResearchResult>(resolve => { first = resolve; })
      : new Promise<WebResearchResult>((_resolve, reject) => { second = reject; }));
    let turns = 0, saved: ChatReadingCheckpoint | undefined;
    const running = runChatReading(state(), "Compare the two findings", async request => {
      if (!turns++) return { reply: "", readRequests: [read("First"), read("Second")] };
      const context = packet(request);
      expect(context.results[0].evidenceIds).toEqual(["e1"]);
      expect(context.results[1].error).toBe("Research service is busy.");
      return { reply: "The first finding is supported [[e1]]. The second could not be checked." };
    }, { webResearch: research, onCheckpoint: value => { saved = value; } });
    await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(2));
    second(new Error("Research service is busy.")); first(result(1));
    const finished = await running;
    expect(finished.webResearch).toEqual({ attempted: 2, completed: 1, issue: "Research service is busy." });
    expect(saved?.webLookups?.map(item => [item.query, item.error])).toEqual([["first", undefined], ["second", "Research service is busy."]]);
  });

  it("cancels both in-flight reads and cannot publish late results or checkpoints", async () => {
    const pending: Array<(value: WebResearchResult) => void> = [], signals: AbortSignal[] = [];
    const research = vi.fn((_query: string, signal: AbortSignal) => { signals.push(signal); return new Promise<WebResearchResult>(resolve => pending.push(resolve)); });
    const controller = new AbortController(), checkpoint = vi.fn();
    const driver = vi.fn(async () => ({ reply: "", readRequests: [read("First"), read("Second")] }));
    const running = runChatReading(state(), "Compare", driver, { webResearch: research, signal: controller.signal, onCheckpoint: checkpoint });
    await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(2));
    const count = checkpoint.mock.calls.length;
    controller.abort(new Error("Request cancelled"));
    expect(signals.every(signal => signal.aborted)).toBe(true);
    pending[1](result(2)); pending[0](result(1));
    await expect(running).rejects.toThrow("Request cancelled");
    expect(driver).toHaveBeenCalledTimes(1);
    expect(checkpoint).toHaveBeenCalledTimes(count);
  });

  it("does not pay for normalized duplicate questions in one batch", async () => {
    const research = vi.fn(async () => result(1)); let turns = 0;
    await runChatReading(state(), "Check a fact", async request => {
      if (!turns++) return { reply: "", readRequests: [read("First question"), read(" FIRST   QUESTION ")] };
      expect(packet(request).results[1].error).toContain("already returned");
      return { reply: "Finding [[e1]]." };
    }, { webResearch: research });
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("reassesses repeated failures before starting another paid pair", async () => {
    const research = vi.fn(async () => { throw new Error("Unavailable"); }); let turns = 0;
    const finished = await runChatReading(state(), "Check four facts", async request => {
      if (!turns++) return { reply: "", readRequests: [1, 2, 3, 4].map(n => read(`Question ${n}`)) };
      expect(packet(request).results.slice(2).every((item: { error: string }) => item.error.includes("no new source evidence"))).toBe(true);
      return { reply: "Research was unavailable; I cannot establish those facts." };
    }, { webResearch: research });
    expect(research).toHaveBeenCalledTimes(2);
    expect(finished.webResearch).toMatchObject({ attempted: 2, completed: 0 });
  });
});
