import type { VoiceActivity } from "./liveVoice";

export const VOICE_FINDING_MAX_WAIT_MS = 12_000;
const QUIET_MS = 1_500;
const BACKGROUND_GAP_MS = 12_000;
const THOUGHT_QUIET_MS = 2_800;
const INCOMPLETE_THOUGHT_QUIET_MS = 8_000;

/** Controls when to offer commentary, never claims that the provider spoke it.
 * Transcript arrivals are the primary speech signal. Audio energy only extends
 * a short quiet window: a fan or open microphone cannot starve a finding.
 */
export class VoiceDeliveryTiming {
  private lastTranscript = -Infinity;
  private lastAssistantTranscript = -Infinity;
  private lastOffered = -Infinity;
  private lastBackground = -Infinity;
  private userGeneration = 0;
  private offeredGeneration = 0;
  private inputStarted = -Infinity;
  private lastOutput = -Infinity;
  private userHoldUntil = -Infinity;
  private assistantTail = "";
  private activity = { inputActive: false, outputActive: false };

  transcript(now = Date.now(), role: "user" | "assistant" = "user", quietForMs = 0, delta?: string) {
    this.lastTranscript = now;
    if (role === "user") {
      this.userGeneration++; this.userHoldUntil = now + Math.max(QUIET_MS, quietForMs);
      // An actual human turn can take the floor from an interrupted fragment.
      // Noise cannot take the floor; missing punctuation has its own longer
      // silence fallback rather than requiring the user to rescue delivery.
      this.assistantTail = "";
    } else {
      this.lastAssistantTranscript = now;
      if (delta) this.assistantTail = (this.assistantTail + delta).slice(-800);
    }
  }
  audio(next: Pick<VoiceActivity, "inputActive" | "outputActive">, now = Date.now()) {
    if (next.inputActive && !this.activity.inputActive) this.inputStarted = now;
    if (next.outputActive || this.activity.outputActive) this.lastOutput = now;
    this.activity = next;
  }
  offered(now = Date.now(), background = false, completion = false) {
    this.lastOffered = now;
    if (background && !completion) { this.lastBackground = now; this.offeredGeneration = this.userGeneration; }
  }
  outputQuiet(now = Date.now()) {
    const tail = this.assistantTail.trim();
    // GPT-Live has no turn-done event. Punctuation shortens the quiet guard;
    // missing punctuation or a dropped final delta cannot latch it forever.
    // The fallback starts after the latest playback OR transcript, never the
    // finding's arrival. Active audio and fresh deltas always retain the floor.
    // Do not apply the user's dangling-word routing heuristic here: a complete
    // answer such as "That's what it is for." must not latch delivery forever.
    const incomplete = tail && (!/[.!?。！？]["'”’\)\]]*$/.test(tail) || /(?:\.{2,}|…)\s*["'”’\)\]]*$/.test(tail));
    const quiet = incomplete ? INCOMPLETE_THOUGHT_QUIET_MS : tail ? THOUGHT_QUIET_MS : QUIET_MS;
    return !this.activity.outputActive && now - this.lastOutput >= quiet && now - this.lastAssistantTranscript >= quiet;
  }
  inputSettled(now = Date.now()) { return now >= this.userHoldUntil; }
  contextSafe(now = Date.now()) { return this.outputQuiet(now) && now - this.lastTranscript >= QUIET_MS && this.inputSettled(now); }
  backgroundEligible(now = Date.now(), completion = false) {
    return completion || this.userGeneration > this.offeredGeneration && now - this.lastBackground >= BACKGROUND_GAP_MS;
  }
  canOffer(queuedAt: number, now = Date.now(), background = false, completion = false) {
    // Limit unsolicited interim chatter. Each admitted assignment's one final
    // answer must still arrive, even if a checkpoint used the interim allowance.
    // Queue identity/revision/sequence deduplication prevents repeated finals.
    if (background && !this.backgroundEligible(now, completion)) return false;
    // Pace independent findings even when several have reached their deadline.
    if (now - this.lastOffered < QUIET_MS) return false;
    // Never stack another speech request onto audible playback. Worker facts
    // remain local until the same floor guard allows their prepared contribution.
    if (!this.outputQuiet(now)) return false;
    // A waiting finding never outranks an arriving human transcript. The cap
    // exists for flickering microphone noise, not for a person thinking aloud.
    if (now - this.lastTranscript < QUIET_MS || now < this.userHoldUntil) return false;
    if (now - queuedAt >= VOICE_FINDING_MAX_WAIT_MS) return true;
    if (this.activity.inputActive && now - this.inputStarted < 2_500) return false;
    return true;
  }
  handoff() {
    // A new audio recipient clears old track timing, not the conversation's
    // unsolicited-update budget. Switching orbs must not trigger a monologue.
    this.lastTranscript = this.lastAssistantTranscript = this.lastOffered = this.inputStarted = this.lastOutput = -Infinity;
    this.userHoldUntil = -Infinity;
    this.assistantTail = "";
    this.activity = { inputActive: false, outputActive: false };
  }
  reset() {
    this.handoff(); this.lastBackground = -Infinity; this.userGeneration = this.offeredGeneration = 0;
  }
}
