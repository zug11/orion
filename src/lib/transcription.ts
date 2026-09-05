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

export function mergeVoiceTranscriptParts(parts: readonly string[]): string {
  const nonEmptyParts = parts
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean);
  if (nonEmptyParts.length === 0) return "";

  const mergedTokens = nonEmptyParts[0].split(" ");
  for (const part of nonEmptyParts.slice(1)) {
    const nextTokens = part.split(" ");
    const maximumOverlap = Math.min(24, mergedTokens.length, nextTokens.length);
    let overlap = 0;
    for (let length = maximumOverlap; length >= 2; length -= 1) {
      const previous = mergedTokens
        .slice(-length)
        .map(canonicalVoiceToken)
        .join("\u0000");
      const next = nextTokens
        .slice(0, length)
        .map(canonicalVoiceToken)
        .join("\u0000");
      if (previous && previous === next) {
        overlap = length;
        break;
      }
    }
    mergedTokens.push(...nextTokens.slice(overlap));
  }
  return mergedTokens.join(" ").trim();
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
