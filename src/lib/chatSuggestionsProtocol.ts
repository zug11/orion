import type { ChatPromptSuggestion, ChatResult } from "../types";
import { chatPromptAllowsNoteCreation } from "./chat";
import protocol from "./chatSuggestionsProtocol.json";

export const CHAT_SUGGESTIONS_INSTRUCTIONS = protocol.instructions;
export const CHAT_SUGGESTIONS_SCHEMA = protocol.schema;
export const MAX_CHAT_SUGGESTION_CONTEXT_BYTES = 32_000;
export interface ChatSuggestionEvidence {
  id: string;
  kind: "note" | "source";
  entityId: string;
  title: string;
  text: string;
}
export interface ChatSuggestionContext {
  spaceId: string;
  spaceName: string;
  attachedNoteId: string | null;
  evidence: ChatSuggestionEvidence[];
  directory: { id: string; title: string }[];
  previousPrompts: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(value).length === names.length && names.every(name => name in value);
}
function text(value: unknown, max: number, nonempty = true): value is string {
  return typeof value === "string" && [...value].length <= max && (!nonempty || Boolean(value.trim()));
}

export function parseChatSuggestionContext(value: string | undefined): ChatSuggestionContext {
  if (!value || new TextEncoder().encode(value).length > MAX_CHAT_SUGGESTION_CONTEXT_BYTES) {
    throw new Error("Chat's suggestion context exceeded its limit.");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("Chat received invalid suggestion context."); }
  if (!record(parsed) || !keys(parsed, ["spaceId", "spaceName", "attachedNoteId", "evidence", "directory", "previousPrompts"]) ||
    !text(parsed.spaceId, 200) || !text(parsed.spaceName, 300, false) ||
    !(parsed.attachedNoteId === null || text(parsed.attachedNoteId, 200)) ||
    !Array.isArray(parsed.evidence) || parsed.evidence.length > 8 || parsed.evidence.some(item =>
      !record(item) || !keys(item, ["id", "kind", "entityId", "title", "text"]) ||
      !text(item.id, 200) || !["note", "source"].includes(String(item.kind)) || !text(item.entityId, 200) ||
      !text(item.title, 300, false) || !text(item.text, 2_000)) ||
    !Array.isArray(parsed.directory) || parsed.directory.length > 12 || parsed.directory.some(item =>
      !record(item) || !keys(item, ["id", "title"]) || !text(item.id, 200) || !text(item.title, 300, false)) ||
    !Array.isArray(parsed.previousPrompts) || parsed.previousPrompts.length > 8 || parsed.previousPrompts.some(item => !text(item, 260))) {
    throw new Error("Chat received invalid suggestion context.");
  }
  const context = parsed as unknown as ChatSuggestionContext;
  if (new Set(context.evidence.map(item => item.id)).size !== context.evidence.length ||
    new Set(context.directory.map(item => item.id)).size !== context.directory.length ||
    (context.attachedNoteId !== null && !context.evidence.some(item => item.kind === "note" && item.entityId === context.attachedNoteId))) {
    throw new Error("Chat received invalid suggestion context.");
  }
  return context;
}

/** Conservative model-output check, never an authority detector for ordinary user messages. */
function discussRequestsEdit(prompt: string): boolean {
  const words: string[] = prompt.toLowerCase().match(/[a-z]+/gu) ?? [];
  const first = words[0] === "please" ? words[1] : words[0];
  const you = words.indexOf("you");
  const afterYou = you < 0 ? [] : words.slice(you + 1, you + 4).filter(word => !["please", "to"].includes(word));
  return words.some(word => protocol.discussEditVerbs.includes(word)) ||
    protocol.discussActionStarters.includes(first ?? "") || protocol.discussActionStarters.includes(afterYou[0] ?? "");
}

export function parseChatSuggestionResult(value: unknown, context: ChatSuggestionContext): ChatResult {
  if (!record(value) || !keys(value, ["suggestions"]) || !Array.isArray(value.suggestions) ||
    value.suggestions.length < 2 || value.suggestions.length > 4) {
    throw new Error("Chat returned invalid prompt suggestions.");
  }
  const evidence = new Map(context.evidence.map(item => [item.id, item]));
  const prompts = new Set<string>();
  const suggestions = value.suggestions.map((item): ChatPromptSuggestion => {
    if (!record(item) || !keys(item, ["prompt", "intent", "evidenceIds"]) || !text(item.prompt, 260) ||
      !["discuss", "edit", "create"].includes(String(item.intent)) || !Array.isArray(item.evidenceIds) ||
      item.evidenceIds.length < 1 || item.evidenceIds.length > 4 ||
      item.evidenceIds.some(id => typeof id !== "string" || !evidence.has(id)) ||
      new Set(item.evidenceIds).size !== item.evidenceIds.length ||
      (item.intent === "discuss" && discussRequestsEdit(item.prompt)) ||
      (item.intent === "create" ? !/^Create a note\b/u.test(item.prompt) || !chatPromptAllowsNoteCreation(item.prompt) : chatPromptAllowsNoteCreation(item.prompt)) ||
      (item.intent === "edit" && (!context.attachedNoteId || !item.evidenceIds.some(id => {
        const passage = evidence.get(id); return passage?.kind === "note" && passage.entityId === context.attachedNoteId;
      })))) {
      throw new Error("Chat returned invalid prompt suggestions.");
    }
    const key = item.prompt.trim().toLocaleLowerCase();
    if (prompts.has(key)) throw new Error("Chat returned duplicate prompt suggestions.");
    prompts.add(key);
    return { prompt: item.prompt, intent: item.intent as ChatPromptSuggestion["intent"], evidenceIds: [...item.evidenceIds] as string[] };
  });
  return { reply: "", suggestions };
}
