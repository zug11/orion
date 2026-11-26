import type { Settings } from "../types";
import { isSelectedAIConfigured } from "./ai";
import { chatWithOrion } from "./storage";
import { validateGeneratedCalculatorRanges } from "./visualArtifactCalculatorRanges";
import { ARTIFACT_FORMATS, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_GUIDANCE, MAX_ARTIFACT_SOURCE, parseArtifactGenerationInput, parseVisualArtifact,
  type ArtifactFormat, type VisualArtifact } from "./visualArtifacts";

export async function generateVisualArtifact(
  source: string, format: ArtifactFormat | "auto", guidance: string, settings: Settings, signal: AbortSignal,
): Promise<VisualArtifact> {
  if (signal.aborted) throw signal.reason;
  if (!source.trim()) throw new Error("Select some note text to visualise.");
  if (source.length > MAX_ARTIFACT_SOURCE) throw new Error("Select up to 12,000 characters to visualise.");
  if (guidance.length > MAX_ARTIFACT_GUIDANCE) throw new Error("Keep the guidance within 800 characters.");
  if (format !== "auto" && !ARTIFACT_FORMATS.includes(format)) throw new Error("Choose an available visual format.");
  if (!isSelectedAIConfigured(settings)) throw new Error("Connect your selected AI provider in Settings to generate a visual.");

  const packet = parseArtifactGenerationInput({ source, format, guidance });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Visual generation timed out. Try again or use a shorter selection.")), 120_000);
  try {
    const result = await chatWithOrion({
      mode: "visual-artifact", prompt: JSON.stringify(packet),
      workspaceName: "", notes: [], sources: [], concepts: [], history: [], allowNoteActions: false,
      model: settings.model, effort: settings.reasoningEffort,
    }, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (new TextEncoder().encode(result.reply).length > MAX_ARTIFACT_BYTES) {
      throw new Error("The generated visual was too large. Try a shorter selection.");
    }
    let document: unknown;
    try { document = JSON.parse(result.reply); }
    catch { throw new Error("The AI returned an incomplete visual. Try generating it again."); }
    if (document && typeof document === "object" && "unavailable" in document &&
        document.unavailable === true && Object.keys(document).length === 1) {
      throw new Error("The selection did not provide enough detail for this visual. Choose another format or select more text.");
    }
    const artifact = parseVisualArtifact(document);
    if (format !== "auto" && artifact.format !== format) throw new Error("The AI returned a different visual format. Try generating it again.");
    validateGeneratedCalculatorRanges(artifact);
    return artifact;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}
