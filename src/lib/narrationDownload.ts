import { chunkSpeechTextWithOffsets, cloudSpeechCacheKey, decodeBase64Audio,
  type CloudSpeechEngine, type GeneratedSpeech, PreparedSpeechCache } from "./speech";

export const MAX_NARRATION_DOWNLOAD_CHARS = 80_000;
export const MAX_NARRATION_AUDIO_BYTES = 128 * 1024 * 1024;
export const NARRATION_SAMPLE_RATE = 24_000;

export function validateNarrationDownload(text: string): void {
  if (!text.trim()) throw new Error("This note has nothing to download.");
  if (text.length > MAX_NARRATION_DOWNLOAD_CHARS) throw new Error("This note is too long to download as one narration. Split it into shorter notes.");
}

/** Decode each complete provider file before joining it. Concatenating MP3
 * containers would leave misleading duration/seek headers in a long download. */
export async function buildNarrationWav(input: {
  text: string; engine: CloudSpeechEngine; voiceId?: string; cache: PreparedSpeechCache;
  generate: (engine: CloudSpeechEngine, text: string, voiceId?: string, options?: { trackWords?: boolean; signal?: AbortSignal }) => Promise<GeneratedSpeech>;
  decode: (bytes: ArrayBuffer) => Promise<Pick<AudioBuffer, "sampleRate" | "length" | "numberOfChannels" | "getChannelData">>;
  signal?: AbortSignal; onProgress?: (completed: number, total: number) => void;
}): Promise<Uint8Array<ArrayBuffer>> {
  validateNarrationDownload(input.text);
  const chunks = chunkSpeechTextWithOffsets(input.text, 1200);
  const check = () => { if (input.signal?.aborted) throw input.signal.reason ?? new Error("Narration download cancelled."); };
  const parts: Uint8Array[] = [];
  let totalBytes = 0;
  for (const [index, chunk] of chunks.entries()) {
    check();
    input.onProgress?.(index, chunks.length);
    // Use exactly the playback cache key and passage boundaries, including any
    // in-flight request. A download never duplicates an already paid passage.
    const [speech] = await input.cache.set(cloudSpeechCacheKey(input.engine, chunk.text, input.voiceId, true), async () => {
      check();
      return [await input.generate(input.engine, chunk.text, input.voiceId, { trackWords: true, signal: input.signal })];
    });
    check();
    const buffer = await input.decode(decodeBase64Audio(speech.base64Data));
    check();
    if (buffer.sampleRate !== NARRATION_SAMPLE_RATE || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2 || !buffer.length) {
      throw new Error("The narration returned unsupported audio.");
    }
    totalBytes += buffer.length * 2;
    if (totalBytes + 44 > MAX_NARRATION_AUDIO_BYTES) throw new Error("This narration is too long to download as one audio file.");
    const pcm = new Uint8Array(buffer.length * 2);
    const view = new DataView(pcm.buffer);
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
    for (let frame = 0; frame < buffer.length; frame++) {
      const sample = Math.max(-1, Math.min(1, channels.reduce((sum, channel) => sum + channel[frame], 0) / channels.length));
      view.setInt16(frame * 2, Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff)), true);
    }
    parts.push(pcm);
    input.onProgress?.(index + 1, chunks.length);
  }
  check();
  const wav = new Uint8Array(44 + totalBytes);
  const view = new DataView(wav.buffer);
  const tag = (offset: number, value: string) => wav.set(new TextEncoder().encode(value), offset);
  tag(0, "RIFF"); view.setUint32(4, wav.length - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, NARRATION_SAMPLE_RATE, true); view.setUint32(28, NARRATION_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, "data"); view.setUint32(40, totalBytes, true);
  let offset = 44;
  for (const part of parts) { wav.set(part, offset); offset += part.length; }
  return wav;
}
