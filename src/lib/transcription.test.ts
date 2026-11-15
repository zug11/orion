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
      mergeVoiceTranscriptParts(
        [
          "The first thought finishes with a useful bridge.",
          "A useful bridge, and the second thought begins here.",
          "",
        ],
        true,
      ),
    ).toBe(
      "The first thought finishes with a useful bridge. and the second thought begins here.",
    );
  });

  it("keeps unrelated adjacent dictation windows intact", () => {
    expect(
      mergeVoiceTranscriptParts(["First complete passage.", "Second complete passage."], true),
    ).toBe("First complete passage. Second complete passage.");
  });

  it.each([
    [
      "an exact repeat",
      "so we decided to take the train to Melbourne",
      "the train to Melbourne because it was cheaper",
      "so we decided to take the train to Melbourne because it was cheaper",
    ],
    [
      "a repeat whose first word was dropped",
      "so we decided to take the train to Melbourne",
      "train to Melbourne because it was cheaper",
      "so we decided to take the train to Melbourne because it was cheaper",
    ],
    [
      "a repeat whose first word was misheard",
      "so we decided to take the train to Melbourne",
      "a train to Melbourne because it was cheaper",
      "so we decided to take the train to Melbourne because it was cheaper",
    ],
    [
      "a repeat that begins with a clipped word",
      "and then we decided to leave early",
      "cided to leave early that night",
      "and then we decided to leave early that night",
    ],
    [
      "two misheard words before the repeat",
      "we should meet on Tuesday afternoon",
      "eat an on Tuesday afternoon to discuss the plan",
      "we should meet on Tuesday afternoon to discuss the plan",
    ],
    [
      "an earlier window that ends on a clipped word",
      "we took the train to Melb",
      "the train to Melbourne because it was cheaper",
      "we took the train to Melbourne because it was cheaper",
    ],
    [
      "Japanese, written without spaces",
      "今日は天気がいいので公園まで散歩に行きました",
      "散歩に行きました。とても気持ちよかったです",
      "今日は天気がいいので公園まで散歩に行きました。とても気持ちよかったです",
    ],
    [
      "Japanese where both windows close the repeated sentence",
      "今日は天気がいいので公園まで散歩に行きました。",
      "に散歩に行きました。とても気持ちよかったです",
      "今日は天気がいいので公園まで散歩に行きました。とても気持ちよかったです",
    ],
    [
      "Chinese, written without spaces",
      "我们明天早上九点在会议室开会",
      "在会议室开会，请大家准时到",
      "我们明天早上九点在会议室开会，请大家准时到",
    ],
  ])("stitches %s", (_label, earlier, later, spoken) => {
    expect(mergeVoiceTranscriptParts([earlier, later], true)).toBe(spoken);
  });

  it("never removes words on the strength of one word, a fragment or punctuation", () => {
    // "other" ends "another" and "her" ends "together": neither is a repeat.
    expect(mergeVoiceTranscriptParts(["we need another", "other people to help"], true)).toBe(
      "we need another other people to help",
    );
    expect(mergeVoiceTranscriptParts(["we went there together", "her plan worked"], true)).toBe(
      "we went there together her plan worked",
    );
    expect(mergeVoiceTranscriptParts(["and then we left", "left turn ahead"], true)).toBe(
      "and then we left left turn ahead",
    );
    expect(mergeVoiceTranscriptParts(["wait — —", "— — what"], true)).toBe("wait — — — — what");
    // One differing word before a two-word match is two sentences, not a mishearing.
    expect(mergeVoiceTranscriptParts(["Buy oat milk today.", "Sell milk today."], true)).toBe(
      "Buy oat milk today. Sell milk today.",
    );
    expect(mergeVoiceTranscriptParts(["今日は晴れです", "です。明日は雨"], true)).toBe(
      "今日は晴れです です。明日は雨",
    );
  });

  it("keeps a window's opening words when the window before it was silent", () => {
    expect(
      mergeVoiceTranscriptParts(["call the dentist today", "", "the dentist today said no"], true),
    ).toBe("call the dentist today the dentist today said no");
  });

  it("removes nothing when the windows share no audio", () => {
    // The Small edition records back-to-back segments: a repeated phrase was spoken twice.
    expect(
      mergeVoiceTranscriptParts(["again and again", "and again we tried", " ", "\n"], false),
    ).toBe("again and again and again we tried");
    expect(mergeVoiceTranscriptParts([], false)).toBe("");
    expect(mergeVoiceTranscriptParts(["", "  "], true)).toBe("");
  });

  it("stitches a long dictation window by window", () => {
    const windows = Array.from({ length: 60 }, (_, index) =>
      `segment ${index} begins here and segment ${index} ends with marker ${index} now`,
    ).map((text, index, all) =>
      index === 0 ? text : `${all[index - 1].split(" ").slice(-4).join(" ")} ${text}`,
    );
    const merged = mergeVoiceTranscriptParts(windows, true);
    expect(merged.split(" ")).toHaveLength(60 * 12);
    expect(merged.match(/ends with marker/g)).toHaveLength(60);
  });
});
