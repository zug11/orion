import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import { resolveThemePalette } from "./theme";
import { recolorIconPixels, resolveIconPalette } from "./themeIcon";

describe("theme icon lighting", () => {
  it("preserves every alpha value, including the hole and antialiased silhouette", () => {
    const source = new Uint8ClampedArray([0, 0, 0, 0, 100, 150, 190, 44, 10, 45, 250, 255]);
    const copy = source.slice();
    const result = recolorIconPixels(source, resolveIconPalette(resolveThemePalette(defaultSettings, "dark")));
    expect([result[3], result[7], result[11]]).toEqual([0, 44, 255]);
    expect(source).toEqual(copy);
  });

  it.each(["dark", "light"] as const)("retains ordered shadows, body and highlights for all %s themes", (mode) => {
    for (const themePreset of ["orion", "tide", "grove", "ember"] as const) {
      for (const themeAccentCustom of ["", "#FFFFFF", "#000000", "#FF2277"]) {
        const theme = resolveThemePalette({ ...defaultSettings, themePreset, themeAccentCustom }, mode);
        const palette = resolveIconPalette(theme);
        const pixels = recolorIconPixels(new Uint8ClampedArray([26, 26, 26, 255, 132, 132, 132, 255, 230, 230, 230, 255]), palette);
        const light = (offset: number) => pixels[offset] * .2126 + pixels[offset + 1] * .7152 + pixels[offset + 2] * .0722;
        expect(light(0)).toBeLessThan(light(4));
        expect(light(4)).toBeLessThan(light(8));
        expect(light(8)).toBeLessThan(245);
        expect(palette.background).toBe(theme.surface1);
      }
    }
  });

  it("responds to the custom accent and gives the same accent a lighter daylight body", () => {
    const theme = resolveThemePalette({ ...defaultSettings, themeAccentCustom: "#9674A8" }, "dark");
    const day = resolveIconPalette({ ...theme, mode: "light" });
    const night = resolveIconPalette(theme);
    expect(day.body.every((value, i) => value > night.body[i])).toBe(true);
    expect(resolveIconPalette({ ...theme, accent: "#008877" })).not.toEqual(night);
  });
});
