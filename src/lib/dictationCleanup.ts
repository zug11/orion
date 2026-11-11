import type { AppSnapshot, Source } from "../types";

export interface DictationBlock {
  kind: "paragraph" | "bullet" | "todo";
  text: string;
}

export const MAX_DICTATION_CLEANUP_CHARS = 24_000;
export const DICTATION_CLEANUP_TIMEOUT_MS = 45_000;
const ORIGINAL_PREFIX = "source-dictation-";

export interface PreparedDictation {
  original: string;
  blocks?: DictationBlock[];
  sourceId?: string;
  notice: string;
}

export interface DictationCompletionOptions {
  signal: AbortSignal;
  onPhase: (phase: "saving" | "cleaning") => void;
}

export type PrepareDictation = (
  sessionId: string,
  transcript: string,
  options: DictationCompletionOptions,
) => Promise<PreparedDictation>;

/** Existing source provenance keeps recovery durable without a parallel note schema. */
export function dictationOriginalSource(noteId: string, sessionId: string, transcript: string, now: string): Source {
  return {
    id: `${ORIGINAL_PREFIX}${sessionId}`,
    title: "Original dictation",
    kind: "audio",
    importedAt: now,
    text: transcript,
    noteIds: [noteId],
  };
}

export function isDictationOriginal(source: Source): boolean {
  return source.kind === "audio" && source.id.startsWith(ORIGINAL_PREFIX);
}

export function attachDictationOriginal(snapshot: AppSnapshot, noteId: string, source: Source): AppSnapshot {
  const note = snapshot.notes.find(candidate => candidate.id === noteId);
  if (!note || !source.noteIds.includes(noteId)) throw new Error("The dictation note is no longer available.");
  const existing = snapshot.sources.find(candidate => candidate.id === source.id);
  if (existing && (existing.text !== source.text || !existing.noteIds.includes(noteId))) {
    throw new Error("The original dictation could not be safely saved.");
  }
  if (existing && note.sourceIds.includes(source.id)) return snapshot;
  return {
    ...snapshot,
    sources: existing ? snapshot.sources : [...snapshot.sources, source],
    notes: snapshot.notes.map(candidate => candidate.id !== noteId || candidate.sourceIds.includes(source.id)
      ? candidate : { ...candidate, sourceIds: [...candidate.sourceIds, source.id] }),
    updatedAt: source.importedAt,
  };
}

/** Only literal text and three structural node types cross the provider boundary. */
export function parseDictationCleanup(value: unknown, original: string): DictationBlock[] {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "blocks") || !("blocks" in value) ||
      !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 256) {
    throw new Error("Dictation cleanup returned an invalid result.");
  }
  let size = 0;
  const blocks: DictationBlock[] = value.blocks.map((block: unknown) => {
    if (!block || typeof block !== "object" || Array.isArray(block) ||
        Object.keys(block).some(key => key !== "kind" && key !== "text") ||
        !("kind" in block) || !["paragraph", "bullet", "todo"].includes(String(block.kind)) ||
        !("text" in block) || typeof block.text !== "string" || !block.text.trim() ||
        /[\u0000-\u001f\u007f]/u.test(block.text)) {
      throw new Error("Dictation cleanup returned unsupported content.");
    }
    const text = block.text.trim();
    size += Array.from(text).length;
    return { kind: block.kind as DictationBlock["kind"], text };
  });
  const inputSize = Array.from(original).length;
  if (size > 32_000 || size > inputSize * 2 + 120 || (inputSize > 200 && size * 4 < inputSize)) {
    throw new Error("Dictation cleanup changed too much text.");
  }
  return blocks;
}

/** Archive first. Cleanup is optional and cannot prevent the original being inserted. */
export async function prepareDictation({
  transcript, aiAvailable, preserveOriginal, clean, signal, onPhase,
}: {
  transcript: string;
  aiAvailable: boolean;
  preserveOriginal: () => Promise<string>;
  clean: (signal: AbortSignal) => Promise<DictationBlock[]>;
  signal: AbortSignal;
  onPhase: DictationCompletionOptions["onPhase"];
}): Promise<PreparedDictation> {
  const original: PreparedDictation = { original: transcript, notice: "Original dictation inserted." };
  onPhase("saving");
  try {
    original.sourceId = await preserveOriginal();
  } catch {
    return { ...original, notice: "Original inserted. Saving its recovery copy failed; your text is still in the note." };
  }
  if (!aiAvailable || signal.aborted) return original;
  if (Array.from(transcript).length > MAX_DICTATION_CLEANUP_CHARS) {
    return { ...original, notice: "Original inserted. This dictation is too long for one cleanup pass." };
  }
  onPhase("cleaning");
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Dictation cleanup timed out.")), DICTATION_CLEANUP_TIMEOUT_MS);
  let abortListener: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(controller.signal.reason ?? new Error("Cleanup cancelled."));
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const blocks = await Promise.race([clean(controller.signal), aborted]);
    controller.signal.throwIfAborted();
    // Also validate custom/mock transports; this is structural, not semantic verification.
    return { ...original, blocks: parseDictationCleanup({ blocks }, transcript), notice: "Dictation cleaned up and inserted. Original saved." };
  } catch {
    return { ...original, notice: signal.aborted ? "Original dictation inserted." : "Original inserted. AI cleanup was unavailable." };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
