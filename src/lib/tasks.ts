import type { Concept, EntityId, Note } from "../types";
import { splitMarkdownFrontmatter } from "./markdown";
import { decorateAutoLinks } from "./wiki";

export interface NoteTask {
  id: string;
  noteId: EntityId;
  noteTitle: string;
  lineIndex: number;
  text: string;
  checked: boolean;
  conceptId?: EntityId;
  conceptLabel?: string;
}

const TASK_LINE = /^(\s*[-+*]\s+\[)([ xX])(\]\s+)(.+?)\s*$/;
const CONCEPT_LINK = /\[[^\]\n]*\]\(orion-concept:\/\/([^)]+)\)/g;
const NOTE_LINK = /\[[^\]\n]*\]\(orion-note:\/\/([^)]+)\)/g;

export function collectNoteTasks(
  notes: readonly Note[],
  concepts: readonly Concept[],
): NoteTask[] {
  const collected = notes.flatMap((note) =>
    collectTasksFromNote(note, concepts).map((task) => ({
      note,
      task,
      fingerprint: taskFingerprint(task.text),
    })),
  );
  const deduplicated: typeof collected = [];

  for (const candidate of collected) {
    const duplicateIndex = deduplicated.findIndex(
      (existing) =>
        existing.fingerprint === candidate.fingerprint &&
        sharesTaskDerivation(existing.note, candidate.note),
    );
    if (duplicateIndex < 0) {
      deduplicated.push(candidate);
      continue;
    }

    if (
      taskAuthority(candidate.note) >
      taskAuthority(deduplicated[duplicateIndex].note)
    ) {
      deduplicated[duplicateIndex] = candidate;
    }
  }

  return deduplicated.map(({ task }) => task);
}

export function collectTasksFromNote(
  note: Note,
  concepts: readonly Concept[],
): NoteTask[] {
  const { content, prefix } = splitMarkdownFrontmatter(note.body);
  const lines = content.split(/\r?\n/);
  const lineOffset = prefix.match(/\n/g)?.length ?? 0;
  const tasks: NoteTask[] = [];
  let inFence = false;

  lines.forEach((line, lineIndex) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const match = line.match(TASK_LINE);
    if (!match) return;
    const rawText = match[4];
    const concept = taskConcept(rawText, note, concepts);
    tasks.push({
      id: `${note.id}:${lineIndex + lineOffset}`,
      noteId: note.id,
      noteTitle: note.title,
      lineIndex: lineIndex + lineOffset,
      text: readableTaskText(rawText),
      checked: match[2].toLocaleLowerCase() === "x",
      ...(concept
        ? { conceptId: concept.id, conceptLabel: concept.label }
        : {}),
    });
  });

  return tasks;
}

export function setTaskChecked(
  markdown: string,
  lineIndex: number,
  checked: boolean,
): string {
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const line = lines[lineIndex];
  const match = line?.match(TASK_LINE);
  if (!match) return markdown;
  lines[lineIndex] = `${match[1]}${checked ? "x" : " "}${match[3]}${match[4]}`;
  return lines.join(newline);
}

function taskConcept(
  rawText: string,
  note: Note,
  concepts: readonly Concept[],
): Concept | undefined {
  for (const match of rawText.matchAll(CONCEPT_LINK)) {
    const concept = concepts.find((candidate) => candidate.id === match[1]);
    if (concept) return concept;
  }
  for (const match of rawText.matchAll(NOTE_LINK)) {
    const concept = concepts.find(
      (candidate) => candidate.canonicalNoteId === match[1],
    );
    if (concept) return concept;
  }

  const visible = readableTaskText(rawText);
  const semanticMatch = decorateAutoLinks(visible, concepts)
    .filter((segment) => segment.type === "concept")
    .sort((left, right) => right.text.length - left.text.length)[0];
  if (semanticMatch?.type === "concept") {
    return concepts.find(
      (candidate) => candidate.id === semanticMatch.conceptId,
    );
  }

  const noteConcepts = concepts.filter((concept) =>
    note.conceptIds.includes(concept.id),
  );
  return (
    noteConcepts.find((concept) => concept.canonicalNoteId === note.id) ??
    (noteConcepts.length === 1 ? noteConcepts[0] : undefined)
  );
}

function readableTaskText(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function taskFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Exact task text is not enough to establish identity: the same recurring task
 * can be intentionally present in unrelated notes. Shared source provenance is
 * a reliable derivation signal. A compatibility `wiki` note is also derivative
 * by design and must not surface a copied project task as a second Home item.
 */
function sharesTaskDerivation(left: Note, right: Note): boolean {
  if (left.id === right.id) {
    return false;
  }
  if (left.kind === "wiki" || right.kind === "wiki") {
    return true;
  }
  if (left.sourceIds.length === 0 || right.sourceIds.length === 0) {
    return false;
  }
  const leftSources = new Set(left.sourceIds);
  return right.sourceIds.some((sourceId) => leftSources.has(sourceId));
}

function taskAuthority(note: Note): number {
  return Number(note.kind !== "wiki");
}
