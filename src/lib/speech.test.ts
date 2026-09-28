/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { normalizeElevenLabsVoiceId } from "../data/defaults";
import {
  chunkSpeechText,
  chunkSpeechTextWithOffsets,
  speechWordsFromCharacterAlignment,
  speechWordAtCharacter,
  speechWordAtTime,
  speakWithSystemVoice,
  playDecodedSpeech,
  type SpeechPlaybackProgress,
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


describe("audio-derived word tracking", () => {
  it("keeps exact normalized UTF-16 chunk offsets without splitting Unicode", () => {
    const text = "  First   sentence.\n\n🙂" + "x".repeat(15) + " Final word.";
    const normalized = text.replace(/\s+/g, " ").trim();
    const chunks = chunkSpeechTextWithOffsets(text, 16);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      expect(normalized.slice(chunk.startChar, chunk.endChar)).toBe(chunk.text);
      expect(chunk.text.length).toBeLessThanOrEqual(16);
      expect(chunk.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
    expect(chunkSpeechText(text, 16)).toEqual(chunks.map((chunk) => chunk.text));
  });

  it("maps original character timing and declines malformed or normalized-text offsets", () => {
    const text = "🙂 Hello again.";
    const characters = [...text];
    const alignment = {
      characters,
      character_start_times_seconds: characters.map((_, i) => i / 10),
      character_end_times_seconds: characters.map((_, i) => (i + 1) / 10),
    };
    const timings = speechWordsFromCharacterAlignment(text, alignment)!;
    expect(timings.map(({ startChar, endChar }) => text.slice(startChar, endChar))).toEqual(["🙂", "Hello", "again."]);
    expect(timings[1].startChar).toBe(3);
    expect(speechWordsFromCharacterAlignment("Some other text", alignment)).toBeUndefined();
    expect(speechWordsFromCharacterAlignment(text, { ...alignment, character_start_times_seconds: [0] })).toBeUndefined();
    expect(speechWordsFromCharacterAlignment(text, { ...alignment, character_end_times_seconds: characters.map(() => Number.NaN) })).toBeUndefined();
    expect(speechWordAtCharacter(timings, 10)).toBe(timings[2]);
    expect(speechWordAtCharacter(timings, 8)).toBe(timings[1]);
    expect(speechWordAtTime(timings, 0.25)).toBe(timings[1]);
    expect(speechWordAtTime(timings, 600)).toBeUndefined();
  });

  it("does not invent word progress in silence and keeps tracked cache entries distinct", () => {
    const timings = [{ startChar: 4, endChar: 9, startSeconds: 1, endSeconds: 2 }];
    expect(speechWordAtTime(timings, 0.9)).toBeUndefined();
    expect(speechWordAtTime(timings, 2)).toBeUndefined();
    expect(speechWordAtCharacter(timings, 0)).toBe(timings[0]);
    expect(cloudSpeechCacheKey("openai", "Hello", "", true)).not.toBe(cloudSpeechCacheKey("openai", "Hello"));
  });
});

class TestUtterance {
  rate = 1;
  onboundary: ((event: { name: string; charIndex: number; charLength: number }) => void) | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("system speech boundaries and playback seeking", () => {
  it("restarts at the requested written offset and only reports real word events", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("SpeechSynthesisUtterance", TestUtterance);
    let utterance: TestUtterance | undefined;
    const cancel = vi.fn();
    vi.stubGlobal("speechSynthesis", { cancel, speak: (value: TestUtterance) => { utterance = value; }, speaking: false, pending: false });
    const progress: SpeechPlaybackProgress[] = [];
    const controller = new AbortController();
    const pending = speakWithSystemVoice("First. Hello again.", controller.signal, (value) => progress.push(value), { startCharIndex: 7, trackWords: true });
    expect(utterance!.text).toBe("Hello again.");
    vi.advanceTimersByTime(500);
    expect(progress.every((value) => value.charIndex === 7 && value.charLength === 0 && value.timingGranularity === "chunk")).toBe(true);
    expect(progress[0].ratio).toBeCloseTo(7 / 19);
    utterance!.onboundary!({ name: "word", charIndex: 6, charLength: 0 });
    expect(progress[progress.length - 1]).toMatchObject({ charIndex: 13, charLength: 6, timingGranularity: "word" });
    const staleBoundary = utterance!.onboundary!;
    const staleEnd = utterance!.onend!;
    controller.abort(new Error("Stopped"));
    await expect(pending).rejects.toThrow("Stopped");
    const count = progress.length;
    staleBoundary({ name: "word", charIndex: 0, charLength: 5 });
    staleEnd();
    vi.advanceTimersByTime(1000);
    expect(progress).toHaveLength(count);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("starts decoded audio at an observed offset and suppresses stale completion after stop", async () => {
    vi.stubGlobal("window", { requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null as (() => void) | null };
    const context = { state: "running", currentTime: 10, decodeAudioData: async () => ({ duration: 8 }), createBufferSource: () => source, destination: {} } as unknown as AudioContext;
    const progress = vi.fn();
    const controller = new AbortController();
    const pending = playDecodedSpeech(context, new ArrayBuffer(1), controller.signal, progress, 3.4);
    await Promise.resolve();
    expect(source.start).toHaveBeenCalledWith(0, 3.4);
    expect(progress).toHaveBeenCalledWith(3.4, 8);
    const staleEnd = source.onended!;
    controller.abort(new Error("Stopped"));
    await expect(pending).rejects.toThrow("Stopped");
    staleEnd();
    expect(progress).toHaveBeenCalledTimes(1);
  });
});
