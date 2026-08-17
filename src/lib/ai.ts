import type { Settings } from "../types";

export type AIProvider = "anthropic" | "openai";

/**
 * The canonical model each provider falls back to when no explicit choice
 * applies. These IDs mirror the defaults already used by the browser-preview
 * request builders and the Settings model list.
 */
export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

export function aiProviderForModel(model: string | undefined): AIProvider {
  return model?.startsWith("claude-") ? "anthropic" : "openai";
}

export function defaultModelForProvider(provider: AIProvider): string {
  return provider === "anthropic"
    ? DEFAULT_ANTHROPIC_MODEL
    : DEFAULT_OPENAI_MODEL;
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
