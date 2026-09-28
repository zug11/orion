import {
  chunkSpeechTextWithOffsets, cloudSpeechCacheKey, decodeBase64Audio,
  playDecodedSpeech, PreparedSpeechCache, speechChunkLimit,
  speechWordAtCharacter, speechWordAtTime,
  type CloudSpeechEngine, type GeneratedSpeech, type SpeechPlaybackOptions,
  type SpeechPlaybackProgress,
} from "./speech";

interface TrackedSpeechInput {
  text: string;
  engine: CloudSpeechEngine;
  voiceId?: string;
  cache: PreparedSpeechCache;
  context: AudioContext;
  generate: (engine: CloudSpeechEngine, text: string, voiceId?: string,
    options?: { trackWords?: boolean; signal?: AbortSignal }) => Promise<GeneratedSpeech>;
  signal?: AbortSignal;
  onProgress?: (progress: SpeechPlaybackProgress) => void;
  options?: SpeechPlaybackOptions;
}

/** Generate bounded passages lazily; audio and genuine timings share one cache.
 * Character estimates drive the overview bar only, never word highlighting. */
export async function playTrackedSpeech({
  text, engine, voiceId, cache, context, generate, signal, onProgress, options = {},
}: TrackedSpeechInput): Promise<void> {
  const chunks = chunkSpeechTextWithOffsets(text, Math.min(1200, speechChunkLimit(engine)));
  if (!chunks.length) return;
  const total = chunks[chunks.length - 1].endChar;
  const requested = Number.isFinite(options.startCharIndex)
    ? Math.max(0, Math.min(total - 1, options.startCharIndex ?? 0)) : 0;
  const firstIndex = Math.max(0, chunks.findIndex((chunk) => chunk.endChar > requested));
  const check = () => { if (signal?.aborted) throw signal.reason ?? new Error("Reading was cancelled."); };
  const load = (index: number) => {
    const chunk = chunks[index];
    return cache.set(cloudSpeechCacheKey(engine, chunk.text, voiceId, true), async () =>
      [await generate(engine, chunk.text, voiceId, { trackWords: true, ...(options.preparationSignal ? { signal: options.preparationSignal } : {}) })]);
  };
  let elapsedBefore = 0;
  for (let index = firstIndex; index < chunks.length; index += 1) {
    check();
    const chunk = chunks[index];
    onProgress?.({ elapsedSeconds: elapsedBefore, durationSeconds: 0,
      ratio: (index === firstIndex ? requested : chunk.startChar) / total, loading: true });
    const [speech] = await load(index);
    check();
    // A timing map may only index the exact script it was generated for.
    const timings = speech.timingText === chunk.text ? speech.wordTimings : undefined;
    const localRequest = requested - chunk.startChar;
    let currentWord = index === firstIndex && localRequest > 0
      && localRequest >= (timings?.[0]?.startChar ?? Infinity)
      ? speechWordAtCharacter(timings, localRequest) : undefined;
    // Missing alignment at the beginning must never skip audible opening words.
    const startOffset = currentWord?.startSeconds ?? 0;
    let duration = 0;
    let prefetched = false;
    await playDecodedSpeech(context, decodeBase64Audio(speech.base64Data), signal, (seconds, localDuration) => {
      if (signal?.aborted) return;
      duration = localDuration;
      // One following passage at most; opening Play never synthesizes a whole
      // long note. Repeated seeks reuse pending and completed requests.
      if (!prefetched && index + 1 < chunks.length) {
        prefetched = true;
        void load(index + 1).catch(() => {});
      }
      const observed = speechWordAtTime(timings, seconds);
      if (observed) currentWord = observed;
      const ratio = (chunk.startChar + chunk.text.length * Math.min(1, seconds / Math.max(.001, localDuration))) / total;
      if (index === firstIndex) elapsedBefore = chunk.startChar / Math.max(1, chunk.text.length) * localDuration;
      const elapsedSeconds = elapsedBefore + seconds;
      onProgress?.({ elapsedSeconds,
        durationSeconds: elapsedBefore + localDuration + (total - chunk.endChar) / Math.max(1, chunk.text.length) * localDuration,
        ratio, loading: false,
        charIndex: chunk.startChar + (currentWord?.startChar ?? 0),
        charLength: currentWord ? currentWord.endChar - currentWord.startChar : 0,
        timingGranularity: timings?.length ? "word" : "chunk",
      });
    }, startOffset);
    check();
    elapsedBefore += duration;
  }
}
