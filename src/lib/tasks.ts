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
  return notes.flatMap((note) => collectTasksFromNote(note, concepts));
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
