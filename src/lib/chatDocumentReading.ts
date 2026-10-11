import type { ChatEvidence } from "../types";
import { MAX_CHAT_PASSAGE_CHARS, MAX_CHAT_READING_EVIDENCE } from "./chatReadingProtocol";
import { visibleTaskPassages, type TaskView } from "./taskWorkingView";

// This is a document-reader budget, never the live voice context or a vault field.
export const MAX_DOCUMENT_READ_BYTES = 192_000;

/** Contiguous, exact, Unicode-safe passages; filtering retains original offsets. */
export function documentPassages(body: string, start: number, view: TaskView) {
  if (start > body.length) throw new Error("That text offset is outside the item.");
  if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start] ?? "")) start--;
  const visible = view === "working" ? visibleTaskPassages(body, [{ start, end: body.length }])
    : [{ start, end: body.length, text: body.slice(start) }];
  const passages: Array<{ start: number; end: number; text: string }> = [];
  let bytes = 0;
  for (const range of visible) {
    for (let cursor = range.start; cursor < range.end;) {
      let end = Math.min(range.end, cursor + MAX_CHAT_PASSAGE_CHARS);
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end--;
      const text = body.slice(cursor, end);
      const size = new TextEncoder().encode(JSON.stringify(text)).length;
      if (bytes + size > MAX_DOCUMENT_READ_BYTES || passages.length >= MAX_CHAT_READING_EVIDENCE) return passages;
      passages.push({ start: cursor, end, text }); bytes += size; cursor = end;
    }
  }
  return passages;
}

/** Coverage describes evidence present NOW, not text read and then evicted. */
export function documentCoverage(body: string, evidence: readonly ChatEvidence[], view: TaskView) {
  const visible = view === "working" ? visibleTaskPassages(body, [{ start: 0, end: body.length }])
    : [{ start: 0, end: body.length, text: body }];
  const ranges = evidence.map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start);
  let firstUnread: number | null = null;
  for (const range of visible) {
    let cursor = range.start;
    for (const read of ranges) {
      if (read.end <= cursor || read.start >= range.end) continue;
      if (read.start > cursor && body.slice(cursor, read.start).trim()) { firstUnread = cursor; break; }
      cursor = Math.max(cursor, Math.min(range.end, read.end));
    }
    if (firstUnread !== null) break;
    if (cursor < range.end && body.slice(cursor, range.end).trim()) { firstUnread = cursor; break; }
  }
  return { length: body.length, complete: firstUnread === null, firstUnread, ranges };
}
