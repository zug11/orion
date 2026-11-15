// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { researchWithOpenAI } from "./openaiWeb";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
afterEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
const result = () => ({ responseId: "web-response", answer: "A cited summary.", retrievedAt: "2026-11-15T00:00:00.000Z",
  sources: [{ id: 1, title: "Source", url: "https://example.com/source", snippet: "A provider summary associated with its source.", evidenceType: "cited_summary" }] });

it.each(["gpt-6.1-sol", "chatgpt:gpt-6.1-sol"])("uses the exact %s model route and retains cited-summary provenance", async model => {
  vi.mocked(invoke).mockResolvedValue(result());
  const response = await researchWithOpenAI(model)("Public question", new AbortController().signal, "deep");
  expect(invoke).toHaveBeenCalledWith("research_openai_web", { requestId: expect.any(String), query: "Public question", depth: "deep", model });
  expect(response.sources[0].evidenceType).toBe("cited_summary");
});

it("cancels only its native request and ignores a late result", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementation(command => command === "research_openai_web" ? new Promise(done => { resolve = done; }) : Promise.resolve(true));
  const controller = new AbortController(), pending = researchWithOpenAI("chatgpt:gpt-6.1-sol")("Public question", controller.signal);
  const requestId = (vi.mocked(invoke).mock.calls[0][1] as { requestId: string }).requestId;
  controller.abort(new Error("Worker cancelled"));
  await expect(pending).rejects.toThrow("Worker cancelled");
  expect(invoke).toHaveBeenLastCalledWith("cancel_openai_web_research", { requestId });
  resolve(result()); await Promise.resolve(); expect(invoke).toHaveBeenCalledTimes(2);
});

it("does not admit cancelled work, unsupported depth, or browser research", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(researchWithOpenAI("gpt-6.1-sol")("Question", controller.signal)).rejects.toThrow();
  await expect(researchWithOpenAI("gpt-6.1-sol")("Question", new AbortController().signal, "unlimited" as "deep")).rejects.toThrow("invalid research depth");
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(researchWithOpenAI("gpt-6.1-sol")("Question", new AbortController().signal)).rejects.toThrow("desktop Orion app");
  expect(invoke).not.toHaveBeenCalled();
});

it("preserves actionable native failures without a second request or provider switch", async () => {
  vi.mocked(invoke).mockRejectedValue("Your ChatGPT workspace does not permit web search. (WEB_UNAVAILABLE)");
  await expect(researchWithOpenAI("chatgpt:gpt-6.1-sol")("Question", new AbortController().signal)).rejects.toThrow("WEB_UNAVAILABLE");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("rejects missing or unsafe source evidence instead of inventing citations", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...result(), sources: [{ ...result().sources[0], url: "file:///private/data" }] });
  await expect(researchWithOpenAI("gpt-6.1-sol")("Question", new AbortController().signal)).rejects.toThrow("invalid or missing source evidence");
});
