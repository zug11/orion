import type { SavedThemePalette, ThemePreset } from "../types";
import type { ThemePreferences } from "./theme";

export const MAX_SAVED_THEME_PALETTES = 24;
export const MAX_THEME_PALETTE_NAME = 60;
const preferenceKeys = [
  "themePreset", "themeAccent", "themeAccentCustom", "themeCanvasTone",
  "themeCanvasCustom", "themeSurfaceLift", "themeSurfaceCustom", "themeTextWarmth", "themeContrast",
] as const;
const colors = ["themeAccentCustom", "themeCanvasCustom", "themeSurfaceCustom"] as const;
const choices = {
  themePreset: ["orion", "tide", "grove", "ember"],
  themeAccent: ["preset", "iris", "tide", "moss", "ember"],
  themeCanvasTone: ["deep", "balanced", "airy"],
  themeSurfaceLift: ["quiet", "balanced", "lifted"],
  themeTextWarmth: ["cool", "neutral", "warm"],
  themeContrast: ["soft", "balanced", "high"],
};

export function readThemePreferences(value: ThemePreferences): ThemePreferences {
  return Object.fromEntries(preferenceKeys.map((key) => [key, value[key]])) as unknown as ThemePreferences;
}

export function sameThemePreferences(left: ThemePreferences, right: ThemePreferences): boolean {
  return preferenceKeys.every((key) => left[key].toLowerCase() === right[key].toLowerCase());
}

export function defaultThemePreferences(themePreset: ThemePreset): ThemePreferences {
  return { themePreset, themeAccent: "preset", themeAccentCustom: "", themeCanvasTone: "balanced",
    themeCanvasCustom: "", themeSurfaceLift: "balanced", themeSurfaceCustom: "",
    themeTextWarmth: "neutral", themeContrast: "balanced" };
}

export function normalizeThemePaletteName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_THEME_PALETTE_NAME);
}

export function isSavedThemePalette(value: unknown): value is SavedThemePalette {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const palette = value as Record<string, unknown>;
  if (typeof palette.id !== "string" || !/^palette-[A-Za-z0-9_-]{1,80}$/.test(palette.id) ||
    typeof palette.name !== "string" || !palette.name.length || palette.name.length > MAX_THEME_PALETTE_NAME ||
    normalizeThemePaletteName(palette.name) !== palette.name) return false;
  return Object.entries(choices).every(([key, allowed]) =>
    typeof palette[key] === "string" && allowed.includes(palette[key] as string)) &&
    colors.every((key) => typeof palette[key] === "string" && /^(?:#[0-9a-f]{6})?$/i.test(palette[key] as string));
}

export function isSavedThemePaletteCollection(value: unknown): value is SavedThemePalette[] {
  return Array.isArray(value) && value.length <= MAX_SAVED_THEME_PALETTES &&
    value.every(isSavedThemePalette) && new Set(value.map((palette) => palette.id)).size === value.length;
}

export function normalizeSavedThemePalettes(value: unknown): SavedThemePalette[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SavedThemePalette[] = [];
  // Bound validation work for corrupted or externally supplied preferences.
  for (const palette of value.slice(0, MAX_SAVED_THEME_PALETTES)) {
    if (!isSavedThemePalette(palette) || seen.has(palette.id)) continue;
    seen.add(palette.id);
    result.push({ id: palette.id, name: palette.name, ...readThemePreferences(palette) });
  }
  return result;
}

export function normalizeActiveThemePaletteId(value: unknown, palettes: SavedThemePalette[]): string {
  return typeof value === "string" && palettes.some((palette) => palette.id === value) ? value : "";
}
