import type { Note, Settings, SpeechVoice, SpeechWordTiming } from "../types";
import {
  normalizeElevenLabsVoiceId,
  normalizeSpeechVoice,
} from "../data/defaults";
import { truncateUnicode } from "./text";

export const MAX_SPEECH_NOTE_CHARS = 24_000;
export const OPENAI_SPEECH_CHUNK_CHARS = 4_000;
export const ELEVENLABS_SPEECH_CHUNK_CHARS = 4_000;
export const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
export const OPENAI_SPEECH_VOICE = "marin";
export const ELEVENLABS_SPEECH_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_SPEECH_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb";
export const SPEECH_INSTRUCTIONS =
  "Speak in a calm, even, editorial voice. Do not perform, joke, or rush. This is a personal knowledge briefing.";

export type CloudSpeechEngine = "openai" | "elevenlabs";

export interface GeneratedSpeech {
  mimeType: string;
  base64Data: string;
  wordTimings?: SpeechWordTiming[];
  timingSource?: "elevenlabs" | "whisper";
  timingText?: string;
}

export function cloudSpeechCacheKey(
  engine: CloudSpeechEngine,
  text: string,
  voiceId = "",
  trackWords = false,
): string {
  return `${engine}\u0000${voiceId}\u0000${trackWords ? "words" : "audio"}\u0000${text}`;
}

/**
 * Deduplicates in-flight and completed cloud TTS so a deck can synthesize the
 * next slides while the current one is still playing.
 */
export class PreparedSpeechCache {
  private readonly entries = new Map<string, Promise<GeneratedSpeech[]>>();

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get(key: string): Promise<GeneratedSpeech[]> | undefined {
    return this.entries.get(key);
  }

  set(
    key: string,
    factory: () => Promise<GeneratedSpeech[]>,
  ): Promise<GeneratedSpeech[]> {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const pending = factory().catch((error: unknown) => {
      this.entries.delete(key);
      throw error;
    });
    this.entries.set(key, pending);
    return pending;
  }

  clear(): void {
    this.entries.clear();
  }
}

/**
 * Play uses ElevenLabs whenever that key is configured, unless the user
 * explicitly chose OpenAI. Missing cloud keys no longer silently fall back to
 * system speech: the caller must show the configuration error.
 */
export function resolveSpeechEngine(
  settings: Pick<
    Settings,
    "speechVoice" | "apiKeyConfigured" | "elevenLabsApiKeyConfigured"
  >,
): SpeechVoice {
  const preferred = normalizeSpeechVoice(settings.speechVoice);
  if (preferred === "openai" && settings.apiKeyConfigured) {
    return "openai";
  }
  if (settings.elevenLabsApiKeyConfigured || preferred === "elevenlabs") {
    return "elevenlabs";
  }
  if (preferred === "openai") {
    return "openai";
  }
  return "system";
}

export function resolveElevenLabsVoiceId(
  settings: Pick<Settings, "elevenLabsVoiceId">,
): string {
  return (
    normalizeElevenLabsVoiceId(settings.elevenLabsVoiceId) ||
    ELEVENLABS_SPEECH_VOICE_ID
  );
}

export function speechChunkLimit(engine: CloudSpeechEngine): number {
  return engine === "openai"
    ? OPENAI_SPEECH_CHUNK_CHARS
    : ELEVENLABS_SPEECH_CHUNK_CHARS;
}

export function chunkSpeechText(text: string, maxChars: number): string[] {
  return chunkSpeechTextWithOffsets(text, maxChars).map((chunk) => chunk.text);
}

/** Offsets refer to the canonical whitespace-normalized text, never Markdown. */
export function chunkSpeechTextWithOffsets(
  text: string,
  maxChars: number,
): { text: string; startChar: number; endChar: number }[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return [{ text: normalized, startChar: 0, endChar: normalized.length }];
  }
  const limit = Math.max(2, Math.floor(maxChars));
  const chunks: { text: string; startChar: number; endChar: number }[] = [];
  let startChar = 0;
  while (startChar < normalized.length) {
    const window = normalized.slice(startChar, startChar + limit);
    const splitAt = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
      window.lastIndexOf(" "),
    );
    let endChar = Math.min(normalized.length, startChar + limit);
    if (endChar < normalized.length) {
      if (splitAt >= Math.floor(limit * 0.4)) endChar = startChar + splitAt + 1;
      // Do not split a UTF-16 surrogate pair at a provider chunk boundary.
      const previous = normalized.charCodeAt(endChar - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) endChar -= 1;
    }
    while (endChar > startChar && normalized[endChar - 1] === " ") endChar -= 1;
    chunks.push({ text: normalized.slice(startChar, endChar), startChar, endChar });
    startChar = endChar;
    while (normalized[startChar] === " ") startChar += 1;
  }
  return chunks;
}

export function speechWordAtTime(
  timings: readonly SpeechWordTiming[] | undefined,
  seconds: number,
): SpeechWordTiming | undefined {
  if (!Number.isFinite(seconds)) return undefined;
  return timings?.find((word) => seconds >= word.startSeconds && seconds < word.endSeconds);
}

