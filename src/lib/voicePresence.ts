import type { VoiceActivity, VoiceStatus } from "./liveVoice";
import type { VoiceWorkOrder } from "./voiceResearch";
import type { VoiceOrbMotion } from "./voiceOrbMotion";

export interface VoicePresence {
  /** One transient physical field shared by every visible call representation. */
  motion?: VoiceOrbMotion;
  status: VoiceStatus;
  activity: VoiceActivity;
  muted: boolean;
  jobs: readonly VoiceWorkOrder[];
  focusedJobId?: string;
  dismissedJobIds?: readonly string[];
}
export const silentVoiceActivity = (): VoiceActivity => ({
  inputActive: false, outputActive: false, measured: false,
  inputLevel: 0, outputLevel: 0, inputMeasured: false, outputMeasured: false, inputMuted: false,
});

/** A window/Space-owned transient channel. Audio frames never rerender the vault owner. */
export function createVoicePresence() {
  let current: VoicePresence = { status: "idle", activity: silentVoiceActivity(), muted: false, jobs: [] };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => current,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    update: (next: VoicePresence) => { current = next; listeners.forEach(listener => listener()); },
  };
}
export type VoicePresenceStore = ReturnType<typeof createVoicePresence>;
