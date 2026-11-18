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
  it("compacts long web pages into read receipts while keeping exact evidence and the locally resumable pages", async () => {
    let checkpoint: ChatReadingCheckpoint | undefined;
    const research = vi.fn(async (query: string) => ({ ...result(Number(query)), answer: ("Long synthesis " + query + " ").repeat(1000) }));
    let turns = 0;
    const answer = await runChatReading(state(), "Compare four sources", async request => {
      if (!turns++) return { reply: "", readRequests: ["1", "2", "3", "4"].map(read) };
      const context = packet(request), memory = context.workerContinuity;
      expect(memory.completedOperationsOmitted).toBe(0);
      expect(memory.completedOperations.map((entry: { result: { responseId?: string } }) => entry.result.responseId).slice(1))
        .toEqual(["response_1", "response_2", "response_3", "response_4"]);
      expect(JSON.stringify(memory)).not.toContain("Long synthesis");
      expect(JSON.stringify(memory).length).toBeLessThan(2_000);
      expect(context.evidence[0]).toMatchObject({ id: "e1", text: "Evidence 1.", web: { url: "https://example.org/1" } });
      return { reply: "First [[e1]]. Fourth [[e4]]." };
    }, { webResearch: research, onCheckpoint: value => { checkpoint = value; } });
    expect(answer.evidence).toHaveLength(2);
    expect((checkpoint!.completedOperations[1].result as { synthesis: string }).synthesis.length).toBeGreaterThan(9_000);
    await runChatReading(state(), "Compare four sources", async () => ({ reply: "Fourth [[e4]]." }), {
      purpose: "search", webResearch: research, resume: checkpoint, initialPublicQuery: "4",
    });
    expect(research).toHaveBeenCalledTimes(4);
  });

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

  it("keeps the exact passage supporting an early checkpoint through later count and byte compaction", async () => {
    const research = async (query: string) => ({ ...result(Number(query)), sources: Array.from({ length: 12 }, (_, i) => ({
      id: i + 1, title: `Study ${query}-${i}`, url: `https://example.org/${query}/${i}`, snippet: `Passage ${query}-${i} ` + "界".repeat(2_000),
    })) });
    let turn = 0;
    const finished = await runChatReading(state(), "Compare the studies", async request => {
      switch (++turn) {
        case 1: return { reply: "", readRequests: [read("1")] };
        case 2: return { reply: "", checkpoint: { finding: "The first study [[e1]].", decisions: [], openQuestions: [] },
          readRequests: ["2", "3", "4", "5"].map(read) };
        case 3: return { reply: "", readRequests: ["6", "7", "8", "9"].map(read) };
        default: {
          const context = packet(request);
          expect(new TextEncoder().encode(request.readingContext!).length).toBeLessThanOrEqual(320_000);
          expect(context.evidence.length).toBeLessThan(96);
          expect(context.evidence.find((e: { id: string }) => e.id === "e1")).toMatchObject({ title: "Study 1-0", web: { url: "https://example.org/1/0" } });
          return { reply: "The first study [[e1]]." };
        }
      }
    }, { webResearch: research, onCheckpoint: () => {} });
    expect(finished.evidence?.[0].text).toBe("Passage 1-0 " + "界".repeat(2_000));
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

  it.each([0, 1])("recovers the lookup that finished first (slot %i) without another paid request", async ready => {
    let saved: ChatReadingCheckpoint | undefined;
    const pending: Array<(value: WebResearchResult) => void> = [];
    const research = vi.fn(() => new Promise<WebResearchResult>(resolve => pending.push(resolve)));
    const abort = new AbortController();
    const initial = runChatReading(state(), "Compare the sources", async () => ({
      reply: "", readRequests: [read("First"), read("Second")],
    }), { webResearch: research, signal: abort.signal, onCheckpoint: value => { saved = value; } }).catch(error => error);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[ready](result(ready + 1));
    try {
      await vi.waitFor(() => expect(saved?.webResults?.map(page => page.result.responseId)).toContain(`response_${ready + 1}`));
      expect(saved?.webAttempts).toBe(2);
    } finally {
      abort.abort(new Error("Stopped by user")); pending[1 - ready](result(99));
      expect((await initial).message).toBe("Stopped by user");
    }
    // A corrected question refreshes local discovery and still needs the
    // unanswered sibling from the interrupted research plan.
    const question = ready === 0 ? "Compare the sources" : "Compare the sources more closely";
    const resumed = await runChatReading(state(), question, async request => {
      const context = packet(request);
      expect(context.evidence).toHaveLength(1);
      expect(context.evidence[0].web.url).toBe(`https://example.org/${ready + 1}`);
      expect(context.workerContinuity.pendingReads.map((r: ChatReadRequest) => r.query)).toEqual([ready === 0 ? "Second" : "First"]);
      return { reply: `One source was recovered [[${context.evidence[0].id}]].` };
    }, { webResearch: research, resume: saved, onCheckpoint: () => {} });
    expect(research).toHaveBeenCalledTimes(2);
    expect(resumed.webResearch).toMatchObject({ attempted: 2, completed: 1, issue: expect.stringContaining("interrupted") });
    expect(resumed.evidence?.[0].title).toBe(`Study ${ready + 1}`);
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
