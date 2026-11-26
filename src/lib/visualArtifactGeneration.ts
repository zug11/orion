import type { ArtifactIllustration } from "./artifactIllustration";
import { visualStreamPreview, type ChatVisualHeading } from "./chatVisualStream";
import type { Settings } from "../types";
import { resolveIllustrationModel } from "./illustrationModel";
import { isChatGPTModel } from "./chatgpt";
import { matchesSelectionPassage, prepareVisualSelection, type VisualSelection } from "./visualSelection";
import { chatWithOrion } from "./storage";
import { validateGeneratedCalculatorRanges } from "./visualArtifactCalculatorRanges";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_GUIDANCE, parseArtifactGenerationInput, parseVisualArtifact,
  type ArtifactFormat, type VisualArtifact } from "./visualArtifacts";

interface DrawingOptions {
  onSourceProgress?: (message: string) => void;
  review?: boolean;
  onModelSelected?: (label: string) => void;
  onReviewStart?: () => void;
  onReviewFallback?: (message: string) => void;
  onPreview?: (artifact: VisualArtifact) => void;
  onHeading?: (heading: ChatVisualHeading) => void;
}

export async function generatePassageIllustration(
  source: string, guidance: string, settings: Settings, signal: AbortSignal, options: DrawingOptions = {},
): Promise<VisualArtifact> {
  const selection = await prepareVisualSelection(source, "explainer", guidance, settings, signal, options.onSourceProgress);
  return drawSelection(selection, guidance, settings, signal, options);
}

async function drawSelection(
  selection: VisualSelection, guidance: string, settings: Settings, signal: AbortSignal, options: DrawingOptions,
): Promise<VisualArtifact> {
  const route = await resolveIllustrationModel(settings, signal);
  options.onModelSelected?.(route.label);
  const draft = await generate(selection, "explainer", guidance, route.settings, signal, true, options.onPreview, options.onHeading);
  if (signal.aborted) throw signal.reason;
  if (!options.review) return draft;
  options.onReviewStart?.();
  try {
    const { reviewPassageIllustration } = await import("./visualArtifactReview");
    return await reviewPassageIllustration(draft, originalDrawing(draft), selection.text, guidance, route.settings, signal);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    options.onReviewFallback?.(error instanceof Error ? error.message : "The visual review could not finish.");
    return draft;
  }
}

export async function generateVisualArtifact(
  source: string, format: ArtifactFormat | "auto", guidance: string, settings: Settings, signal: AbortSignal,
  onPreview?: (artifact: VisualArtifact) => void, onHeading?: (heading: ChatVisualHeading) => void,
  onModelSelected?: (label: string) => void, onSourceProgress?: (message: string) => void,
) {
  if ((format === "auto" || format === "explainer") && asksForIllustration(guidance)) {
    return generatePassageIllustration(source, guidance, settings, signal, { onPreview, onHeading, onModelSelected, onSourceProgress });
  }
  const selection = await prepareVisualSelection(source, format, guidance, settings, signal, onSourceProgress);
  return generate(selection, format, guidance, settings, signal, false, onPreview, onHeading, onModelSelected);
}

