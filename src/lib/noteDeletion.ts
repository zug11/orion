import { reconcileConceptVocabulary } from "./concepts";
import { stripOrionLinksToTargets } from "./markdown";
import type { AppSnapshot, EntityId } from "../types";
import { deleteSourceFromSnapshot } from "./sourceDeletion";
import { proseSourceCitationIds } from "./sourceCitations";

export interface DeleteNoteOptions {
  fallbackNoteId?: EntityId | null;
}

export interface DeleteNoteResult {
  snapshot: AppSnapshot;
  deleted: boolean;
  removedConceptIds: EntityId[];
}

export function deleteNoteFromSnapshot(
  snapshot: AppSnapshot,
  noteId: EntityId,
  now: string,
  options: DeleteNoteOptions = {},
): DeleteNoteResult {
  if (!snapshot.notes.some((note) => note.id === noteId)) {
    return {
      snapshot,
      deleted: false,
      removedConceptIds: [],
    };
  }

  const remainingNotes = snapshot.notes.filter(
    (note) => note.id !== noteId,
  );
  const remainingConcepts = snapshot.concepts
    .map((concept) => ({
      ...concept,
      noteIds: concept.noteIds.filter(
        (candidateId) => candidateId !== noteId,
      ),
      ...(concept.canonicalNoteId === noteId
        ? { canonicalNoteId: undefined }
        : {}),
    }))
    .filter((concept) => concept.noteIds.length > 0);
  const vocabulary = reconcileConceptVocabulary(
    remainingNotes,
    remainingConcepts,
  );
  const validConceptIds = new Set(
    vocabulary.concepts.map((concept) => concept.id),
  );
  const removedConceptIds = snapshot.concepts
    .map((concept) => concept.id)
    .filter((conceptId) => !validConceptIds.has(conceptId));
  const notes = vocabulary.notes.map((note) => {
    const body = stripOrionLinksToTargets(note.body, {
      noteIds: [noteId],
      conceptIds: removedConceptIds,
    });
    return body === note.body ? note : { ...note, body, updatedAt: now };
  });
  const preferredFallback = options.fallbackNoteId ?? null;
  const fallbackNoteId = notes.some(
    (note) => note.id === preferredFallback,
  )
    ? preferredFallback
    : null;

  const result: DeleteNoteResult = {
    deleted: true,
    removedConceptIds,
    snapshot: {
      ...snapshot,
      notes,
      concepts: vocabulary.concepts,
      relationships: snapshot.relationships.filter(
        (relationship) =>
          relationship.fromNoteId !== noteId &&
          relationship.toNoteId !== noteId &&
          (!relationship.conceptId ||
            validConceptIds.has(relationship.conceptId)),
      ),
      sources: snapshot.sources.map((source) => ({
        ...source,
        noteIds: source.noteIds.filter(
          (candidateId) => candidateId !== noteId,
        ),
      })),
      importDrafts: snapshot.importDrafts.map((draft) => ({
        ...draft,
        generatedNoteIds: draft.generatedNoteIds.filter(
          (candidateId) => candidateId !== noteId,
        ),
      })),
      ...(snapshot.spaceOverview
        ? {
            spaceOverview: {
              ...snapshot.spaceOverview,
              relatedNoteIds: snapshot.spaceOverview.relatedNoteIds.filter(
                (candidateId) => candidateId !== noteId,
              ),
            },
          }
        : {}),
      activeNoteId:
        snapshot.activeNoteId === noteId
          ? fallbackNoteId
          : snapshot.activeNoteId,
      updatedAt: now,
    },
  };
  const deletedNote = snapshot.notes.find(note => note.id === noteId)!;
  const survivingIds = new Set(notes.map(note => note.id));
  const usedSources = new Set(notes.flatMap(note => [...note.sourceIds, ...proseSourceCitationIds(note.body)]));
  for (const source of snapshot.sources) {
    if (source.kind === "audio" && source.id.startsWith("source-dictation-") &&
      (source.noteIds.includes(noteId) || deletedNote.sourceIds.includes(source.id)) &&
      !source.noteIds.some(id => survivingIds.has(id)) && !usedSources.has(source.id)) {
      result.snapshot = deleteSourceFromSnapshot(result.snapshot, source.id, now).snapshot;
    }
  }
  return result;
}
