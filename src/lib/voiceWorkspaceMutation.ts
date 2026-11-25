import { nanoid } from 'nanoid';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import type { AppSnapshot, Note } from '../types';
import { slugifyTitle } from '../data/defaults';
import { calendarDateFromUrl, dateLabel, validCalendarDate } from './calendarDate';
import { chatEditableBody } from './chatEdits';
import { ticketTitleKey } from './ticketInference';
import { boardColumns, boardMarker, collectWork, noteWork, patchTicket, type NoteBoard, type Ticket } from './tickets';
import { uniqueVoiceTicket } from './voiceTicketCompletion';
import type { VoiceWorkWrite } from './voiceWorkspace';

function changed(): never {
  throw new Error('The note, ticket, or calendar entry changed before Orion could save. Repeat the request using its current name.');
}

function uniqueNote(space: AppSnapshot, id: string) {
  const notes = space.notes.filter(note => note.id === id);
  return notes.length === 1 ? notes[0] : undefined;
}

function boardMatches(space: AppSnapshot, board?: NoteBoard) {
  if (!board) return true;
  if (!uniqueNote(space, board.noteId)) return false;
  const current = collectWork(space.notes).boards.find(item => item.id === board.id);
  return current?.noteId === board.noteId && boardMarker(current) === boardMarker(board);
}

function newStorageNote(title: string): Note {
  const id = `note-${nanoid(10)}`, now = new Date().toISOString();
  return { id, title, slug: slugifyTitle(title) || id, body: '', summary: '', tags: [], aliases: [],
    kind: 'article', status: 'ready', sourceIds: [], conceptIds: [], createdAt: now, updatedAt: now };
}

function appendBeforeFooters(note: Note, markdown: string) {
  const { prefix, body, suffix } = chatEditableBody(note.body);
  const newline = note.body.includes('\r\n') ? '\r\n' : '\n';
  const separator = !body || body.endsWith(newline + newline) ? '' : body.endsWith(newline) ? newline : newline + newline;
  const beforeSuffix = suffix && !suffix.startsWith(newline) ? newline + newline : '';
  return prefix + body + separator + markdown + beforeSuffix + suffix;
}

type Receipt = (space: AppSnapshot, note: Note) => boolean;

function ticketReceipt(expected: Ticket): Receipt {
  return space => {
    const found = uniqueVoiceTicket(space, expected);
    return !!found && found.title === expected.title && found.status === expected.status &&
      found.boardId === expected.boardId && found.dueDate === expected.dueDate &&
      found.urgency === expected.urgency && found.origin === expected.origin;
  };
}

const parser = unified().use(remarkParse).use(remarkGfm);
type MarkdownNode = Root | RootContent;
interface DateOccurrence { day: string; block: string; from: number; to: number }

function visibleText(node: MarkdownNode): string {
  if (node.type === 'html') return '';
  if ('value' in node) return node.value;
  return 'children' in node ? node.children.map(visibleText).join('') : '';
}

// Compare the authored date, label and surrounding block across Markdown serialization.
// A matching URL elsewhere, or a literal example in code, cannot acknowledge the write.
function pickedDates(markdown: string): DateOccurrence[] {
  const { prefix, body } = chatEditableBody(markdown);
  const result: DateOccurrence[] = [];
  function visit(node: MarkdownNode, block = '') {
    if (node.type === 'blockquote') return;
    if (node.type === 'listItem' && node.checked === true) {
      for (const child of node.children) if (child.type === 'list') visit(child);
      return;
    }
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      block = visibleText(node).replace(/\s+/g, ' ').trim();
    }
    if (node.type === 'link' && node.position) {
      const day = calendarDateFromUrl(node.url), { start, end } = node.position;
      if (day && start.offset !== undefined && end.offset !== undefined)
        result.push({ day, block, from: prefix.length + start.offset, to: prefix.length + end.offset });
    } else if ('children' in node) node.children.forEach(child => visit(child, block));
  }
  visit(parser.parse(body));
  return result;
}

