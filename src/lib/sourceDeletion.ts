import type { AppSnapshot, EntityId, Relationship } from "../types";
import { proseSourceCitationIds, removeSourceCitations } from "./sourceCitations";

export interface DeleteSourceResult {
  snapshot: AppSnapshot;
  deleted: boolean;
  detachedNoteIds: EntityId[];
}

/**
 * Adds both sides of the note/source provenance edge in one snapshot update.
 * This also repairs older snapshots where only one side of the edge exists.
 */
export function attachSourceToNoteInSnapshot(
  snapshot: AppSnapshot,
  noteId: EntityId,
  sourceId: EntityId,
  now: string,
): AppSnapshot {
  const note = snapshot.notes.find((candidate) => candidate.id === noteId);
  const source = snapshot.sources.find(
    (candidate) => candidate.id === sourceId,
  );
  if (!note || !source) return snapshot;

  const noteHasSource = note.sourceIds.includes(sourceId);
  const sourceHasNote = source.noteIds.includes(noteId);
  if (noteHasSource && sourceHasNote) return snapshot;

  return {
    ...snapshot,
    notes: snapshot.notes.map((candidate) =>
      candidate.id === noteId
        ? {
            ...candidate,
            sourceIds: noteHasSource
              ? candidate.sourceIds
              : [...candidate.sourceIds, sourceId],
            updatedAt: now,
          }
        : candidate,
    ),
    sources: snapshot.sources.map((candidate) =>
      candidate.id === sourceId
        ? {
            ...candidate,
            noteIds: sourceHasNote
              ? candidate.noteIds
              : [...candidate.noteIds, noteId],
          }
        : candidate,
    ),
    updatedAt: now,
  };
}

/** Complete import provenance in the same immutable update as the note merge.
 * Only sources already present exactly once in this Space are eligible. Check
 * before and after merging: an upsert may otherwise hide duplicate input IDs.
 */
export function reconcileImportedSourceCitations(
  before: AppSnapshot,
  merged: AppSnapshot,
  importedNoteIds: readonly EntityId[],
  authorizedEdges?: ReadonlyMap<EntityId, ReadonlySet<EntityId>>,
): AppSnapshot {
  if (before.workspace.id !== merged.workspace.id) throw new Error("Import provenance cannot cross a Space boundary.");
  const counts = (records: readonly { id: string }[]) => {
    const result = new Map<string, number>();
    for (const record of records) result.set(record.id, (result.get(record.id) ?? 0) + 1);
    return result;
  };
  const beforeSources = counts(before.sources);
  const afterSources = counts(merged.sources);
  const noteCounts = counts(merged.notes);
  const targets = new Set(importedNoteIds);
  const additions = new Map<string, Set<string>>();
  let changed = false;
  const notes = merged.notes.map((note) => {
    if (!targets.has(note.id) || noteCounts.get(note.id) !== 1) return note;
    const ids = proseSourceCitationIds(note.body).filter((id) => beforeSources.get(id) === 1 && afterSources.get(id) === 1
      && (!authorizedEdges || authorizedEdges.get(note.id)?.has(id)));
    for (const id of ids) {
      const noteIds = additions.get(id) ?? new Set<string>();
      noteIds.add(note.id);
      additions.set(id, noteIds);
    }
    const missing = ids.filter((id) => !note.sourceIds.includes(id));
    if (!missing.length) return note;
    changed = true;
    return { ...note, sourceIds: [...note.sourceIds, ...missing] };
  });
  const sources = merged.sources.map((source) => {
    const missing = [...(additions.get(source.id) ?? [])].filter((id) => !source.noteIds.includes(id));
    if (!missing.length) return source;
    changed = true;
    return { ...source, noteIds: [...source.noteIds, ...missing] };
  });
  return changed ? { ...merged, notes, sources } : merged;
}

function withoutSourceId(
  relationship: Relationship,
  sourceId: EntityId,
): Relationship {
  if (relationship.sourceId !== sourceId) return relationship;
  const { sourceId: _removedSourceId, ...remaining } = relationship;
  return remaining;
}

export function deleteSourceFromSnapshot(
  snapshot: AppSnapshot,
  sourceId: EntityId,
  now: string,
): DeleteSourceResult {
  if (!snapshot.sources.some((source) => source.id === sourceId)) {
    return {
      snapshot,
      deleted: false,
      detachedNoteIds: [],
    };
  }

  const detachedNoteIds = snapshot.notes
    .filter((note) => note.sourceIds.includes(sourceId))
    .map((note) => note.id);
  const remainingSources = snapshot.sources.filter(
    (source) => source.id !== sourceId,
  );

  return {
    deleted: true,
    detachedNoteIds,
    snapshot: {
      ...snapshot,
      sources: remainingSources,
      notes: snapshot.notes.map((note) => {
        const sourceIds = note.sourceIds.filter(
          (candidateId) => candidateId !== sourceId,
        );
        const body = removeSourceCitations(
          note.body,
          [sourceId],
          remainingSources,
        );
        return sourceIds.length !== note.sourceIds.length || body !== note.body
          ? { ...note, sourceIds, body, updatedAt: now }
          : note;
      }),
      relationships: snapshot.relationships.map((relationship) =>
        withoutSourceId(relationship, sourceId),
      ),
      studio: {
        ...snapshot.studio,
        cards: snapshot.studio.cards.map((card) =>
          card.sourceIds.includes(sourceId)
            ? {
                ...card,
                sourceIds: card.sourceIds.filter(
                  (candidateId) => candidateId !== sourceId,
                ),
                updatedAt: now,
              }
            : card,
        ),
      },
      updatedAt: now,
    },
  };
}
