import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import {
  contrastRatio,
  resolveThemeMode,
  resolveThemePalette,
  themeCssVariables,
  themePresetOptions,
} from "./theme";

describe("theme system", () => {
  it("resolves System without changing the selected preset", () => {
    expect(resolveThemeMode("system", true)).toBe("light");
    expect(resolveThemeMode("system", false)).toBe("dark");
    expect(resolveThemeMode("dark", true)).toBe("dark");
  });

  it.each(["dark", "light"] as const)(
    "keeps every curated %s palette readable",
    (mode) => {
      for (const preset of themePresetOptions) {
        const palette = resolveThemePalette(
          { ...defaultSettings, themePreset: preset.id },
          mode,
        );
        expect(
          contrastRatio(palette.text, palette.surface1),
        ).toBeGreaterThanOrEqual(7);
        expect(
          contrastRatio(palette.textSoft, palette.surface1),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette.muted, palette.surface1),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette.faint, palette.surface1),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette.accent, palette.surface1),
        ).toBeGreaterThanOrEqual(4.5);
        expect(
          contrastRatio(palette.accentInk, palette.accentStrong),
        ).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it.each(["dark", "light"] as const)(
    "makes Deep darker and Airy lighter in %s mode",
    (mode) => {
      const deep = resolveThemePalette(
        { ...defaultSettings, themeCanvasTone: "deep" },
        mode,
      );
      const airy = resolveThemePalette(
        { ...defaultSettings, themeCanvasTone: "airy" },
        mode,
      );
      expect(contrastRatio(deep.canvas, "#000000")).toBeLessThan(
        contrastRatio(airy.canvas, "#000000"),
      );
    },
  );

  it("clamps custom colors to the selected mode and derives safe foregrounds", () => {
    const dark = resolveThemePalette(
      {
        ...defaultSettings,
        themeAccentCustom: "#222222",
        themeCanvasCustom: "#ffffff",
        themeSurfaceCustom: "#ffffff",
      },
      "dark",
    );
    const light = resolveThemePalette(
      {
        ...defaultSettings,
        themeAccentCustom: "#eeeeee",
        themeCanvasCustom: "#000000",
        themeSurfaceCustom: "#000000",
      },
      "light",
    );

    expect(dark.canvas).not.toBe("#ffffff");
    expect(light.canvas).not.toBe("#000000");
    expect(contrastRatio(dark.text, dark.surface1)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(light.text, light.surface1)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(dark.accent, dark.surface1)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(light.accent, light.surface1)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it("maps the palette through one stable CSS-variable contract", () => {
    const variables = themeCssVariables(defaultSettings, "dark");
    expect(variables["--ink"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(variables["--surface-raised"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(variables["--periwinkle"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(variables["--accent-ink"]).toMatch(/^#[0-9a-f]{6}$/i);
    expect(variables["--theme-selection"]).toMatch(/^rgba\(/);
  });
});
