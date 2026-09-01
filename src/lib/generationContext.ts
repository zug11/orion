import type { AppSnapshot, ChatRequest, Note } from "../types";
import { buildSpaceBlueprintOrientation, buildSpaceNoteDigests, spaceNoteVersion } from "./spaceKnowledge";
import { buildLocalSpaceOverview } from "./spaceOverview";
import { truncateUnicode } from "./text";

type ContextNote = ChatRequest["notes"][number];
export interface GenerationContext {
  orientation: ContextNote[];
  directory: ContextNote[];
  candidates: Note[];
  availableNoteCount: number;
}

/** Local retrieval only. Explicit per-generation consent never changes settings. */
export function buildGenerationContext(
  snapshot: AppSnapshot,
  instruction: string,
  enabled = snapshot.settings.includeExistingNotesInAIContext,
): GenerationContext {
  if (!enabled) return { orientation: [], directory: [], candidates: [], availableNoteCount: 0 };
  const clean = {
    ...snapshot,
    notes: snapshot.notes.filter((note) =>
      !note.tags.includes("orion-generate-pending") &&
      !/<!--\s*orion-generate-pending\s*-->/.test(note.body) && note.body.trim(),
    ),
  };
  const tokens = [...new Set(instruction.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  const hierarchy = buildSpaceBlueprintOrientation(clean, instruction);
  const routedIds = new Set(hierarchy?.clusters.flatMap(({ noteIds }) => noteIds) ?? []);
  const overview = clean.spaceOverview ?? buildLocalSpaceOverview(clean);
  const relatedIds = new Set(overview?.relatedNoteIds ?? []);
  const digests = buildSpaceNoteDigests(clean).map((digest) => {
    const names = [digest.title, ...digest.aliases].join(" ").toLocaleLowerCase();
    const sketch = JSON.stringify(digest).toLocaleLowerCase();
    const score = tokens.reduce((sum, token) => sum + (names.includes(token) ? 12 : sketch.includes(token) ? 2 : 0), 0)
      + (routedIds.has(digest.noteId) ? 4 : 0) + (relatedIds.has(digest.noteId) ? 2 : 0);
    return { digest, score };
  }).sort((a, b) => b.score - a.score || a.digest.noteId.localeCompare(b.digest.noteId));
  // Fits the native 80-record boundary even with orientation and exact excerpts.
  const selected = digests.slice(0, 48);
  const notesById = new Map(clean.notes.map((note) => [note.id, note]));
  const orientation: ContextNote[] = hierarchy ? [{
    title: hierarchy.root.title,
    summary: "Validated Space hierarchy: orientation, not evidence. Follow exact note IDs for facts.",
    body: truncateUnicode(JSON.stringify(hierarchy), 7_500),
  }] : overview ? [{
    title: overview.title,
    summary: `Space overview: orientation, not evidence; ${overview.stale ? "stale—check current notes" : "saved/local"}.`,
    body: truncateUnicode(overview.body, 5_000),
  }] : [];
  return {
    orientation,
    availableNoteCount: clean.notes.length,
    directory: selected.map(({ digest }) => ({
      title: `Note directory: ${digest.title}`,
      summary: "Local whole-body digest; use the note's exact text for detailed claims.",
      body: JSON.stringify({
        noteId: digest.noteId, version: digest.noteVersion, title: digest.title,
        aliases: digest.aliases.slice(0, 8).map((alias) => truncateUnicode(alias, 100)),
        tags: digest.tags.slice(0, 8).map((tag) => truncateUnicode(tag, 80)),
        quality: digest.quality, qualityReason: digest.qualityReason,
        headings: digest.headings.slice(0, 12).map((heading) => truncateUnicode(heading, 100)),
        sketch: truncateUnicode(digest.wholeBodySketch, 600),
      }),
    })),
    candidates: selected.flatMap(({ digest }) => {
      const note = notesById.get(digest.noteId);
      return note ? [note] : [];
    }),
  };
}

/** Exact excerpts selected across the body, with omissions explicitly labelled. */
export function generationNoteEvidence(note: Note, query: string, maximum = 7_000): ContextNote {
  const paragraphs = note.body.split(/\n\s*\n/);
  const tokens = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  let body = note.body;
  if ([...body].length > maximum) {
    const ranked = paragraphs.map((text, index) => ({ text, index,
      score: tokens.reduce((n, token) => n + (text.toLocaleLowerCase().includes(token) ? 1 : 0), 0)
        + (index === 0 || index === paragraphs.length - 1 ? 0.5 : 0),
    })).sort((a, b) => b.score - a.score || a.index - b.index);
    const excerpts: Array<{ text: string; index: number }> = [];
    let remaining = maximum - 100;
    for (const paragraph of ranked) {
      if (remaining < 80) break;
      const text = truncateUnicode(paragraph.text, Math.min(remaining, 2_000));
      excerpts.push({ text, index: paragraph.index });
      remaining -= [...text].length + 30;
    }
    body = "Selected exact excerpts; intervening text omitted.\n\n" + excerpts
      .sort((a, b) => a.index - b.index)
      .map(({ text, index }) => `[Paragraph ${index + 1}]\n${text}`).join("\n\n[… omitted …]\n\n");
  }
  return {
    title: `${note.title} [${note.id}]`,
    summary: `Exact note version ${spaceNoteVersion(note)}. ${note.sourceIds.length === 0 ? "Authored note; no imported Source record is required." : "Preserved note text."}`,
    body: truncateUnicode(body, maximum),
  };
}
