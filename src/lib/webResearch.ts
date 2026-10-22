import type { ChatEvidence } from "../types";

export interface WebResearchResult {
  responseId: string;
  answer: string;
  retrievedAt: string;
  sources: { id: number; title: string; url: string; snippet: string; publishedAt?: string }[];
}
export type WebResearch = (query: string, signal: AbortSignal) => Promise<WebResearchResult>;

/** Remote text is reference data. Only provider search-result URLs may become citations. */
export function safeWebUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

export function validWebMetadata(value: unknown): value is NonNullable<ChatEvidence["web"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ["url", "retrievedAt", "publishedAt"].includes(key)) && safeWebUrl(item.url) &&
    typeof item.retrievedAt === "string" && item.retrievedAt.length <= 40 && Number.isFinite(Date.parse(item.retrievedAt)) &&
    (item.publishedAt === undefined || (typeof item.publishedAt === "string" && item.publishedAt.length <= 100 && !/[\u0000-\u001f]/.test(item.publishedAt)));
}

export function validateWebResult(value: unknown): WebResearchResult {
  const item = value as WebResearchResult;
  if (!item || typeof item.responseId !== "string" || !/^[\w-]{1,200}$/.test(item.responseId) ||
    // Transport integrity ceiling, shared with the native response-body guard.
    // Ordinary long answers remain intact and are paged inside the reader.
    typeof item.answer !== "string" || new TextEncoder().encode(item.answer).length > 2_000_000 ||
    typeof item.retrievedAt !== "string" || !Number.isFinite(Date.parse(item.retrievedAt)) ||
    !Array.isArray(item.sources) || !item.sources.length || item.sources.length > 12 ||
    new Set(item.sources.map(source => source.id)).size !== item.sources.length ||
    item.sources.some(source => !Number.isSafeInteger(source.id) || source.id < 1 ||
      typeof source.title !== "string" || !source.title.trim() || source.title.length > 600 ||
      typeof source.snippet !== "string" || !source.snippet.trim() || source.snippet.length > 3_000 ||
      !validWebMetadata({ url: source.url, retrievedAt: item.retrievedAt, ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}) }))) {
    throw new Error("Web research returned invalid or missing source evidence. Retry the request.");
  }
  return item;
}

/** Exact, contiguous UTF-16 pages; never call the provider again to read a tail. */
export function webSynthesisPage(answer: string, start = 0) {
  if (!Number.isSafeInteger(start) || start < 0 || start > answer.length ||
    (start > 0 && /[\uD800-\uDBFF]/.test(answer[start - 1]) && /[\uDC00-\uDFFF]/.test(answer[start] ?? ""))) {
    throw new Error("That retained web research offset is invalid. Use its returned nextStart.");
  }
  let end = Math.min(answer.length, start + 12_000);
  if (end < answer.length) {
    const paragraph = answer.lastIndexOf("\n", end - 1);
    const word = answer.lastIndexOf(" ", end - 1);
    const boundary = paragraph >= start + 9_000 ? paragraph + 1 : word + 1;
    if (boundary >= start + 9_000) end = boundary;
    if (/[\uD800-\uDBFF]/.test(answer[end - 1]) && /[\uDC00-\uDFFF]/.test(answer[end])) end--;
  }
  return { synthesis: answer.slice(start, end), synthesisRange: { start, end, total: answer.length, offsetUnit: "utf16" as const },
    synthesisComplete: start === 0 && end === answer.length, nextStart: end < answer.length ? end : null };
}
