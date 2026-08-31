import type { Note, Settings, SpeechVoice } from "../types";
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
}

export function cloudSpeechCacheKey(
  engine: CloudSpeechEngine,
  text: string,
  voiceId = "",
): string {
  return `${engine}\u0000${voiceId}\u0000${text}`;
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
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  if (maxChars <= 0) return [normalized];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    const window = remaining.slice(0, maxChars);
    const splitAt = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("? "),
      window.lastIndexOf("! "),
      window.lastIndexOf(" "),
    );
    const take = splitAt >= Math.floor(maxChars * 0.4) ? splitAt + 1 : maxChars;
    chunks.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
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
): Promise<void> {
  throwIfAborted(signal);
  if (context.state === "suspended") {
    await context.resume();
  }
  const buffer = await context.decodeAudioData(data.slice(0));
  throwIfAborted(signal);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  await new Promise<void>((resolve, reject) => {
    let frame = 0;
    const startedAt = context.currentTime;
    const stop = () => {
      window.cancelAnimationFrame(frame);
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      reject(signal?.reason ?? new Error("Reading was cancelled."));
    };
    const tick = () => {
      const elapsed = Math.min(
        buffer.duration,
        Math.max(0, context.currentTime - startedAt),
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
      window.cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", stop);
      onProgress?.(buffer.duration, buffer.duration);
      resolve();
    };
    source.start();
    onProgress?.(0, buffer.duration);
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
): Promise<void> {
  const spoken = text.trim();
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
    const stop = () => {
      window.clearInterval(timer);
      synthesis.cancel();
    };
    const tick = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      onProgress?.({
        elapsedSeconds: Math.min(elapsed, estimated),
        durationSeconds: estimated,
        ratio: Math.min(1, elapsed / estimated),
        loading: false,
      });
    };
    if (signal?.aborted) {
      stop();
      reject(signal.reason ?? new Error("Reading was cancelled."));
      return;
    }
    const onAbort = () => {
      stop();
      reject(signal?.reason ?? new Error("Reading was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    utterance.onend = () => {
      window.clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      onProgress?.({
        elapsedSeconds: estimated,
        durationSeconds: estimated,
        ratio: 1,
        loading: false,
      });
      resolve();
    };
    utterance.onerror = () => {
      window.clearInterval(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("System speech could not finish this note."));
    };
    if (synthesis.speaking || synthesis.pending) {
      synthesis.cancel();
    }
    synthesis.speak(utterance);
    onProgress?.({
      elapsedSeconds: 0,
      durationSeconds: estimated,
      ratio: 0,
      loading: false,
    });
    timer = window.setInterval(tick, 120);
  });
}
