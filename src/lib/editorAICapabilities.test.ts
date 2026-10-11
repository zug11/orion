import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import { resolveEditorAICapabilities } from "./editorAICapabilities";

describe("editor AI capabilities", () => {
  it.each([
    ["gpt-6-astra", false, false, false, false],
    ["gpt-6-astra", false, true, false, false],
    ["gpt-6-astra", true, false, true, true],
    ["gpt-6-astra", true, true, true, true],
    ["claude-sonnet-5", false, false, false, false],
    ["claude-sonnet-5", true, false, false, false],
    ["claude-sonnet-5", false, true, true, false],
    ["claude-sonnet-5", true, true, true, true],
  ])("gates %s with OpenAI=%s and Anthropic=%s", (
    model, apiKeyConfigured, anthropicApiKeyConfigured, writingEnabled, imageGenerationEnabled,
  ) => {
    const result = resolveEditorAICapabilities({
      ...defaultSettings, model, apiKeyConfigured, anthropicApiKeyConfigured,
    });
    expect(result.writingEnabled).toBe(writingEnabled);
    expect(result.imageGenerationEnabled).toBe(imageGenerationEnabled);
    expect(Boolean(result.writingUnavailableReason)).toBe(!writingEnabled);
    expect(Boolean(result.imageUnavailableReason)).toBe(!imageGenerationEnabled);
  });

  it("names both missing keys when a selected Anthropic planner has neither", () => {
    const result = resolveEditorAICapabilities({
      ...defaultSettings, model: "claude-sonnet-5", apiKeyConfigured: false, anthropicApiKeyConfigured: false,
    });
    expect(result.writingUnavailableReason).toBe("Add an Anthropic key in Settings to write or rewrite with the selected model.");
    expect(result.imageUnavailableReason).toBe("Add OpenAI and Anthropic keys in Settings to generate images with the selected planning model.");
  });

  it("explains the missing selected planner key when OpenAI image rendering is configured", () => {
    const result = resolveEditorAICapabilities({
      ...defaultSettings, model: "claude-sonnet-5", apiKeyConfigured: true, anthropicApiKeyConfigured: false,
    });
    expect(result.imageUnavailableReason).toBe("Add an Anthropic key in Settings to plan images with the selected model.");
  });

  it("leaves text actions enabled while explaining a missing OpenAI image key", () => {
    const result = resolveEditorAICapabilities({
      ...defaultSettings, model: "claude-sonnet-5", apiKeyConfigured: false, anthropicApiKeyConfigured: true,
    });
    expect(result.writingEnabled).toBe(true);
    expect(result.writingUnavailableReason).toBeUndefined();
    expect(result.imageUnavailableReason).toBe("Add an OpenAI key in Settings to generate images.");
  });
});
