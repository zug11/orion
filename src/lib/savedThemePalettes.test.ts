import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import {
  defaultThemePreferences, isSavedThemePaletteCollection, normalizeActiveThemePaletteId,
  normalizeSavedThemePalettes, normalizeThemePaletteName, readThemePreferences, sameThemePreferences,
} from "./savedThemePalettes";

const palette = { ...defaultThemePreferences("tide"), id: "palette-coastal", name: "Coastal" };

describe("saved reading-room palettes", () => {
  it("supports old settings and persists only palette preferences", () => {
    expect(normalizeSavedThemePalettes(undefined)).toEqual([]);
    expect(normalizeActiveThemePaletteId("palette-missing", [palette])).toBe("");
    expect(normalizeActiveThemePaletteId(palette.id, [palette])).toBe(palette.id);
    const preferences = readThemePreferences({ ...defaultSettings, themeCanvasCustom: "#123456" });
    expect(preferences).not.toHaveProperty("theme");
    expect(preferences).not.toHaveProperty("apiKeyConfigured");
    expect(preferences).toHaveProperty("themeCanvasCustom", "#123456");
  });

  it("rejects malformed, duplicate, oversized and unsafe persisted collections", () => {
    expect(isSavedThemePaletteCollection([palette])).toBe(true);
    for (const bad of [null, {}, [palette, palette], Array(25).fill(palette),
      [{ ...palette, name: "" }], [{ ...palette, name: "a".repeat(61) }],
      [{ ...palette, name: "Coastal\n" }], [{ ...palette, id: "../../secret" }],
      [{ ...palette, themeCanvasCustom: "red" }], [{ ...palette, themeSurfaceCustom: "#fff;display:none" }],
      [{ ...palette, themeContrast: "unbounded" }], [{ ...palette, themeAccentCustom: null }]]) {
      expect(isSavedThemePaletteCollection(bad)).toBe(false);
    }
    expect(normalizeSavedThemePalettes([palette, palette, { ...palette, name: null }])).toEqual([palette]);
  });

  it("compares content rather than object key order and ignores mode", () => {
    expect(sameThemePreferences(defaultSettings, defaultThemePreferences("orion"))).toBe(true);
    expect(sameThemePreferences({ ...palette, themeCanvasCustom: "#AABBCC" },
      { ...palette, themeCanvasCustom: "#aabbcc" })).toBe(true);
    expect(sameThemePreferences(palette, { ...palette, themeCanvasTone: "deep" })).toBe(false);
    expect(normalizeThemePaletteName("  My   room\n")).toBe("My room");
  });
});
