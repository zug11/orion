import type { ParsedImport, TranscribedMedia } from "../types";

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
