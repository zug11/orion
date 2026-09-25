import { describe, expect, it } from "vitest";
import { defaultWindowGlass, isWindowGlassSettings, normalizeWindowGlass, requestedWindowMaterial } from "./windowGlass";

describe("window glass preferences", () => {
  it("hydrates missing and partial preferences without losing an explicit off choice", () => {
    expect(isWindowGlassSettings(undefined)).toBe(true);
    expect(normalizeWindowGlass(undefined)).toEqual(defaultWindowGlass);
    expect(normalizeWindowGlass({ enabled: false })).toEqual({ ...defaultWindowGlass, enabled: false });
    expect(normalizeWindowGlass({ material: "solid" })).toEqual({ ...defaultWindowGlass, enabled: false });
  });

  it.each([
    { material: "hologram" }, { material: ["liquid"] }, { style: "thick" },
    { sidebar: "false" }, { interactive: 1 }, { sidebarOpacity: -1 },
    { topbarOpacity: 101 }, { topbarOpacity: "50" }, { cornerRadius: Infinity },
    { cornerRadius: 25 }, { sidebarOpacity: NaN }, { blur: -1 }, { blur: 101 }, { blur: "50" },
    { enabled: "true" }, { tintOpacity: -1 }, { tintOpacity: 101 }, { tintOpacity: NaN }, { tintOpacity: "30" },
    null, [],
  ])("rejects invalid stored preferences: %j", (value) => expect(isWindowGlassSettings(value)).toBe(false));

  it("migrates separate tints to their average and retires the old style controls", () => {
    const legacy = { material: "liquid", style: "clear", sidebar: true, topbar: true, sidebarOpacity: 60, topbarOpacity: 20, blur: 75, cornerRadius: 8, interactive: true };
    expect(isWindowGlassSettings(legacy)).toBe(true);
    expect(normalizeWindowGlass(legacy)).toEqual({ enabled: true, tintOpacity: 40, blur: 75 });
  });

  it("preserves the visible area's tint and explicit disabled choices during migration", () => {
    expect(normalizeWindowGlass({ sidebar: false, topbar: true, sidebarOpacity: 80, topbarOpacity: 20 }))
      .toEqual({ ...defaultWindowGlass, tintOpacity: 20 });
    expect(normalizeWindowGlass({ material: "frosted", sidebar: false, topbar: false, sidebarOpacity: 80, topbarOpacity: 20 }))
      .toEqual({ ...defaultWindowGlass, enabled: false, tintOpacity: 50 });
    expect(normalizeWindowGlass({ material: "solid", sidebarOpacity: 60, topbarOpacity: 20, blur: 75 }))
      .toEqual({ enabled: false, tintOpacity: 40, blur: 75 });
  });

  it("prefers the new settings when a merge still contains legacy fields", () => {
    const preference = { enabled: false, tintOpacity: 65, blur: 10 };
    expect(isWindowGlassSettings(preference)).toBe(true);
    expect(normalizeWindowGlass({ material: "liquid", sidebarOpacity: 20, topbarOpacity: 40, ...preference })).toEqual(preference);
    expect(normalizeWindowGlass(normalizeWindowGlass(preference))).toEqual(preference);
  });

  it("removes a fully hidden material while retaining adjustable preferences", () => {
    expect(requestedWindowMaterial({ ...defaultWindowGlass, enabled: false })).toBe("solid");
    expect(requestedWindowMaterial({ ...defaultWindowGlass, tintOpacity: 100 })).toBe("solid");
    expect(requestedWindowMaterial({ ...defaultWindowGlass, tintOpacity: 0 })).toBe("liquid");
  });
});
