import { useSyncExternalStore } from "react";
import type { VoicePresenceStore } from "../lib/voicePresence";
import { ChatVoiceMark } from "./icons/ChatVoiceMark";
import { VoiceConstellation } from "./VoiceConstellation";
import type { IconPalette } from "../lib/themeIcon";

export function SidebarVoiceIndicator({ presence, voicePalette }: { presence: VoicePresenceStore; voicePalette?: IconPalette }) {
  const voice = useSyncExternalStore(presence.subscribe, presence.getSnapshot);
  if (!["connecting", "listening", "closing"].includes(voice.status)) return <ChatVoiceMark />;
  return <span className="sidebar-voice-presence" aria-label={voice.muted ? "Voice active, microphone muted" : "Voice active"}>
    <VoiceConstellation {...voice} palette={voicePalette} size="sidebar" onFocus={() => undefined} onDismiss={() => undefined} />
  </span>;
}
