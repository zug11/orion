import type { ParsedImport, TranscribedMedia } from "../types";

export const MAX_VOICE_MEMO_BYTES = 64 * 1024 * 1024;

export const WHISPER_MODEL_EDITION =
  import.meta.env.VITE_ORION_WHISPER_MODEL === "medium" ? "medium" : "small";

export const USE_PERSISTENT_VOICE_MEMO_WORKER =
  WHISPER_MODEL_EDITION === "medium";

// The Small edition amortizes setup with broad requests. The Medium edition
// loads its model once per dictation and continuously processes short windows.
export const VOICE_MEMO_SEGMENT_MS = USE_PERSISTENT_VOICE_MEMO_WORKER
  ? 30 * 1_000
  : 2 * 60 * 1_000;

function canonicalVoiceToken(token: string): string {
  return token
    .toLocaleLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

const SEAM_TOKENS = 24;
const SEAM_CHARACTERS = 48;
const MINIMUM_SEAM_CHARACTERS = 4;
/** Words the next window may have misheard or clipped before the repeat begins. */
const MISHEARD_LEADING = 2;
/** Scripts written without spaces between words, where a "token" is a whole sentence. */
const SPACELESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

interface TokenSeam {
  /** Trailing tokens of the earlier window that the later one transcribed in full. */
  dropPrevious: number;
  /** Leading tokens of the later window that repeat the earlier one. */
  skipNext: number;
}

/**
 * Finds where a window that began two seconds early stops repeating the window
 * before it. The cut rarely falls between words, so the repeat may begin with a
 * misheard or clipped word, and the earlier window may end on a clipped one.
 * The longest run of at least two matching words wins; an exact repeat wins ties.
 * A repeat that only appears after discarding a misheard opening needs three,
 * so "First complete passage." and "Second complete passage." stay two sentences.
 */
function tokenSeam(previous: readonly string[], next: readonly string[]): TokenSeam {
  const tail = previous.slice(-(SEAM_TOKENS + 1)).map(canonicalVoiceToken);
  const head = next.slice(0, SEAM_TOKENS + MISHEARD_LEADING + 1).map(canonicalVoiceToken);
  let best = { length: 0, dropPrevious: 0, skipNext: 0 };
  for (const clipped of [0, 1]) {
    for (let skip = 0; skip <= MISHEARD_LEADING; skip += 1) {
      const maximum = Math.min(SEAM_TOKENS, tail.length - clipped, head.length - skip - clipped);
      const minimum = skip > 0 ? 3 : 2;
      for (let length = maximum; length >= minimum && length > best.length; length -= 1) {
        const from = tail.length - clipped - length;
        let spoken = 0;
        let matches = true;
        for (let index = 0; index < length; index += 1) {
          if (tail[from + index] !== head[skip + index]) {
            matches = false;
            break;
          }
          if (tail[from + index]) spoken += 1;
        }
        // Punctuation alone never establishes a repeat.
        if (!matches || spoken < 2) continue;
        if (clipped) {
          const cut = tail[tail.length - 1];
          const whole = head[skip + length];
          if (!cut || !whole || whole.length <= cut.length || !whole.startsWith(cut)) continue;
        }
        best = { length, dropPrevious: clipped, skipNext: skip + length };
        break;
      }
    }
  }
  return best;
}

interface SpokenCharacter {
  value: string;
  /** Index just past this character in the original text. */
  end: number;
}

function spokenCharacters(text: string): SpokenCharacter[] {
  const characters: SpokenCharacter[] = [];
  let index = 0;
  for (const character of text) {
    index += character.length;
    if (/[\p{L}\p{N}]/u.test(character)) {
      characters.push({ value: character.toLocaleLowerCase(), end: index });
    }
  }
  return characters;
}

/**
 * The same seam for text without spaces between words, compared character by
 * character. Returns the index in `next` where new speech begins, or 0.
 */
function characterSeam(previous: string, next: string): number {
  const tail = spokenCharacters(previous.slice(-SEAM_CHARACTERS * 4))
    .slice(-SEAM_CHARACTERS)
    .map((character) => character.value);
  const head = spokenCharacters(next.slice(0, SEAM_CHARACTERS * 4)).slice(
    0,
    SEAM_CHARACTERS + MISHEARD_LEADING,
  );
  let best = { length: 0, resume: 0 };
  for (let skip = 0; skip <= MISHEARD_LEADING; skip += 1) {
    const maximum = Math.min(tail.length, head.length - skip);
    const minimum = MINIMUM_SEAM_CHARACTERS + (skip > 0 ? 2 : 0);
    for (let length = maximum; length >= minimum && length > best.length; length -= 1) {
      const from = tail.length - length;
      let matches = true;
      for (let index = 0; index < length; index += 1) {
        if (tail[from + index] !== head[skip + index].value) {
          matches = false;
          break;
        }
      }
      if (!matches) continue;
      best = { length, resume: head[skip + length - 1].end };
      break;
    }
  }
  return best.resume;
}

/**
 * Joins the transcripts of consecutive dictation windows in order.
 *
 * With `acousticOverlap`, each window began with the last two seconds of the
 * one before it, so its opening words repeat that window's ending and are
 * removed. Without it the windows share no audio: a phrase at a boundary that
 * appears twice was spoken twice, and nothing is removed. A silent window means
 * the following one has nothing to repeat.
 */
export function mergeVoiceTranscriptParts(
  parts: readonly string[],
  acousticOverlap: boolean = USE_PERSISTENT_VOICE_MEMO_WORKER,
): string {
  let merged = "";
  let afterSilence = false;
  for (const raw of parts) {
    const part = raw.trim().replace(/\s+/g, " ");
    if (!part) {
      afterSilence = true;
      continue;
    }
    if (!merged) {
      merged = part;
    } else if (!acousticOverlap || afterSilence) {
      merged = `${merged} ${part}`;
    } else if (SPACELESS_SCRIPT.test(merged.slice(-SEAM_CHARACTERS) + part.slice(0, SEAM_CHARACTERS))) {
      const resume = characterSeam(merged, part);
      let addition = part.slice(resume).trimStart();
      // Both windows may close the repeated sentence with their own full stop.
      if (resume > 0 && /[^\p{L}\p{N}\s]$/u.test(merged)) {
        addition = addition.replace(/^[^\p{L}\p{N}]+/u, "");
      }
      if (addition) merged = resume > 0 ? `${merged}${addition}` : `${merged} ${addition}`;
    } else {
      const previousTokens = merged.split(" ");
      const nextTokens = part.split(" ");
      const seam = tokenSeam(previousTokens, nextTokens);
      merged = [
        ...previousTokens.slice(0, previousTokens.length - seam.dropPrevious),
        ...nextTokens.slice(seam.skipNext),
      ].join(" ");
    }
    afterSilence = false;
  }
  return merged.trim();
}

export function transcriptToParsedImport(
  transcript: TranscribedMedia,
): ParsedImport {
  const format = transcript.sourceUrl
    ? "youtube"
    : transcript.mimeType.startsWith("video/")
      ? "video"
      : "audio";
  return {
    title: transcript.title.trim() || "Media transcript",
    fileName: transcript.sourceUrl
      ? `${transcript.title.trim() || "YouTube video"} · YouTube`
      : transcript.fileName,
    mimeType: transcript.mimeType,
    format,
    byteSize: transcript.byteSize,
    sourceUrl: transcript.sourceUrl,
    text: transcript.text.trim(),
    warnings: [...transcript.warnings],
  };
}
