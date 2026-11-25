import { isCalendarDismissalList } from "./calendarDismissal";
import { writingOrigins } from "./writingOrigins";
import { allocateTicketCodes } from './ticketCodes';
import type { ConceptStudioState, ChatThread, StudioMessage, OrionVault } from "../types";
import { messageChatThreadId } from "./chatThreads";

export type ConflictChoice = "local" | "remote";

export class WindowVaultConflict extends Error {
  constructor(readonly fields: string[], readonly revision: string) {
    super("Another Orion window changed the same content. Choose which changes to keep.");
    this.name = "WindowVaultConflict";
  }
}

type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export function vaultValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => vaultValuesEqual(value, b[index]));
  if (object(a) && object(b)) {
    const keys = Object.keys(a).filter((key) => a[key] !== undefined);
    return keys.length === Object.keys(b).filter((key) => b[key] !== undefined).length && keys.every((key) => vaultValuesEqual(a[key], b[key]));
  }
  return false;
}
const same = vaultValuesEqual;
const recordId = (value: unknown): string | undefined => {
  if (!object(value)) return undefined;
  return typeof value.id === "string" ? value.id
    : object(value.workspace) && typeof value.workspace.id === "string" ? value.workspace.id : undefined;
};

/** Three-way merge against the last disk snapshot, never a last-writer-wins save. */
export function mergeWindowVault(
  base: OrionVault,
  local: OrionVault,
  remote: OrionVault,
  choice?: ConflictChoice,
): OrionVault {
  const conflicts: string[] = [];
  const merge = (before: unknown, ours: unknown, theirs: unknown, path: string): unknown => {
    // Optional metadata did not exist in older vaults. Two windows may each
    // create their first independent chat without conflicting on the array.
    if (before === undefined && (path.endsWith(".studio.threads") || path.endsWith(".dismissedCalendarMentions")) && Array.isArray(ours) && Array.isArray(theirs)) before = [];
    if (path.endsWith(".writingOrigins")) {
      // Each window can add an origin independently. Undo removes only an
      // origin that was present in the shared base; new additions survive.
      const original = writingOrigins(before), left = writingOrigins(ours), right = writingOrigins(theirs);
      const merged = writingOrigins([...left, ...right]).filter(origin =>
        !original.includes(origin) || left.includes(origin) && right.includes(origin));
      return merged.length ? merged : undefined;
    }
    if (same(ours, before)) return theirs;
    if (same(theirs, before) || same(ours, theirs)) return ours;
    const parts = path.split(".");
    const field = parts[parts.length - 1];
    if (field === "updatedAt" || field === "lastOpenedAt") {
      const values = [ours, theirs].filter((value): value is string => typeof value === "string")
        .sort((a, b) => Date.parse(a) - Date.parse(b));
      return values[values.length - 1];
    }
    if (field === "activeSpaceId" || field === "activeNoteId") return ours;
    // These are derived caches. A concurrent refresh must not merge two trees.
    if (field === "spaceOverview" || field === "spaceKnowledge") return undefined;
    if (Array.isArray(before) && Array.isArray(ours) && Array.isArray(theirs)) {
      const all = [...before, ...ours, ...theirs];
      if (all.every((item) => typeof item === "string")) {
        const removed = new Set(before.filter((item) => !ours.includes(item) || !theirs.includes(item)));
        const combined = [...new Set([...theirs, ...ours])].filter((item) => !removed.has(item));
        if (field === "dismissedCalendarMentions" && !isCalendarDismissalList(combined)) {
          // Preserve both complete versions for conflict resolution; never trim
          // a dismissal list and silently make old dates visible again.
          conflicts.push(path);
          return choice === "remote" ? theirs : ours;
        }
        return combined;
      }
      if (all.every((item) => recordId(item) !== undefined)) {
        const index = (items: unknown[]) => new Map(items.map((item) => [recordId(item)!, item]));
        const b = index(before), l = index(ours), r = index(theirs);
        // Preserve established disk order. A record only this window has keeps
        // its place relative to its local neighbours: a note created at the top
        // of the list stays at the top instead of dropping to the end. Records
        // another writer added at the same place come first, so appended chat
        // messages keep the order in which they reached disk.
        const inserts = new Map<string | null, string[]>();
        let anchor: string | null = null;
        for (const id of l.keys()) {
          if (r.has(id)) { anchor = id; continue; }
          const group = inserts.get(anchor);
          if (group) group.push(id); else inserts.set(anchor, [id]);
        }
        const ids: string[] = [];
        let pending = inserts.get(null) ?? [];
        for (const id of r.keys()) {
          const addedRemotely = !b.has(id) && !l.has(id);
          if (!addedRemotely && pending.length) { ids.push(...pending); pending = []; }
          ids.push(id);
          const group = inserts.get(id);
          if (group) pending = group;
        }
        ids.push(...pending);
        for (const id of b.keys()) if (!r.has(id) && !l.has(id)) ids.push(id);
        return ids.flatMap((id) => {
          const item = l.get(id) ?? r.get(id) ?? b.get(id);
          const name = object(item) ? item.title ?? (object(item.workspace) ? item.workspace.name : undefined) ?? id : id;
          const value = merge(b.get(id), l.get(id), r.get(id), `${path}[${name}]`);
          return value === undefined ? [] : [value];
        });
      }
    }
    if (object(before) && object(ours) && object(theirs)) {
      const merged: RecordValue = Object.create(null) as RecordValue;
      for (const key of new Set([...Object.keys(before), ...Object.keys(ours), ...Object.keys(theirs)])) {
        const value = merge(before[key], ours[key], theirs[key], path ? `${path}.${key}` : key);
        if (value !== undefined) merged[key] = value;
      }
      return merged;
    }
    conflicts.push(path);
    return choice === "remote" ? theirs : ours;
  };
  let result = merge(base, local, remote, "") as OrionVault;
  // Messages intentionally remain flat for compatibility. Reconcile a deleted
  // thread atomically with its metadata when another writer appended/edited a
  // reply, rather than returning messages orphaned by independent array merges.
  type ThreadPart = { metadata?: ChatThread; messages: StudioMessage[] };
  const indexThreads = (studio: ConceptStudioState | undefined) => {
    const index = new Map<string, ThreadPart>();
    for (const thread of studio?.threads ?? []) index.set(thread.id, { metadata: thread, messages: [] });
    for (const message of studio?.messages ?? []) {
      const id = messageChatThreadId(message);
      let part = index.get(id);
      if (!part) { part = { messages: [] }; index.set(id, part); }
      part.messages.push(message);
    }
    return index;
  };
  for (const beforeSpace of base.spaces) {
    const ours = local.spaces.find(space => space.workspace.id === beforeSpace.workspace.id);
    const theirs = remote.spaces.find(space => space.workspace.id === beforeSpace.workspace.id);
    if (!ours || !theirs) continue; // Whole-Space deletion has its own merge guard.
    // Ordinary note typing never indexes Chat. A deletion/reply race requires
    // both writers to have changed Studio. Index each changed history once.
    if (same(beforeSpace.studio, ours.studio) || same(beforeSpace.studio, theirs.studio)) continue;
    const beforeIndex = indexThreads(beforeSpace.studio), leftIndex = indexThreads(ours.studio), rightIndex = indexThreads(theirs.studio);
    for (const [id, before] of beforeIndex) {
      const left = leftIndex.get(id) ?? { messages: [] }, right = rightIndex.get(id) ?? { messages: [] };
      const leftExists = Boolean(left.metadata || left.messages.length), rightExists = Boolean(right.metadata || right.messages.length);
      if ((!leftExists && rightExists && !same(before, right)) || (!rightExists && leftExists && !same(before, left))) {
        conflicts.push(`spaces[${beforeSpace.workspace.name}].studio.threads[${before.metadata?.title || id}]`);
        if (choice) {
          const selected = choice === "local" ? left : right;
          result = { ...result, spaces: result.spaces.map(space => space.workspace.id !== beforeSpace.workspace.id ? space : {
            ...space, studio: { ...space.studio,
              messages: [...space.studio.messages.filter(message => messageChatThreadId(message) !== id), ...selected.messages],
              threads: [...(space.studio.threads ?? []).filter(thread => thread.id !== id), ...(selected.metadata ? [selected.metadata] : [])],
            },
          }) };
        }
      }
    }
  }
  if (conflicts.length && !choice) throw new WindowVaultConflict(conflicts, remote.updatedAt);
  return preserveWindowNavigation(result, local);
}

