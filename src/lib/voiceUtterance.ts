/** Conservative transcript assembly hints, not a semantic intent classifier.
 * Clear assignments keep their quick path; a dangling clause cannot authorize
 * research or an edit just because the transport emitted a delegation. */
export function unfinishedVoiceThought(text: string): boolean {
  const words = text.trim().toLowerCase().replace(/[,.!?…—–-]+$/g, "")
    .replace(/(?:[,\s]+(?:um|uh|erm|hmm))+$/g, "").trim();
  if (!words) return true;
  return /\b(?:and|but|because|although|whereas|whether|unless|which|with|without|about|into|to|the|a|an|my|your|our|of|for|than|versus|between|if|or)$/.test(words)
    || /\b(?:think|thinking|thought|is|was|believe|means) that$/.test(words)
    || /^(?:(?:so|well|okay|ok|um|uh)[,\s]+)*(?:i (?:was |am |was just |am just |just )?(?:thinking|wondering)|i think|the idea is|what if|can you|could you|would you|let me|read|research|compare|rewrite|edit|add|find|look up)$/.test(words);
}

export const VOICE_TURN_SETTLE_MS = 900;
export const VOICE_THOUGHT_SETTLE_MS = 3_200;
export const VOICE_THOUGHT_CONTINUATION_MS = 8_000;

export function voiceTurnSettleMs(text: string) {
  return unfinishedVoiceThought(text) ? VOICE_THOUGHT_SETTLE_MS : VOICE_TURN_SETTLE_MS;
}
