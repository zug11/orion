import { en, type ParsedResult } from 'chrono-node';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Note } from '../types';
import { splitMarkdownFrontmatter } from './markdown';
import { displayNoteTitle } from './noteMetadata';
import { calendarDateFromUrl, dateKey, localDate, validCalendarDate } from './calendarDate';
import { noteWork } from './tickets';
import { stableKnowledgeHash } from './spaceKnowledge';

export interface CalendarEntry {
  id: string; date: string; endDate?: string; noteId: string; noteTitle: string;
  title: string; phrase: string; kind: 'mentioned' | 'picked' | 'ticket'; referenceDate?: string;
  /** Source identity, independent of the resolved date and document offsets. */
  dismissalKey?: string;
  /** Exact UTF-16 Markdown range when a date can be located in the original note. */
  sourceRange?: { from: number; to: number };
}
interface Ast {
  type: string; checked?: boolean; value?: string; url?: string; children?: Ast[];
  position?: { start: { line: number; offset?: number }; end?: { offset?: number } };
}
const parser = unified().use(remarkParse).use(remarkGfm);
const cache = new WeakMap<Note, CalendarEntry[]>();
// A window with none of these cannot hold a date. Whether a phrase is found must
// not depend on an unrelated digit elsewhere in its paragraph, so every word the
// recognizer can anchor on is listed.
const possibleDate = /\d|\b(?:today|tomorrow|yesterday|tonight|next|last|this|ago|days?|weeks?|weekend|months?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const skip = new Set(['code', 'inlineCode', 'html', 'image', 'blockquote']);

const WINDOW = 2048, WINDOW_STEP = 1800;
const ORDINAL_DAY_TAG = 'orion/ordinalDay';
const recognizer = en.GB.clone();
// “Pay rent on the 15th.” resolves to the next such day on or after the note's
// saved date. A following noun (“on the 15th floor”) is not a date, so only a
// sentence boundary or a small set of connectives may follow.
recognizer.parsers.push({
  pattern: () => /\b(?:on|by|until|till|before|after|from|due)\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b(?=\s*(?:$|[.,;:!?)\]–—-]|\s(?:at|and|or|to|so|but|for|with|we|i|he|she|they|it|if|when|then|because|unless|each|every|this|next|please)\b))/i,
  extract(context, match) {
    const day = Number(match[1]);
    if (!(day >= 1 && day <= 31)) return null;
    const from = context.refDate, today = dateKey(from);
    for (let step = 0; step < 14; step += 1) {
      const candidate = new Date(from.getFullYear(), from.getMonth() + step, day, 12);
      // A month without that day overflows into the next one.
      if (candidate.getDate() !== day || dateKey(candidate) < today) continue;
      return context.createParsingComponents({ day, month: candidate.getMonth() + 1, year: candidate.getFullYear() }).addTag(ORDINAL_DAY_TAG);
    }
    return null;
  },
});

const weekdayAbbreviation = /^(?:sun|mon|tues?|wed|thur?s?|fri|sat)\.?$/i;
const dateCueBefore = /(?:^|[^\p{L}\p{N}])(?:on|by|due|until|till|before|after|from|since|starting|dated?|deadline|next|this|last|every|each)\s+$/iu;
const dayNumberAfter = /^[.,]?\s+\d{1,2}(?:st|nd|rd|th)?\b(?![:.]\d)/i;
const labelSeparatorAfter = /^\.?\s*(?::|\s[–—-]\s)/;
const labelSeparatorBefore = /(?::|\s[–—-])\s+$/;
const anchoredRelative = /^(?:in|within)\s|\s(?:ago|from now|from today|hence)$|^(?:the\s+)?day (?:after tomorrow|before yesterday)$|^(?:next|last)\s+(?:week|month|year)$|^end of /i;
const vagueQuantity = /\b(?:few|several|couple|some)\b/i;
const dayMonthOnly = /^\d{1,2}\/\d{1,2}$/;

/**
 * The recognizer reads any quantity of time as a date relative to now, any
 * weekday abbreviation as that weekday and any `a/b` as day/month. In prose
 * those are mostly durations (“lasted 45 minutes”, “the 1990s”), ordinary words
 * (“the Sun”, “they wed”) and fractions (“3/4 of the total”). Keep a result only
 * when its own wording or its immediate surroundings say it is a date.
 */
