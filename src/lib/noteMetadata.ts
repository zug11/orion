import type { Note, NoteHeadingLayout } from "../types";

export interface NoteHeadingVisibility { title: boolean; subtitle: boolean }

/** Old notes retain both rows. Incoming authored text always remains visible,
 * even if another writer fills a heading that was previously removed. */
export function noteHeadingVisibility(note: Pick<Note, "title" | "summary" | "headingLayout">): NoteHeadingVisibility {
  const layout = note.headingLayout ?? "both";
  return {
    title: layout === "both" || layout === "title" || editableNoteTitle(note).length > 0,
    subtitle: layout === "both" || layout === "subtitle" || editableNoteSubtitle(note).length > 0,
  };
}

export function noteHeadingLayout({ title, subtitle }: NoteHeadingVisibility): NoteHeadingLayout {
  return title ? subtitle ? "both" : "title" : subtitle ? "subtitle" : "none";
}

/** Old starter copy is a placeholder, never an authored document heading. */
export function editableNoteTitle(note: Pick<Note, "title">): string {
  return note.title === "Untitled note" ? "" : note.title;
}

export function editableNoteSubtitle(note: Pick<Note, "summary">): string {
  return note.summary === "A new thread in your atlas." ? "" : note.summary;
}

/** Empty titles remain optional while navigation keeps an accessible name. */
export function displayNoteTitle(note: Pick<Note, "title">): string {
  return editableNoteTitle(note).trim() || "New note";
}

const RESERVED_NOTE_TAGS = new Set([
  "ai-draft",
  "wiki-article",
  "orion-link-draft",
  "orion-link-pending",
  "orion-generate-pending",
  "orion-slide-deck",
]);

export function visibleNoteTags(note: Pick<Note, "tags">): string[] {
  return note.tags.filter(
    (tag) => !RESERVED_NOTE_TAGS.has(tag.trim().toLocaleLowerCase()),
  );
}
