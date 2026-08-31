import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  normalizeHomeAtmosphere,
  normalizeHomeAtmosphereMotion,
  normalizeHomeAtmosphereTone,
  normalizeElevenLabsVoiceId,
  normalizeElevenLabsVoices,
  normalizeSpeechVoice,
  normalizeThemeAccent,
  normalizeThemeCanvasTone,
  normalizeThemeColor,
  normalizeThemeContrast,
  normalizeThemePreset,
  normalizeThemeSurfaceLift,
  normalizeThemeTextWarmth,
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

describe("speech voice defaults", () => {
  it("preserves a legacy voice and makes migration repeatable", () => {
    const voiceId = "21m00Tcm4TlvDq8ikWAM";
    const migrated = normalizeElevenLabsVoices(undefined, voiceId);
    expect(migrated).toEqual([{ name: "Saved voice", voiceId }]);
    expect(normalizeElevenLabsVoices(migrated, voiceId)).toEqual(migrated);
    expect(normalizeElevenLabsVoices(undefined, "../bad")).toEqual([]);
    expect(defaultSettings.elevenLabsVoices).toEqual([]);
  });

  it("keeps names and order while removing duplicate IDs and invalid presets", () => {
    const voice = { name: "  Everyday reading  ", voiceId: "21m00Tcm4TlvDq8ikWAM" };
    expect(normalizeElevenLabsVoices([
      voice,
      { ...voice, name: "Duplicate" },
      { name: "Bad ID", voiceId: "../voice" },
      { name: "", voiceId: "JBFqnCBsd6RMkjVDRZzb" },
    ], voice.voiceId)).toEqual([{ ...voice, name: "Everyday reading" }]);
  });

  it("keeps supported engines and hydrates older vaults to System", () => {
    expect(normalizeSpeechVoice("elevenlabs")).toBe("elevenlabs");
    expect(normalizeSpeechVoice(undefined)).toBe("system");
    expect(defaultSettings.speechVoice).toBe("system");
    expect(defaultSettings.elevenLabsApiKeyConfigured).toBe(false);
    expect(defaultSettings.elevenLabsVoiceId).toBe("");
    expect(normalizeElevenLabsVoiceId("21m00Tcm4TlvDq8ikWAM")).toBe(
      "21m00Tcm4TlvDq8ikWAM",
    );
    expect(normalizeElevenLabsVoiceId("../voice")).toBe("");
  });
});

describe("theme defaults", () => {
  it("keeps supported curated choices", () => {
    expect(normalizeThemePreset("grove")).toBe("grove");
    expect(normalizeThemeAccent("moss")).toBe("moss");
    expect(normalizeThemeColor("#aabbcc")).toBe("#AABBCC");
    expect(normalizeThemeCanvasTone("airy")).toBe("airy");
    expect(normalizeThemeSurfaceLift("lifted")).toBe("lifted");
    expect(normalizeThemeTextWarmth("warm")).toBe("warm");
    expect(normalizeThemeContrast("high")).toBe("high");
  });

  it("hydrates missing or malformed choices to the restrained defaults", () => {
    expect(normalizeThemePreset(undefined)).toBe("orion");
    expect(normalizeThemeAccent("neon")).toBe("preset");
    expect(normalizeThemeColor("blue")).toBe("");
    expect(normalizeThemeCanvasTone(3)).toBe("balanced");
    expect(normalizeThemeSurfaceLift("floating")).toBe("balanced");
    expect(normalizeThemeTextWarmth(null)).toBe("neutral");
    expect(normalizeThemeContrast("maximum")).toBe("balanced");
  });
});
