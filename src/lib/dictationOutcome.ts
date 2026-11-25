/**
 * A dictation that outlives its note has no button left to report through.
 *
 * Switching Spaces or closing the editor stops capture, finishes transcription
 * and archives the original to Sources without insertion. Same-Space navigation
 * retains the editor and its floating control instead.
 */
export interface DetachedDictationOutcome {
  /** True when the original transcript was archived to Sources. */
  saved: boolean;
  /** Why nothing could be saved, when it could not. */
  message?: string;
}

type Listener = (outcome: DetachedDictationOutcome) => void;
const listeners = new Set<Listener>();

export function onDetachedDictation(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reportDetachedDictation(outcome: DetachedDictationOutcome): void {
  for (const listener of [...listeners]) listener(outcome);
}
