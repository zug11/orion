import type { OrionVault } from "../types";
import {
  hasSubstantiveOverviewNote,
  spaceKnowledgeFingerprint,
} from "./spaceOverview";

export function shouldAcceptExternalVault(
  currentUpdatedAt: string,
  incomingUpdatedAt: string,
): boolean {
  const currentTime = Date.parse(currentUpdatedAt);
  const incomingTime = Date.parse(incomingUpdatedAt);
  return (
    Number.isFinite(incomingTime) &&
    (!Number.isFinite(currentTime) ||
      incomingTime > currentTime ||
      (incomingTime === currentTime && incomingUpdatedAt !== currentUpdatedAt))
  );
}

export function spacesNeedingOverviewRefresh(
  previousVault: OrionVault,
  incomingVault: OrionVault,
): string[] {
  return incomingVault.spaces
    .filter((space) => {
      const previous = previousVault.spaces.find(
        (candidate) => candidate.workspace.id === space.workspace.id,
      );
      const knowledgeChanged =
        !previous ||
        spaceKnowledgeFingerprint(previous) !==
          spaceKnowledgeFingerprint(space);
      if (!knowledgeChanged) return false;
      const hasKnowledge = space.notes.some(hasSubstantiveOverviewNote);
      return hasKnowledge
        ? !space.spaceOverview || space.spaceOverview.stale
        : Boolean(space.spaceOverview);
    })
    .map((space) => space.workspace.id);
}
