import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  normalizeHomeAtmosphere,
  normalizeHomeAtmosphereMotion,
  normalizeHomeAtmosphereTone,
} from "./defaults";

describe("normalizeHomeAtmosphere", () => {
  it.each([
    ["signal-decay", "signal-decay"],
    ["line-waves", "line-waves"],
    ["field", "field"],
  ] as const)("keeps the active %s atmosphere", (input, expected) => {
    expect(normalizeHomeAtmosphere(input)).toBe(expected);
  });

  it("migrates the retired atmospheres to their closest replacements", () => {
    expect(normalizeHomeAtmosphere("antigravity")).toBe("signal-decay");
    expect(normalizeHomeAtmosphere("constellation")).toBe("signal-decay");
    expect(normalizeHomeAtmosphere("aurora")).toBe("line-waves");
    expect(normalizeHomeAtmosphere("liquid-ether")).toBe("line-waves");
  });

  it("falls back to the curated default", () => {
    expect(normalizeHomeAtmosphere("galaxy")).toBe(
      defaultSettings.homeAtmosphere,
    );
  });
});

describe("home atmosphere tuning defaults", () => {
  it("keeps supported curated values", () => {
    expect(normalizeHomeAtmosphereTone("gold")).toBe("gold");
    expect(normalizeHomeAtmosphereMotion("alive")).toBe("alive");
  });

  it("falls back when older or malformed vaults omit tuning", () => {
    expect(normalizeHomeAtmosphereTone(undefined)).toBe("signature");
    expect(normalizeHomeAtmosphereMotion("fast")).toBe("calm");
  });
});
