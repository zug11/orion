import { describe, expect, it } from "vitest";
import { unfinishedVoiceThought, voiceTurnSettleMs } from "./voiceUtterance";
import { VoiceConversation } from "./voiceConversation";

describe("developing spoken thoughts", () => {
  it.each(["I was just thinking…", "Could you", "Read", "Compare the first note with", "spawn 10 workers to", "I think that, um", "The idea is", "What if"])('holds the unfinished phrase %s', text => {
    expect(unfinishedVoiceThought(text)).toBe(true); expect(voiceTurnSettleMs(text)).toBe(3_200);
  });
  it.each(["Stop that", "Follow that", "What do you think?", "Spawn 10 workers", "Read across all the notes", "Research attachment theory", "Why does this sentence feel awkward?", "It reminds me of that."])('keeps a complete request responsive: %s', text => {
    expect(unfinishedVoiceThought(text)).toBe(false); expect(voiceTurnSettleMs(text)).toBe(900);
  });
  it("joins hesitation across an assistant backchannel but retains a separate explicit assignment", () => {
    const conversation = new VoiceConversation();
    const input = (delta: string, start: number) => conversation.receive({ type: "session.input_transcript.delta", delta, start_ms: start, end_ms: start + 100 });
    input("I was thinking", 0);
    conversation.receive({ type: "session.output_transcript.delta", delta: "Mm-hmm", start_ms: 700, end_ms: 900 });
    expect(conversation.takeTurns()).toEqual([]);
    input("actually, what if the narrator is unreliable?", 3_000);
    expect(conversation.takeTurns()[0].prompt).toBe("I was thinking actually, what if the narrator is unreliable?");
    input("Research the other ending", 4_200);
    expect(conversation.takeTurns()[0].prompt).toBe("Research the other ending");
  });
});
