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
  it("never lets an overdue finding interrupt continuous human transcripts", () => {
    const timing = new VoiceDeliveryTiming();
    for (let now = 0; now <= VOICE_FINDING_MAX_WAIT_MS * 3; now += 500) {
      timing.transcript(now);
      timing.audio({ inputActive: now % 1_000 === 0, outputActive: false }, now);
      expect(timing.canOffer(0, now)).toBe(false);
    }
    expect(timing.canOffer(0, VOICE_FINDING_MAX_WAIT_MS * 3 + 1_499)).toBe(false);
    expect(timing.canOffer(0, VOICE_FINDING_MAX_WAIT_MS * 3 + 1_500)).toBe(true);
  });
  it("still caps flickering room noise when there is no new transcript", () => {
    const timing = new VoiceDeliveryTiming(); timing.transcript(0);
    for (let now = 0; now < VOICE_FINDING_MAX_WAIT_MS; now += 500) {
      timing.audio({ inputActive: false, outputActive: false }, now);
      timing.audio({ inputActive: true, outputActive: false }, now);
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
  it("waits for audible output to finish even after the input-noise deadline", () => {
    const timing = new VoiceDeliveryTiming();
    timing.audio({ inputActive: false, outputActive: true }, 0);
    expect(timing.canOffer(0, 30_000)).toBe(false);
    timing.audio({ inputActive: false, outputActive: false }, 30_000);
    expect(timing.canOffer(0, 31_499)).toBe(false);
    expect(timing.canOffer(0, 31_500)).toBe(true);
  });
  it("never lets the input-noise deadline override an arriving assistant transcript", () => {
    const timing = new VoiceDeliveryTiming();
    for (let now = 0; now <= 30_000; now += 500) {
      timing.transcript(now, "assistant");
      timing.audio({ inputActive: false, outputActive: false }, now);
      expect(timing.canOffer(0, now)).toBe(false);
    }
    expect(timing.canOffer(0, 31_499)).toBe(false);
    expect(timing.canOffer(0, 31_500)).toBe(true);
  });
  it("does not renew unsolicited speech during silence, assistant transcripts, noise or an orb handoff", () => {
    const timing = new VoiceDeliveryTiming();
    expect(timing.canOffer(0, 20_000, true)).toBe(false);
    timing.transcript(20_000, "user");
    expect(timing.canOffer(20_000, 21_500, true)).toBe(true);
    timing.offered(21_500, true);
    timing.transcript(25_000, "assistant");
    timing.audio({ inputActive: true, outputActive: false }, 26_000);
    expect(timing.canOffer(20_000, 80_000, true)).toBe(false);
    timing.handoff();
    expect(timing.canOffer(20_000, 80_000, true)).toBe(false);
    // A direct request can still get its result. New user speech renews the
    // background allowance; provider transcripts cannot do that themselves.
    expect(timing.canOffer(20_000, 80_000, false)).toBe(true);
    timing.transcript(80_000, "user");
    expect(timing.canOffer(80_000, 81_500, true)).toBe(true);
  });
});
