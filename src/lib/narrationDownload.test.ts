import { describe, expect, it, vi } from "vitest";
import { buildNarrationWav, NARRATION_SAMPLE_RATE, validateNarrationDownload } from "./narrationDownload";
import { chunkSpeechTextWithOffsets, cloudSpeechCacheKey, PreparedSpeechCache } from "./speech";

const speech = { mimeType: "audio/mpeg", base64Data: "AQID" };
const decode = vi.fn(async () => ({ sampleRate: NARRATION_SAMPLE_RATE, length: 3, numberOfChannels: 1,
  getChannelData: () => new Float32Array([0, .5, -1]) }));

describe("narration audio downloads", () => {
  it("reuses completed and pending playback audio and writes one seekable PCM container", async () => {
    const cache = new PreparedSpeechCache();
    const text = "A sentence. ".repeat(150);
    const chunks = chunkSpeechTextWithOffsets(text, 1200);
    await cache.set(cloudSpeechCacheKey("openai", chunks[0].text, undefined, true), async () => [speech]);
    const generate = vi.fn(async () => speech);
    const audio = await buildNarrationWav({ text, engine: "openai", cache, generate, decode });
    expect(generate).toHaveBeenCalledTimes(chunks.length - 1);
    const view = new DataView(audio.buffer);
    expect(new TextDecoder().decode(audio.subarray(0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(audio.length - 8);
    expect(view.getUint32(40, true)).toBe(chunks.length * 6);
    expect(view.getInt16(46, true)).toBe(16384);
    expect(view.getInt16(48, true)).toBe(-32768);
    await buildNarrationWav({ text, engine: "openai", cache, generate, decode });
    expect(generate).toHaveBeenCalledTimes(chunks.length - 1);
  });
  it("stops before generating subsequent passages on cancellation", async () => {
    const controller = new AbortController();
    const generate = vi.fn(async () => { controller.abort(); return speech; });
    await expect(buildNarrationWav({ text: "A sentence. ".repeat(400), engine: "elevenlabs", cache: new PreparedSpeechCache(), generate, decode, signal: controller.signal })).rejects.toBeDefined();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it("validates empty and oversized scripts before provider work", () => {
    expect(() => validateNarrationDownload(" ")).toThrow();
    expect(() => validateNarrationDownload("x".repeat(80_001))).toThrow();
  });
});
