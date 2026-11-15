import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { createWebResearch, resolveWebResearchProvider, webResearchUnavailableReason } from "./webResearchProvider";
import { researchWithOpenAI } from "./openaiWeb";
import { researchWithPerplexity } from "./perplexity";
vi.mock("./openaiWeb", () => ({ researchWithOpenAI: vi.fn() }));
vi.mock("./perplexity", () => ({ researchWithPerplexity: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("captured web research provider", () => {
  it("preserves Perplexity precedence in Automatic while allowing an explicit OpenAI choice", () => {
    const settings = { ...defaultSettings, model: "gpt-6.1-sol", apiKeyConfigured: true, perplexityApiKeyConfigured: true };
    expect(resolveWebResearchProvider(settings)).toEqual({ provider: "perplexity", label: "Perplexity" });
    expect(createWebResearch(settings)).toBe(researchWithPerplexity);
    expect(resolveWebResearchProvider({ ...settings, webResearchProvider: "openai" })).toEqual({ provider: "openai", label: "OpenAI API", model: settings.model });
  });

  it.each(["gpt-6.1-sol", "chatgpt:gpt-6.1-sol"])("uses the exact selected %s route without another credential", model => {
    const settings = { ...defaultSettings, model, apiKeyConfigured: !model.startsWith("chatgpt:"), chatgptConfigured: model.startsWith("chatgpt:"), chatgptAccountId: "account-a" };
    const research = vi.fn(); vi.mocked(researchWithOpenAI).mockReturnValue(research);
    expect(resolveWebResearchProvider(settings)).toEqual({ provider: "openai", label: model.startsWith("chatgpt:") ? "ChatGPT plan" : "OpenAI API", model });
    expect(createWebResearch(settings)).toBe(research);
    expect(researchWithOpenAI).toHaveBeenCalledExactlyOnceWith(model);
  });

  it("does not silently replace an unavailable explicit provider or bill another OpenAI connection", () => {
    const both = { ...defaultSettings, model: "chatgpt:gpt-6.1-sol", apiKeyConfigured: true, chatgptConfigured: false, perplexityApiKeyConfigured: true };
    expect(createWebResearch({ ...both, webResearchProvider: "openai" })).toBeUndefined();
    expect(createWebResearch({ ...both, model: "gpt-6.1-sol", apiKeyConfigured: false, chatgptConfigured: true, webResearchProvider: "openai" })).toBeUndefined();
    expect(createWebResearch({ ...both, perplexityApiKeyConfigured: false, webResearchProvider: "perplexity" })).toBeUndefined();
    expect(createWebResearch({ ...both, model: "claude-sonnet-5", anthropicApiKeyConfigured: true, webResearchProvider: "openai" })).toBeUndefined();
    expect(webResearchUnavailableReason({ ...both, model: "claude-sonnet-5", webResearchProvider: "openai" })).toContain("Choose an OpenAI or ChatGPT model");
    expect(researchWithOpenAI).not.toHaveBeenCalled(); expect(researchWithPerplexity).not.toHaveBeenCalled();
  });

  it("captures its route once and never falls back after an admitted search fails", async () => {
    const settings = { ...defaultSettings, model: "gpt-6.1-sol", apiKeyConfigured: true, perplexityApiKeyConfigured: true, webResearchProvider: "openai" as const };
    const search = vi.fn().mockRejectedValue(new Error("Model web access is unavailable"));
    vi.mocked(researchWithOpenAI).mockReturnValue(search);
    const captured = createWebResearch(settings)!; settings.model = "chatgpt:gpt-6.1-terra";
    await expect(captured("Public question", new AbortController().signal, "standard")).rejects.toThrow("web access is unavailable");
    expect(researchWithOpenAI).toHaveBeenCalledExactlyOnceWith("gpt-6.1-sol");
    expect(researchWithPerplexity).not.toHaveBeenCalled();
  });
});
