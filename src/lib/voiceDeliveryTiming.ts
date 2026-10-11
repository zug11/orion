import type { VoiceActivity } from "./liveVoice";

export const VOICE_FINDING_MAX_WAIT_MS = 12_000;
const QUIET_MS = 1_500;

/** Controls when to offer commentary, never claims that the provider spoke it.
 * Transcript arrivals are the primary speech signal. Audio energy only extends
 * a short quiet window: a fan or open microphone cannot starve a finding.
 */
export class VoiceDeliveryTiming {
  private lastTranscript = -Infinity;
  private lastOffered = -Infinity;
  private inputStarted = -Infinity;
  private outputStarted = -Infinity;
  private activity = { inputActive: false, outputActive: false };

  transcript(now = Date.now()) { this.lastTranscript = now; }
  audio(next: Pick<VoiceActivity, "inputActive" | "outputActive">, now = Date.now()) {
    if (next.inputActive && !this.activity.inputActive) this.inputStarted = now;
    if (next.outputActive && !this.activity.outputActive) this.outputStarted = now;
    this.activity = next;
  }
  offered(now = Date.now()) { this.lastOffered = now; }
  canOffer(queuedAt: number, now = Date.now()) {
    // Pace independent findings even when several have reached their deadline.
    if (now - this.lastOffered < QUIET_MS) return false;
    // This only offers context to the voice. The provider still chooses when to
    // speak it, including when the person is in the middle of a sentence.
    if (now - queuedAt >= VOICE_FINDING_MAX_WAIT_MS) return true;
    if (now - this.lastTranscript < QUIET_MS) return false;
    if (this.activity.inputActive && now - this.inputStarted < 2_500) return false;
    if (this.activity.outputActive && now - this.outputStarted < 4_000) return false;
    return true;
  }
  reset() {
    this.lastTranscript = this.lastOffered = this.inputStarted = this.outputStarted = -Infinity;
    this.activity = { inputActive: false, outputActive: false };
  }
}
