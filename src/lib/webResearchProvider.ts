import type { Settings } from "../types";
import { aiProviderForModel, isSelectedAIConfigured } from "./ai";
import { isChatGPTModel } from "./chatgpt";
import { researchWithOpenAI } from "./openaiWeb";
import { researchWithPerplexity } from "./perplexity";
import type { WebResearch } from "./webResearch";

export type WebResearchRoute = { provider: "perplexity"; label: "Perplexity" } |
  { provider: "openai"; label: "OpenAI API" | "ChatGPT plan"; model: string };

/** Resolve before admission. An unavailable explicit choice never bills another connection. */
export function resolveWebResearchProvider(settings: Settings): WebResearchRoute | undefined {
  const choice = settings.webResearchProvider ?? "auto";
  if (choice !== "auto" && choice !== "openai" && choice !== "perplexity") return;
  if (choice !== "openai" && settings.perplexityApiKeyConfigured) return { provider: "perplexity", label: "Perplexity" };
  if (choice === "perplexity" || aiProviderForModel(settings.model) !== "openai" || !isSelectedAIConfigured(settings)) return;
  return { provider: "openai", label: isChatGPTModel(settings.model) ? "ChatGPT plan" : "OpenAI API", model: settings.model };
}

export function webResearchUnavailableReason(settings: Settings): string {
  if (settings.webResearchProvider === "perplexity") return "Add a Perplexity key in Settings to use Web.";
  if (aiProviderForModel(settings.model) !== "openai") return settings.webResearchProvider === "openai"
    ? "Choose an OpenAI or ChatGPT model under Intelligence to use OpenAI web search."
    : "Choose a connected OpenAI or ChatGPT model, or add a Perplexity key in Settings to use Web.";
  return isChatGPTModel(settings.model)
    ? "Connect the selected ChatGPT account in Settings to use Web."
    : "Add an OpenAI API key in Settings, or choose a connected ChatGPT model, to use Web.";
}

export function createWebResearch(settings: Settings): WebResearch | undefined {
  const route = resolveWebResearchProvider(settings);
  if (route?.provider === "perplexity") return researchWithPerplexity;
  if (route?.provider === "openai") return researchWithOpenAI(route.model);
}