export function speechWordAtCharacter(
  timings: readonly SpeechWordTiming[] | undefined,
  charIndex: number,
): SpeechWordTiming | undefined {
  if (!timings?.length || !Number.isFinite(charIndex)) return undefined;
  let preceding = timings[0];
  for (const word of timings) {
    if (charIndex < word.startChar) break;
    preceding = word;
    if (charIndex < word.endChar) break;
  }
  return preceding;
}

/** Original-text character alignment from ElevenLabs, not normalized_alignment. */
export function speechWordsFromCharacterAlignment(
  text: string,
  alignment: unknown,
): SpeechWordTiming[] | undefined {
  if (!alignment || typeof alignment !== "object" || text.length > 8192) return undefined;
  const value = alignment as Record<string, unknown>;
  const characters = value.characters;
  const starts = value.character_start_times_seconds;
  const ends = value.character_end_times_seconds;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)
    || characters.length === 0 || characters.length > 8192
    || starts.length !== characters.length || ends.length !== characters.length) return undefined;
  let joined = "";
  let previousStart = 0;
  let previousEnd = 0;
  const spans: { startChar: number; endChar: number; startSeconds: number; endSeconds: number }[] = [];
  for (let index = 0; index < characters.length; index += 1) {
    const character: unknown = characters[index];
    const start: unknown = starts[index];
    const end: unknown = ends[index];
    if (typeof character !== "string" || character.length < 1 || character.length > 8
      || typeof start !== "number" || typeof end !== "number"
      || !Number.isFinite(start) || !Number.isFinite(end)
      || start < previousStart || end < previousEnd || end < start || end > 600) return undefined;
    spans.push({ startChar: joined.length, endChar: joined.length + character.length, startSeconds: start, endSeconds: end });
    joined += character;
    previousStart = start;
    previousEnd = end;
  }
  if (joined !== text) return undefined;
  const words: SpeechWordTiming[] = [];
  for (const match of text.matchAll(/\S+/gu)) {
    const startChar = match.index;
    const endChar = startChar + match[0].length;
    const first = spans.find((span) => span.endChar > startChar);
    const last = [...spans].reverse().find((span) => span.startChar < endChar);
    if (first && last && last.endSeconds > first.startSeconds) {
      words.push({ startChar, endChar, startSeconds: first.startSeconds, endSeconds: last.endSeconds });
    }
  }
  return words.length ? words : undefined;
}

export function speakableNoteText(
  note: Pick<Note, "title" | "summary" | "body">,
): string {
  const body = note.body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateUnicode(
    [note.title.trim(), note.summary.trim(), body].filter(Boolean).join(". "),
    MAX_SPEECH_NOTE_CHARS,
  );
}

