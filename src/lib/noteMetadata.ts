import type { Note } from "../types";

const RESERVED_NOTE_TAGS = new Set([
  "ai-draft",
  "wiki-article",
  "orion-link-draft",
  "orion-link-pending",
]);

export function visibleNoteTags(note: Pick<Note, "tags">): string[] {
  return note.tags.filter(
    (tag) => !RESERVED_NOTE_TAGS.has(tag.trim().toLocaleLowerCase()),
  );
}
