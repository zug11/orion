import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { VoiceResearch, voiceContext } from "./voiceResearch";
import { researchWithOpenAI } from "./openaiWeb";
import { researchWithPerplexity } from "./perplexity";
import type { ChatRequest, ChatResult } from "../types";
const native = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock("./openaiWeb", () => ({ researchWithOpenAI: vi.fn(() => native.search) }));
vi.mock("./perplexity", () => ({ researchWithPerplexity: vi.fn() }));
const response = () => ({ responseId: "openai-search", retrievedAt: "2026-11-15T00:00:00.000Z", answer: "A cited finding.",
  sources: [{ id: 1, title: "Public source", url: "https://example.com/research", snippet: "A provider-generated account of a public finding.", evidenceType: "cited_summary" as const }] });
const driver = async (request: ChatRequest): Promise<ChatResult> => {
  const packet = JSON.parse(request.readingContext!);
  expect(request.allowNoteActions).toBe(false);
  return packet.evidence.length ? { reply: "The public finding is qualified [[e1]]." }
    : { reply: "", readRequests: [{ kind: "web", id: "", query: "A public research question", start: null, depth: "standard" }] };
};
beforeEach(() => { vi.clearAllMocks(); native.search.mockReset().mockResolvedValue(response()); });

describe("OpenAI web research in voice workers", () => {
  it.each(["gpt-6.1-sol", "chatgpt:gpt-6.1-sol"])("uses %s for the same read-only worker with retained provenance", async model => {
    const snapshot = createEmptySnapshot("Research", "2026-11-15T00:00:00.000Z", "research");
    Object.assign(snapshot.settings, { model, apiKeyConfigured: !model.startsWith("chatgpt:"), chatgptConfigured: model.startsWith("chatgpt:"), chatgptAccountId: "account-a" });
    const commit = vi.fn(), deliver = vi.fn();
    const engine = new VoiceResearch({ snapshot: () => snapshot, driver, commit, deliver, onProgress: vi.fn(), onResult: vi.fn() });
    expect(JSON.parse(voiceContext(snapshot, "")).webResearchAvailable).toBe(true);
    await engine.run("research-worker", "Research this public topic", "", undefined, null, false, undefined, { subject: "Public research", focus: "Investigate the public topic." });
    expect(researchWithOpenAI).toHaveBeenCalledExactlyOnceWith(model); expect(native.search).toHaveBeenCalledTimes(1); expect(researchWithPerplexity).not.toHaveBeenCalled();
    expect(engine.getJobs()[0]).toMatchObject({ state: "completed", result: { webResearch: { attempted: 1, completed: 1 }, evidence: [expect.objectContaining({ kind: "web", web: expect.objectContaining({ evidenceType: "cited_summary" }) })] } });
    expect(commit).not.toHaveBeenCalled(); expect(snapshot.sources).toEqual([]); engine.dispose();
  });

  it("withholds an old account's in-flight finding after the selected ChatGPT account changes", async () => {
    const snapshot = createEmptySnapshot("Research", "2026-11-15T00:00:00.000Z", "research");
    Object.assign(snapshot.settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
    let finish!: (value: ReturnType<typeof response>) => void;
    native.search.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onResult = vi.fn(), commit = vi.fn();
    const engine = new VoiceResearch({ snapshot: () => snapshot, driver, commit, onResult, deliver: vi.fn(), onProgress: vi.fn() });
    const work = engine.run("old-account", "Research the public topic", "");
    await vi.waitFor(() => expect(native.search).toHaveBeenCalledOnce());
    snapshot.settings.chatgptAccountId = "account-b"; finish(response()); await work;
    expect(engine.getJobs()[0].state).toBe("failed"); expect(onResult).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); engine.dispose();
  });

  it("blocks a second submission on an amended utterance and allows the worker's explicit Retry", async () => {
    const snapshot = createEmptySnapshot("Research", "2026-11-18", "research");
    Object.assign(snapshot.settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
    let finish!: (value: ReturnType<typeof response>) => void;
    native.search.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const commit = vi.fn(), onResult = vi.fn();
    const engine = new VoiceResearch({ snapshot: () => snapshot, commit, onResult, deliver: vi.fn(), onProgress: vi.fn(),
      driver: async request => {
        const packet = JSON.parse(request.readingContext!);
        if (!packet.evidence.length && (packet.finalizing || packet.results.some((r: { error?: string }) => r.error))) return { reply: "No confirmed source yet." };
        return driver(request);
      } });
    const assignment = { subject: "Public research", focus: "Investigate the public topic.", publicQuery: "A public research question" };
    const old = engine.run("worker", "Research the public topic", "", undefined, null, false, undefined, assignment);
    await vi.waitFor(() => expect(native.search).toHaveBeenCalledOnce());
    await engine.run("worker", "Research the public topic, especially its origins.", "", undefined, null, false, undefined, assignment);
    expect(engine.getJobs()[0]).toMatchObject({ state: "failed", revision: 2 });
    expect(native.search).toHaveBeenCalledOnce();
    finish(response()); await old;
    expect(onResult).not.toHaveBeenCalled();
    await engine.retry("worker", "");
    expect(native.search).toHaveBeenCalledTimes(2);
    expect(engine.getJobs()[0]).toMatchObject({ state: "completed", revision: 3, result: { webResearch: { attempted: 2, completed: 1 } } });
    expect(engine.getJobs()[0].result?.webResearch?.issue).toBeUndefined();
    expect(onResult).toHaveBeenCalledOnce(); expect(commit).not.toHaveBeenCalled(); engine.dispose();
  });
});
