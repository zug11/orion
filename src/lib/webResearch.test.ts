import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { runChatReading } from "./chatReading";
import { applyChatResult } from "./chat";
import { portableChatEvidence, savedChatEvidence } from "./chatCitations";
import { isChatEvidence, parseChatReadRequests } from "./chatReadingProtocol";
import { safeWebUrl, validateWebResult, webSynthesisPage, type WebResearchResult } from "./webResearch";
import type { ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import { VoiceResearch, voiceContext } from "./voiceResearch";
import { researchWithPerplexity } from "./perplexity";

vi.mock("./perplexity", () => ({ researchWithPerplexity: vi.fn() }));
const snapshot = () => createEmptySnapshot("Research", "2026-10-22T00:00:00.000Z", "research-space");
const response = (): WebResearchResult => ({ responseId: "response_1", retrievedAt: "2026-10-22T02:00:00.000Z", answer: "Finding [7]. More [11].",
  sources: [{ id: 7, title: "Primary paper", url: "https://example.org/paper", snippet: "First supported finding." },
    { id: 11, title: "Replication", url: "https://example.org/replication", snippet: "Second supported finding." }] });
const webRead = { kind: "web" as const, id: "", query: "Public research question", start: null };
async function answer(request: ChatRequest): Promise<ChatResult> {
  const packet = JSON.parse(request.readingContext!);
  return packet.evidence.length ? { reply: `Finding [[${packet.evidence[0].id}]].`, readRequests: [] }
    : { reply: "", readRequests: [webRead] };
}

describe("bounded web research in the shared reader", () => {
  it("never calls Perplexity just because a key is configured; text grants access per request", async () => {
    vi.mocked(researchWithPerplexity).mockReset();
    const state = snapshot(); state.settings.perplexityApiKeyConfigured = true;
    let turn = 0;
    await runChatReading(state, "What is new?", async request => {
      const packet = JSON.parse(request.readingContext!);
      expect(packet.webResearch.enabled).toBe(false);
      if (turn++ === 0) return { reply: "", readRequests: [webRead] };
      expect(packet.results[0].error).toContain("Web research is off");
      return { reply: "Enable Web to research that." };
    });
    expect(researchWithPerplexity).not.toHaveBeenCalled();
  });

  it("maps provider source IDs, preserves source URLs when saved, and never adds source records to the vault", async () => {
    const state = snapshot(), original = structuredClone(state), research = vi.fn(async () => response());
    const result = await runChatReading(state, "Research the public topic", async request => {
      const packet = JSON.parse(request.readingContext!);
      expect(packet.webResearch.enabled).toBe(true);
      if (!packet.evidence.length) return { reply: "", readRequests: [webRead] };
      expect(packet.results[0].citations).toEqual([{ providerId: 7, evidenceId: "e1" }, { providerId: 11, evidenceId: "e2" }]);
      return { reply: "Finding [[e2]]." };
    }, { webResearch: research });
    expect(research).toHaveBeenCalledTimes(1);
    expect(research).toHaveBeenCalledWith(webRead.query, expect.any(AbortSignal), "standard");
    expect(result.evidence?.[0]).toMatchObject({ id: "e2", kind: "web", text: "Second supported finding.", web: { url: "https://example.org/replication" } });
    expect(result.coverage).toMatchObject({ webSearches: 1, openedSources: 0, openedNotes: 0 });
    expect(result.webResearch).toEqual({ attempted: 1, completed: 1 });
    expect(state).toEqual(original);
    const saved = portableChatEvidence(result.reply, result.evidence!);
    expect(saved).toContain("https://example.org/replication");
    expect(savedChatEvidence(saved)).toEqual(result.evidence);
    let id = 0;
    const next = applyChatResult(state, "Research", result, "2026-10-22", () => `message-${++id}`);
    expect(next.studio.messages.slice(-1)[0]?.evidence).toEqual(result.evidence);
    expect(next.sources).toEqual([]);
  });

  it("retains completed research across checkpoints but cannot restore it into a request without Web", async () => {
    const state = snapshot(), research = vi.fn(async () => response());
    let checkpoint: ChatReadingCheckpoint | undefined;
    await runChatReading(state, "Research", answer, { webResearch: research, onCheckpoint: value => { checkpoint = value; } });
    await runChatReading(state, "Research", answer, { webResearch: research, resume: checkpoint });
    expect(research).toHaveBeenCalledTimes(1);
    await runChatReading(state, "Research", async request => {
      expect(JSON.parse(request.readingContext!).evidence).toEqual([]);
      return { reply: "Web is off." };
    }, { resume: checkpoint });
  });

  it("revokes late research on cancellation, even if the transport resolves afterwards", async () => {
    let finish!: (result: WebResearchResult) => void;
    const research = vi.fn(() => new Promise<WebResearchResult>(resolve => { finish = resolve; }));
    const controller = new AbortController(), driver = vi.fn(answer);
    const running = runChatReading(snapshot(), "Research", driver, { webResearch: research, signal: controller.signal });
    await vi.waitFor(() => expect(research).toHaveBeenCalledTimes(1));
    controller.abort(new Error("Worker cancelled")); finish(response());
    await expect(running).rejects.toThrow("Worker cancelled");
    expect(driver).toHaveBeenCalledTimes(1);
  });

  it("reports provider failure while allowing a useful local answer", async () => {
    let turn = 0;
    const result = await runChatReading(snapshot(), "Research", async () => turn++ === 0 ? { reply: "", readRequests: [webRead] } : { reply: "Here is what I can say provisionally." },
      { webResearch: async () => { throw new Error("Perplexity needs API credit."); } });
    expect(result.reply).toContain("Web research notice: Perplexity needs API credit.");
    expect(result.webResearch).toEqual({ attempted: 1, completed: 0, issue: "Perplexity needs API credit." });
    expect(result.evidence).toEqual([]);
  });

  it("reports partial web success from host observations even if a provider reports a different outcome", async () => {
    let turn = 0;
    const research = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("Perplexity's shared request limit is busy. (WEB_REQUEST_RATE_LIMIT)"));
    const result = await runChatReading(snapshot(), "Research", async () => {
      if (turn++ < 2) return { reply: "", readRequests: [{ ...webRead, query: `Question ${turn}` }] };
      return { reply: "Finding [[e1]].", webResearch: { attempted: 10, completed: 10 }, voice: { label: "Finding", summary: "Finding [[e1]]." } };
    }, { webResearch: research });
    expect(result.webResearch).toEqual({ attempted: 2, completed: 1, issue: "Perplexity's shared request limit is busy. (WEB_REQUEST_RATE_LIMIT)" });
    expect(result.evidence?.[0].kind).toBe("web");
    const noResearch = await runChatReading(snapshot(), "Discuss", async () => ({ reply: "Discussion.", webResearch: { attempted: 1, completed: 1 } }));
    expect(noResearch).not.toHaveProperty("webResearch");
  });

  it("admits all four useful research requests in one planning step", async () => {
    let lookups = 0;
    const research = vi.fn(async () => {
      const index = ++lookups;
      return { ...response(), responseId: `response_${index}`, sources: [{ ...response().sources[0], url: `https://example.org/paper-${index}` }] };
    }); let turn = 0;
    await runChatReading(snapshot(), "Research", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (turn++ === 0) return { reply: "", readRequests: Array.from({ length: 4 }, (_, i) => ({ ...webRead, query: `Question ${i}` })) };
      expect(packet.webResearch).not.toHaveProperty("remainingRequests");
      expect(packet.webResearch.completedSearches).toBe(4);
      expect(packet.results.every((item: { error?: string }) => !item.error)).toBe(true);
      return { reply: "Finding [[e1]]." };
    }, { webResearch: research });
    expect(research).toHaveBeenCalledTimes(4);
  });

  it("automatically enables the same research path for voice workers, with attributable findings", async () => {
    const state = snapshot(); state.settings.apiKeyConfigured = true; state.settings.perplexityApiKeyConfigured = true;
    vi.mocked(researchWithPerplexity).mockReset().mockResolvedValue(response());
    const deliver = vi.fn(), commit = vi.fn();
    const engine = new VoiceResearch({ snapshot: () => state, driver: async request => answer(request), onProgress: vi.fn(), onResult: vi.fn(), deliver, commit });
    expect(JSON.parse(voiceContext(state, "")).webResearchAvailable).toBe(true);
    await engine.run("web-worker", "Research this public topic", "");
    expect(researchWithPerplexity).toHaveBeenCalledTimes(1);
    expect(engine.getJobs()[0]).toMatchObject({ state: "completed", result: { evidence: [expect.objectContaining({ kind: "web" })] } });
    expect(deliver.mock.calls.some(call => String(call[3]?.reference ?? call[1]).includes('"kind":"web"'))).toBe(true);
    expect(commit).not.toHaveBeenCalled();
  });

  it("gives concurrent read-only voice assignments web access and preserves each outcome", async () => {
    const state = snapshot(); state.settings.apiKeyConfigured = true; state.settings.perplexityApiKeyConfigured = true;
    const pending: { resolve: (result: WebResearchResult) => void; reject: (error: Error) => void }[] = [];
    vi.mocked(researchWithPerplexity).mockReset().mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
    const deliver = vi.fn(), commit = vi.fn();
    const engine = new VoiceResearch({ snapshot: () => state, driver: async request => {
      expect(request.prompt).toBe("Investigate these topics with two workers");
      expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBeUndefined();
      expect(request.history[0].content).toContain("relevant public web evidence");
      expect(request.history[0].content).toContain("web readRequests");
      const packet = JSON.parse(request.readingContext!);
      expect(packet.webResearch.enabled).toBe(true);
      if (packet.results.some((result: { error?: string }) => result.error)) return { reply: "The web lookup could not finish." };
      return answer(request);
    }, onProgress: vi.fn(), onResult: vi.fn(), deliver, commit });
    const work = ["First", "Second"].map((subject, i) => engine.run(`worker-${i}`, "Investigate these topics with two workers", "", undefined, null, false, undefined, { subject, focus: `Investigate public evidence about ${subject}.` }));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0].resolve(response()); pending[1].reject(new Error("Perplexity's shared request limit is busy. (WEB_REQUEST_RATE_LIMIT)"));
    await Promise.all(work);
    const jobs = engine.getJobs();
    expect(jobs[0]).toMatchObject({ id: "worker-0", state: "completed", result: { webResearch: { attempted: 1, completed: 1 } } });
    expect(jobs[1]).toMatchObject({ id: "worker-1", state: "failed", progress: expect.stringContaining("WEB_REQUEST_RATE_LIMIT") });
    expect(engine.conversationContext("worker-1")).toBeUndefined();
    expect(commit).not.toHaveBeenCalled();
  });

  it("answers from retained web excerpts when synthesis is absent, without repeating the lookup", async () => {
    const research = vi.fn(async () => ({ ...response(), answer: "" }));
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const packet = JSON.parse(request.readingContext!);
      if (!packet.evidence.length) return { reply: "", readRequests: [webRead] };
      expect(packet.results[0]).toMatchObject({ synthesis: "", synthesisComplete: true, nextStart: null });
      expect(packet.evidence[0].text).toBe("First supported finding.");
      return { reply: "Finding [[e1]].", voice: { label: "Public evidence", summary: "Finding [[e1]]." } };
    });
    const result = await runChatReading(snapshot(), "Investigate the public topic", driver, { purpose: "search", webResearch: research, onWorkLabel: vi.fn() });
    expect(research).toHaveBeenCalledTimes(1);
    expect(driver).toHaveBeenCalledTimes(2);
    expect(result.webResearch).toEqual({ attempted: 1, completed: 1 });
    expect(result.voice?.summary).toContain("#orion-evidence-e1");
  });

  it("fails an unsupported voice worker visibly instead of publishing a ready local-only fallback", async () => {
    const state = snapshot(); state.settings.apiKeyConfigured = true; state.settings.perplexityApiKeyConfigured = true;
    vi.mocked(researchWithPerplexity).mockReset();
    const deliver = vi.fn(), onResult = vi.fn(), commit = vi.fn();
    const driver = vi.fn(async () => ({ reply: "I could not find this in the Space." }));
    const engine = new VoiceResearch({ snapshot: () => state, driver, onProgress: vi.fn(), onResult, deliver, commit });
    await engine.run("unsupported", "Research historical precedents", "", undefined, null, false, undefined,
      { subject: "Historical precedents", focus: "Investigate public historical precedents." });
    expect(engine.getJobs()[0]).toMatchObject({ state: "failed", progress: expect.stringContaining("CHAT_RESEARCH_UNGROUNDED") });
    expect(onResult).not.toHaveBeenCalled();
    expect(researchWithPerplexity).not.toHaveBeenCalled();
    expect(deliver.mock.calls.some(call => String(call[1]).includes("did not complete a web lookup"))).toBe(true);
  });

  it("corrects a local-only evidence gap by offering web reads inside the same worker", async () => {
    let turn = 0;
    const research = vi.fn(async () => response());
    const result = await runChatReading(snapshot(), "Research historical precedents", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (turn++ === 0) return { reply: "I could not find this in the Space." };
      if (turn === 2) {
        expect(packet.correction).toContain("A local Space search is not a web lookup");
        return { reply: "", readRequests: [webRead] };
      }
      return { reply: "The source supports this finding [[e1]]." };
    }, { purpose: "search", webResearch: research });
    expect(result.webResearch).toEqual({ attempted: 1, completed: 1 });
    expect(result.evidence?.[0].kind).toBe("web");
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("does not report retrieved web sources as a failed local search when citations are missing", async () => {
    const research = vi.fn(async () => response());
    let turn = 0;
    await expect(runChatReading(snapshot(), "Research", async () => turn++ === 0
      ? { reply: "", readRequests: [webRead] } : { reply: "Unsupported conclusion." },
    { purpose: "search", requireSupportedFinding: true, webResearch: research })).rejects.toThrow("Web sources were retrieved, but the worker did not return a supported answer");
    expect(research).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe links, fabricated metadata and malformed web requests", () => {
    expect(safeWebUrl("javascript:alert(1)")).toBe(false);
    expect(safeWebUrl("https://user:secret@example.org")).toBe(false);
    expect(() => validateWebResult({ ...response(), sources: [{ ...response().sources[0], url: "file:///vault.json" }] })).toThrow();
    expect(() => validateWebResult({ ...response(), answer: "", sources: [] })).toThrow();
    expect(() => parseChatReadRequests([{ ...webRead, id: "note-1" }])).toThrow();
    expect(isChatEvidence({ id: "e1", kind: "web", entityId: "fake", title: "Fake", version: "v", start: 0, end: 1, text: "x", offsetUnit: "utf16" })).toBe(false);
  });

  it("reads the complete long research in exact pages and resumes without another paid search", async () => {
    const complete = "Opening finding.\n" + "Full research 😀. ".repeat(1_500) + "\nFinal qualification: correlation does not establish causation [7].";
    const research = vi.fn(async () => ({ ...response(), answer: complete }));
    const state = snapshot();
    let checkpoint: ChatReadingCheckpoint | undefined;
    const pages: string[] = [];
    let nextStart = 0;
    // Stop after reading the first page, retaining exactly the admitted result.
    const cancelled = new AbortController();
    await expect(runChatReading(state, "Research", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (!packet.evidence.length) return { reply: "", readRequests: [webRead] };
      const page = packet.results[0];
      expect(page.synthesis.length).toBeLessThanOrEqual(12_000);
      expect(page.synthesisComplete).toBe(false);
      pages.push(page.synthesis); nextStart = page.nextStart;
      cancelled.abort(new Error("Pause"));
      return { reply: "" };
    }, { webResearch: research, signal: cancelled.signal, onCheckpoint: value => { checkpoint = value; } })).rejects.toThrow("Pause");
    expect(checkpoint?.webResults?.[0].result.answer).toBe(complete);
    expect(checkpoint?.webAttempts).toBe(1);
    let first = true;
    const result = await runChatReading(state, "Research", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (first) { first = false; return { reply: "", readRequests: [{ kind: "web", id: "response_1", query: "", start: nextStart }] }; }
      const page = packet.results[0];
      expect(page.citations[0]).toEqual({ providerId: 7, evidenceId: "e1" });
      expect(page.synthesisRange).toMatchObject({ start: nextStart, total: complete.length, offsetUnit: "utf16" });
      pages.push(page.synthesis); nextStart = page.nextStart;
      if (page.nextStart !== null) return { reply: "", readRequests: [{ kind: "web", id: page.responseId, query: "", start: page.nextStart }] };
      expect(page.synthesis).toContain("Final qualification");
      return { reply: "The finding retains its qualification [[e1]]." };
    }, { purpose: "search", webResearch: research, resume: checkpoint, onCheckpoint: value => { checkpoint = value; } });
    expect(pages.join("")).toBe(complete);
    expect(research).toHaveBeenCalledTimes(1);
    expect(result.webResearch).toEqual({ attempted: 1, completed: 1 });
    expect(result.coverage?.webSearches).toBe(1);
    expect(checkpoint?.evidence).toHaveLength(2);
    expect(checkpoint?.webResults?.[0].result.answer).toBe(complete);
  });

  it("never uses a retained research page as a new web request or a cross-worker read", async () => {
    const research = vi.fn(async () => response());
    let turn = 0;
    await runChatReading(snapshot(), "Research", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (turn++ === 0) return { reply: "", readRequests: [{ kind: "web", id: "other_worker_response", query: "", start: 12_000 }] };
      expect(packet.results[0].error).toContain("not retained by this worker");
      return { reply: "That research is unavailable in this worker." };
    }, { webResearch: research });
    expect(research).not.toHaveBeenCalled();
    expect(() => parseChatReadRequests([{ ...webRead, id: "response_1" }])).toThrow();
    expect(() => parseChatReadRequests([{ ...webRead, start: 1 }])).toThrow();
  });

  it("keeps Unicode and words intact at research page boundaries", () => {
    const text = "a".repeat(11_999) + "😀 qualification.";
    const first = webSynthesisPage(text);
    expect(first.synthesis).toBe("a".repeat(11_999));
    const second = webSynthesisPage(text, first.nextStart!);
    expect(first.synthesis + second.synthesis).toBe(text);
    expect(() => webSynthesisPage(text, 12_000)).toThrow("offset");
    expect(() => webSynthesisPage(text, text.length + 1)).toThrow("offset");
    expect(() => webSynthesisPage(text, -1)).toThrow("offset");
  });
});
