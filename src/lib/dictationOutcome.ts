/**
 * A dictation that outlives its note has no button left to report through.
 *
 * Leaving a note while recording used to discard the recording. The session now
 * finishes transcribing in the background and archives the original to Sources
 * without inserting it. The window listens here to tell the user what happened.
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
