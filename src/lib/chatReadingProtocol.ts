import { validWebMetadata } from "./webResearch";
import type { ChatCoverage, ChatEvidence, ChatReadRequest, ChatReadingFinding, ChatVoicePresentation } from "../types";
import protocol from "./chatReadingProtocol.json";

export const CHAT_READING_INSTRUCTIONS = protocol.instructions;
export const CHAT_READ_REQUESTS_SCHEMA = protocol.requestsSchema;
export const CHAT_READING_CHECKPOINT_SCHEMA = protocol.checkpointSchema;
export const CHAT_VOICE_PRESENTATION_SCHEMA = protocol.voiceSchema;
export const MAX_CHAT_READING_CONTEXT_BYTES = protocol.maxContextBytes;
export const MAX_CHAT_READING_EVIDENCE = protocol.maxReadingEvidence;
export const MAX_CHAT_EVIDENCE = 12;
export const MAX_CHAT_PASSAGE_CHARS = 3_000;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseChatVoicePresentation(value: unknown): ChatVoicePresentation | undefined {
  if (value == null) return undefined;
  if (!record(value) || Object.keys(value).sort().join(",") !== "label,summary" ||
    typeof value.label !== "string" || !value.label.trim() || [...value.label].length > 80 || /[\u0000-\u001f]/.test(value.label) ||
    typeof value.summary !== "string" || [...value.summary].length > 360 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.summary)) {
    throw new Error("Chat returned an invalid voice summary (CHAT_VOICE). Try again.");
  }
  return { label: value.label.trim(), summary: value.summary.trim() };
}

export function parseChatReadingFinding(value: unknown): ChatReadingFinding | undefined {
  if (value == null) return undefined;
  const strings = (items: unknown, count: number, width: number) => Array.isArray(items) && items.length <= count &&
    items.every(item => typeof item === "string" && [...item].length <= width);
  if (!record(value) || Object.keys(value).sort().join(",") !== "decisions,finding,openQuestions" ||
      typeof value.finding !== "string" || [...value.finding].length > 1_200 ||
      !strings(value.decisions, 4, 240) || !strings(value.openQuestions, 4, 240)) {
    throw new Error("Chat returned an invalid research checkpoint.");
  }
  return value as unknown as ChatReadingFinding;
}

export function parseChatReadRequests(value: unknown): ChatReadRequest[] {
  if (!Array.isArray(value) || value.length > 4 || value.some((item) =>
    !record(item) || !["id,kind,query,start", "depth,id,kind,query,start"].includes(Object.keys(item).sort().join(",")) ||
    !["search", "cluster", "note", "source", "note-full", "source-full", "related", "web"].includes(String(item.kind)) ||
    typeof item.id !== "string" || [...item.id].length > 200 ||
    typeof item.query !== "string" || [...item.query].length > 600 ||
    (item.start !== null && (!Number.isSafeInteger(item.start) || Number(item.start) < 0 || Number(item.start) > 1_000_000_000)) ||
    (item.depth != null && (!(["quick", "standard", "deep"] as unknown[]).includes(item.depth) || item.kind !== "web" || item.id !== "")) ||
    (item.kind === "search" ? !item.query.trim() || item.id !== ""
      : item.kind === "web" ? item.id === "" ? !item.query.trim() || item.start !== null
        : !/^[\w-]{1,200}$/.test(item.id) || item.start === null || item.query !== ""
      : !item.id.trim())
  )) throw new Error("Chat returned an invalid reading request.");
  return value as ChatReadRequest[];
}

export function parseChatReadingContext(value: string | undefined): Record<string, unknown> {
  if (!value || new TextEncoder().encode(value).length > MAX_CHAT_READING_CONTEXT_BYTES) {
    throw new Error("Chat's reading packet exceeded its limit.");
  }
  const parsed: unknown = JSON.parse(value);
  if (!record(parsed) || typeof parsed.finalizing !== "boolean" ||
    !Array.isArray(parsed.evidence) || parsed.evidence.length > MAX_CHAT_READING_EVIDENCE) {
    throw new Error("Chat received an invalid reading packet.");
  }
  return parsed;
}

export function isChatEvidence(value: unknown): value is ChatEvidence {
  return record(value) && typeof value.id === "string" && /^e[1-9]\d{0,3}$/.test(value.id) &&
    (value.kind === "web" ? validWebMetadata(value.web) && value.start === 0
      : (value.kind === "note" || value.kind === "source") && value.web === undefined) &&
    typeof value.entityId === "string" && value.entityId.length > 0 && value.entityId.length <= 200 &&
    typeof value.title === "string" && value.title.length <= 600 &&
    typeof value.version === "string" && value.version.length <= 200 &&
    Number.isSafeInteger(value.start) && Number(value.start) >= 0 &&
    Number.isSafeInteger(value.end) && Number(value.end) >= Number(value.start) &&
    typeof value.text === "string" && value.text.length <= MAX_CHAT_PASSAGE_CHARS &&
    value.text.length === Number(value.end) - Number(value.start) && value.offsetUnit === "utf16";
}

export function isChatCoverage(value: unknown): value is ChatCoverage {
  return record(value) && ["availableNotes", "availableSources", "openedNotes", "openedSources", "searches"]
    .every((key) => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) &&
    (value.webSearches === undefined || (Number.isSafeInteger(value.webSearches) && Number(value.webSearches) >= 0)) &&
    typeof value.limited === "boolean";
}
