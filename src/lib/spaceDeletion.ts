import type { OrionVault } from "../types";

export interface SpaceDeletionResult {
  vault: OrionVault;
  deleted: boolean;
  activeSpaceChanged: boolean;
  nextActiveSpaceId: string;
}

/**
 * Removes one Space while preserving the vault invariant that an active Space
 * always exists. When the active Space is removed, prefer the following Space
 * in visual order and fall back to the previous one at the end of the list.
 */
export function deleteSpaceFromVault(
  vault: OrionVault,
  spaceId: string,
  now: string,
): SpaceDeletionResult {
  const deletedIndex = vault.spaces.findIndex(
    (space) => space.workspace.id === spaceId,
  );
  if (deletedIndex < 0 || vault.spaces.length <= 1) {
    return {
      vault,
      deleted: false,
      activeSpaceChanged: false,
      nextActiveSpaceId: vault.activeSpaceId,
    };
  }

  const spaces = vault.spaces.filter(
    (space) => space.workspace.id !== spaceId,
  );
  const activeSpaceChanged = vault.activeSpaceId === spaceId;
  const nextActiveSpaceId = activeSpaceChanged
    ? spaces[Math.min(deletedIndex, spaces.length - 1)].workspace.id
    : vault.activeSpaceId;

  return {
    vault: {
      ...vault,
      spaces,
      activeSpaceId: nextActiveSpaceId,
      updatedAt: now,
    },
    deleted: true,
    activeSpaceChanged,
    nextActiveSpaceId,
  };
}
