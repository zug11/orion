import type { AppSnapshot, OrionVault } from "../types";

export const MAX_SPACE_NAME_LENGTH = 60;

export function normalizeSpaceName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function spaceNameError(
  name: string,
  spaces: readonly AppSnapshot[],
  exceptSpaceId?: string,
): string | null {
  const normalized = normalizeSpaceName(name);
  if (!normalized) return "Enter a Space name.";
  if (normalized.length > MAX_SPACE_NAME_LENGTH) return "Use 60 characters or fewer.";
  if (spaces.some((space) => space.workspace.id !== exceptSpaceId
    && space.workspace.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
    return "That name is already in use.";
  }
  return null;
}

/** Rename only the requested record; retain content and the window's navigation. */
export function renameSpaceInVault(
  vault: OrionVault,
  spaceId: string,
  name: string,
  now: string,
  expectedName: string,
): { vault: OrionVault; error: string | null } {
  const target = vault.spaces.find((space) => space.workspace.id === spaceId);
  if (!target) return { vault, error: "This Space is no longer available." };
  if (target.workspace.name !== expectedName) {
    return { vault, error: "This Space was renamed elsewhere. Reopen Rename to use its current name." };
  }
  const error = spaceNameError(name, vault.spaces, spaceId);
  if (error) return { vault, error };
  const normalized = normalizeSpaceName(name);
  if (normalized === target.workspace.name) return { vault, error: null };
  return {
    vault: {
      ...vault,
      spaces: vault.spaces.map((space) => space.workspace.id === spaceId
        ? { ...space, workspace: { ...space.workspace, name: normalized }, updatedAt: now }
        : space),
      updatedAt: now,
    },
    error: null,
  };
}
