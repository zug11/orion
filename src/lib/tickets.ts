import { validCalendarDate } from './calendarDate';
import { nanoid } from 'nanoid';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { sharesTaskDerivation } from './tasks';
import type { Note } from '../types';
import { splitMarkdownFrontmatter } from './markdown';
import { displayNoteTitle } from './noteMetadata';
import { changeTicketBlock, type TicketDetailChange } from './ticketDetails';

export type TicketStatus = 'todo' | 'progress' | 'done' | `column-${string}`;
export const validTicketStatus = (value: unknown): value is TicketStatus => typeof value === 'string' && (/^(todo|progress|done)$/.test(value) || /^column-[a-zA-Z0-9_-]{1,80}$/.test(value));
export interface BoardColumn { id: TicketStatus; title: string }
export type BoardChange = {kind:'title'; title:string} | {kind:'addColumn'; title:string} | {kind:'columnTitle'; id:TicketStatus; title:string};
export const TICKET_URGENCIES = ['urgent', 'high', 'medium', 'low'] as const;
export type TicketUrgency = typeof TICKET_URGENCIES[number] | '';
export const validTicketUrgency = (value: unknown): value is TicketUrgency => value === '' || TICKET_URGENCIES.includes(value as never);
export interface TicketMeta { id: string; status: TicketStatus; boardId: string; dueDate?: string; origin?: 'board'; urgency?: TicketUrgency }
export interface NoteBoard { id: string; title: string; noteId: string; columns?: BoardColumn[] }
export interface Ticket extends TicketMeta { noteId: string; noteTitle: string; title: string; lineIndex: number; rawLine: string; rawBlock?: string; durable: boolean; markerStart?: number }
export type TicketPatch = Partial<Pick<TicketMeta, 'status' | 'boardId' | 'dueDate' | 'urgency'>> & { detail?: TicketDetailChange };
export const TICKET_STATUSES: readonly [TicketStatus, string][] = [['todo', 'To do'], ['progress', 'In progress'], ['done', 'Done']];
const ID = /^[a-zA-Z0-9_-]{1,96}$/;
const TASK = /^(\s*[-+*]\s+\[)([ xX])(\]\s+)(.*)$/;
const TICKET = /<!-- orion-ticket:v1 ([\w-]{1,96}) (todo|progress|done|column-[a-zA-Z0-9_-]{1,80}) ([\w-]{1,96}|-)(?: due=(\d{4}-\d{2}-\d{2}))?(?: (origin=board))?(?: urgency=(urgent|high|medium|low))? -->/;
const BOARD = /^<!-- orion-kanban:v1 ([\w-]{1,96}) ([^\s<>]{1,1800})(?: columns=([^\s<>]{1,30000}))? -->$/;
export const newTicketId = () => `ticket-${nanoid(16)}`;
export const newBoardId = () => `board-${nanoid(16)}`;
export function parseTicketMarker(value: string): TicketMeta | null {
  const m = value.match(TICKET);
  return m && m[0] === value && (!m[4] || validCalendarDate(m[4])) ? { id: m[1], status: m[2] as TicketStatus, boardId: m[3] === '-' ? '' : m[3], ...(m[4] ? { dueDate: m[4] } : {}), ...(m[5] ? { origin: 'board' as const } : {}), ...(m[6] ? { urgency: m[6] as TicketUrgency } : {}) } : null;
}
export function ticketMarker(meta: TicketMeta): string {
  if (meta.urgency !== undefined && !validTicketUrgency(meta.urgency)) return '';
  if (meta.dueDate && !validCalendarDate(meta.dueDate) || !ID.test(meta.id) || meta.boardId && !ID.test(meta.boardId) || !validTicketStatus(meta.status)) return '';
  return `<!-- orion-ticket:v1 ${meta.id} ${meta.status} ${meta.boardId || '-'}${meta.dueDate ? ` due=${meta.dueDate}` : ''}${meta.origin === 'board' ? ' origin=board' : ''}${meta.urgency ? ` urgency=${meta.urgency}` : ''} -->`;
}
export function parseBoardMarker(value: string): Omit<NoteBoard, 'noteId'> | null {
  const m = value.trim().match(BOARD); if (!m) return null;
  try { const title = decodeURIComponent(m[2]); return title.trim() && title.length <= 140 && !/[\r\n\u0000-\u001f]/.test(title) ? { id: m[1], title, ...(m[3] ? {columns: parseBoardColumns(decodeURIComponent(m[3]))} : {}) } : null; } catch { return null; }
}
export function boardMarker(board: Pick<NoteBoard, 'id' | 'title' | 'columns'>): string {
  if (!ID.test(board.id)) return '';
  const title = board.title.trim().slice(0, 140).replace(/[\r\n\u0000-\u001f]/g, ' ');
  return title ? `<!-- orion-kanban:v1 ${board.id} ${encodeURIComponent(title).replace(/-/g, '%2D')}${board.columns?.length ? ` columns=${encodeURIComponent(JSON.stringify(parseBoardColumns(JSON.stringify(board.columns))))}` : ''} -->` : '';
}
export function effectiveTicketStatus(checked: boolean, status: unknown): TicketStatus { return checked ? 'done' : validTicketStatus(status) && status !== 'done' ? status : 'todo'; }
export function newTicketMarkdown(title: string, boardId = '', status: TicketStatus = 'todo', dueDate = '', origin?: 'board', urgency?: TicketUrgency): string {
  // A title is literal prose, not a second Markdown/HTML command channel.
  const text = title.trim().slice(0, 140).replace(/[\r\n\u0000-\u001f]/g, ' ').replace(/[\\`*_[\]<>#~!+|.-]/g, '\\$&');
  return `- [${status === 'done' ? 'x' : ' '}] ${text} ${ticketMarker({ id: newTicketId(), status, boardId, dueDate, origin, urgency })}`;
}
interface MarkdownNode {
  type: string;
  value?: string;
  checked?: boolean | null;
  children?: MarkdownNode[];
  position?: { start: { line: number; column: number; offset?: number }; end: { line: number; column: number; offset?: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}
const parser = unified().use(remarkParse).use(remarkGfm);
function prose(node: MarkdownNode): string {
  if (node.type === 'html') return '';
  return node.value ?? node.children?.map(prose).join('') ?? '';
}
function scanWork(markdown: string) {
  const { prefix, content } = splitMarkdownFrontmatter(markdown);
  const offset = prefix.match(/\n/g)?.length ?? 0;
  const lines = markdown.split(/\r?\n/);
  const tickets: (Omit<Ticket, 'noteId' | 'noteTitle'> & { blockStart?: number; blockEnd?: number })[] = [];
  const boards: Omit<NoteBoard, 'noteId'>[] = [];
  const boardLines = new Map<string, number[]>();
  const identityCounts = new Map<string, number>();
  function visit(node: MarkdownNode, parent?: MarkdownNode) {
    // Quoted/code examples and raw HTML never become actionable tickets.
    if (node.type === 'blockquote' || node.type === 'code' || node.type === 'inlineCode') return;
    const lineIndex = (node.position?.start.line ?? 1) - 1 + offset;
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const rawLine = lines[lineIndex];
      if (TASK.test(rawLine)) {
        const paragraph = node.children?.find(child => child.type === 'paragraph');
        const markers = paragraph?.children?.flatMap(child => {
          const meta = child.type === 'html' ? parseTicketMarker(child.value ?? '') : null;
          return meta && child.position?.start.line === node.position?.start.line ? [{ meta, start: child.position!.start.column - 1 }] : [];
        }) ?? [];
        // Count every active marker, even on an empty/ambiguous task that has no
        // card. Such a copy must not make a destructive action look unique.
        markers.forEach(({ meta }) => identityCounts.set(meta.id, (identityCounts.get(meta.id) ?? 0) + 1));
        const marker = markers.length === 1 ? markers[0] : null;
        const meta = marker?.meta;
        const title = paragraph ? prose(paragraph).trim() : '';
        const start = node.position?.start.offset, end = node.position?.end.offset;
        const blockStart = start === undefined ? undefined : markdown.lastIndexOf('\n', prefix.length + start - 1) + 1;
        const blockEnd = end === undefined ? undefined : prefix.length + end;
        const rawBlock = blockStart === undefined || blockEnd === undefined ? undefined : markdown.slice(blockStart, blockEnd);
        if (title) tickets.push({ id: meta?.id ?? `line:${lineIndex}`, status: effectiveTicketStatus(node.checked, meta?.status),
          boardId: meta?.boardId ?? '', ...(meta?.dueDate ? { dueDate: meta.dueDate } : {}), ...(meta?.origin ? { origin: meta.origin } : {}), ...(meta?.urgency ? { urgency: meta.urgency } : {}), title, lineIndex, rawLine, rawBlock, blockStart, blockEnd, durable: Boolean(meta), markerStart: marker?.start });
      }
    }
    const board = node.type === 'html' && parent?.type !== 'paragraph' ? parseBoardMarker(node.value ?? '') : null;
    if (board) { boards.push(board); boardLines.set(board.id,[...(boardLines.get(board.id) ?? []),lineIndex]); }
    node.children?.forEach(child => visit(child, node));
  }
  visit(parser.parse(content) as MarkdownNode);
  return { tickets, boards, identityCounts, boardLines };
}
const cache = new WeakMap<Note, { tickets: Ticket[]; boards: NoteBoard[]; ticketIdCounts: ReadonlyMap<string, number> }>();
/** Derived, Space-local views. Unchanged immutable notes are never rescanned. */
export function noteWork(note: Note) {
  const cached = cache.get(note);
  if (cached) return cached;
  const scanned = scanWork(note.body);
  const result = {
    ticketIdCounts: scanned.identityCounts,
    tickets: scanned.tickets.map(({ blockStart: _start, blockEnd: _end, ...ticket }) => ({ ...ticket, id: ticket.durable ? ticket.id : `${note.id}:${ticket.lineIndex}`,
      noteId: note.id, noteTitle: displayNoteTitle(note) })),
    boards: scanned.boards.map(board => ({ ...board, noteId: note.id })),
  };
  cache.set(note, result);
  return result;
}
const spaceCache = new WeakMap<readonly Note[], { tickets: Ticket[]; boards: NoteBoard[] }>();
export function collectWork(notes: readonly Note[]) {
  const cached = spaceCache.get(notes);
  if (cached) return cached;
  const buckets = new Map<string, { note: Note; ticket: Ticket }[]>();
  const boards = notes.flatMap(note => noteWork(note).boards);
  const boardCounts = new Map<string, number>();
  boards.forEach(board => boardCounts.set(board.id, (boardCounts.get(board.id) ?? 0) + 1));
  for (const note of notes) for (const ticket of noteWork(note).tickets) {
    const fingerprint = ticket.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const bucket = buckets.get(fingerprint) ?? [];
    // Explicit separate tickets keep their identity. Collapse only derived task copies.
    const duplicate = bucket.findIndex(other => !(other.ticket.durable && ticket.durable && other.ticket.id !== ticket.id)
      && sharesTaskDerivation(note, other.note));
    if (duplicate < 0) bucket.push({ note, ticket });
    else if (note.kind !== 'wiki' && bucket[duplicate].note.kind === 'wiki') bucket[duplicate] = { note, ticket };
    buckets.set(fingerprint, bucket);
  }
  const result = { tickets: [...buckets.values()].flatMap(bucket => bucket.map(item => item.ticket)),
    // Ambiguous copied IDs must not silently combine unrelated boards.
    boards: boards.filter(board => boardCounts.get(board.id) === 1) };
  spaceCache.set(notes, result);
  return result;
}
/** Resolve durable identity on the latest body; reject ambiguous copies and stale prose. */
export function patchTicket(markdown: string, ticket: Ticket, patch: TicketPatch): string | null {
  if (patch.detail) {
    if (Object.keys(patch).length !== 1 || !ticket.durable || !ticket.rawBlock) return null;
    const scanned = scanWork(markdown);
    const current = scanned.tickets.find(t => t.id === ticket.id);
    if (scanned.identityCounts.get(ticket.id) !== 1 || !current || current.rawBlock !== ticket.rawBlock || current.blockStart === undefined || current.blockEnd === undefined) return null;
    const replacement = changeTicketBlock(ticket, patch.detail);
    return replacement === null ? null : markdown.slice(0, current.blockStart) + replacement + markdown.slice(current.blockEnd);
  }
  if (patch.urgency !== undefined && !validTicketUrgency(patch.urgency)) return null;
  if (patch.dueDate && !validCalendarDate(patch.dueDate)) return null;
  if (patch.status !== undefined && !validTicketStatus(patch.status) || patch.boardId && !ID.test(patch.boardId)) return null;
  const lines = markdown.split(/\r?\n/);
  const current = scanWork(markdown).tickets;
  const candidates = current.filter(candidate => ticket.durable ? candidate.durable && candidate.id === ticket.id
    : !candidate.durable && candidate.lineIndex === ticket.lineIndex).map(candidate => candidate.lineIndex);
  if (candidates.length !== 1) return null;
  const index = candidates[0], line = lines[index], task = line?.match(TASK);
  if (!task || line !== ticket.rawLine) return null;
  const status = patch.status ?? (patch.boardId !== undefined && patch.boardId !== ticket.boardId && ticket.status.startsWith('column-') ? 'todo' : ticket.status), boardId = patch.boardId ?? ticket.boardId;
  // Completing an ordinary checklist must not silently promote it into a ticket.
  if (!ticket.durable && patch.boardId === undefined && patch.dueDate === undefined && patch.urgency === undefined && status !== 'progress') {
    lines[index] = `${task[1]}${status === 'done' ? 'x' : ' '}${task[3]}${task[4]}`;
    return lines.join(markdown.includes('\r\n') ? '\r\n' : '\n');
  }
  const cleanLine = ticket.durable && ticket.markerStart !== undefined
    ? line.slice(0, ticket.markerStart) + line.slice(ticket.markerStart + (line.slice(ticket.markerStart).match(TICKET)?.[0].length ?? 0)) : line;
  const content = cleanLine.match(TASK)![4].trimEnd();
  const meta = ticketMarker({ id: ticket.durable ? ticket.id : newTicketId(), status, boardId, dueDate: patch.dueDate ?? ticket.dueDate, origin: ticket.origin, urgency: patch.urgency ?? ticket.urgency });
  lines[index] = `${task[1]}${status === 'done' ? 'x' : ' '}${task[3]}${content} ${meta}`;
  return lines.join(markdown.includes('\r\n') ? '\r\n' : '\n');
}

/** Remove only the captured authored task, including its child content. */
export function deleteTicket(markdown: string, ticket: Ticket): string | null {
  if (!ticket.durable || !ticket.rawBlock) return null;
  const current = scanWork(markdown);
  if (current.identityCounts.get(ticket.id) !== 1) return null;
  const target = current.tickets.find(candidate => candidate.durable && candidate.id === ticket.id);
  if (!target || target.rawLine !== ticket.rawLine || target.rawBlock !== ticket.rawBlock || target.blockStart === undefined || target.blockEnd === undefined) return null;
  let end = target.blockEnd;
  // Consume this item's line ending, without normalizing surrounding whitespace
  // or changing the newlines used elsewhere in the note.
  if (markdown.startsWith('\r\n', end)) end += 2;
  else if (markdown[end] === '\n') end += 1;
  return markdown.slice(0, target.blockStart) + markdown.slice(end);
}

/** Read/export a validated board at its authored position. Never interpret raw HTML. */
export function remarkNoteBoards() {
  return (tree: MarkdownNode) => {
    function visit(parent: MarkdownNode) {
      if (!parent.children) return;
      parent.children = parent.children.filter(child => !(child.type === 'html' && parseTicketMarker(child.value ?? ''))).map(child => {
        const board = parent.type !== 'paragraph' && child.type === 'html' && child.value ? parseBoardMarker(child.value) : null;
        if (board) return { type: 'orionBoard', position: child.position, data: { hName: 'section', hProperties: { 'data-orion-board': board.id, 'data-board-title': board.title } }, children: [{ type: 'paragraph', children: [{ type: 'text', value: board.title }] }] };
        if (child.type !== 'code' && child.type !== 'inlineCode') visit(child);
        return child;
      });
    }
    visit(tree);
  };
}

export function parseBoardColumns(json: string): BoardColumn[] {
  const columns: unknown = JSON.parse(json);
  if (!Array.isArray(columns) || columns.length > 23) throw new Error('Invalid board columns');
  const ids = new Set<string>();
  return columns.map(column => {
    if (!column || typeof column !== 'object' || !validTicketStatus(column.id) || ids.has(column.id) || typeof column.title !== 'string' || !column.title.trim() || column.title.length > 80 || /[\r\n\u0000-\u001f]/.test(column.title)) throw new Error('Invalid board column');
    ids.add(column.id);
    return {id: column.id as BoardColumn['id'], title: column.title};
  });
}
export function boardColumns(board: Pick<NoteBoard, 'columns'>): readonly [TicketStatus, string][] {
  return [...TICKET_STATUSES.map(([id,title]) => [id,board.columns?.find(column => column.id === id)?.title ?? title] as [TicketStatus,string]), ...(board.columns ?? []).filter(column => column.id.startsWith('column-')).map(column => [column.id,column.title] as [TicketStatus,string])];
}
export function changeBoard(markdown: string, board: NoteBoard, change: BoardChange): string | null {
  const scanned = scanWork(markdown);
  const current = scanned.boards.filter(candidate => candidate.id === board.id);
  const name = change.title.trim();
  if (current.length !== 1 || JSON.stringify(current[0].columns ?? []) !== JSON.stringify(board.columns ?? []) || current[0].title !== board.title || !name || name.length > (change.kind === 'title' ? 140 : 80) || /[\r\n\u0000-\u001f]/.test(name)) return null;
  let updated = {...board};
  if(change.kind === 'title') updated.title = name;
  else {
    const columns = boardColumns(board);
    if(columns.some(([id,label]) => (change.kind !== 'columnTitle' || id !== change.id) && label.toLocaleLowerCase() === name.toLocaleLowerCase())) return null;
    if(change.kind === 'addColumn' && columns.length >= 23 || change.kind === 'columnTitle' && !columns.some(([id]) => id === change.id)) return null;
    const id = change.kind === 'columnTitle' ? change.id : `column-${nanoid(12)}` as TicketStatus;
    const existing = (board.columns ?? []).some(column => column.id === id);
    updated.columns = existing ? board.columns!.map(column => column.id === id ? {...column,title:name} : column) : [...(board.columns ?? []), {id,title:name}];
  }
  const lines = markdown.split(/\r?\n/);
  const index = scanned.boardLines.get(board.id)?.[0];
  if (index === undefined || !parseBoardMarker(lines[index])) return null;
  lines[index] = (lines[index].match(/^[ \t]*/)?.[0] ?? '') + boardMarker(updated);
  return lines.join(markdown.includes('\r\n') ? '\r\n' : '\n');
}
