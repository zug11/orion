import type { OrionVault } from "../types";
import { reconcileSnapshotConceptVocabulary } from "./concepts";
import { vaultValuesEqual } from "./windowVault";

/** Reuse immutable renderer objects after a disk round trip. Native JSON creates
 * new identities for every note; unchanged identities must not rebuild editors,
 * automatic linking and voice context throughout the library after each save. */
function share<T>(previous: T, incoming: T): T {
  if (vaultValuesEqual(previous, incoming)) return previous;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    return incoming.map((item, index) => share(previous[index], item)) as T;
  }
  if (previous && incoming && typeof previous === "object" && typeof incoming === "object" && !Array.isArray(previous) && !Array.isArray(incoming)) {
    return Object.fromEntries(Object.entries(incoming).map(([key, value]) => [key, share((previous as Record<string, unknown>)[key], value)])) as T;
  }
  return incoming;
}

export function publishWindowVault(current: OrionVault, incoming: OrionVault): OrionVault {
  const previous = new Map(current.spaces.map(space => [space.workspace.id, space]));
  const spaces = incoming.spaces.map(space => {
    const own = previous.get(space.workspace.id);
    // Locally edited notes already have their vocabulary reconciled. Only
    // genuinely incoming note/concept changes require the external-writer pass.
    const unchangedKnowledge = own && vaultValuesEqual(own.notes, space.notes) && vaultValuesEqual(own.concepts, space.concepts);
    const reconciled = unchangedKnowledge ? space : reconcileSnapshotConceptVocabulary(space);
    return own ? share(own, reconciled) : reconciled;
  });
  return share(current, { ...incoming, spaces });
}
