import type {
  AppSnapshot,
  HomeAtmosphere,
  HomeAtmosphereMotion,
  HomeAtmosphereTone,
  OrionVault,
  Settings,
} from "../types";
import { createEmptyStudio } from "../lib/studio";

export const defaultSettings: Settings = {
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
  apiKeyConfigured: false,
  anthropicApiKeyConfigured: false,
  autoLink: true,
  showHoverPreviews: true,
  includeExistingNotesInAIContext: true,
  organizationInstructions:
    "Prefer durable, concise wiki notes. Preserve uncertainty, cite the source, and connect ideas only when the source supports the connection.",
  whisperLanguage: "",
  theme: "dark",
  homeAtmosphere: "field",
  homeAtmosphereTone: "signature",
  homeAtmosphereMotion: "calm",
};

export function normalizeHomeAtmosphere(value: unknown): HomeAtmosphere {
  if (
    value === "signal-decay" ||
    value === "line-waves" ||
    value === "field"
  ) {
    return value;
  }
  if (value === "antigravity" || value === "constellation") {
    return "signal-decay";
  }
  if (value === "aurora" || value === "liquid-ether") {
    return "line-waves";
  }
  return defaultSettings.homeAtmosphere;
}

export function normalizeHomeAtmosphereTone(
  value: unknown,
): HomeAtmosphereTone {
  if (
    value === "signature" ||
    value === "violet" ||
    value === "mint" ||
    value === "gold"
  ) {
    return value;
  }
  return defaultSettings.homeAtmosphereTone;
}

export function normalizeHomeAtmosphereMotion(
  value: unknown,
): HomeAtmosphereMotion {
  if (value === "still" || value === "calm" || value === "alive") {
    return value;
  }
  return defaultSettings.homeAtmosphereMotion;
}

export function createEmptySnapshot(
  name = "Orion",
  now = new Date().toISOString(),
  workspaceId = `workspace-${slugifyTitle(name) || "orion"}`,
): AppSnapshot {
  return {
    schemaVersion: 1,
    workspace: {
      id: workspaceId,
      name,
      description: "A living atlas of connected thought.",
      createdAt: now,
    },
    notes: [],
    sources: [],
    concepts: [],
    relationships: [],
    importDrafts: [],
    studio: createEmptyStudio(),
    settings: { ...defaultSettings },
    activeNoteId: null,
    updatedAt: now,
  };
}

export function createEmptyVault(
  name = "Orion",
  now = new Date().toISOString(),
): OrionVault {
  const space = createEmptySnapshot(name, now);
  return {
    schemaVersion: 2,
    spaces: [space],
    activeSpaceId: space.workspace.id,
    updatedAt: now,
  };
}

export function wrapLegacySnapshot(snapshot: AppSnapshot): OrionVault {
  return {
    schemaVersion: 2,
    spaces: [snapshot],
    activeSpaceId: snapshot.workspace.id,
    updatedAt: snapshot.updatedAt,
  };
}

export function activeSpace(vault: OrionVault): AppSnapshot {
  return (
    vault.spaces.find(
      (space) => space.workspace.id === vault.activeSpaceId,
    ) ?? vault.spaces[0]
  );
}

export function slugifyTitle(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
