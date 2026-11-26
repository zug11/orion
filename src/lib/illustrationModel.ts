import type { ReasoningEffort, Settings } from "../types";
import { isSelectedAIConfigured } from "./ai";
import { isChatGPTModel } from "./chatgpt";
import { loadIllustrationModelCatalog } from "./storage";

const astraId = /^gpt-(\d{1,3}(?:\.\d{1,3})*)-astra(?:-(latest|\d{4}-\d{2}-\d{2}))?$/u;
const efforts: ReasoningEffort[] = ["high", "xhigh", "max", "medium", "low", "none"];

export interface IllustrationModelItem {
  id: string;
  name?: string;
  efforts?: string[];
  planAccountId?: string;
}

export function drawingModelPolicyLabel(settings: Pick<Settings, "model">): string {
  if (settings.model.startsWith("claude-")) return settings.model;
  return isChatGPTModel(settings.model) ? "Astra · ChatGPT plan" : "Astra · OpenAI API";
}

export function isAstraDrawingModel(model: string) {
  return astraId.test(model.replace(/^chatgpt:/u, ""));
}

function compareVersions(a: string, b: string) {
  const match = (id: string) => astraId.exec(id.replace(/^chatgpt:/u, ""))!;
  const [, leftVersion, variantA = ""] = match(a);
  const [, rightVersion, variantB = ""] = match(b);
  const left = leftVersion.split(".").map(Number);
  const right = rightVersion.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff) return diff;
  }
  // Prefer the stable catalog alias over a dated snapshot of that version.
  if (!variantA || !variantB) return Number(Boolean(variantA)) - Number(Boolean(variantB));
  return variantB.localeCompare(variantA);
}

export function chooseIllustrationModel(settings: Settings, items: IllustrationModelItem[]): { settings: Settings; label: string } {
  const plan = isChatGPTModel(settings.model);
  const available = items.filter(item => isChatGPTModel(item.id) === plan && isAstraDrawingModel(item.id));
  const exact = available.find(item => item.id === settings.model);
  if (isAstraDrawingModel(settings.model) && !exact) {
    throw new Error("Your selected Astra model is unavailable on this connection. Check the model in Settings.");
  }
  const selected = exact ?? available.sort((a, b) => compareVersions(a.id, b.id))[0];
  if (!selected) throw new Error("This connection does not list an Astra model for drawing. Choose a connection with Astra access or select Anthropic in Settings.");
  // API-key catalogs generally list IDs alone. When the account publishes
  // effort capabilities use only those advertised by that specific model.
  const configured = settings.reasoningEffort;
  const higher = configured === "xhigh" || configured === "max";
  const supported = selected.efforts;
  let effort: ReasoningEffort | undefined = "high";
  if (supported) {
    effort = higher && supported.includes(configured) ? configured : efforts.find(option => supported.includes(option));
  }
  if (!effort) throw new Error("The Astra model does not list a reasoning effort Orion supports.");
  if (plan && selected.planAccountId && settings.chatgptAccountId && settings.chatgptAccountId !== selected.planAccountId) {
    throw new Error("The ChatGPT account changed. Start the drawing again.");
  }
  const name = selected.name || selected.id.replace(/^chatgpt:/u, "");
  return {
    settings: {
      ...settings, model: selected.id, reasoningEffort: effort,
      ...(plan && selected.planAccountId ? { chatgptAccountId: selected.planAccountId } : {}),
    },
    label: [name, effort + " reasoning", plan ? "ChatGPT plan" : "OpenAI API"].join(" · "),
  };
}

export async function resolveIllustrationModel(settings: Settings, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  if (!isSelectedAIConfigured(settings)) throw new Error("Connect your selected AI provider in Settings to draw an illustration.");
  if (settings.model.startsWith("claude-")) return { settings, label: settings.model + " · Anthropic" };
  const catalog = await loadIllustrationModelCatalog(settings, signal);
  if (signal.aborted) throw signal.reason;
  if (catalog === null && !isChatGPTModel(settings.model)) {
    const id = isAstraDrawingModel(settings.model) ? settings.model : "gpt-6.2-astra";
    const route = chooseIllustrationModel(settings, [{ id }]);
    return { ...route, label: route.label + " (model list restricted)" };
  }
  return chooseIllustrationModel(settings, catalog ?? []);
}

export function apiIllustrationModelItems(value: unknown): IllustrationModelItem[] {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) {
    throw new Error("OpenAI returned an invalid model catalog.");
  }
  const items: IllustrationModelItem[] = [];
  for (const model of value.data) {
    if (!model || typeof model.id !== "string" || model.id.length > 110 || !astraId.test(model.id)) continue;
    const item: IllustrationModelItem = { id: model.id };
    if (typeof model.display_name === "string") item.name = model.display_name.slice(0, 128);
    const supported = model.supported_reasoning_levels ?? model.supported_reasoning_efforts;
    if (Array.isArray(supported)) {
      item.efforts = supported.map(level => typeof level === "string" ? level : level?.effort).filter(level => typeof level === "string");
    }
    items.push(item);
  }
  return items;
}
