import type { Settings } from "../types";
import { isSelectedAIConfigured, selectedAIProviderName } from "./ai";

export interface EditorAICapabilities {
  writingEnabled: boolean;
  imageGenerationEnabled: boolean;
  writingUnavailableReason?: string;
  imageUnavailableReason?: string;
}

/** Image composition uses the selected text model before OpenAI renders it. */
export function resolveEditorAICapabilities(settings: Settings): EditorAICapabilities {
  const writingEnabled = isSelectedAIConfigured(settings);
  const providerName = selectedAIProviderName(settings);
  const imageGenerationEnabled = writingEnabled && settings.apiKeyConfigured;

  let imageUnavailableReason: string | undefined;
  if (!imageGenerationEnabled) {
    if (!settings.apiKeyConfigured && !writingEnabled && providerName === "Anthropic") {
      imageUnavailableReason = "Add OpenAI and Anthropic keys in Settings to generate images with the selected planning model.";
    } else if (!settings.apiKeyConfigured) {
      imageUnavailableReason = "Add an OpenAI key in Settings to generate images.";
    } else {
      imageUnavailableReason = `Add an ${providerName} key in Settings to plan images with the selected model.`;
    }
  }

  return {
    writingEnabled,
    imageGenerationEnabled,
    writingUnavailableReason: writingEnabled
      ? undefined
      : `Add an ${providerName} key in Settings to write or rewrite with the selected model.`,
    imageUnavailableReason,
  };
}
