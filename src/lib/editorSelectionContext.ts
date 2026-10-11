import type { Note } from "../types";
import { spaceNoteVersion } from "./spaceKnowledge";
import type { TextRange } from "./taskWorkingView";

export const EDITOR_CONTEXT_MAX_CHARS = 12_000;
export const EDITOR_CONTEXT_MAX_FRAGMENTS = 128;
export type EditorContextReason = "flow" | "preview" | "not-ready" | "stale-document" | "invalid-range" | "completed-task";
export interface EditorCaptureState {
  available: boolean;
  reason?: "flow" | "preview" | "not-ready";
  cursor?: { position: number; unit: "prosemirror-position" };
}
export interface EditorSelectionOptions { state: () => EditorCaptureState }
export interface EditorContextIdentity { spaceId: string; noteId: string; documentVersion: string }
export interface EditorContextRange { coordinateSystem: "dom-text-utf16" | "prosemirror-position"; from: number; to: number }
export type EditorSelectionSnapshot =
  | (Partial<EditorContextIdentity> & { state: "none" | "pending" | "unavailable"; reason?: EditorContextReason })
  | (EditorContextIdentity & { state: "cursor"; selection: EditorContextRange; hiddenTask?: boolean })
  | (EditorContextIdentity & { state: "selected"; selection: EditorContextRange & { coordinateSystem: "dom-text-utf16" }; text: string; hiddenTaskRanges: readonly TextRange[] });
export interface EditorContextReference {
  state: EditorSelectionSnapshot["state"];
  documentVersion?: string;
  selection?: EditorContextRange;
  fragments: { text: string; from: number; to: number }[];
  truncated: boolean;
  omittedChars: number;
  completedTasksOmitted: boolean;
  completedTaskChars: number;
  reason?: EditorContextReason;
}
export function editorDocumentVersion(note: Note) { return `displayed-v1:${spaceNoteVersion(note)}`; }
export function editorContextIdentity(note: Note, spaceId: string): EditorContextIdentity {
  return { spaceId, noteId: note.id, documentVersion: editorDocumentVersion(note) };
}
const scalarCount = (value: string) => { let count = 0; for (const _character of value) count++; return count; };
const scalarBoundary = (text: string, offset: number) => offset === 0 || offset === text.length ||
  !(text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff && text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff);
const validOffset = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** The only external projection. Full selected text and hidden task ranges stay
 * local. No surrounding prose, Markdown offsets, write version or authority. */
export function editorSelectionReference(value: EditorSelectionSnapshot, options: { taskView: "working" | "history"; maxChars: number }, currentNote?: Note): EditorContextReference {
  if ((options.taskView !== "working" && options.taskView !== "history") || !Number.isInteger(options.maxChars) || options.maxChars < 1 || options.maxChars > EDITOR_CONTEXT_MAX_CHARS) {
    throw new Error("Editor context requires an explicit working/history view and maxChars from 1 to 12000.");
  }
  const result: EditorContextReference = { state: value.state, ...(value.documentVersion ? { documentVersion: value.documentVersion } : {}),
    fragments: [], truncated: false, omittedChars: 0, completedTasksOmitted: false, completedTaskChars: 0 };
  const unavailable = (reason: EditorContextReason): EditorContextReference => ({ ...result, state: "unavailable", reason });
  if (value.noteId && (!currentNote || currentNote.id !== value.noteId || editorDocumentVersion(currentNote) !== value.documentVersion)) return unavailable("stale-document");
  if (value.state !== "selected" && value.state !== "cursor") {
    if (value.reason) result.reason = value.reason;
    return result;
  }
  const range = value.selection;
  if (!validOffset(range.from) || !validOffset(range.to) || range.to < range.from) return unavailable("invalid-range");
  if (value.state === "cursor") {
    if (range.from !== range.to || !["dom-text-utf16", "prosemirror-position"].includes(range.coordinateSystem)) return unavailable("invalid-range");
    if (value.hiddenTask && options.taskView === "working") return { ...unavailable("completed-task"), completedTasksOmitted: true };
    return { ...result, selection: { ...range } };
  }
  if (range.coordinateSystem !== "dom-text-utf16" || range.from === range.to || value.text.length !== range.to - range.from ||
      [...value.text].some(character => { const code = character.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })) return unavailable("invalid-range");
  const hidden: TextRange[] = [];
  for (const candidate of [...value.hiddenTaskRanges].sort((a, b) => a.start - b.start)) {
    if (!validOffset(candidate.start) || !validOffset(candidate.end) || candidate.start >= candidate.end || candidate.end > value.text.length ||
        !scalarBoundary(value.text, candidate.start) || !scalarBoundary(value.text, candidate.end)) return unavailable("invalid-range");
    const previous = hidden[hidden.length - 1];
    if (previous && candidate.start <= previous.end) previous.end = Math.max(previous.end, candidate.end);
    else hidden.push({ ...candidate });
  }
  const omitted = options.taskView === "working" ? hidden : [];
  result.completedTaskChars = omitted.reduce((count, segment) => count + scalarCount(value.text.slice(segment.start, segment.end)), 0);
  result.completedTasksOmitted = omitted.length > 0;
  result.selection = { ...range };
  let returnedChars = 0, cursor = 0;
  const append = (from: number, to: number) => {
    if (from >= to || returnedChars >= options.maxChars || result.fragments.length >= EDITOR_CONTEXT_MAX_FRAGMENTS) return;
    let text = "";
    for (const character of value.text.slice(from, to)) {
      if (returnedChars === options.maxChars) break;
      text += character; returnedChars++;
    }
    if (text) result.fragments.push({ text, from: range.from + from, to: range.from + from + text.length });
  };
  for (const segment of omitted) { append(cursor, segment.start); cursor = segment.end; }
  append(cursor, value.text.length);
  const total = scalarCount(value.text);
  result.omittedChars = total - returnedChars;
  result.truncated = returnedChars < total - result.completedTaskChars;
  return result;
}
