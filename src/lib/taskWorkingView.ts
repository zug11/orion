import type { AppSnapshot } from "../types";

export type TaskView = "working" | "history";
export interface TextRange { start: number; end: number }

/** Completed actions and their continuation text, never standalone decisions or code examples. */
export function completedTaskRanges(body: string): TextRange[] {
  const lines = body.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const ranges: TextRange[] = [];
  let offset = 0, fence = "", fenceWidth = 0, activeIndent: number | undefined, blank = false;
  const frontEnd = lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && ["---", "..."].includes(line.trim())) : -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index], text = line.replace(/[\r\n]+$/, ""), trimmed = text.trimStart();
    const indent = text.length - trimmed.length;
    let hide = false;
    if (index > frontEnd) {
      const marker = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
      const inFence = Boolean(fence);
      if (indent <= 3 && marker) {
        if (fence && marker[1][0] === fence && marker[1].length >= fenceWidth && !marker[2].trim()) fence = "";
        else if (!fence && (marker[1][0] !== "`" || !marker[2].includes("`"))) { fence = marker[1][0]; fenceWidth = marker[1].length; }
      }
      const task = !inFence && !marker && trimmed.match(/^[-+*][ \t]+\[([ xX])\][ \t]+\S/);
      if (task) { activeIndent = task[1] === " " ? undefined : indent; hide = activeIndent !== undefined; blank = false; }
      else if (activeIndent !== undefined) {
        if (!trimmed) blank = true;
        else if (indent > activeIndent || (!blank && !/^(?:#{1,6}\s|[-+*]\s|<!--)/.test(trimmed))) hide = true;
        else activeIndent = undefined;
      }
    }
    if (hide) {
      const end = offset + text.length;
      if (end > offset) ranges.push({ start: offset, end });
    }
    offset += line.length;
  }
  return ranges;
}

/** UTF-16 offsets and original line numbers survive. Masking occurs before model context is built. */
export function workingTaskText(body: string): string {
  const ranges = completedTaskRanges(body);
  if (!ranges.length) return body;
  let result = "", offset = 0;
  for (const range of ranges) { result += body.slice(offset, range.start) + " ".repeat(range.end - range.start); offset = range.end; }
  return result + body.slice(offset);
}

/** Split filtered reads into verbatim original passages for citations and guarded edits. */
export function visibleTaskPassages(body: string, passages: TextRange[]): Array<TextRange & { text: string }> {
  const omissions = completedTaskRanges(body);
  return passages.flatMap(passage => {
    let cursor = passage.start;
    const visible: TextRange[] = [];
    for (const range of omissions) {
      if (range.end <= cursor || range.start >= passage.end) continue;
      if (range.start > cursor) visible.push({ start: cursor, end: range.start });
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < passage.end) visible.push({ start: cursor, end: passage.end });
    return visible.map(range => ({ ...range, text: body.slice(range.start, range.end) })).filter(part => part.text.trim());
  });
}

/** Drop cached derivatives that may still describe completed work; rebuild discovery locally. */
export function workingTaskSnapshot(snapshot: AppSnapshot): AppSnapshot {
  const notes = snapshot.notes.map(note => ({ ...note, body: workingTaskText(note.body) }));
  const sources = snapshot.sources.map(source => ({ ...source, text: workingTaskText(source.text) }));
  if (notes.every((note, index) => note.body === snapshot.notes[index].body) && sources.every((source, index) => source.text === snapshot.sources[index].text)) return snapshot;
  return { ...snapshot, notes: notes.map(note => ({ ...note, summary: "" })), sources,
    concepts: snapshot.concepts.map(concept => ({ ...concept, description: "" })),
    relationships: snapshot.relationships.map(relation => ({ ...relation, context: undefined })),
    spaceOverview: undefined, spaceKnowledge: undefined };
}

/** Only the user's current request can broaden ordinary reading to completed-work history. */
export function requestedTaskView(prompt: string): TaskView {
  if (/\b(?:do not|don.t|never|exclude|ignore|hide|omit|without|skip)\b[^.!?\n]{0,120}\b(?:completed|finished|closed|done)\b/i.test(prompt)) return "working";
  return /\b(?:completed|finished|closed|done)\s+(?:tasks?|to-?dos?|work|items?|history)\b|\b(?:audit|history|regression)\s+(?:of|for|about)\s+(?:completed|finished|closed)\b/i.test(prompt) ? "history" : "working";
}