export function asksForIllustration(guidance: string): boolean {
  if (/\b(?:chart|graph|calculator|quiz|flashcards?|timeline|flowchart|comparison table)\b/iu.test(guidance)) return false;
  return /\b(?:draw|sketch|illustrate|svg|illustration|picture|drawing|cutaway|cross[- ]section)\b/iu.test(guidance)
    && !/\b(?:don['’]t|do not|without|avoid|no)\s+(?:an?\s+)?(?:draw(?:ing)?|sketch|illustrat(?:e|ion)|svg|picture)\b/iu.test(guidance);
}

function originalDrawing(artifact: VisualArtifact): ArtifactIllustration | undefined {
  return artifact.blocks.find((block): block is ArtifactIllustration =>
    block.kind === "illustration" && block.parts.some(part => part.selectable && Boolean(part.shapes?.length)));
}

function checkSource(artifact: VisualArtifact, selection: VisualSelection) {
  const {text: source, excerpts} = selection;
  // A passage may show several exact excerpts separated by an explicit
  // omission. A citation must never claim that joined words were contiguous.
  const checkQuote = (quote: string) => {
    if (excerpts && source.includes(quote) && !excerpts.some(excerpt => excerpt.includes(quote))) {
      throw new Error("A quotation crosses an omission in the selection. Quote one continuous excerpt.");
    }
  };
  for (const block of artifact.blocks) {
    if (block.kind === "illustration") {
      if (!matchesSelectionPassage(selection, block.passage)) throw new Error("The illustration's passage differs from the selected text.");
      for (const part of block.parts) if (part.quote) checkQuote(part.quote);
    }
  }
  for (const claim of artifact.evidence?.claims ?? []) claim.quotes.forEach(checkQuote);
  if (artifact.evidence && !matchesSelectionPassage(selection, artifact.evidence.passage)) {
    throw new Error("The quoted source passage differs from the selection.");
  }
}

async function generate(
  selection: VisualSelection, format: ArtifactFormat | "auto", guidance: string, settings: Settings, signal: AbortSignal,
  drawing: boolean, onPreview?: (artifact: VisualArtifact) => void, onHeading?: (heading: ChatVisualHeading) => void,
  onModelSelected?: (label: string) => void,
): Promise<VisualArtifact> {
  if (signal.aborted) throw signal.reason;
  const source = selection.text;
  const planDrawing = !drawing && !settings.model.startsWith("claude-");
  const packet = parseArtifactGenerationInput({ source, format, guidance, ...(drawing && {drawing}) });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Visual generation timed out. Try again or use a shorter selection.")), drawing ? 360_000 : 120_000);
  const newStream = () => onPreview ? visualStreamPreview(artifact => {
    if (controller.signal.aborted || (planDrawing && artifact.blocks.some(block => block.kind === "illustration"))) return;
    if (drawing && !originalDrawing(artifact)) return;
    try { checkSource(artifact, selection); } catch { return; }
    if (format === "auto" || format === artifact.format) onPreview(artifact);
  }, heading => {
    if (!controller.signal.aborted && (format === "auto" || format === heading.format)) onHeading?.(heading);
  }) : undefined;
  let stream: ReturnType<typeof newStream> = undefined;
  try {
    let correction: string | undefined;
    while (true) {
      stream?.close();
      stream = newStream();
      const result = await chatWithOrion({
        mode: "visual-artifact", prompt: JSON.stringify({ ...packet, ...(correction && { correction }) }),
        workspaceName: "", notes: [], sources: [], concepts: [], history: [], allowNoteActions: false,
        model: settings.model, effort: settings.reasoningEffort,
        ...(isChatGPTModel(settings.model) && settings.chatgptAccountId && { drawingAccountId: settings.chatgptAccountId }),
      }, controller.signal, undefined, stream?.delta);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (new TextEncoder().encode(result.reply).length > MAX_ARTIFACT_BYTES) {
        throw new Error("The generated visual was too large. Try a shorter selection.");
      }
      let document: unknown;
      try { document = JSON.parse(result.reply); } catch { /* Handled below as an incomplete document. */ }
      if (document && typeof document === "object" && "unavailable" in document &&
          document.unavailable === true && Object.keys(document).length === 1) {
        throw new Error("The selection did not provide enough detail for this visual. Choose another format or select more text.");
      }
      try {
        if (document === undefined) throw new Error("The AI returned an incomplete visual. Try generating it again.");
        if (planDrawing) {
          clearTimeout(timer); // The dedicated drawing request has its own deadline.
          stream?.close();
          document = await completePlannedIllustration(document, selection, guidance, format, settings, signal, onModelSelected);
        }
        const artifact = parseVisualArtifact(document);
        if (format !== "auto" && artifact.format !== format) throw new Error("The AI returned a different visual format. Try generating it again.");
        if (drawing && !originalDrawing(artifact)) {
          throw new Error("Draw the subject with original shapes or paths on at least one selectable part. Library symbols may support the drawing.");
        }
        checkSource(artifact, selection);
        validateGeneratedCalculatorRanges(artifact);
        return artifact;
      } catch (error) {
        if (!drawing || correction || controller.signal.aborted || !(error instanceof Error)) throw error;
        correction = error.message.replace(/[\x00-\x1F\x7F]/gu, " ").slice(0, 300);
      }
    }
  } finally {
    stream?.close();
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

/** Validate the complete surrounding artifact before spending a second call on
 * its illustration. Swapping at the original index keeps evidence targets stable. */
async function completePlannedIllustration(document: unknown, selection: VisualSelection, guidance: string,
  format: ArtifactFormat | "auto", settings: Settings, signal: AbortSignal, onModelSelected?: (label: string) => void,
): Promise<unknown> {
  if (!document || typeof document !== "object" || !("blocks" in document) || !Array.isArray(document.blocks)) return document;
  const blocks = document.blocks;
  const index = blocks.findIndex(block => block?.kind === "drawingRequest" || block?.kind === "illustration");
  if (index < 0) return document;
  const request = blocks[index];
  if (blocks.slice(index + 1).some(block => block?.kind === "drawingRequest" || block?.kind === "illustration")) {
    throw new Error("A visual can request one shared illustration. Try selecting a shorter passage.");
  }
  if (request.kind === "drawingRequest" && (Object.keys(request).length !== 2 || typeof request.description !== "string"
    || !request.description.trim() || request.description.length > 400 || /[\x00-\x1F\x7F]/u.test(request.description))) {
    throw new Error("The visual returned an invalid drawing description.");
  }
  const replace = (block: unknown) => ({ ...document, blocks: blocks.map((existing, i) => i === index ? block : existing) });
  const surrounding = parseVisualArtifact(replace({ kind: "text", text: "Drawing" }));
  if (format !== "auto" && surrounding.format !== format) throw new Error("The AI returned a different visual format. Try generating it again.");
  checkSource(surrounding, selection);
  validateGeneratedCalculatorRanges(surrounding);
  // An older model may return its own illustration in place of the request.
  // Discard that geometry; the dedicated model draws afresh from the source.
  const detail = request.kind === "drawingRequest" ? request.description : "";
  const instructions = [guidance, detail].filter(Boolean).join("\n").slice(0, MAX_ARTIFACT_GUIDANCE);
  const drawn = await drawSelection(selection, instructions, settings, signal, { onModelSelected });
  return replace(originalDrawing(drawn));
}
