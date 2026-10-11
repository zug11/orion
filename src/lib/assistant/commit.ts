import type { AppSnapshot, OrionVault } from "../../types";
import { reconcileConceptVocabulary } from "../concepts";
import { stableSnapshotVersion } from "../knowledgeOrchestration/context";
import { proseSourceCitationIds } from "../sourceCitations";
import { reconcileImportedSourceCitations } from "../sourceDeletion";
import { markSpaceOverviewStale } from "../spaceOverview";
import { nextVaultRevision } from "../windowVault";

export function assertUnchangedSpace(base: AppSnapshot, current: AppSnapshot | undefined) {
  if (!current || current.workspace.id !== base.workspace.id || stableSnapshotVersion(current) !== stableSnapshotVersion(base)) {
    throw new Error("This Space changed while Orion was working. Nothing from the workflow was saved; start a new request against current knowledge.");
  }
}

/** Compose only knowledge fields; navigation and settings belong to the live app. */
export function composeWorkflowVault(current: OrionVault, base: AppSnapshot, generated: AppSnapshot): OrionVault {
  const live = current.spaces.find((space) => space.workspace.id === base.workspace.id);
  assertUnchangedSpace(base, live);
  if (generated.workspace.id !== base.workspace.id) throw new Error("Workflow result crossed a Space boundary.");
  const now = nextVaultRevision(current.updatedAt);
  return { ...current, updatedAt: now, spaces: current.spaces.map((space) => space.workspace.id !== base.workspace.id ? space : {
    ...space, notes: generated.notes, sources: generated.sources, concepts: generated.concepts, relationships: generated.relationships,
    spaceOverview: generated.spaceOverview, spaceKnowledge: generated.spaceKnowledge, updatedAt: now,
  }) };
}

function mergeRecords<T extends { id: string }>(base: T[], generated: T[], live: T[]): T[] {
  const originals = new Map(base.map((item) => [item.id, item]));
  const updates = new Map(generated.map((item) => [item.id, item]));
  const current = new Set(live.map((item) => item.id));
  return [
    ...live.map((item) => {
      const original = originals.get(item.id);
      const comparable = (value: T | undefined) => value ? JSON.stringify({ ...value, lastOpenedAt: undefined }) : undefined;
      if (comparable(item) !== comparable(original)) return item;
      const updated = updates.get(item.id) ?? item;
      return "lastOpenedAt" in item ? { ...updated, lastOpenedAt: item.lastOpenedAt } : updated;
    }),
    ...generated.filter((item) => !originals.has(item.id) && !current.has(item.id)),
  ];
}

/** Rebase only citation edges added by this workflow, never repair the library.
 * Record-level merging preserves newer source fields, but can lose its new
 * backlink or carry one into an ambiguous source or a subsequently edited note.
 */
