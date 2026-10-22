// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { researchWithPerplexity, savePerplexityKey } from "./perplexity";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
afterEach(() => { vi.resetAllMocks(); vi.mocked(isTauri).mockReturnValue(true); });
it("preserves the native actionable failure without logging the key", async () => {
  vi.mocked(invoke).mockRejectedValue("Perplexity needs API credit. (WEB_HTTP_402)");
  await expect(researchWithPerplexity("A public question", new AbortController().signal)).rejects.toThrow("WEB_HTTP_402");
});
it("cancels only the admitted native request and releases the caller immediately", async () => {
  const controller = new AbortController();
  vi.mocked(invoke).mockImplementation((command) => command === "research_perplexity" ? new Promise(() => {}) : Promise.resolve(true));
  const work = researchWithPerplexity("A public question", controller.signal);
  const requestId = (vi.mocked(invoke).mock.calls[0][1] as { requestId: string }).requestId;
  controller.abort(new Error("This worker was cancelled"));
  await expect(work).rejects.toThrow("This worker was cancelled");
  expect(invoke).toHaveBeenLastCalledWith("cancel_perplexity_research", { requestId });
});
it("does not admit already cancelled work or persist credentials in browser storage", async () => {
  const storageBefore = JSON.stringify(localStorage);
  const controller = new AbortController(); controller.abort();
  await expect(researchWithPerplexity("Question", controller.signal)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
  vi.mocked(isTauri).mockReturnValue(false);
  await expect(savePerplexityKey("test-only")).rejects.toThrow("desktop Orion app");
  expect(invoke).not.toHaveBeenCalled();
  expect(JSON.stringify(localStorage)).toBe(storageBefore);
});
