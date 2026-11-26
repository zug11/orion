import type { AppSnapshot, Concept, Note } from "../types";
import { expandOrionWikiLinks, splitMarkdownFrontmatter, stripOrionNoteMarkers } from "./markdown";
import { decorateAutoLinks, resolveConceptDestination } from "./wiki";

export type ExportScope = "note" | "linked" | "space";

const ORION_LINK_PATTERN =
  /\[[^\]\n]*\]\(orion-(note|concept):\/\/([^) \t\r\n]+)(?:[ \t]+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?\)/g;

export function conceptDestinationIds(
  concept: Concept,
  notes: readonly Note[],
): string[] {
  const destination = resolveConceptDestination(concept, notes);
  return destination.kind === "note"
    ? [destination.noteId]
    : destination.kind === "connections"
      ? destination.noteIds
      : [];
}

export function linkedNoteIdsForExport(
  note: Note,
  snapshot: AppSnapshot,
): string[] {
  const expanded = expandOrionWikiLinks(
    splitMarkdownFrontmatter(stripOrionNoteMarkers(note.body)).content,
    snapshot.notes,
    snapshot.concepts,
  );
  const ids = new Set<string>();
  let match: RegExpExecArray | null;
  ORION_LINK_PATTERN.lastIndex = 0;
  while ((match = ORION_LINK_PATTERN.exec(expanded)) !== null) {
    if (match[1] === "note") {
      ids.add(match[2]);
      continue;
    }
    const concept = snapshot.concepts.find((item) => item.id === match?.[2]);
    if (concept) {
      conceptDestinationIds(concept, snapshot.notes).forEach((id) => ids.add(id));
    }
  }

  for (const segment of decorateAutoLinks(expanded, snapshot.concepts, {
    excludeNoteIdFromTargets: note.id,
  })) {
    if (segment.type !== "concept") continue;
    const concept = snapshot.concepts.find(
      (candidate) => candidate.id === segment.conceptId,
    );
    if (concept) {
      conceptDestinationIds(concept, snapshot.notes).forEach((id) => ids.add(id));
    }
  }

  ids.delete(note.id);
  return snapshot.notes.filter((candidate) => ids.has(candidate.id)).map(({ id }) => id);
}

export function notesForExportScope(
  snapshot: AppSnapshot,
  scope: ExportScope,
  originNoteId: string | null,
): Note[] {
  if (scope === "space") return [...snapshot.notes];
  const origin = snapshot.notes.find((note) => note.id === originNoteId);
  if (!origin) return [];
  if (scope === "note") return [origin];
  const linkedIds = new Set(linkedNoteIdsForExport(origin, snapshot));
  return [origin, ...snapshot.notes.filter((note) => linkedIds.has(note.id))];
}