function rebaseCitationEdges(base: AppSnapshot, generated: AppSnapshot, current: AppSnapshot, merged: AppSnapshot): AppSnapshot {
  const index = <T extends { id: string }>(records: readonly T[]) => {
    const groups = new Map<string, T[]>();
    for (const record of records) {
      const members = groups.get(record.id) ?? [];
      members.push(record);
      groups.set(record.id, members);
    }
    return groups;
  };
  const unique = <T,>(records: readonly T[] | undefined) => records?.length === 1 ? records[0] : undefined;
  const baseNotes = index(base.notes), baseSources = index(base.sources);
  const committedNotes = index(generated.notes), committedSources = index(generated.sources);
  const liveNotes = index(current.notes), liveSources = index(current.sources);
  const candidates = new Map<string, Set<string>>();
  const authorized = new Map<string, Set<string>>();
  for (const [noteId, records] of committedNotes) {
    const note = unique(records);
    if (!note || (baseNotes.get(noteId)?.length ?? 0) > 1) continue;
    const original = unique(baseNotes.get(noteId));
    const newPairs = note.sourceIds.filter((sourceId) => {
      const source = unique(baseSources.get(sourceId));
      const committedSource = unique(committedSources.get(sourceId));
      return source && committedSource?.noteIds.includes(noteId)
        && (!original?.sourceIds.includes(sourceId) || !source.noteIds.includes(noteId));
    });
    if (!newPairs.length) continue;
    const citations = new Set(proseSourceCitationIds(note.body));
    for (const sourceId of newPairs) {
      if (!citations.has(sourceId)) continue;
      const source = unique(baseSources.get(sourceId))!;
      const hadNoteEdge = original?.sourceIds.includes(sourceId) ?? false;
      const hadSourceEdge = source.noteIds.includes(noteId);
      const ids = candidates.get(noteId) ?? new Set<string>();
      ids.add(sourceId);
      candidates.set(noteId, ids);
      const liveNote = unique(liveNotes.get(noteId));
      const liveSource = unique(liveSources.get(sourceId));
      // A removed original attachment is a subsequent user choice. A missing
      // new note is normal before the commit appears in the live snapshot.
      if (!liveSource || (original && !liveNote) || (!original && liveNotes.has(noteId))
        || (hadNoteEdge && !liveNote?.sourceIds.includes(sourceId))
        || (hadSourceEdge && !liveSource.noteIds.includes(noteId))) continue;
      const allowed = authorized.get(noteId) ?? new Set<string>();
      allowed.add(sourceId);
      authorized.set(noteId, allowed);
    }
  }
  if (!candidates.size) return merged;

  // Remove only freshly generated members before checking current prose and
  // uniqueness. Original/manual attachments and every live user's edge survive.
  const stripped = { ...merged,
    notes: merged.notes.map((note) => ({ ...note, sourceIds: note.sourceIds.filter((id) =>
      !candidates.get(note.id)?.has(id)
      || baseNotes.get(note.id)?.some((item) => item.sourceIds.includes(id))
      || liveNotes.get(note.id)?.some((item) => item.sourceIds.includes(id))) })),
    sources: merged.sources.map((source) => ({ ...source, noteIds: source.noteIds.filter((id) =>
      !candidates.get(id)?.has(source.id)
      || baseSources.get(source.id)?.some((item) => item.noteIds.includes(id))
      || liveSources.get(source.id)?.some((item) => item.noteIds.includes(id))) })),
  };
  return reconcileImportedSourceCitations(base, stripped, [...candidates.keys()], authorized);
}

/**
 * Edits queued during the tiny atomic-save window take precedence as subsequent
 * user edits. Keep new generated records without resurrecting deleted records.
 */
export function rebaseCommittedWorkflow(baseVault: OrionVault, saved: OrionVault, live: OrionVault, spaceId: string): OrionVault {
  const base = baseVault.spaces.find((space) => space.workspace.id === spaceId);
  const generated = saved.spaces.find((space) => space.workspace.id === spaceId);
  const current = live.spaces.find((space) => space.workspace.id === spaceId);
  if (!base || !generated || !current) return live;
  if (JSON.stringify(baseVault) === JSON.stringify(live)) return saved;
  const sources = mergeRecords(base.sources, generated.sources, current.sources);
  const sourceIds = new Set(sources.map((source) => source.id));
  const notes = mergeRecords(base.notes, generated.notes, current.notes).map((note) => ({ ...note, sourceIds: note.sourceIds.filter((id) => sourceIds.has(id)) }));
  const noteIds = new Set(notes.map((note) => note.id));
  const vocabulary = reconcileConceptVocabulary(notes, mergeRecords(base.concepts, generated.concepts, current.concepts));
  const conceptIds = new Set(vocabulary.concepts.map((concept) => concept.id));
  const relationships = mergeRecords(base.relationships, generated.relationships, current.relationships)
    .filter((item) => noteIds.has(item.fromNoteId) && noteIds.has(item.toNoteId))
    .map((item) => ({ ...item, sourceId: item.sourceId && sourceIds.has(item.sourceId) ? item.sourceId : undefined,
      conceptId: item.conceptId && conceptIds.has(item.conceptId) ? item.conceptId : undefined }));
  const updatedAt = new Date().toISOString();
  const assembled = { ...current, ...vocabulary,
    sources: sources.map((source) => ({ ...source, noteIds: source.noteIds.filter((id) => noteIds.has(id)) })),
    relationships, spaceOverview: generated.spaceOverview, spaceKnowledge: generated.spaceKnowledge, updatedAt,
  };
  const reconciled = rebaseCitationEdges(base, generated, current, assembled);
  const merged = stableSnapshotVersion(base) === stableSnapshotVersion(current) ? reconciled : markSpaceOverviewStale(reconciled);
  return { ...live, updatedAt, spaces: live.spaces.map((space) => space.workspace.id === spaceId ? merged : space) };
}
