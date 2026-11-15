import type { AppSnapshot, Source } from "../types";
import { validCalendarDate } from "./calendarDate";
import type { NoteBoard, TicketUrgency } from "./tickets";

export interface DictationBlock {
  kind: "paragraph" | "bullet" | "todo";
  text: string;
}

/** Provider describes new content only; the editor owns all IDs and insertion. */
export interface DictationTicketBlock {
  kind: "ticket";
  text: string;
  evidence: string;
  boardName: string;
  dueDate: string;
  urgency: TicketUrgency;
}

export interface DictationProposal {
  blocks: Array<DictationBlock | DictationTicketBlock | DictationKanbanBlock | DictationTableBlock>;
}

export type DictationBoardTicket = Omit<DictationTicketBlock, "kind" | "boardName">;
export interface DictationKanbanBlock {
  kind: "kanban";
  text: string;
  evidence: string;
  tickets: DictationBoardTicket[];
}
export interface DictationTableBlock {
  kind: "table";
  text: string;
  evidence: string;
  columns: string[];
  rows: string[][];
}

export interface DictationCleanupResult {
  /** Faithful fallback, including spoken instruction words. */
  blocks: DictationBlock[];
  proposal?: DictationProposal | null;
}

export const MAX_DICTATION_CLEANUP_CHARS = 24_000;
export const DICTATION_CLEANUP_TIMEOUT_MS = 45_000;
export const MAX_DICTATION_PROPOSAL_TICKETS = 32;
export const MAX_DICTATION_BOARDS = 4;
export const MAX_DICTATION_TABLES = 4;
export const MAX_DICTATION_TABLE_ROWS = 20;
export const MAX_DICTATION_TABLE_COLUMNS = 12;
export const MAX_DICTATION_CELL_CHARS = 500;
const MAX_DICTATION_BLOCKS = 256;
const MAX_DICTATION_OUTPUT_CHARS = 32_000;
const ORIGINAL_PREFIX = "source-dictation-";

export interface PreparedDictation {
  original: string;
  blocks?: DictationBlock[];
  proposal?: DictationProposal;
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

function parseLiteralBlock(block: unknown): DictationBlock {
  if (!block || typeof block !== "object" || Array.isArray(block) ||
        Object.keys(block).some(key => key !== "kind" && key !== "text") ||
        !("kind" in block) || typeof block.kind !== "string" || !["paragraph", "bullet", "todo"].includes(block.kind) ||
        !("text" in block) || typeof block.text !== "string" || !block.text.trim() ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(block.text)) {
    throw new Error("Dictation cleanup returned unsupported content.");
  }
  return { kind: block.kind as DictationBlock["kind"], text: block.text.trim() };
}

/** Only literal text and three structural node types cross the provider boundary. */
export function parseDictationCleanup(value: unknown, original: string): DictationBlock[] {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "blocks") || !("blocks" in value) ||
      !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > MAX_DICTATION_BLOCKS) {
    throw new Error("Dictation cleanup returned an invalid result.");
  }
  const blocks = value.blocks.map(parseLiteralBlock);
  const size = blocks.reduce((sum, block) => sum + Array.from(block.text).length, 0);
  const inputSize = Array.from(original).length;
  if (size > MAX_DICTATION_OUTPUT_CHARS || size > inputSize * 2 + 120 || (inputSize > 200 && size * 4 < inputSize)) {
    throw new Error("Dictation cleanup changed too much text.");
  }
  return blocks;
}

/** Faithful cleanup is required; optional formatting cannot discard valid prose. */
export function parseDictationResult(value: unknown, original: string): DictationCleanupResult {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => key !== "blocks" && key !== "proposal") || !("blocks" in value)) {
    throw new Error("Dictation cleanup returned an invalid result.");
  }
  const blocks = parseDictationCleanup({ blocks: value.blocks }, original);
  if (!("proposal" in value) || value.proposal === undefined) return { blocks };
  if (value.proposal === null) return { blocks, proposal: null };
  try {
    return { blocks, proposal: parseDictationProposal(value.proposal, original) };
  } catch {
    // Discard the entire proposal, never individual fields or spans. The faithful
    // alternative above is independently complete and keeps the spoken commands.
    // This cannot repair invalid faithful text, infer missing data, or add authority.
    return { blocks, proposal: null };
  }
}