function calendarReceipt(body: string, from: number, date: string, original?: DateOccurrence): Receipt {
  const entries = pickedDates(body);
  const expected = entries.find(entry => entry.from === from && entry.day === date);
  if (!expected) changed();
  const count = (entries: DateOccurrence[], target: DateOccurrence) =>
    entries.filter(entry => entry.day === target.day && entry.block === target.block).length;
  const required = count(entries, expected);
  const oldCount = original && count(entries, original);
  return (_space, actual) => {
    if (actual.body === body) return true;
    const saved = pickedDates(actual.body);
    return count(saved, expected) === required && (!original || count(saved, original) === oldCount);
  };
}

export function prepareVoiceWorkWrite(space: AppSnapshot, action: VoiceWorkWrite) {
  const board = action.kind === 'moveDate' ? undefined : action.board;
  if (space.workspace.id !== action.spaceId || !boardMatches(space, board)) changed();
  const captured = action.kind === 'patchTicket' ? undefined : action.note;
  const targetId = action.kind === 'patchTicket' ? action.ticket.noteId : captured?.id;
  const newTitle = action.kind === 'append' ? action.newNoteTitle : undefined;
  const creating = !targetId;
  if ((creating && !newTitle) || (!creating && newTitle)) changed();
  const sameName = (note: Note) => ticketTitleKey(note.title) === ticketTitleKey(newTitle ?? '');
  if (creating && (!newTitle?.trim() || space.notes.some(sameName))) changed();
  const note = (targetId ? uniqueNote(space, targetId) : newStorageNote(newTitle!)) ?? changed();
  if (creating && space.notes.some(item => item.id === note.id)) changed();
  if (captured && (captured.body !== note.body || captured.title !== note.title)) changed();

  let body: string;
  let receipt: Receipt;
  if (action.kind === 'patchTicket') {
    const { ticket, patch } = action;
    if (!Object.keys(patch).length || Object.keys(patch).some(key => !['status', 'boardId', 'dueDate'].includes(key))) changed();
    const live = uniqueVoiceTicket(space, ticket);
    if (!live || !ticket.rawBlock || ticket.rawBlock !== live.rawBlock || ticket.rawLine !== live.rawLine) changed();
    if (patch.boardId && patch.boardId !== board?.id) changed();
    if (patch.status?.startsWith('column-') &&
        (!board || !boardColumns(board).some(([column]) => column === patch.status))) changed();
    const patched = patchTicket(note.body, live, patch);
    if (patched === null) changed();
    body = patched;
    const expected = noteWork({ ...note, body }).tickets.find(item => item.id === ticket.id);
    if (!expected) changed();
    receipt = ticketReceipt(expected);
  } else if (action.kind === 'moveDate') {
    const { from, to, original, replacement, oldDate, newDate } = action;
    if (!validCalendarDate(oldDate) || !validCalendarDate(newDate) || !original ||
        note.body.slice(from, to) !== original || replacement !== `[${dateLabel(newDate)}](orion-date://${newDate})`) changed();
    const previous = pickedDates(note.body).find(item => item.from === from && item.to === to && item.day === oldDate);
    if (!previous) changed();
    body = note.body.slice(0, from) + replacement + note.body.slice(to);
    receipt = calendarReceipt(body, from, newDate, previous);
  } else {
    const { markdown } = action;
    if (!markdown.trim() || /[\r\n]/.test(markdown)) changed();
    body = appendBeforeFooters(note, markdown);
    const [ticket] = noteWork({ ...note, body: markdown }).tickets;
    if (ticket?.durable) {
      if (ticket.boardId !== (board?.id ?? '') || space.notes.some(n => noteWork(n).ticketIdCounts.has(ticket.id))) changed();
      if (!noteWork({ ...note, body }).tickets.some(t => t.durable && t.id === ticket.id)) changed();
      receipt = ticketReceipt(ticket);
    } else {
      const [date] = pickedDates(markdown);
      if (board || !date) changed();
      const addedAt = body.length - chatEditableBody(body).suffix.length - markdown.length;
      receipt = calendarReceipt(body, addedAt + date.from, date.day);
    }
  }

  function verify(saved: AppSnapshot) {
    if (saved.workspace.id !== action.spaceId || !boardMatches(saved, board)) return false;
    const persisted = uniqueNote(saved, note.id);
    if (!persisted || (creating && (!sameName(persisted) || saved.notes.filter(sameName).length !== 1))) return false;
    return receipt(saved, persisted);
  }
  return { note, body, creating, verify };
}
