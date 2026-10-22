import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatReadRequest, ChatRequest, ChatResult } from "../types";
import { runChatReading } from "./chatReading";
import type { ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import { isChatCoverage } from "./chatReadingProtocol";
import { VoiceResearch } from "./voiceResearch";
import { researchWithPerplexity } from "./perplexity";
import type { WebResearchResult } from "./webResearch";

vi.mock("./perplexity", () => ({ researchWithPerplexity: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
const snapshot = () => createEmptySnapshot("Research", "2026-10-22T00:00:00.000Z", "continued-space");
const read = (query: string): ChatReadRequest => ({ kind: "web", id: "", query, start: null, depth: "standard" });
const result = (index: number): WebResearchResult => ({ responseId: `response_${index}`, answer: `Finding ${index} [1].`,
  retrievedAt: "2026-10-22T00:00:00.000Z", sources: [{ id: 1, title: `Primary source ${index}`,
    url: `https://example.org/study-${index}`, snippet: `Evidence for subquestion ${index}.` }] });
const answer = (request: ChatRequest): ChatResult => ({ reply: `Supported finding [[${JSON.parse(request.readingContext!).evidence.at(-1).id}]].` });

describe("evidence-driven web continuation", () => {
  it("answers after eight sequential lookups, preserving citations and serializable coverage", async () => {
    let calls = 0, turns = 0;
    const research = vi.fn(async () => result(++calls));
    const finished = await runChatReading(snapshot(), "Investigate eight related evidence gaps", async request => {
      const packet = JSON.parse(request.readingContext!);
      expect(packet.finalizing).toBe(false);
      expect(packet.webResearch).not.toHaveProperty("remainingRequests");
      return turns++ < 8 ? { reply: "", readRequests: [read(`Unresolved subquestion ${turns}`)] } : answer(request);
    }, { webResearch: research });
    expect(research).toHaveBeenCalledTimes(8);
    expect(finished.webResearch).toEqual({ attempted: 8, completed: 8 });
    expect(finished.evidence?.[0].web?.url).toBe("https://example.org/study-8");
    expect(isChatCoverage(finished.coverage)).toBe(true);
    expect(isChatCoverage({ ...finished.coverage, webSearches: -1 })).toBe(false);
    expect(isChatCoverage({ ...finished.coverage, webSearches: 1.5 })).toBe(false);
  });

  it("keeps voice in the same work order across eight sequential lookups", async () => {
    const state = snapshot(); state.settings.apiKeyConfigured = true; state.settings.perplexityApiKeyConfigured = true;
    let calls = 0, turns = 0;
    vi.mocked(researchWithPerplexity).mockImplementation(async () => result(++calls));
    const voice = new VoiceResearch({ snapshot: () => state, driver: async request => turns++ < 8
      ? { reply: "", readRequests: [read(`Evidence gap ${turns}`)] } : answer(request),
    onProgress: vi.fn(), onResult: vi.fn(), deliver: vi.fn(), commit: vi.fn() });
    await voice.run("same-worker", "Research all the relevant evidence", "");
    expect(voice.getJobs()).toHaveLength(1);
    expect(voice.getJobs()[0]).toMatchObject({ id: "same-worker", state: "completed", result: { webResearch: { attempted: 8, completed: 8 } } });
  });

  it("retains totals and receipts beyond the result cache and operation journal, including resume", async () => {
    let calls = 0, turns = 0, checkpoint: ChatReadingCheckpoint | undefined;
    const research = vi.fn(async () => result(++calls));
    await runChatReading(snapshot(), "A large evidence comparison", async request => turns++ < 36
      ? { reply: "", readRequests: [read(`Subquestion ${turns}`)] } : answer(request),
    { webResearch: research, onCheckpoint: value => { checkpoint = value; } });
    expect(checkpoint?.webResults).toHaveLength(3);
    expect(checkpoint?.completedOperations).toHaveLength(32);
    expect(checkpoint?.webSearches).toBe(36);
    expect(checkpoint?.webLookups).toHaveLength(36);
    let resumed = 0;
    const finished = await runChatReading(snapshot(), "A large evidence comparison", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (!resumed++) return { reply: "", readRequests: [read("  SUBQUESTION   1  ")] };
      expect(packet.results[0].error).toContain("already researched");
      return answer(request);
    }, { webResearch: research, resume: checkpoint });
    expect(research).toHaveBeenCalledTimes(36);
    expect(finished.webResearch).toEqual({ attempted: 36, completed: 36 });
  });

  it("finishes when repeated rephrased lookups bring back the same evidence with new timestamps", async () => {
    let calls = 0, turns = 0;
    const research = vi.fn(async () => ({ ...result(1), responseId: `response_${++calls}`, retrievedAt: `2026-10-22T00:00:0${calls}.000Z` }));
    const finished = await runChatReading(snapshot(), "Resolve this uncertainty", async request => {
      const packet = JSON.parse(request.readingContext!);
      return packet.finalizing ? answer(request) : { reply: "", readRequests: [read(`Another approach ${++turns}`)] };
    }, { webResearch: research });
    expect(calls).toBe(3); // one useful result, then two with no new evidence
    expect(finished.coverage?.limited).toBe(true);
    expect(finished.evidence).toHaveLength(1);
  });

  it("suppresses duplicate failed requests in one run but permits an explicit resumed retry", async () => {
    let turns = 0, checkpoint: ChatReadingCheckpoint | undefined;
    const research = vi.fn().mockRejectedValueOnce(new Error("The lookup timed out.")).mockResolvedValueOnce(result(1));
    await runChatReading(snapshot(), "Research", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (packet.finalizing) return { reply: "The lookup did not complete." };
      return { reply: "", readRequests: [read(++turns % 2 ? "Question" : " QUESTION ")] };
    }, { webResearch: research, onCheckpoint: value => { checkpoint = value; } });
    expect(research).toHaveBeenCalledTimes(1);
    let retryTurn = 0;
    const retried = await runChatReading(snapshot(), "Research", async request => !retryTurn++
      ? { reply: "", readRequests: [read("Question")] } : answer(request), { webResearch: research, resume: checkpoint });
    expect(research).toHaveBeenCalledTimes(2);
    expect(retried.webResearch).toMatchObject({ attempted: 2, completed: 1 });
  });

  it("cancels a seventh in-flight lookup without publishing its late result", async () => {
    let calls = 0, turns = 0, complete!: (value: WebResearchResult) => void;
    const controller = new AbortController();
    const research = vi.fn(async () => ++calls < 7 ? result(calls) : new Promise<WebResearchResult>(resolve => { complete = resolve; }));
    const driver = vi.fn(async (): Promise<ChatResult> => ({ reply: "", readRequests: [read(`Question ${++turns}`)] }));
    const running = runChatReading(snapshot(), "Research", driver, { webResearch: research, signal: controller.signal });
    await vi.waitFor(() => expect(calls).toBe(7));
    controller.abort(new Error("Worker cancelled")); complete(result(7));
    await expect(running).rejects.toThrow("Worker cancelled");
    expect(driver).toHaveBeenCalledTimes(7);
  });

  it("still times out one stalled lookup after its depth allowance and answer grace", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const research = vi.fn((_query: string, signal: AbortSignal) => new Promise<WebResearchResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
    }));
    const running = runChatReading(snapshot(), "Research", async () => ({ reply: "", readRequests: [read("Question")] }), { webResearch: research }).catch(error => error);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(await running).toMatchObject({ message: expect.stringContaining("reading time limit") });
    expect(aborted).toBe(true);
    expect(research).toHaveBeenCalledTimes(1);
  });
});
