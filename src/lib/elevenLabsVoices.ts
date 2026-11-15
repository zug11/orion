import { invoke, isTauri } from "@tauri-apps/api/core";
import { MAX_VOICE_NAME_LENGTH, normalizeElevenLabsVoiceId } from "../data/defaults";
export interface VoiceControls { stability: number; similarity_boost: number; style: number; speed: number; use_speaker_boost: boolean; clone_strength?: number }
export interface LibraryVoice { id: string; name: string; description: string; category: string; requiresVerification: boolean; labels: Record<string,string>; settings: VoiceControls; samples: { id: string; name: string }[] }
export interface VoiceModel { id: string; name: string; supportsStyle: boolean; supportsSpeakerBoost: boolean }
export interface PickedSample { name: string; bytes: number }
export const defaultVoiceControls: VoiceControls = { stability: 0.5, similarity_boost: 0.75, style: 0, speed: 1, use_speaker_boost: true };
export async function voiceCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("Voice cloning and voice controls are available in the Orion desktop app.");
  return invoke<T>(command, args);
}

/** A complete, transient account catalog. Never use partial coverage to clear a saved choice. */
export async function loadElevenLabsAccountVoices(active: () => boolean): Promise<LibraryVoice[] | undefined> {
  const voices = new Map<string, LibraryVoice>(), pages = new Set<string>();
  let nextPage: string | null = null;
  for (let page = 0; page < 20 && active(); page++) {
    const result: { voices: LibraryVoice[]; nextPage: string | null } = await voiceCommand("elevenlabs_list_voices", { nextPage });
    if (!active()) return;
    if (!result || !Array.isArray(result.voices) || result.voices.length > 100 ||
        result.nextPage !== null && (typeof result.nextPage !== "string" || !result.nextPage || result.nextPage.length > 2_048)) {
      throw new Error("ElevenLabs returned an invalid voice library. Refresh voices to try again.");
    }
    for (const voice of result.voices) {
      if (!voice || normalizeElevenLabsVoiceId(voice.id) !== voice.id || !voice.id || typeof voice.name !== "string" || typeof voice.requiresVerification !== "boolean") {
        throw new Error("ElevenLabs returned an invalid voice. Refresh voices to try again.");
      }
      const name = voice.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, MAX_VOICE_NAME_LENGTH) || "Voice";
      voices.set(voice.id, { ...voice, name });
    }
    if (result.nextPage === null) return [...voices.values()];
    if (pages.has(result.nextPage)) throw new Error("ElevenLabs repeated a voice library page. Refresh voices to try again.");
    pages.add(result.nextPage); nextPage = result.nextPage;
  }
  if (active()) throw new Error("The account voice library could not be fully loaded. Your saved voices are unchanged.");
}
