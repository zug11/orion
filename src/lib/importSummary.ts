import type { Note, Source } from "../types";
import { stripMarkdownComments } from "./markdown";
import { importNoteExcerpt } from "./importNoteExcerpt";

export function cleanPlainText(text: string): string {
  return stripMarkdownComments(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[((?:\\.|[^\]\\])*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~[\]()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function manualSummary(text: string): string {
  const plain = cleanPlainText(text);
  if (plain.length <= 190) {
    return plain || "Imported source ready for review.";
  }
  return `${plain.slice(0, 189).trimEnd()}…`;
}

/** Hide only the old mechanical Markdown excerpt, preserving authored summaries. */
export function visibleNoteSummary(note: Note, sources: readonly Source[]): string {
  if (!note.summary) return "";
  return sources.some(source => source.kind === "markdown" && note.sourceIds.includes(source.id)
    && note.summary === manualSummary(importNoteExcerpt(source.text).text.trim())) ? "" : note.summary;
}
