/** A bounded display envelope over local PCM energy. This is neither speech
 * recognition nor a provider turn boundary. No audio leaves this calculation. */
export class VoiceAudioEnvelope {
  private level = 0;
  private sampledAt?: number;
  private lastSound = -Infinity;

  sample(samples: Float32Array, now: number): { level: number; active: boolean } {
    let energy = 0;
    for (const value of samples) if (Number.isFinite(value)) energy += Math.min(1, value * value);
    const rms = samples.length ? Math.sqrt(energy / samples.length) : 0;
    if (rms >= 0.012) this.lastSound = now;
    // Suppress low room/codec noise, then compress ordinary speaking levels
    // into a useful display range without turning each syllable into a peak.
    const target = Math.pow(Math.min(1, Math.max(0, rms - 0.004) / 0.18), 0.65);
    const elapsed = this.sampledAt === undefined ? 1 / 30 : Math.min(0.1, Math.max(0, (now - this.sampledAt) / 1000));
    this.sampledAt = now;
    const duration = target > this.level ? 0.045 : 0.14;
    this.level += (target - this.level) * (1 - Math.exp(-elapsed / duration));
    if (this.level < 0.002) this.level = 0;
    return { level: Math.round(this.level * 1000) / 1000, active: now - this.lastSound < 600 };
  }

  reset() { this.level = 0; this.sampledAt = undefined; this.lastSound = -Infinity; }
}
