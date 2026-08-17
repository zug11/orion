import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import {
  atmosphereToneOptions,
  resolveAtmospherePalette,
} from "./homeAtmosphere";
import { contrastRatio, resolveThemePalette } from "./theme";

describe("home atmosphere theme inheritance", () => {
  it.each(["dark", "light"] as const)(
    "gives every shader one shared, gently offset %s room",
    (mode) => {
      const theme = resolveThemePalette(
        {
          ...defaultSettings,
          themePreset: "grove",
          themeCanvasCustom: mode === "dark" ? "#122019" : "#E7EFE6",
          themeSurfaceCustom: mode === "dark" ? "#192A20" : "#F6FAF2",
        },
        mode,
      );
      const rooms = (["line-waves", "signal-decay", "field"] as const).map(
        (atmosphere) =>
          resolveAtmospherePalette(atmosphere, "signature", theme),
      );

      for (const room of rooms) {
        expect(room.background).toBe(theme.canvasDeep);
        expect(room.backgroundSecondary).toBe(theme.surface0);
        expect(room.background).not.toBe(theme.canvas);
      }
      expect(new Set(rooms.map((room) => room.background)).size).toBe(1);
      expect(
        new Set(rooms.map((room) => room.backgroundSecondary)).size,
      ).toBe(1);
    },
  );

  it("derives the signature strokes and room from the complete custom palette", () => {
    const theme = resolveThemePalette(
      {
        ...defaultSettings,
        themePreset: "tide",
        themeAccentCustom: "#B16BDA",
        themeCanvasCustom: "#111B24",
        themeSurfaceCustom: "#162B34",
        themeTextWarmth: "warm",
        themeContrast: "high",
      },
      "dark",
    );

    const atmosphere = resolveAtmospherePalette(
      "field",
      "signature",
      theme,
    );

    expect(atmosphere).toMatchObject({
      primary: theme.accentStrong,
      secondary: theme.accent,
      tertiary: theme.mint,
      bright: theme.text,
      muted: theme.muted,
      background: theme.canvasDeep,
      backgroundSecondary: theme.surface0,
    });
    expect(atmosphereToneOptions[0]).toEqual({
      id: "signature",
      name: "Theme",
    });
  });

  it("adapts backgrounds and readable strokes across light and dark modes", () => {
    const settings = {
      ...defaultSettings,
      themePreset: "ember" as const,
      themeCanvasCustom: "#D7C9B6",
      themeSurfaceCustom: "#F7EADB",
      themeTextWarmth: "warm" as const,
    };
    const lightTheme = resolveThemePalette(settings, "light");
    const darkTheme = resolveThemePalette(settings, "dark");
    const light = resolveAtmospherePalette(
      "signal-decay",
      "signature",
      lightTheme,
    );
    const dark = resolveAtmospherePalette(
      "signal-decay",
      "signature",
      darkTheme,
    );

    expect(light.background).toBe(lightTheme.canvasDeep);
    expect(dark.background).toBe(darkTheme.canvasDeep);
    expect(light.background).not.toBe(dark.background);
    expect(light.isLight).toBe(true);
    expect(dark.isLight).toBe(false);
    expect(light.bright).toBe(lightTheme.text);
    expect(dark.bright).toBe(darkTheme.text);
  });

  it("keeps an intentional atmosphere tint while inheriting the themed room", () => {
    const theme = resolveThemePalette(
      {
        ...defaultSettings,
        themeCanvasCustom: "#132020",
        themeSurfaceCustom: "#19302D",
        themeTextWarmth: "cool",
      },
      "dark",
    );
    const atmosphere = resolveAtmospherePalette("line-waves", "gold", theme);

    expect(atmosphere.primary).toBe("#D8B675");
    expect(atmosphere.bright).toBe(theme.text);
    expect(atmosphere.muted).toBe(theme.muted);
    expect(atmosphere.background).toBe(theme.canvasDeep);
    expect(atmosphere.backgroundSecondary).toBe(theme.surface0);
  });

  it.each(["violet", "mint", "gold"] as const)(
    "keeps the explicit %s tint visible in a light room",
    (tone) => {
      const theme = resolveThemePalette(
        {
          ...defaultSettings,
          themePreset: "ember",
          themeCanvasTone: "airy",
          themeSurfaceLift: "lifted",
        },
        "light",
      );
      const atmosphere = resolveAtmospherePalette("line-waves", tone, theme);

      for (const color of [
        atmosphere.primary,
        atmosphere.secondary,
        atmosphere.tertiary,
      ]) {
        expect(contrastRatio(color, theme.canvasDeep)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(color, theme.surface0)).toBeGreaterThanOrEqual(3);
      }
    },
  );
});
