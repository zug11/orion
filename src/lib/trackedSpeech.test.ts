import { beforeEach, describe, expect, it, vi } from "vitest";
import { playTrackedSpeech } from "./trackedSpeech";
import { playDecodedSpeech, PreparedSpeechCache, type SpeechPlaybackProgress } from "./speech";
vi.mock("./speech", async (original) => ({ ...await original<typeof import("./speech")>(),
  decodeBase64Audio: () => new ArrayBuffer(1), playDecodedSpeech: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());
const context = {} as AudioContext;
const words = [
  { startChar: 0, endChar: 5, startSeconds: .2, endSeconds: .8 },
  { startChar: 6, endChar: 12, startSeconds: 1.1, endSeconds: 1.8 },
];

describe("tracked cloud note playback", () => {
  it("seeks to the measured word time, follows real timings, and reuses generated audio", async () => {
    const generate = vi.fn(async () => ({ mimeType: "audio/mpeg", base64Data: "AA==", timingText: "First second", wordTimings: words }));
    vi.mocked(playDecodedSpeech).mockImplementation(async (_context, _data, _signal, progress, offset) => { expect(offset).toBe(1.1); progress?.(1.3, 2); });
    const cache = new PreparedSpeechCache(); const progress: SpeechPlaybackProgress[] = [];
    const input = { text: "First second", engine: "openai" as const, cache, context, generate, options: { startCharIndex: 8, trackWords: true }, onProgress: (item: SpeechPlaybackProgress) => progress.push(item) };
    await playTrackedSpeech(input); await playTrackedSpeech(input);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(progress[progress.length - 1]).toMatchObject({ charIndex: 6, charLength: 6, timingGranularity: "word" });
    expect(generate).toHaveBeenCalledWith("openai", "First second", undefined, { trackWords: true });
  });

  it("does not invent word positions for untimed or mismatched audio", async () => {
    const generate = vi.fn(async () => ({ mimeType: "audio/mpeg", base64Data: "AA==", timingText: "different text", wordTimings: words }));
    vi.mocked(playDecodedSpeech).mockImplementation(async (_context, _data, _signal, progress, offset) => { expect(offset).toBe(0); progress?.(1.9, 2); });
    const progress = vi.fn();
    await playTrackedSpeech({ text: "First second", engine: "elevenlabs", cache: new PreparedSpeechCache(), context, generate, onProgress: progress, options: { startCharIndex: 8 } });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ charIndex: 0, charLength: 0, timingGranularity: "chunk" }));
  });

  it("preserves the opening audio when its first words have no reliable timestamps", async () => {
    const generate = vi.fn(async () => ({ mimeType: "audio/mpeg", base64Data: "AA==", timingText: "First second", wordTimings: [words[1]] }));
    vi.mocked(playDecodedSpeech).mockImplementation(async (_context, _data, _signal, progress, offset) => {
      expect(offset).toBe(0); progress?.(.3, 2);
    });
    const progress = vi.fn();
    await playTrackedSpeech({ text: "First second", engine: "openai", cache: new PreparedSpeechCache(), context, generate, onProgress: progress });
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ charIndex: 0, charLength: 0 }));
  });

  it("does not start audio after a generation request has been cancelled", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async () => { controller.abort(); return { mimeType: "audio/mpeg", base64Data: "AA==" }; });
    await expect(playTrackedSpeech({ text: "First second", engine: "openai", cache: new PreparedSpeechCache(), context, generate, signal: controller.signal })).rejects.toThrow();
    expect(playDecodedSpeech).not.toHaveBeenCalled();
  });

  it("generates at most one following passage while playing and never schedules further after abort", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async () => ({ mimeType: "audio/mpeg", base64Data: "AA==" }));
    vi.mocked(playDecodedSpeech).mockImplementation(async (_context, _data, _signal, progress) => { progress?.(0, 60); controller.abort(); progress?.(1, 60); });
    await expect(playTrackedSpeech({ text: Array.from({ length: 400 }, (_, index) => `Passage ${index} of a longer note.`).join(" "), engine: "openai", cache: new PreparedSpeechCache(), context, generate, signal: controller.signal })).rejects.toThrow();
    expect(generate).toHaveBeenCalledTimes(2); expect(playDecodedSpeech).toHaveBeenCalledTimes(1);
  });
});
