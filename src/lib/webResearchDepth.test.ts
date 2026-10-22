import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult, WebResearchDepth } from "../types";
import { runChatReading } from "./chatReading";
import { CHAT_READ_REQUESTS_SCHEMA, parseChatReadRequests } from "./chatReadingProtocol";
import type { ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import { VoiceResearch } from "./voiceResearch";
import { researchWithPerplexity } from "./perplexity";
import { WEB_RESEARCH_PROFILES, type WebResearchResult } from "./webResearch";

vi.mock("./perplexity", () => ({ researchWithPerplexity: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); });
const snapshot = () => createEmptySnapshot("Research", "2026-10-22T00:00:00.000Z", "depth-space");
const result = (id = "response_1"): WebResearchResult => ({ responseId: id, answer: "A supported conclusion [1].",
  retrievedAt: "2026-10-22T00:00:00.000Z", sources: [{ id: 1, title: "Primary evidence", url: "https://example.org/paper", snippet: "Supported conclusion." }] });
const read = (depth?: WebResearchDepth) => ({ kind: "web" as const, id: "", query: "A public research question", start: null, ...(depth ? { depth } : {}) });
const driver = (depth?: WebResearchDepth) => async (request: ChatRequest): Promise<ChatResult> => {
  const packet = JSON.parse(request.readingContext!);
  return packet.evidence.length ? { reply: `Conclusion [[${packet.evidence[0].id}]].`, readRequests: [] }
    : { reply: "", readRequests: [read(depth)] };
};

describe("adaptive web depth", () => {
  it.each(["quick", "standard", "deep"] as const)("passes the reader's %s choice to research without another routing call", async depth => {
    const research = vi.fn(async () => result()), readAnswer = vi.fn(driver(depth));
    await runChatReading(snapshot(), "Research this question", readAnswer, { webResearch: research });
    expect(research).toHaveBeenCalledWith(read().query, expect.any(AbortSignal), depth);
    expect(readAnswer).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readAnswer.mock.calls[0][0].readingContext!).webResearch.depths).toEqual(["quick", "standard", "deep"]);
  });

  it("retains backward compatibility and rejects depth on local reads or stored pages", () => {
    expect(parseChatReadRequests([read()])).toEqual([read()]);
    expect(parseChatReadRequests([{ ...read(), depth: null }])).toHaveLength(1);
    expect(CHAT_READ_REQUESTS_SCHEMA.items.required).toContain("depth");
    for (const request of [{ ...read(), depth: "unlimited" }, { ...read("deep"), kind: "search" },
      { ...read("deep"), id: "response_1", query: "", start: 12000 }, { ...read("deep"), maxSteps: 999 }]) {
      expect(() => parseChatReadRequests([request])).toThrow("invalid reading request");
    }
  });

  it("can deepen the same question, then reuses the deeper result for a simpler request and checkpoint resume", async () => {
    let calls = 0, turn = 0, checkpoint: ChatReadingCheckpoint | undefined;
    const research = vi.fn(async () => result(`response_${++calls}`));
    await runChatReading(snapshot(), "Compare the conflicting evidence", async request => {
      const packet = JSON.parse(request.readingContext!);
      if (turn === 1) expect(packet.results[0].depth).toBe("quick");
      if (turn === 2 || turn === 3) expect(packet.results[0].depth).toBe("deep");
      const depth = (["quick", "deep", "standard"] as const)[turn++];
      return depth ? { reply: "", readRequests: [read(depth)] } : { reply: "Conclusion [[e1]]." };
    }, { webResearch: research, onCheckpoint: value => { checkpoint = value; } });
    expect(research.mock.calls).toHaveLength(2);
    expect(checkpoint?.webResults?.map(item => item.depth)).toEqual(["quick", "deep"]);
    const resumed = await runChatReading(snapshot(), "Compare the conflicting evidence", driver("deep"), { webResearch: research, resume: checkpoint });
    expect(research).toHaveBeenCalledTimes(2);
    expect(resumed.webResearch).toEqual({ attempted: 2, completed: 2 });
  });

  it("does not grant Web capability just because a deep lookup was requested", async () => {
    const research = vi.fn(async () => result());
    let turn = 0;
    await runChatReading(snapshot(), "Research deeply", async request => {
      if (!turn++) return { reply: "", readRequests: [read("deep")] };
      expect(JSON.parse(request.readingContext!).results[0].error).toContain("Web research is off");
      return { reply: "Web must be enabled." };
    });
    expect(research).not.toHaveBeenCalled();
    expect(researchWithPerplexity).not.toHaveBeenCalled();
  });

  it("allows a deep typed lookup to outlive the local three-minute limit", async () => {
    vi.useFakeTimers();
    const onDeadlineChanged = vi.fn();
    const research = vi.fn(() => new Promise<WebResearchResult>(resolve => setTimeout(() => resolve(result()), 210_000)));
    const running = runChatReading(snapshot(), "Investigate thoroughly", driver("deep"), { webResearch: research, onDeadlineChanged });
    const finished = expect(running).resolves.toMatchObject({ evidence: [expect.objectContaining({ kind: "web" })] });
    await vi.advanceTimersByTimeAsync(210_000);
    await finished;
    expect(onDeadlineChanged).toHaveBeenCalledTimes(1);
    expect(WEB_RESEARCH_PROFILES.deep.timeoutMs).toBeGreaterThan(210_000);
  });

  it("extends the voice worker's outer deadline too, preserving its work identity", async () => {
    vi.useFakeTimers();
    const state = snapshot(); state.settings.apiKeyConfigured = true; state.settings.perplexityApiKeyConfigured = true;
    vi.mocked(researchWithPerplexity).mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(result()), 210_000)));
    const voice = new VoiceResearch({ snapshot: () => state, driver: driver("deep"), onProgress: vi.fn(), onResult: vi.fn(), deliver: vi.fn(), commit: vi.fn() });
    const running = voice.run("depth-worker", "Investigate the public evidence thoroughly", "");
    await vi.advanceTimersByTimeAsync(210_000);
    await running;
    expect(voice.getJobs()[0]).toMatchObject({ id: "depth-worker", state: "completed" });
  });

  it("keeps local-only work at three minutes even when Web is available", async () => {
    vi.useFakeTimers();
    const research = vi.fn(async () => result()), onDeadlineChanged = vi.fn();
    const running = runChatReading(snapshot(), "Discuss my notes", (_request, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }), { webResearch: research, onDeadlineChanged }).catch(error => error);
    await vi.advanceTimersByTimeAsync(180_001);
    expect(await running).toMatchObject({ message: expect.stringContaining("reading time limit") });
    expect(research).not.toHaveBeenCalled();
    expect(onDeadlineChanged).not.toHaveBeenCalled();
  });

  it("lets productive deep research continue beyond fifteen minutes", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now(), onDeadlineChanged = vi.fn();
    let turn = 0;
    const research = vi.fn((_query: string, signal: AbortSignal) => new Promise<WebResearchResult>((resolve, reject) => {
      const index = turn;
      const timer = setTimeout(() => resolve({ ...result(`response_${index}`), sources: [{ ...result().sources[0], url: `https://example.org/paper-${index}` }] }), 310_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }));
    const running = runChatReading(snapshot(), "A substantial investigation", async request => {
      expect(JSON.parse(request.readingContext!).finalizing).toBe(false);
      return turn < 4 ? { reply: "", readRequests: [{ ...read("deep"), query: `Public subquestion ${++turn}` }] }
        : { reply: "Conclusion [[e1]]." };
    }, { webResearch: research, onDeadlineChanged });
    await vi.advanceTimersByTimeAsync(1_240_001);
    expect(await running).toMatchObject({ webResearch: { attempted: 4, completed: 4 } });
    expect(research).toHaveBeenCalledTimes(4);
    expect(onDeadlineChanged).toHaveBeenLastCalledWith(startedAt + 930_000 + WEB_RESEARCH_PROFILES.deep.timeoutMs + 60_000);
  });
});
