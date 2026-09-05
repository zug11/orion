import type { AppSnapshot, OrionVault } from "../../types";
import { reconcileConceptVocabulary } from "../concepts";
import { stableSnapshotVersion } from "../knowledgeOrchestration/context";
import { markSpaceOverviewStale } from "../spaceOverview";

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
  const now = new Date().toISOString();
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
  const merged = stableSnapshotVersion(base) === stableSnapshotVersion(current) ? assembled : markSpaceOverviewStale(assembled);
  return { ...live, updatedAt, spaces: live.spaces.map((space) => space.workspace.id === spaceId ? merged : space) };
}
