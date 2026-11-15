import { en } from 'chrono-node';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Note } from '../types';
import { splitMarkdownFrontmatter } from './markdown';
import { displayNoteTitle } from './noteMetadata';
import { calendarDateFromUrl, dateKey, validCalendarDate } from './calendarDate';
import { noteWork } from './tickets';
import { stableKnowledgeHash } from './spaceKnowledge';

export interface CalendarEntry {
  id: string; date: string; endDate?: string; noteId: string; noteTitle: string;
  title: string; phrase: string; kind: 'mentioned' | 'picked' | 'ticket'; referenceDate?: string;
  /** Source identity, independent of the resolved date and document offsets. */
  dismissalKey?: string;
}
interface Ast {
  type: string; checked?: boolean; value?: string; url?: string; children?: Ast[];
  position?: { start: { line: number; offset?: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm);
const cache = new WeakMap<Note, CalendarEntry[]>();
const possibleDate = /\d|\b(?:today|tomorrow|yesterday|tonight|next|last|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const skip = new Set(['code', 'inlineCode', 'html', 'image', 'blockquote']);
function prose(node: Ast, omitPicked = false): string {
  if (skip.has(node.type)) return ' ';
  if (omitPicked && node.type === 'link' && calendarDateFromUrl(node.url)) return ' ';
  return node.value ?? node.children?.map(child => prose(child, omitPicked)).join('') ?? ' ';
}

/** Yield between bounded prose windows. Home schedules this work; the editor never calls it. */
export function* recognizeNoteDates(note: Note): Generator<void, CalendarEntry[]> {
  const known = cache.get(note); if (known) return known;
  const entries: CalendarEntry[] = [];
  const reference = new Date(note.updatedAt);
  // Invalid legacy timestamps must not turn a relative phrase into a moving deadline.
  const referenceValid = Number.isFinite(reference.getTime());
  const base = { noteId: note.id, noteTitle: displayNoteTitle(note) };
  const { prefix, content } = splitMarkdownFrontmatter(note.body);
  const lineOffset = prefix.match(/\n/g)?.length ?? 0;
  const dueLines = new Set(noteWork(note).tickets.filter(t => t.dueDate).map(t => t.lineIndex));
  const blockCounts = new Map<string, number>();
  const blockSources = new WeakMap<Ast, { text: string; hash: string; occurrence: number }>();
  // Eligibility can change without changing a source occurrence. Count completed
  // and dated tasks too, so they retain their ordinal slot when not displayed.
  function* indexBlocks(node: Ast): Generator<void> {
    if (skip.has(node.type)) return;
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      const text = prose(node, true), hash = stableKnowledgeHash(`${node.type}\0${text}`);
      const occurrence = blockCounts.get(hash) ?? 0;
      blockSources.set(node, { text, hash, occurrence });
      blockCounts.set(hash, occurrence + 1);
      yield;
      return;
    }
    for (const child of node.children ?? []) yield* indexBlocks(child);
  }
  function* visit(node: Ast): Generator<void> {
    if (skip.has(node.type)) return;
    if (node.type === 'listItem' && node.checked === true) {
      // A completed parent does not complete its independently open subtasks.
      for (const child of node.children ?? []) if (child.type === 'list') yield* visit(child);
      return;
    }
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      const line = (node.position?.start.line ?? 1) - 1 + lineOffset;
      if (dueLines.has(line)) return; // A chosen due date takes precedence on that ticket.
      const title = prose(node).trim().replace(/\s+/g, ' ').slice(0, 180);
      const position = node.position?.start.offset ?? 0;
      const pickedDates = new Set<string>();
      const inferredDates = new Set<string>();
      function explicit(part: Ast) {
        if (skip.has(part.type)) return;
        const date = part.type === 'link' ? calendarDateFromUrl(part.url) : null;
        if (date) { pickedDates.add(date); entries.push({ ...base, id: `${note.id}:picked:${part.position?.start.offset ?? position}`, date, title, phrase: prose(part), kind: 'picked' }); }
        else part.children?.forEach(explicit);
      }
      explicit(node);
      const { text, hash, occurrence } = blockSources.get(node)!;
      // Adding/removing an identical block makes its ordinal ambiguous. Reset
      // that group's keys instead of transferring a dismissal to another block.
      const blockHash = stableKnowledgeHash(`${hash}\0${blockCounts.get(hash)}`);
      // Overlap carries phrases across windows; absolute match offsets deduplicate them.
      const seen = new Set<number>();
      for (let offset = 0; offset < text.length; offset += 1800) {
        const window = text.slice(offset, offset + 2048);
        if (possibleDate.test(window) && referenceValid) {
          for (const result of en.GB.parse(window, reference, { forwardDate: true })) {
            const index = offset + result.index;
            if (seen.has(index) || !(result.start.isCertain('day') || result.start.isCertain('weekday'))) continue;
            const date = dateKey(result.start.date()), endDate = result.end ? dateKey(result.end.date()) : undefined;
            if (!validCalendarDate(date) || endDate && (!validCalendarDate(endDate) || endDate < date)) continue;
            seen.add(index);
            const dateIdentity = `${date}:${endDate || date}`;
            if (inferredDates.has(dateIdentity) || pickedDates.has(date) && (!endDate || endDate === date)) continue;
            inferredDates.add(dateIdentity);
            entries.push({ ...base, id: `${note.id}:mentioned:${position}:${index}`, date, ...(endDate && endDate !== date ? { endDate } : {}),
              title, phrase: result.text, kind: 'mentioned', referenceDate: dateKey(reference), dismissalKey: `v1:${blockHash}:${occurrence}:${index}` });
          }
        }
        yield;
      }
      return;
    }
    for (const child of node.children ?? []) yield* visit(child);
  }
  const tree = parser.parse(content) as Ast;
  yield* indexBlocks(tree);
  yield* visit(tree);
  cache.set(note, entries); return entries;
}
