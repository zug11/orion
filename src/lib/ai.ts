import type { Settings } from "../types";

export type AIProvider = "anthropic" | "openai";

export function aiProviderForModel(model: string | undefined): AIProvider {
  return model?.startsWith("claude-") ? "anthropic" : "openai";
}

export function isSelectedAIConfigured(settings: Settings): boolean {
  return aiProviderForModel(settings.model) === "anthropic"
    ? settings.anthropicApiKeyConfigured
    : settings.apiKeyConfigured;
}

export function selectedAIProviderName(settings: Settings): string {
  return aiProviderForModel(settings.model) === "anthropic"
    ? "Anthropic"
    : "OpenAI";
}