function plausibleMention(result: ParsedResult, block: string, index: number): boolean {
  const phrase = result.text.trim(), tags = result.start.tags();
  if (tags.has(ORDINAL_DAY_TAG)) return true;
  if (tags.has('casualReference/now')) return false;
  if (tags.has('result/relativeDate')) {
    // Seconds, minutes and hours never name a day; a bare “3 days” is a duration.
    if (tags.has('result/relativeDateAndTime') || vagueQuantity.test(phrase)) return false;
    return anchoredRelative.test(phrase);
  }
  const before = block.slice(Math.max(0, index - 32), index);
  const after = block.slice(index + result.text.length, index + result.text.length + 32);
  if (weekdayAbbreviation.test(phrase)) {
    if (!/^\p{Lu}/u.test(phrase)) return false;
    return dateCueBefore.test(before) || dayNumberAfter.test(after) || labelSeparatorAfter.test(after);
  }
  if (dayMonthOnly.test(phrase)) {
    if (phrase === '24/7') return false;
    return !before.trim() || dateCueBefore.test(before) || labelSeparatorBefore.test(before) || labelSeparatorAfter.test(after);
  }
  return true;
}
// A date can describe an appointment or the beginning of work. Only a deadline
// cue attached to the date assigns it to the ticket.
const deadlineCue = /\b(due(?:\s+date)?(?:\s+(?:is|on|by|for)){0,2}|deadline(?:\s+(?:is|of|on|for)){0,2}|no later than|by)\s*[:–—-]?\s*$/i;
const startAction = /\b(?:start(?:ing)?|begin(?:ning)?|commenc(?:e|ing)|kick(?:ing)? off)\b/i;

// Chrono falls back to US month/day order even in the en.GB locale,
// including on some malformed ISO dates. Check the actual written components.
function writtenDateMatches(result: ParsedResult): boolean {
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(result.text);
  if (iso) return Number(iso[2]) === result.start.get('month') && Number(iso[3]) === result.start.get('day');
  const au = /^(\d{1,2})([./-])(\d{1,2})(?:\2\d{2,4})?\b/.exec(result.text);
  return !au || Number(au[1]) === result.start.get('day') && Number(au[3]) === result.start.get('month');
}

