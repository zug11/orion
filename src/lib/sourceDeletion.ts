import type { AppSnapshot, EntityId, Relationship } from "../types";
import { removeSourceCitations } from "./sourceCitations";

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
