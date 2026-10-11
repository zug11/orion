import { describe, expect, it } from "vitest";
import { VoiceAudioEnvelope } from "./voiceAudioActivity";

describe("local voice display envelope", () => {
  it("follows phrase energy and settles during pauses while retaining the legacy activity hold", () => {
    const envelope = new VoiceAudioEnvelope(), pcm = new Float32Array(1024);
    expect(envelope.sample(pcm, 0)).toEqual({ level: 0, active: false });
    pcm.fill(0.035);
    const onset = envelope.sample(pcm, 33);
    const sustained = envelope.sample(pcm, 66);
    expect(onset.level).toBeGreaterThan(0); expect(sustained.level).toBeGreaterThan(onset.level);
    pcm.fill(0.13);
    const emphasis = envelope.sample(pcm, 99);
    expect(emphasis.level).toBeGreaterThan(sustained.level); expect(emphasis.level).toBeLessThan(1);
    pcm.fill(0);
    const pause = envelope.sample(pcm, 132);
    expect(pause.active).toBe(true); expect(pause.level).toBeLessThan(emphasis.level);
    let settled = pause;
    for (let now = 165; now < 1500; now += 33) settled = envelope.sample(pcm, now);
    expect(settled).toEqual({ active: false, level: 0 });
  });

  it("does not revive stale energy after mute, suspension, or replacement", () => {
    const envelope = new VoiceAudioEnvelope(), pcm = new Float32Array(1024).fill(0.2);
    expect(envelope.sample(pcm, 0).active).toBe(true);
    envelope.reset(); pcm.fill(0);
    expect(envelope.sample(pcm, 33)).toEqual({ active: false, level: 0 });
  });

  it("bounds malformed or full-scale samples and suppresses low codec noise", () => {
    const envelope = new VoiceAudioEnvelope();
    expect(envelope.sample(new Float32Array(1024).fill(0.003), 0)).toEqual({ active: false, level: 0 });
    const result = envelope.sample(new Float32Array([NaN, Infinity, -Infinity, 100, -100]), 33);
    expect(Number.isFinite(result.level)).toBe(true); expect(result.level).toBeGreaterThanOrEqual(0); expect(result.level).toBeLessThanOrEqual(1);
    envelope.reset(); expect(envelope.sample(new Float32Array(), 0)).toEqual({ active: false, level: 0 });
  });
});
