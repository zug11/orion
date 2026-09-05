import { describe, expect, it } from "vitest";
import {
  mergeVoiceTranscriptParts,
  transcriptToParsedImport,
} from "./transcription";

describe("transcript imports", () => {
  it("continues to map ordinary media transcripts to audio imports", () => {
    expect(
      transcriptToParsedImport({
        title: "Interview",
        fileName: "interview.m4a",
        mimeType: "audio/mp4",
        byteSize: 12,
        text: "Transcript",
        warnings: [],
      }).format,
    ).toBe("audio");
  });

  it("removes the repeated words from overlapping dictation windows", () => {
    expect(
      mergeVoiceTranscriptParts([
        "The first thought finishes with a useful bridge.",
        "A useful bridge, and the second thought begins here.",
        "",
      ]),
    ).toBe(
      "The first thought finishes with a useful bridge. and the second thought begins here.",
    );
  });

  it("keeps unrelated adjacent dictation windows intact", () => {
    expect(
      mergeVoiceTranscriptParts(["First complete passage.", "Second complete passage."]),
    ).toBe("First complete passage. Second complete passage.");
  });
});