export function statedTicketDeadline(clause: string, updatedAt: string): string | undefined {
  // Date-only references are already local calendar days. JS interprets a bare
  // ISO date as UTC and can also normalise an impossible day into the next month.
  const savedDay = updatedAt.match(/^\d{4}-\d\d-\d\d(?=T|$)/)?.[0];
  const reference = savedDay === updatedAt && validCalendarDate(savedDay) ? localDate(savedDay) : new Date(updatedAt);
  const dated = Number.isFinite(reference.valueOf()) && validCalendarDate(savedDay);
  const dates = new Set<string>();
  // Slash spelling also recognises single-digit components in short-year dates.
  const input = clause.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})\b/g, '$1/$2/$3');
  const matches = recognizer.parse(input, dated ? reference : new Date(2000, 0, 1, 12), { forwardDate: true });
  for (const [index, match] of matches.entries()) {
    // Our ordinal recognizer includes the preposition in "due the 15th".
    const offset = match.start.tags().has(ORDINAL_DAY_TAG) ? match.text.search(/the\s+\d/i) : 0;
    const prefix = clause.slice(0, match.index + offset);
    const cue = deadlineCue.exec(prefix);
    if (!cue) continue;
    const action = prefix.slice(0, cue.index).split(/[,;]|\b(?:and|but|then)\b/i).pop() ?? '';
    if (/^(?:by|no later than)$/i.test(cue[1]) && startAction.test(action)) continue;
    if (cue[1].toLowerCase() === 'by' && /\b(?:inspired|illustrated|written)\s*$/i.test(action)) continue;
    if (match.end || !(match.start.isCertain('day') || match.start.isCertain('weekday'))) continue;
    if (!plausibleMention(match, clause, match.index) || !writtenDateMatches(match)) continue;
    if (!dated && (!match.start.isCertain('year') || !/\b[1-9]\d{3}\b/.test(match.text) || match.start.tags().has('result/relativeDate'))) continue;
    if (/^(?:this|next|last)\s+(?:week|weekend|month|year)$/i.test(match.text)) continue;
    const after = match.index + match.text.length;
    const next = matches[index + 1];
    if (next && /^\s*(?:,|and|or)?\s*$/i.test(clause.slice(after, next.index))) return;
    const suffix = clause.slice(after);
    if (/^\s*(?:(?:or|to|through|until)\b|[-–—/.]\s*\d)/i.test(suffix)) return;
    const date = dateKey(match.start.date());
    if (!validCalendarDate(date)) continue;
    dates.add(date);
  }
  return dates.size === 1 ? [...dates][0] : undefined;
}
/** Voice writes must resolve the whole date phrase to one all-day date. */
export function spokenCalendarDay(phrase: string, now: Date): string | undefined {
  const text = phrase.trim().replace(/^on\s+/i, '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return validCalendarDate(text) ? text : undefined;
  const [match, extra] = recognizer.parse(text, now, { forwardDate: true });
  if (!match || extra || match.index !== 0 || match.text.length !== text.length || match.end ||
      match.start.isCertain('hour') || !(match.start.isCertain('day') || match.start.isCertain('weekday')) ||
      !writtenDateMatches(match) || /^(?:this|next|last)\s+(?:week|weekend|month|year)$/i.test(text)) return;
  const key = dateKey(match.start.date());
  return validCalendarDate(key) ? key : undefined;
}
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
  function plainDateRange(block: Ast, phrase: string): CalendarEntry['sourceRange'] {
    for (const child of block.children ?? []) {
      if (child.type !== 'text' || child.position?.start.offset === undefined || child.position?.end?.offset === undefined) continue;
      const start = prefix.length + child.position.start.offset;
      const raw = note.body.slice(start, prefix.length + child.position.end.offset);
      if (raw !== child.value) continue;
      const within = raw.indexOf(phrase);
      if (within >= 0) return { from: start + within, to: start + within + phrase.length };
    }
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
        if (date) {
          const start = part.position?.start.offset, end = part.position?.end?.offset;
          const sourceRange = start !== undefined && end !== undefined ? { from: prefix.length + start, to: prefix.length + end } : undefined;
          pickedDates.add(date);
          entries.push({ ...base, id: `${note.id}:picked:${start ?? position}`, date, title, phrase: prose(part), kind: 'picked', sourceRange });
        }
        else part.children?.forEach(explicit);
      }
      explicit(node);
      const { text, hash, occurrence } = blockSources.get(node)!;
      // Adding/removing an identical block makes its ordinal ambiguous. Reset
      // that group's keys instead of transferring a dismissal to another block.
      const blockHash = stableKnowledgeHash(`${hash}\0${blockCounts.get(hash)}`);
      // Overlap carries phrases across windows; absolute match offsets deduplicate them.
      const seen = new Set<number>();
      for (let offset = 0; offset < text.length; offset += WINDOW_STEP) {
        const window = text.slice(offset, offset + WINDOW), continues = offset + WINDOW < text.length;
        if (possibleDate.test(window) && referenceValid) {
          for (const result of recognizer.parse(window, reference, { forwardDate: true })) {
            // A phrase starting in the overlap may be cut off by this window's
            // end. The next window reads it again with its full wording.
            if (continues && result.index >= WINDOW_STEP) continue;
            const index = offset + result.index;
            if (seen.has(index) || !(result.start.isCertain('day') || result.start.isCertain('weekday'))) continue;
            if (!plausibleMention(result, text, index)) continue;
            const date = dateKey(result.start.date()), endDate = result.end ? dateKey(result.end.date()) : undefined;
            if (!validCalendarDate(date) || endDate && (!validCalendarDate(endDate) || endDate < date)) continue;
            seen.add(index);
            const dateIdentity = `${date}:${endDate || date}`;
            if (inferredDates.has(dateIdentity) || pickedDates.has(date) && (!endDate || endDate === date)) continue;
            inferredDates.add(dateIdentity);
            entries.push({ ...base, id: `${note.id}:mentioned:${position}:${index}`, date, ...(endDate && endDate !== date ? { endDate } : {}),
              // Only a literal text node can anchor a prose reschedule. Escaped
              // or compound markup stays readable without granting an edit range.
              sourceRange: plainDateRange(node, result.text),
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
