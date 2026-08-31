import type {
  AppSnapshot,
  HomeAtmosphere,
  HomeAtmosphereMotion,
  HomeAtmosphereTone,
  OrionVault,
  SavedElevenLabsVoice,
  Settings,
  SpeechVoice,
  ThemeAccent,
  ThemeCanvasTone,
  ThemeContrast,
  ThemePreset,
  ThemeSurfaceLift,
  ThemeTextWarmth,
} from "../types";
import { createEmptyStudio } from "../lib/studio";

export const defaultSettings: Settings = {
  model: "gpt-5.6-sol",
  reasoningEffort: "low",
  apiKeyConfigured: false,
  anthropicApiKeyConfigured: false,
  elevenLabsApiKeyConfigured: false,
  elevenLabsVoiceId: "",
  elevenLabsVoices: [],
  speechVoice: "system",
  sidebarCollapsed: false,
  providerFailoverEnabled: false,
  autoLink: true,
  showHoverPreviews: true,
  includeExistingNotesInAIContext: true,
  organizationInstructions:
    "Prefer durable, concise wiki notes. Preserve uncertainty, cite the source, and connect ideas only when the source supports the connection.",
  whisperLanguage: "",
  theme: "dark",
  themePreset: "orion",
  themeAccent: "preset",
  themeAccentCustom: "",
  themeCanvasTone: "balanced",
  themeCanvasCustom: "",
  themeSurfaceLift: "balanced",
  themeSurfaceCustom: "",
  themeTextWarmth: "neutral",
  themeContrast: "balanced",
  homeAtmosphere: "field",
  homeAtmosphereTone: "signature",
  homeAtmosphereMotion: "calm",
};

export function normalizeSpeechVoice(value: unknown): SpeechVoice {
  if (value === "system" || value === "openai" || value === "elevenlabs") {
    return value;
  }
  return defaultSettings.speechVoice;
}

const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{8,40}$/;

export function normalizeElevenLabsVoiceId(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return ELEVENLABS_VOICE_ID.test(trimmed) ? trimmed : "";
}

export const MAX_VOICE_NAME_LENGTH = 80;

export function isSavedElevenLabsVoice(
  value: unknown,
): value is SavedElevenLabsVoice {
  if (!value || typeof value !== "object") return false;
  const voice = value as Partial<SavedElevenLabsVoice>;
  return (
    typeof voice.name === "string" &&
    voice.name.trim().length > 0 &&
    voice.name.length <= MAX_VOICE_NAME_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(voice.name) &&
    typeof voice.voiceId === "string" &&
    voice.voiceId === voice.voiceId.trim() &&
    ELEVENLABS_VOICE_ID.test(voice.voiceId)
  );
}

export function normalizeElevenLabsVoices(
  value: unknown,
  currentVoiceId?: unknown,
): SavedElevenLabsVoice[] {
  const voices: SavedElevenLabsVoice[] = [];
  const seen = new Set<string>();
  if (Array.isArray(value)) {
    for (const voice of value) {
      if (!isSavedElevenLabsVoice(voice) || seen.has(voice.voiceId)) continue;
      voices.push({ name: voice.name.trim(), voiceId: voice.voiceId });
      seen.add(voice.voiceId);
    }
  }
  // Keep a previously pasted voice selectable when upgrading an older vault.
  const current = normalizeElevenLabsVoiceId(currentVoiceId);
  if (current && !seen.has(current)) {
    voices.unshift({ name: "Saved voice", voiceId: current });
  }
  return voices;
}

export function normalizeThemePreset(value: unknown): ThemePreset {
  if (
    value === "orion" ||
    value === "tide" ||
    value === "grove" ||
    value === "ember"
  ) {
    return value;
  }
  return defaultSettings.themePreset;
}

export function normalizeThemeAccent(value: unknown): ThemeAccent {
  if (
    value === "preset" ||
    value === "iris" ||
    value === "tide" ||
    value === "moss" ||
    value === "ember"
  ) {
    return value;
  }
  return defaultSettings.themeAccent;
}

export function normalizeThemeColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? value.toUpperCase()
    : "";
}

export function normalizeThemeCanvasTone(value: unknown): ThemeCanvasTone {
  if (value === "deep" || value === "balanced" || value === "airy") {
    return value;
  }
  return defaultSettings.themeCanvasTone;
}

export function normalizeThemeSurfaceLift(value: unknown): ThemeSurfaceLift {
  if (value === "quiet" || value === "balanced" || value === "lifted") {
    return value;
  }
  return defaultSettings.themeSurfaceLift;
}

export function normalizeThemeTextWarmth(value: unknown): ThemeTextWarmth {
  if (value === "cool" || value === "neutral" || value === "warm") {
    return value;
  }
  return defaultSettings.themeTextWarmth;
}

export function normalizeThemeContrast(value: unknown): ThemeContrast {
  if (value === "soft" || value === "balanced" || value === "high") {
    return value;
  }
  return defaultSettings.themeContrast;
}

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