export function openSpeechPlaybackContext(): AudioContext | null {
  const Context =
    globalThis.AudioContext ??
    (globalThis as typeof globalThis & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  void context.resume();
  return context;
}

export function decodeBase64Audio(base64Data: string): ArrayBuffer {
  const binary = atob(base64Data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export interface SpeechPlaybackProgress {
  elapsedSeconds: number;
  durationSeconds: number;
  ratio: number;
  loading: boolean;
  charIndex?: number;
  charLength?: number;
  timingGranularity?: "word" | "chunk";
}

export interface SpeechPlaybackOptions {
  startCharIndex?: number;
  trackWords?: boolean;
  /** Survives seek/pause; cancels only local preparation on Stop/navigation. */
  preparationSignal?: AbortSignal;
}

export function formatSpeechClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export async function playDecodedSpeech(
  context: AudioContext,
  data: ArrayBuffer,
  signal?: AbortSignal,
  onProgress?: (elapsedSeconds: number, durationSeconds: number) => void,
  startOffsetSeconds = 0,
): Promise<void> {
  throwIfAborted(signal);
  if (context.state === "suspended") {
    await context.resume();
  }
  const buffer = await context.decodeAudioData(data.slice(0));
  throwIfAborted(signal);
  const source = context.createBufferSource();
  const offset = Number.isFinite(startOffsetSeconds)
    ? Math.max(0, Math.min(buffer.duration, startOffsetSeconds)) : 0;
  source.buffer = buffer;
  source.connect(context.destination);
  await new Promise<void>((resolve, reject) => {
    let frame = 0;
    let settled = false;
    const startedAt = context.currentTime;
    const stop = () => {
      if (settled) return;
      settled = true;
      window.cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", stop);
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      reject(signal?.reason ?? new Error("Reading was cancelled."));
    };
    const tick = () => {
      if (settled) return;
      const elapsed = Math.min(
        buffer.duration,
        offset + Math.max(0, context.currentTime - startedAt),
      );
      onProgress?.(elapsed, buffer.duration);
      if (elapsed < buffer.duration && !signal?.aborted) {
        frame = window.requestAnimationFrame(tick);
      }
    };
    if (signal?.aborted) {
      stop();
      return;
    }
    signal?.addEventListener("abort", stop, { once: true });
    source.onended = () => {
      if (settled) return;
      settled = true;
      window.cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", stop);
      onProgress?.(buffer.duration, buffer.duration);
      resolve();
    };
    source.start(0, offset);
    onProgress?.(offset, buffer.duration);
    frame = window.requestAnimationFrame(tick);
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new Error("Reading was cancelled.");
}

export function dwellSpeech(
  seconds: number,
  signal?: AbortSignal,
  onProgress?: (progress: SpeechPlaybackProgress) => void,
): Promise<void> {
  const duration = Math.max(0.2, seconds);
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let timer = 0;
    const stop = () => window.clearInterval(timer);
    const fail = () => {
      stop();
      reject(signal?.reason ?? new Error("Reading was cancelled."));
    };
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener("abort", fail, { once: true });
    onProgress?.({
      elapsedSeconds: 0,
      durationSeconds: duration,
      ratio: 0,
      loading: false,
    });
    timer = window.setInterval(() => {
      const elapsed = Math.min(duration, (Date.now() - startedAt) / 1000);
      onProgress?.({
        elapsedSeconds: elapsed,
        durationSeconds: duration,
        ratio: elapsed / duration,
        loading: false,
      });
      if (elapsed < duration) return;
      stop();
      signal?.removeEventListener("abort", fail);
      resolve();
    }, 80);
  });
}

export function speakWithSystemVoice(
  text: string,
  signal?: AbortSignal,
  onProgress?: (progress: SpeechPlaybackProgress) => void,
  options: SpeechPlaybackOptions = {},
): Promise<void> {
  const requested = Number.isFinite(options.startCharIndex) ? Math.floor(options.startCharIndex!) : 0;
  let startChar = Math.max(0, Math.min(text.length, requested));
  if (startChar > 0 && /[\uDC00-\uDFFF]/.test(text[startChar] ?? "")) startChar -= 1;
  while (/\s/u.test(text[startChar] ?? "") && startChar < text.length) startChar += 1;
  const spoken = text.slice(startChar).trimEnd();
  if (!spoken) {
    return Promise.reject(new Error("This note has nothing to read aloud."));
  }
  const synthesis = globalThis.speechSynthesis;
  if (!synthesis || typeof SpeechSynthesisUtterance === "undefined") {
    return Promise.reject(
      new Error("System speech is not available in this browser preview."),
    );
  }
  const estimated = Math.max(1.2, spoken.length / 14.5);
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(spoken);
    utterance.rate = 0.96;
    const startedAt = Date.now();
    let timer = 0;
    let settled = false;
    let boundary: Pick<SpeechPlaybackProgress, "charIndex" | "charLength" | "timingGranularity"> = options.trackWords
      ? { charIndex: startChar, charLength: 0, timingGranularity: "chunk" } : {};
    const cleanup = () => {
      window.clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      utterance.onboundary = null;
      utterance.onend = null;
      utterance.onerror = null;
    };
    const tick = () => {
      if (settled) return;
      const elapsed = (Date.now() - startedAt) / 1000;
      onProgress?.({
        elapsedSeconds: Math.min(elapsed, estimated),
        durationSeconds: estimated,
        ratio: options.trackWords
          ? Math.min(1, (startChar + spoken.length * Math.min(1, elapsed / estimated)) / text.length)
          : Math.min(1, elapsed / estimated),
        loading: false,
        ...boundary,
      });
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      synthesis.cancel();
      reject(signal?.reason ?? new Error("Reading was cancelled."));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    utterance.onboundary = (event) => {
      if (settled || signal?.aborted || !options.trackWords || event.name !== "word"
        || !Number.isInteger(event.charIndex) || event.charIndex < 0 || event.charIndex >= spoken.length) return;
      const index = event.charIndex;
      // charLength may be zero on supported engines; the boundary still supplies
      // an actual spoken position. Use its containing written word, not a clock estimate.
      const before = spoken.slice(0, index).match(/\S*$/u)?.[0].length ?? 0;
      const after = spoken.slice(index).match(/^\S*/u)?.[0].length ?? 0;
      const wordStart = index - before;
      const explicitLength = Number.isInteger(event.charLength) && event.charLength > 0
        ? Math.min(event.charLength, spoken.length - index) : 0;
      const length = explicitLength || before + after;
      if (length === 0) return;
      const absolute = startChar + (explicitLength ? index : wordStart);
      if (boundary.charIndex !== undefined && absolute < boundary.charIndex) return;
      boundary = { charIndex: absolute, charLength: length, timingGranularity: "word" };
      tick();
    };
    utterance.onend = () => {
      if (settled) return;
      settled = true;
      cleanup();
      onProgress?.({
        elapsedSeconds: estimated,
        durationSeconds: estimated,
        ratio: 1,
        loading: false,
        ...boundary,
      });
      resolve();
    };
    utterance.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("System speech could not finish this note."));
    };
    if (synthesis.speaking || synthesis.pending) synthesis.cancel();
    tick();
    timer = window.setInterval(tick, 120);
    synthesis.speak(utterance);
  });
}
