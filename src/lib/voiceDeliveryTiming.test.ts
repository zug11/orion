import { describe, expect, it } from "vitest";
import { VoiceDeliveryTiming, VOICE_FINDING_MAX_WAIT_MS } from "./voiceDeliveryTiming";

describe("voice finding delivery timing", () => {
  it("uses arriving transcripts for speech even when the meter reports silence", () => {
    const timing = new VoiceDeliveryTiming();
    timing.transcript(1_000);
    timing.audio({ inputActive: false, outputActive: false }, 1_100);
    expect(timing.canOffer(0, 2_499)).toBe(false);
    expect(timing.canOffer(0, 2_500)).toBe(true);
  });
  it("does not let constant room noise hold a finding forever", () => {
    const timing = new VoiceDeliveryTiming();
    timing.audio({ inputActive: true, outputActive: false }, 0);
    expect(timing.canOffer(0, 2_000)).toBe(false);
    expect(timing.canOffer(0, 2_500)).toBe(true);
  });
  it("caps the wait for continuous speech or flickering background audio", () => {
    const timing = new VoiceDeliveryTiming();
    for (let now = 0; now < VOICE_FINDING_MAX_WAIT_MS; now += 500) {
      timing.transcript(now);
      timing.audio({ inputActive: now % 1_000 === 0, outputActive: true }, now);
      expect(timing.canOffer(0, now)).toBe(false);
    }
    expect(timing.canOffer(0, VOICE_FINDING_MAX_WAIT_MS)).toBe(true);
  });
  it("paces a backlog and clears call-specific timing on reconnect", () => {
    const timing = new VoiceDeliveryTiming();
    timing.offered(20_000);
    expect(timing.canOffer(0, 20_500)).toBe(false);
    expect(timing.canOffer(0, 21_500)).toBe(true);
    timing.reset();
    expect(timing.canOffer(0, 1)).toBe(true);
  });
});
