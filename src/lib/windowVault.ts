import type { OrionVault } from "../types";

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
        return [...new Set([...theirs, ...ours])].filter((item) => !removed.has(item));
      }
      if (all.every((item) => recordId(item) !== undefined)) {
        const index = (items: unknown[]) => new Map(items.map((item) => [recordId(item)!, item]));
        const b = index(before), l = index(ours), r = index(theirs);
        // Preserve established disk order; append only genuinely new local records.
        const ids = [...new Set([...r.keys(), ...l.keys(), ...b.keys()])];
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
  const result = merge(base, local, remote, "") as OrionVault;
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