/** Receiving another window's save must not navigate this window. */
export function preserveWindowNavigation(incoming: OrionVault, local: OrionVault): OrionVault {
  const activeSpaceId = incoming.spaces.some((s) => s.workspace.id === local.activeSpaceId)
    ? local.activeSpaceId : incoming.spaces.some((s) => s.workspace.id === incoming.activeSpaceId)
      ? incoming.activeSpaceId : incoming.spaces[0].workspace.id;
  return {
    ...incoming, activeSpaceId,
    spaces: incoming.spaces.map((space) => {
      const own = local.spaces.find((s) => s.workspace.id === space.workspace.id);
      const activeNoteId = own && space.notes.some((n) => n.id === own.activeNoteId) ? own.activeNoteId : null;
      return own ? { ...space, activeNoteId } : space;
    }),
  };
}

interface Persistence {
  load: () => Promise<OrionVault | null>;
  save: (vault: OrionVault, revision: string | null) => Promise<void>;
}

export function nextVaultRevision(...previous: string[]): string {
  return new Date(Math.max(Date.now(), ...previous.map((revision) => Date.parse(revision) + 1 || 0))).toISOString();
}

export async function persistWindowVault(
  base: OrionVault | null,
  local: OrionVault,
  storage: Persistence,
  resolution?: { choice: ConflictChoice; revision: string },
): Promise<OrionVault> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const latest = await storage.load();
    if (base && !latest) throw new Error("The Orion library was removed. Your unsaved changes remain in this window.");
    const choice = resolution?.revision === latest?.updatedAt ? resolution?.choice : undefined;
    let merged = latest && base ? mergeWindowVault(base, local, latest, choice) : local;
    if (!base && latest) {
      throw new Error("Another window created the library first. Reload Orion before editing this window.");
    }
    merged = allocateTicketCodes(merged, latest ?? undefined);
    if (latest && same(merged, latest)) return latest;
    merged = {
      ...merged,
      updatedAt: nextVaultRevision(latest?.updatedAt ?? "", local.updatedAt),
    };
    try {
      await storage.save(merged, latest?.updatedAt ?? null);
      return merged;
    } catch (error) {
      if (!String(error).includes("ORION_VAULT_CONFLICT")) throw error;
    }
  }
  throw new Error("Other Orion windows are still saving. Your changes remain here; try saving again.");
}
