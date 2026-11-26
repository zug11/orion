import type { Settings } from "../types";
import { parseArtifactIllustration, validateIllustrationSource, type ArtifactIllustration } from "./artifactIllustration";
import { rasteriseArtifactIllustration } from "./rasteriseArtifactIllustration";
import { isChatGPTModel } from "./chatgpt";
import { chatWithOrion } from "./storage";
import { MAX_ARTIFACT_BYTES, parseVisualArtifact, type VisualArtifact } from "./visualArtifacts";

function contentIdentity(drawing: ArtifactIllustration) {
  return JSON.stringify([drawing.passage,
    drawing.parts.map(p => [p.id, p.name, p.selectable, p.about, p.quote, p.level]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))),
    drawing.states?.label,
    drawing.states?.items.map(item => [item.label, item.caption, item.changes.map(change => [change.part, change.hidden, change.emphasis, change.level])]),
    drawing.handles, drawing.animation,
  ]);
}

/** One optional second look at the rendered first drawing. Numeric results,
 * surrounding prose, source quotes and the rest of the artifact stay intact. */
export async function reviewPassageIllustration(
  draft: VisualArtifact, drawing: ArtifactIllustration | undefined, source: string, guidance: string, settings: Settings, signal: AbortSignal,
): Promise<VisualArtifact> {
  if (signal.aborted) throw signal.reason;
  if (!drawing) throw new Error("No drawing was available for review.");
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("The drawing review timed out.")), 120_000);
  try {
    const png = await rasteriseArtifactIllustration(drawing, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    const result = await chatWithOrion({
      mode: "visual-artifact", prompt: JSON.stringify({ source, guidance, format: "explainer", drawing: true }),
      ...(isChatGPTModel(settings.model) && { drawingAccountId: settings.chatgptAccountId }),
      visualReview: { png, drawing }, model: settings.model, effort: settings.reasoningEffort,
      workspaceName: "", notes: [], sources: [], concepts: [], history: [], allowNoteActions: false,
    }, controller.signal);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (new TextEncoder().encode(result.reply).length > MAX_ARTIFACT_BYTES) throw new Error("The reviewed drawing was too large.");
    const raw = JSON.parse(result.reply);
    if (raw?.unchanged === true && Object.keys(raw).length === 1) return draft;
    const corrected = parseArtifactIllustration(raw);
    validateIllustrationSource(corrected, source);
    if (contentIdentity(corrected) !== contentIdentity(drawing)) throw new Error("The proposed revision changed parts, controls, motion or text from the original drawing.");
    return parseVisualArtifact({ ...draft, blocks: draft.blocks.map(block => block === drawing ? corrected : block) });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
