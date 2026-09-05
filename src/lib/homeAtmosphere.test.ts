import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import {
  atmosphereToneOptions,
  resolveAtmospherePalette,
} from "./homeAtmosphere";
import { contrastRatio, resolveThemePalette } from "./theme";

describe("home atmosphere theme inheritance", () => {
  const atmospheres = [
    "line-waves", "signal-decay", "field", "quiet-loom", "nova", "flux",
    "tidal-glass", "prism-drift", "nebula", "emberwake", "gravity-silk", "mirage",
  ] as const;

  it("uses both chosen hues and their blend across every shader", () => {
    for (const atmosphere of atmospheres) {
      const pair = resolveAtmospherePalette(atmosphere, "gold", undefined, "#ff0000", "#0000ff");
      expect(pair).toMatchObject({ primary: "#FF0000", secondary: "#0000FF", tertiary: "#800080" });
      const changedFirst = resolveAtmospherePalette(atmosphere, "gold", undefined, "#00ff00", "#0000ff");
      expect(changedFirst.secondary).toBe(pair.secondary);
      expect(changedFirst.primary).not.toBe(pair.primary);
      expect(changedFirst.tertiary).not.toBe(pair.tertiary);
    }
  });

  it.each(["dark", "light"] as const)("keeps custom pairs readable in every %s shader", (mode) => {
    for (const themePreset of ["orion", "tide", "grove", "ember"] as const) {
      const theme = resolveThemePalette({ ...defaultSettings, themePreset }, mode);
      for (const atmosphere of atmospheres) {
        for (const [first, second] of [["#FF6699", "#66CFFF"], ["#000000", "#FFFFFF"], ["#00FF00", "#FF00FF"]]) {
          const pair = resolveAtmospherePalette(atmosphere, "signature", theme, first, second);
          expect(pair.primary).not.toBe(pair.secondary);
          expect(pair.background).toBe(theme.canvasDeep);
          expect(pair.backgroundSecondary).toBe(theme.surface0);
          for (const colour of [pair.primary, pair.secondary, pair.tertiary]) {
            expect(contrastRatio(colour, theme.canvasDeep)).toBeGreaterThanOrEqual(3);
            expect(contrastRatio(colour, theme.surface0)).toBeGreaterThanOrEqual(3);
          }
        }
      }
    }
  });

  it("preserves legacy single-colour overrides and the untouched default palette", () => {
    const theme = resolveThemePalette(defaultSettings, "dark");
    for (const atmosphere of atmospheres) {
      for (const secondary of [undefined, "", "red", "#123", "#00ggff", "#112233;}"]) {
        expect(resolveAtmospherePalette(atmosphere, "signature", theme, "#ff4c80", secondary))
          .toEqual(resolveAtmospherePalette(atmosphere, "signature", theme, "#ff4c80"));
        expect(resolveAtmospherePalette(atmosphere, "signature", theme, "", secondary))
          .toEqual(resolveAtmospherePalette(atmosphere, "signature", theme));
      }
    }
  });

  it("can override only the second hue while retaining the preset primary", () => {
    const preset = resolveAtmospherePalette("nova", "mint");
    const pair = resolveAtmospherePalette("nova", "mint", undefined, "", "#ff6699");
    expect(pair.primary).toBe(preset.primary);
    expect(pair.secondary).toBe("#FF6699");
  });

  it("uses a custom hue across every shader and ignores the selected preset", () => {
    const theme = resolveThemePalette(defaultSettings, "dark");
    for (const mode of [
      "line-waves", "signal-decay", "field", "quiet-loom", "nova", "flux",
      "tidal-glass", "prism-drift", "nebula", "emberwake", "gravity-silk", "mirage",
    ] as const) {
      const custom = resolveAtmospherePalette(mode, "mint", theme, "#ff4c80");
      expect(custom.primary).toBe("#FF4C80");
      expect(custom.secondary).not.toBe(custom.primary);
      expect(custom.tertiary).not.toBe(custom.primary);
      expect(custom).toEqual(resolveAtmospherePalette(mode, "gold", theme, "#FF4C80"));
      expect(custom.background).toBe(theme.canvasDeep);
      expect(custom.backgroundSecondary).toBe(theme.surface0);
    }
  });

  it.each(["dark", "light"] as const)("keeps extreme custom colors visible in %s mode", (mode) => {
    const theme = resolveThemePalette(defaultSettings, mode);
    for (const customColor of ["#000000", "#FFFFFF", "#0000FF", "#00FF00"]) {
      const palette = resolveAtmospherePalette("flux", "signature", theme, customColor);
      for (const color of [palette.primary, palette.secondary, palette.tertiary]) {
        expect(contrastRatio(color, theme.canvasDeep)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(color, theme.surface0)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("falls back to the preset for absent or invalid custom colors", () => {
    const theme = resolveThemePalette(defaultSettings, "dark");
    const preset = resolveAtmospherePalette("mirage", "gold", theme);
    for (const color of [undefined, "", "red", "#123", "#00ggff", "#112233;}"]) {
      expect(resolveAtmospherePalette("mirage", "gold", theme, color)).toEqual(preset);
    }
  });

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
      const rooms = ([
        "line-waves", "signal-decay", "field", "quiet-loom", "nova",
        "flux", "tidal-glass", "prism-drift", "nebula",
        "emberwake", "gravity-silk", "mirage",
      ] as const).map(
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
      for (const mode of [
        "line-waves", "quiet-loom", "nova", "flux", "tidal-glass", "prism-drift", "nebula",
        "emberwake", "gravity-silk", "mirage",
      ] as const) {
        const atmosphere = resolveAtmospherePalette(mode, tone, theme);
        for (const color of [atmosphere.primary, atmosphere.secondary, atmosphere.tertiary]) {
          expect(contrastRatio(color, theme.canvasDeep)).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(color, theme.surface0)).toBeGreaterThanOrEqual(3);
        }
      }
    },
  );
});