/** Shared validation for IPC and insertion. No IDs, markup, or edit targets. */
export function parseDictationProposal(proposal: unknown, original: string): DictationProposal {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal) ||
      Object.keys(proposal).some(key => key !== "blocks") || !("blocks" in proposal) ||
      !Array.isArray(proposal.blocks) || !proposal.blocks.length || proposal.blocks.length > MAX_DICTATION_BLOCKS) {
    throw new Error("Dictation cleanup returned an invalid proposal.");
  }
  let tickets = 0;
  let boards = 0;
  let tables = 0;
  let size = 0;
  const invalid = () => new Error("Dictation cleanup returned invalid structured content.");
  function record(value: unknown, fields: string[]): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== fields.length || fields.some(field => !(field in value))) throw invalid();
    return value as Record<string, unknown>;
  }
  function literal(value: unknown, max: number, empty = false): string {
    if (typeof value !== "string" || (!empty && !value.trim()) || Array.from(value.trim()).length > max ||
        /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw invalid();
    return value.trim();
  }
  function evidence(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || Array.from(value.trim()).length > 2_000 ||
        /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || !original.includes(value.trim())) throw invalid();
    return value.trim();
  }
  function ticket(value: Record<string, unknown>): DictationBoardTicket {
    const text = literal(value.text, 140), quote = evidence(value.evidence), dueDate = literal(value.dueDate, 10, true);
    if (dueDate && !validCalendarDate(dueDate) || !["", "urgent", "high", "medium", "low"].includes(value.urgency as string)) throw invalid();
    tickets += 1;
    size += Array.from(text).length;
    return { text, evidence: quote, dueDate, urgency: value.urgency as TicketUrgency };
  }
  const proposalBlocks: DictationProposal["blocks"] = proposal.blocks.map((block: unknown) => {
    if (!block || typeof block !== "object" || Array.isArray(block) || !("kind" in block)) {
      throw new Error("Dictation cleanup returned unsupported content.");
    }
    if (block.kind === "kanban") {
      const value = record(block, ["kind", "text", "evidence", "tickets"]);
      const text = literal(value.text, 140), quote = evidence(value.evidence);
      if (!Array.isArray(value.tickets) || value.tickets.length > MAX_DICTATION_PROPOSAL_TICKETS) throw invalid();
      boards += 1; size += Array.from(text).length;
      return { kind: "kanban", text, evidence: quote, tickets: value.tickets.map(item =>
        ticket(record(item, ["text", "evidence", "dueDate", "urgency"]))) };
    }
    if (block.kind === "table") {
      const value = record(block, ["kind", "text", "evidence", "columns", "rows"]);
      const text = literal(value.text, 140, true), quote = evidence(value.evidence);
      if (!Array.isArray(value.columns) || !value.columns.length || value.columns.length > MAX_DICTATION_TABLE_COLUMNS ||
          !Array.isArray(value.rows) || !value.rows.length || value.rows.length > MAX_DICTATION_TABLE_ROWS) throw invalid();
      const columns = value.columns.map(cell => literal(cell, MAX_DICTATION_CELL_CHARS));
      const rows = value.rows.map(row => {
        if (!Array.isArray(row) || row.length !== columns.length) throw invalid();
        return row.map(cell => literal(cell, MAX_DICTATION_CELL_CHARS, true));
      });
      tables += 1; size += Array.from(text + columns.join("") + rows.flat().join("")).length;
      return { kind: "table", text, evidence: quote, columns, rows };
    }
    if (block.kind !== "ticket") {
      // An individual prose block needs structural validation, not a loss check
      // against the entire recording. The complete variant is bounded below.
      const parsed = parseLiteralBlock(block);
      size += Array.from(parsed.text).length;
      return parsed;
    }
    const value = record(block, ["kind", "text", "evidence", "boardName", "dueDate", "urgency"]);
    return { kind: "ticket", ...ticket(value), boardName: literal(value.boardName, 140, true) };
  });
  // Instructions can legitimately shrink into short ticket titles. The faithful
  // text above retains the loss guard, while proposals need only an upper bound.
  if (!(tickets || boards || tables) || tickets > MAX_DICTATION_PROPOSAL_TICKETS || boards > MAX_DICTATION_BOARDS ||
      tables > MAX_DICTATION_TABLES || size > MAX_DICTATION_OUTPUT_CHARS || size > Array.from(original).length * 2 + 120) {
    throw new Error("Dictation cleanup returned an invalid proposal.");
  }
  return { blocks: proposalBlocks };
}

/** Resolve only an exact, unambiguous label among this Space's supplied boards. */
export function resolveDictationBoard(boardName: string, boards: readonly Pick<NoteBoard, "id" | "title">[]): string {
  const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();
  const name = normalize(boardName);
  if (!name) return "";
  const matches = boards.filter(board => normalize(board.title) === name);
  if (matches.length !== 1 || boards.filter(board => board.id === matches[0].id).length !== 1) return "";
  return matches[0].id;
}

/** Archive first. Cleanup is optional and cannot prevent the original being inserted. */
/**
 * A finished dictation could not be inserted because its note or cursor is no
 * longer there. `sourceId` is set when the original was archived to Sources.
 */
export class DictationNotInsertedError extends Error {
  constructor(message: string, readonly sourceId?: string) {
    super(message);
    this.name = "DictationNotInsertedError";
  }
}

export async function prepareDictation({
  transcript, aiAvailable, preserveOriginal, clean, signal, onPhase,
}: {
  transcript: string;
  aiAvailable: boolean;
  preserveOriginal: () => Promise<string>;
  clean: (signal: AbortSignal) => Promise<DictationBlock[] | DictationCleanupResult>;
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
  if (signal.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("Dictation cleanup timed out.")), DICTATION_CLEANUP_TIMEOUT_MS);
  let abortListener: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      abortListener = () => reject(controller.signal.reason ?? new Error("Cleanup cancelled."));
      controller.signal.addEventListener("abort", abortListener, { once: true });
      if (controller.signal.aborted) abortListener();
    });
    const result = await Promise.race([clean(controller.signal), aborted]);
    controller.signal.throwIfAborted();
    // Also validate custom/mock transports; this is structural, not semantic verification.
    const parsed = parseDictationResult(Array.isArray(result) ? { blocks: result } : result, transcript);
    return { ...original, blocks: parsed.blocks, ...(parsed.proposal ? { proposal: parsed.proposal } : {}),
      notice: "Dictation cleaned up and inserted. Original saved." };
  } catch {
    return { ...original, notice: signal.aborted ? "Original dictation inserted." : "Original inserted. AI cleanup was unavailable." };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
