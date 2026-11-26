import { useSyncExternalStore } from "react";
import type { VoicePresenceStore } from "../lib/voicePresence";
import { ChatVoiceMark } from "./icons/ChatVoiceMark";
import { VoiceConstellation } from "./VoiceConstellation";
import type { IconPalette } from "../lib/themeIcon";
import type { Settings } from "../types";

export function SidebarVoiceIndicator({ presence, voicePalette, settings }: { presence: VoicePresenceStore; voicePalette?: IconPalette; settings?: Settings }) {
  const voice = useSyncExternalStore(presence.subscribe, presence.getSnapshot);
  if (!["connecting", "listening", "closing"].includes(voice.status)) return <ChatVoiceMark />;
  return <span className="sidebar-voice-presence" aria-label={voice.muted ? "Voice active, microphone muted" : "Voice active"}>
    <VoiceConstellation {...voice} settings={settings} palette={voicePalette} size="sidebar" onFocus={() => undefined} onDismiss={() => undefined} />
  </span>;
}
