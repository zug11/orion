/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { defaultSettings } from "../data/defaults";
import { normalizeElevenLabsVoiceId } from "../data/defaults";
import {
  chunkSpeechText,
  cloudSpeechCacheKey,
  ELEVENLABS_SPEECH_VOICE_ID,
  formatSpeechClock,
  PreparedSpeechCache,
  resolveElevenLabsVoiceId,
  resolveSpeechEngine,
  speakableNoteText,
} from "./speech";

describe("resolveSpeechEngine", () => {
  it("uses ElevenLabs for Play whenever that key is configured", () => {
    expect(
      resolveSpeechEngine({
        ...defaultSettings,
        speechVoice: "system",
        elevenLabsApiKeyConfigured: true,
      }),
    ).toBe("elevenlabs");
  });

  it("keeps an explicit OpenAI choice when that key is present", () => {
    expect(
      resolveSpeechEngine({
        ...defaultSettings,
        speechVoice: "openai",
        apiKeyConfigured: true,
        elevenLabsApiKeyConfigured: true,
      }),
    ).toBe("openai");
  });

  it("does not silently fall back from ElevenLabs to System", () => {
    expect(
      resolveSpeechEngine({
        ...defaultSettings,
        speechVoice: "elevenlabs",
        elevenLabsApiKeyConfigured: false,
      }),
    ).toBe("elevenlabs");
  });
});

describe("resolveElevenLabsVoiceId", () => {
  it("uses a supplied library id and ignores junk", () => {
    expect(
      resolveElevenLabsVoiceId({ elevenLabsVoiceId: "21m00Tcm4TlvDq8ikWAM" }),
    ).toBe("21m00Tcm4TlvDq8ikWAM");
    expect(normalizeElevenLabsVoiceId("../secret")).toBe("");
    expect(normalizeElevenLabsVoiceId("short")).toBe("");
    expect(resolveElevenLabsVoiceId({ elevenLabsVoiceId: "" })).toBe(
      ELEVENLABS_SPEECH_VOICE_ID,
    );
  });
});

describe("formatSpeechClock", () => {
  it("formats minutes and seconds", () => {
    expect(formatSpeechClock(0)).toBe("0:00");
    expect(formatSpeechClock(75.9)).toBe("1:15");
  });
});

describe("chunkSpeechText", () => {
  it("splits on sentence boundaries under the cap", () => {
    const text = `${"Alpha sentence. ".repeat(40)}Beta comes next.`;
    const chunks = chunkSpeechText(text, 80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(chunks.join(" ")).toContain("Beta comes next.");
  });
});

describe("PreparedSpeechCache", () => {
  it("reuses an in-flight synthesize and drops failed keys", async () => {
    const cache = new PreparedSpeechCache();
    let calls = 0;
    const factory = () => {
      calls += 1;
      return Promise.resolve([
        { mimeType: "audio/mpeg", base64Data: "Zg==" },
      ]);
    };
    const key = cloudSpeechCacheKey("elevenlabs", "Hello", "voice");
    const first = cache.set(key, factory);
    const second = cache.set(key, factory);
    expect(first).toBe(second);
    await first;
    expect(calls).toBe(1);
    expect(cache.has(key)).toBe(true);

    const failing = cache.set("fail", () => Promise.reject(new Error("no")));
    await expect(failing).rejects.toThrow("no");
    expect(cache.has("fail")).toBe(false);
  });
});

describe("speakableNoteText", () => {
  it("reads title, summary, and stripped body", () => {
    const spoken = speakableNoteText({
      title: "Phenomenology",
      summary: "A Space briefing.",
      body: "## Spirit\n\nHegel [argues](https://example.com) the opposite.\n\n```\ncode\n```",
    });
    expect(spoken).toContain("Phenomenology");
    expect(spoken).toContain("A Space briefing.");
    expect(spoken).toContain("Hegel argues the opposite.");
    expect(spoken).not.toContain("```");
    expect(spoken).not.toContain("https://");
  });
});
