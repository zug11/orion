import { ArtifactCompositionError } from "./artifactComposition";
import { ArgumentReadingError } from "./artifactArgument";
import type { ArtifactIllustration } from "./artifactIllustration";
import { visualStreamPreview, type ChatVisualHeading } from "./chatVisualStream";
import type { Settings } from "../types";
import { resolveIllustrationModel } from "./illustrationModel";
import { isChatGPTModel } from "./chatgpt";
import { matchesSelectionPassage, prepareVisualSelection, type VisualSelection } from "./visualSelection";
import { chatWithOrion } from "./storage";
import { validateGeneratedCalculatorRanges } from "./visualArtifactCalculatorRanges";
import { MAX_ARTIFACT_BYTES, MAX_ARTIFACT_GUIDANCE, parseArtifactGenerationInput, parseVisualArtifact,
  type ArtifactFormat, type DrawingInteraction, type VisualArtifact } from "./visualArtifacts";

interface DrawingOptions {
  interaction?: DrawingInteraction;
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
  const draft = await generate(selection, "explainer", guidance, route.settings, signal, true, options.onPreview,
    options.onHeading, undefined, options.interaction ?? drawingInteraction(guidance));
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
  const interaction = drawingInteraction(guidance);
  if (/\b(?:chart|graph|calculator|quiz|flashcards?|timeline|flowchart|comparison table|linked views|argument explorer|zoom across sizes|deep time)\b/iu.test(guidance)
    || (!interaction && /\bcycle\b/iu.test(guidance))) return false;
  return (Boolean(interaction) || /\b(?:draw|sketch|illustrate|svg|illustration|picture|drawing|cutaway|cross[- ]section)\b/iu.test(guidance))
    && !/\b(?:don['’]t|do not|without|avoid|no)\s+(?:an?\s+)?(?:draw(?:ing)?|sketch|illustrat(?:e|ion)|svg|picture)\b/iu.test(guidance);
}

function drawingInteraction(guidance: string): DrawingInteraction | undefined {
  const play = /\b(?:animate|animated|animations?|playback)\b/iu.test(guidance)
    && !/\b(?:no|without|avoid|skip|don['’]t|do not)\s+(?:(?:want|use|include|add|any|an)\s+)*(?:animat\w*|playback)\b/iu.test(guidance);
  const drag = /\b(?:draggable|drag[- ]and[- ]drop|drag (?:the|a|both|each|either)|by dragging)\b/iu.test(guidance)
    && !/\b(?:no|without|avoid|don['’]t|do not)\s+drag\w*\b/iu.test(guidance);
  return play && drag ? "dragAndPlay" : play ? "play" : drag ? "drag" : undefined;
}

function interactionMatches(drawing: ArtifactIllustration | undefined, interaction?: DrawingInteraction) {
  return (!interaction || interaction === "drag" || !!drawing?.animation) &&
    (!interaction || interaction === "play" || !!drawing?.handles?.length);
}

function originalDrawing(artifact: VisualArtifact): ArtifactIllustration | undefined {
  return artifact.blocks.find((block): block is ArtifactIllustration =>
    block.kind === "illustration" && block.parts.some(part => part.selectable && Boolean(part.shapes?.length)));
}

function needsArgumentReading(artifact: VisualArtifact) {
  return artifact.format === "argument" && artifact.blocks.some(block => block.kind === "argument" && !block.reading);
}
function needsInteractiveDesign(artifact: VisualArtifact, requested: ArtifactFormat | "auto", guidance: string) {
  if (guidance.trim() || (requested !== "auto" && requested !== "custom")) return false;
  if (artifact.format === "explainer") return artifact.blocks.every(block => block.kind === "text");
  if (artifact.format !== "custom" || !artifact.blocks.every(block => block.kind === "text" || block.kind === "table")) return false;
  return !artifact.layout?.rows.some(row => row.some(cell => !("control" in cell) &&
    (cell.when?.length || ("readout" in cell && new Set(cell.values).size > 1))));
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
    if ("passage" in block && !matchesSelectionPassage(selection, block.passage)) {
      throw new Error("The visual’s passage differs from the selected text.");
    }
    if (block.kind === "cycle" || block.kind === "linkedViews") block.phases.forEach(phase => checkQuote(phase.quote));
    if (block.kind === "argument") {
      block.premises.forEach(item => { if ("quote" in item && item.quote) checkQuote(item.quote); });
      block.conclusions.forEach(item => checkQuote(item.quote));
    }
    if (block.kind === "illustration") {
      for (const part of block.parts) if (part.quote) checkQuote(part.quote);
      for (const handle of block.handles ?? []) checkQuote(handle.quote);
      if (block.animation) checkQuote(block.animation.quote);
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
  onModelSelected?: (label: string) => void, interaction?: DrawingInteraction,
): Promise<VisualArtifact> {
  if (signal.aborted) throw signal.reason;
  const source = selection.text;
  const deferGeometry = !drawing && !settings.model.startsWith("claude-");
  const packet = parseArtifactGenerationInput({ source, format, guidance, ...(drawing && {drawing}), ...(interaction && {interaction}) });
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestedFormat = format;
  const newStream = () => onPreview ? visualStreamPreview(artifact => {
    if (controller.signal.aborted || (deferGeometry && artifact.blocks.some(block => block.kind === "illustration"))) return;
    if (drawing && (!originalDrawing(artifact) || !interactionMatches(originalDrawing(artifact), interaction))) return;
    if (needsArgumentReading(artifact) || needsInteractiveDesign(artifact, format, guidance)) return;
    try { checkSource(artifact, selection); } catch { return; }
    if (requestedFormat === "auto" || requestedFormat === artifact.format) onPreview(artifact);
  }, heading => {
    if (!controller.signal.aborted && (requestedFormat === "auto" || requestedFormat === heading.format)) onHeading?.(heading);
  }) : undefined;
  let stream: ReturnType<typeof newStream> = undefined;
  try {
    let correction: string | undefined;
    while (true) {
      stream?.close();
      stream = newStream();
      timer = setTimeout(() => controller.abort(new Error("Visual generation timed out. Try again or use a shorter selection.")), drawing ? 360_000 : 120_000);
      const result = await chatWithOrion({
        mode: "visual-artifact", prompt: JSON.stringify({ ...packet, format: requestedFormat, ...(correction && { correction }) }),
        workspaceName: "", notes: [], sources: [], concepts: [], history: [], allowNoteActions: false,
        model: settings.model, effort: settings.reasoningEffort,
        ...(isChatGPTModel(settings.model) && settings.chatgptAccountId && { drawingAccountId: settings.chatgptAccountId }),
      }, controller.signal, undefined, stream?.delta);
      clearTimeout(timer);
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
        if (!drawing) {
          stream?.close();
          document = await completePlannedIllustration(document, selection, guidance, requestedFormat, settings, signal, deferGeometry, onModelSelected);
        }
        const artifact = parseVisualArtifact(document);
        if (requestedFormat !== "auto" && artifact.format !== requestedFormat) throw new Error("The AI returned a different visual format. Try generating it again.");
        if (drawing && !originalDrawing(artifact)) {
          throw new Error("Draw the subject with original shapes or paths on at least one selectable part. Library symbols may support the drawing.");
        }
        if (drawing && !interactionMatches(originalDrawing(artifact), interaction)) {
          throw new Error(interaction === "drag" ? "Include illustration.handles so the reader can drag the drawing." :
            interaction === "play" ? "Include illustration.animation with time-keyed movement so the drawing plays." :
            "Include both illustration.handles and illustration.animation so the reader can change the drawing during playback.");
        }
        if (needsInteractiveDesign(artifact, format, guidance))
          throw new ArtifactCompositionError("Give the reader a source-grounded choice with a visible consequence, or a drawing, argument or other block they can explore.");
        if (needsArgumentReading(artifact))
          throw new ArgumentReadingError("Include reading with complete paragraph variants and a fallback in each argument block.");
        checkSource(artifact, selection);
        validateGeneratedCalculatorRanges(artifact);
        return artifact;
      } catch (error) {
        if (correction || controller.signal.aborted || !(error instanceof Error)) throw error;
        if (!drawing) {
          if (error instanceof ArtifactCompositionError && (format === "auto" || format === "custom")) requestedFormat = "custom";
          else if (error instanceof ArgumentReadingError && (format === "argument" ||
            (format === "auto" && document && typeof document === "object" && "format" in document && document.format === "argument"))) requestedFormat = "argument";
          else throw error;
        }
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
  format: ArtifactFormat | "auto", settings: Settings, signal: AbortSignal, deferGeometry: boolean, onModelSelected?: (label: string) => void,
): Promise<unknown> {
  if (!document || typeof document !== "object" || !("blocks" in document) || !Array.isArray(document.blocks)) return document;
  const blocks = document.blocks;
  const index = blocks.findIndex(block => block?.kind === "drawingRequest" || (deferGeometry && block?.kind === "illustration"));
  if (index < 0) return document;
  const request = blocks[index];
  if (blocks.slice(index + 1).some(block => block?.kind === "drawingRequest" || block?.kind === "illustration")) {
    throw new Error("A visual can request one shared illustration. Try selecting a shorter passage.");
  }
  if (request.kind === "drawingRequest" && (Object.keys(request).some(k => !["kind","description","interaction"].includes(k)) ||
    ("interaction" in request && !["drag","play","dragAndPlay"].includes(request.interaction)) || typeof request.description !== "string"
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
  const drawn = await drawSelection(selection, instructions, settings, signal, { onModelSelected,
    interaction: request.kind === "drawingRequest" ? request.interaction : undefined });
  return replace(originalDrawing(drawn));
}
