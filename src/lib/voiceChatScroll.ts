/** A short, bounded reveal gesture before ordinary conversation scrolling. */
export const VOICE_CHAT_REVEAL_DISTANCE = 280;

export function voiceChatPanelGeometry(viewportHeight: number, chromeHeight: number, bottomInset: number, promptHeight = 0) {
  const maximum = Math.max(0, Math.min(viewportHeight * .82, viewportHeight - bottomInset - 24));
  const available = Math.max(0, maximum - chromeHeight);
  // A short window should still expose the prompt's actual prose, not only its
  // author label. Let the voice illustration yield some room before clipping it.
  const minimumScene = Math.min(120, Math.max(64, available - 112), available);
  const prompt = Math.min(promptHeight, Math.max(0, available - minimumScene));
  const minimum = Math.min(maximum, Math.max(440, chromeHeight + 120) + prompt);
  return { minimum, maximum, scene: Math.max(0, minimum - chromeHeight - prompt) };
}

export function consumeVoiceChatScroll(reveal: number, delta: number, threadTop: number) {
  const current = Math.max(0, Math.min(VOICE_CHAT_REVEAL_DISTANCE, reveal));
  // Reading older messages never changes the panel's size. Collapse begins at
  // the start of the conversation, on the next upward gesture at that boundary.
  if (current === VOICE_CHAT_REVEAL_DISTANCE && (delta >= 0 || threadTop > 1)) {
    return { reveal: current, handled: false, remainder: 0 };
  }
  const next = Math.max(0, Math.min(VOICE_CHAT_REVEAL_DISTANCE, current + delta));
  return { reveal: next, handled: true, remainder: Math.max(0, current + delta - VOICE_CHAT_REVEAL_DISTANCE) };
}
