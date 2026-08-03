import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import {
  aiProviderForModel,
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "./ai";

describe("AI provider selection", () => {
  it("routes Claude model IDs to Anthropic", () => {
    expect(aiProviderForModel("claude-fable-5")).toBe("anthropic");
    expect(aiProviderForModel("claude-opus-5")).toBe("anthropic");
    expect(aiProviderForModel("claude-sonnet-5")).toBe("anthropic");
  });

  it("keeps GPT and missing model IDs on OpenAI", () => {
    expect(aiProviderForModel("gpt-5.6-sol")).toBe("openai");
    expect(aiProviderForModel(undefined)).toBe("openai");
  });

  it("uses only the selected provider's configured status", () => {
    const settings = {
      ...defaultSettings,
      model: "claude-opus-5",
      apiKeyConfigured: true,
      anthropicApiKeyConfigured: false,
    };
    expect(isSelectedAIConfigured(settings)).toBe(false);
    expect(selectedAIProviderName(settings)).toBe("Anthropic");
    expect(
      isSelectedAIConfigured({
        ...settings,
        anthropicApiKeyConfigured: true,
      }),
    ).toBe(true);
  });
});
