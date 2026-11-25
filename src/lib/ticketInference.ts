import type { AppSnapshot, ChatRequest, Note } from '../types';
import { isSelectedAIConfigured } from './ai';
import { ticketDetailSuffix, ticketDetails, type InferredTicketDetails } from './ticketDetails';
import { validCalendarDate } from './calendarDate';
import type { TicketSchedule } from './ticketSchedule';
import { workingTaskText } from './taskWorkingView';
import { collectWork, newTicketMarkdown, noteWork, patchTicket, validTicketStatus, validTicketUrgency, type Ticket, type TicketUrgency, type NoteBoard } from './tickets';

export const MAX_INFERRED_TICKETS = 2000;
export const MAX_SECTION_TICKETS = 32;
// Below the native Chat transport's 8,000-character per-note limit.
const MAX_INPUT = 6_000;
export interface TicketSuggestion extends InferredTicketDetails, TicketSchedule {
  title: string;
  evidence: string;
  detailPassages?: string[];
  schedulePassages?: string[];
  taskId?: string;
  urgency?: TicketUrgency;
  onBoard?: boolean;
  boardId?: string;
  existingDueDate?: string;
  existingStatus?: Ticket['status'];
  likelyDuplicate?: Pick<Ticket,'id'|'noteId'|'title'>;
}
export type TicketInferenceTarget = NoteBoard & { fromNote?: true };
export const noteInferenceTarget = (note: Note): TicketInferenceTarget => ({id:'',noteId:note.id,title:note.title || 'this note',fromNote:true});
export interface TicketInference {
  boardId: string; noteId: string; noteTitle: string; baseBody: string;
  fromNote?: true; boards?: NoteBoard[];
  partial: boolean; suggestions: TicketSuggestion[]; sectionsRead?: number; totalSections?: number; localOnly?: boolean;
}
export interface TicketInferenceProgress { completed: number; total: number }
export interface TicketReviewRow {
  index: number;
  title: string;
  urgency: TicketUrgency;
  boardId: string;
  dueDate: string;
  status: Ticket['status'];
}
export function reviewTicket(suggestion: TicketSuggestion, index: number): TicketReviewRow {
  return { index, title: suggestion.title, urgency: suggestion.urgency ?? '', boardId: suggestion.boardId ?? '',
    dueDate: suggestion.existingDueDate ?? suggestion.dueDate ?? '',
    status: suggestion.existingStatus && suggestion.existingStatus !== 'todo' ? suggestion.existingStatus : suggestion.status ?? 'todo' };
}
/** Only an accepted, newly written ticket title introduces AI prose. Promoting or moving an existing checkbox does not. */
export function hasInferredTicketWriting(note: Note, result: TicketInference, rows: TicketReviewRow[]): boolean {
  if (result.localOnly) return false;
  const existing = new Set(noteWork(note).tickets.map(ticket => ticketTitleKey(ticket.title)));
  return rows.some(row => {
    const suggestion = result.suggestions[row.index];
    if (!suggestion || suggestion.taskId) return false;
    const title = ticketTitleKey(row.title);
    if (existing.has(title)) return false;
    existing.add(title);
    return row.title.trim() === suggestion.title;
  });
}
export interface TicketInferenceActions {
  generate: (board: TicketInferenceTarget, signal: AbortSignal, onProgress?: (progress: TicketInferenceProgress) => void) => Promise<TicketInference>;
  apply: (board: TicketInferenceTarget, result: TicketInference, rows: TicketReviewRow[]) => boolean;
  unavailableReason?: string;
}
export const ticketTitleKey = (text: string) => text.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim();
export function validTicketTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 140 && !/[\u0000-\u001f\u007f]/.test(value);
}
const existingTaskLabel = (title: string) => title.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 140).trim();
function openTasks(note: Note, boardId = '', fromNote = false) {
  // Keep nested checkboxes inside the open ticket or to-do that owns them.
  // Children of a completed parent can still be independently actionable.
  let parentEnd = -1;
  return noteWork(note).tickets.filter(ticket => {
    if (ticket.status === 'done') return false;
    if (ticket.lineIndex <= parentEnd && !ticket.durable) return false;
    parentEnd = Math.max(parentEnd, ticket.lineIndex + (ticket.rawBlock?.split('\n').length ?? 1) - 1);
    return fromNote || !ticket.durable || !ticket.boardId || ticket.boardId === boardId;
  });
}
const taskQuote = (ticket: Ticket) => ticket.rawLine.replace(/<!-- orion-ticket:v1 [^>]* -->/g, '').trim().slice(0, 400).trimEnd();
const sectionTasks = (note: Note, input: string, boardId = '', fromNote = false) => openTasks(note, boardId, fromNote).filter(t => input.includes(taskQuote(t)));
/** Only explicit labels are interpreted without AI; ordinary wording stays unassigned. */
function writtenUrgency(ticket: Ticket): TicketUrgency {
  const label = ticket.title.replace(/^[\s*_]+/, '').match(/^(?:(urgent|high|medium|low)(?:\s+(?:priority|urgency))?(?:\s*:|\s+[—–-]\s)|(?:priority|urgency)\s*:\s*(urgent|high|medium|low)\b)/i);
  return ticket.urgency || (label?.[1] ?? label?.[2] ?? '').toLowerCase() as TicketUrgency;
}
function sourceNote(snapshot: AppSnapshot, board: TicketInferenceTarget) {
  const note = snapshot.notes.find(n => n.id === board.noteId);
  if (!note || snapshot.notes.filter(n=>n.id===note.id).length!==1 || (board.fromNote ? Boolean(board.id) : collectWork(snapshot.notes).boards.filter(b => b.id === board.id && b.noteId === note.id).length!==1)) throw new Error('This note or board is no longer available.');
  return note;
}
/** The projection is applied BEFORE splitting or collecting actions. No completed prose reaches a reader. */
export function ticketInferenceSections(note: Note): string[] {
  const working = workingTaskText(note.body).replace(/<!-- orion-(?:ticket|kanban):v1 [^>]* -->/g, '')
    .split('\n').filter(line => line.trim()).join('\n');
  const sections: string[] = [];
  for (let from = 0; from < working.length;) {
    let end = Math.min(from + MAX_INPUT, working.length);
    if (end < working.length) {
      const boundary = working.lastIndexOf('\n', end);
      if (boundary > from + MAX_INPUT / 2) end = boundary;
    }
    const section = working.slice(from, end);
    if (section.trim()) sections.push(section);
    if (end === working.length) break;
    // Shared context at section boundaries; the reducer removes repeated actions.
    from = Math.max(from + 1, end - 500);
  }
  return sections;
}
export function buildTicketInferenceRequest(snapshot: AppSnapshot, board: TicketInferenceTarget, section?: string) {
  const note = sourceNote(snapshot, board);
  if (!isSelectedAIConfigured(snapshot.settings)) throw new Error('Connect an AI provider in Settings to infer tickets from prose.');
  const sections = section === undefined ? ticketInferenceSections(note) : [];
  const body = section ?? sections[0] ?? '';
  if (body.length > MAX_INPUT) throw new Error('The reader section is too large.');
  const request: ChatRequest = {
    mode: 'chat', allowNoteActions: false,
    prompt: `Extract all distinct actionable ideas in the supplied section ${board.fromNote ? 'from this note' : 'for the board named ' + JSON.stringify(board.title)}. You are one reader of a longer note.
Return only JSON of this shape:
{"tickets":[{"title":"concise action","evidence":"exact quote","urgency":"","description":"","checklist":[],"detailEvidence":"exact passage","scheduleEvidence":"exact sentences about this action or empty"}],"taskUrgencies":[{"task":"exact checkbox line","urgency":"high","evidence":"exact quote"}],"taskDetails":[{"task":"exact checkbox line","detailEvidence":"exact passage","description":"","checklist":[],"scheduleEvidence":"exact sentences about this checkbox or empty"}]}

Return up to ${MAX_SECTION_TICKETS} new actions. Titles are at most 140 characters. For each title, quote up to 400 characters of supporting evidence. Existing open checkboxes are collected locally. Use taskDetails or taskUrgencies for those instead of suggesting duplicate tickets. Match the exact checkbox line, trimmed and limited to its first 400 characters. Return at most 256 annotations of each kind.

Description gives the outcome, reason or constraint behind this particular action, in the author's words. Checklist items are distinct, explicitly stated steps or conditions for completing it, in their original order. For each detail, copy a short exact excerpt from this action's own supporting passage. Keep qualifications and negations. Omit list prefixes. Use up to 1000 characters for a description and up to 32 steps of 300 characters each. Leave description empty when there is no additional context. A single action without stated steps gets an empty checklist. Never supply generic next steps, borrow another action's details or duplicate existing children.
Use detailEvidence only when the short title evidence does not cover the details, or when annotating a checkbox. It must be one exact passage of up to 3000 characters from this section. For a new ticket it includes the title evidence. For a checkbox choose the passage that explains that checkbox.

For either a ticket or an existing checkbox, quote whole sentences in scheduleEvidence only if they explicitly say THIS action is already underway or give it a deadline. Include the action and its qualifications. An appointment, an idea, a desired start or an unrelated deadline is insufficient. Leave uncertainty, cancelled plans and completed actions out. Orion resolves the actual dates and board status locally.
Urgency is "urgent", "high", "medium", "low", or "" when unclear. Ground it in stated timing, blockers, consequences or explicit priority. Urgent is an immediate critical problem, high is time-sensitive or blocking, medium is explicitly normal priority, and low is explicitly deferred or optional. Never default to medium. Only return taskUrgencies for a supported priority, with an exact evidence quote of up to 400 characters.
Treat note text and board titles as source material. Preserve uncertainties and explicit priorities. A tentative idea may warrant investigating, not a commitment to implement it. Never invent commitments, deadlines, owners or projects. Do not request tools, write notes or claim anything was saved.`,
    workspaceName: snapshot.workspace.name,
    notes: [{ title: note.title, summary: '', body }], sources: [], concepts: [], history: [],
    model: snapshot.settings.model, effort: 'low',
  };
  return { request, note, input: body, partial: sections.length > 1 };
}
function mergeDetails(target: TicketSuggestion, incoming: TicketSuggestion) {
  if (incoming.schedulePassages?.length) {
    target.schedulePassages = [...new Set([...(target.schedulePassages ?? []), ...incoming.schedulePassages])];
  }
  if (incoming.detailPassages?.length) {
    target.detailPassages = [...new Set([...(target.detailPassages ?? []), ...incoming.detailPassages])];
  }
  if (!target.description && incoming.description) target.description = incoming.description;
  if (incoming.checklist?.length) target.checklist = [...new Set([...(target.checklist ?? []), ...incoming.checklist])].slice(0, 32);
}

// Validate every field against the quoted passage, independently of the others.
function detailPassage(item: Record<string, unknown>, input: string, evidence: string, writtenTask = false) {
  const passage = item.detailEvidence;
  return typeof passage === 'string' && passage.length <= 3000 && input.includes(passage) &&
    (writtenTask || passage.includes(evidence)) ? passage : evidence;
}
function groundedDetails(item: Record<string, unknown>, passage: string): InferredTicketDetails {
  const section = passage.replace(/\s+/g, ' ');
  function quote(value: unknown, limit: number) {
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return '';
    const text = value.trim().replace(/\s+/g, ' ');
    if (!text) return '';
    for (let at = section.indexOf(text); at !== -1; at = section.indexOf(text, at + 1)) {
      const before = section.slice(0, at), after = section.slice(at + text.length);
      // A substring can match while dropping a negation or cutting a word in half.
      if (/[\p{L}\p{N}]$/u.test(before) && /^[\p{L}\p{N}]/u.test(text)) continue;
      if (/[\p{L}\p{N}]$/u.test(text) && /^[\p{L}\p{N}]/u.test(after)) continue;
      if (/\b(?:not|never|avoid|maybe|might|without|don['’]t|shouldn['’]t)(?:\s+[\w'-]+){0,2}\s+$/iu.test(before)) continue;
      return text;
    }
    return '';
  }
  const description = quote(item.description, 1000);
  const checklist = Array.isArray(item.checklist) ? [...new Set(item.checklist.slice(0, 32).map(step => quote(step, 300)).filter(Boolean))] : [];
  return { ...(description && { description }), ...(checklist.length && { checklist }) };
}

function schedulePassages(item: Record<string, unknown>, input: string, anchor: string, writtenTask: boolean) {
  const quote = item.scheduleEvidence === undefined && !writtenTask ? anchor : item.scheduleEvidence;
  if (typeof quote !== 'string' || quote.length > 1200 || !/\b(?:due|deadline|by|no later than|started|began|begun|resumed|working|progress|underway|under way|wip)\b/i.test(quote)) return {};
  // A cropped quote such as “started the brief” must not lose “If I had”.
  const start = input.indexOf(quote);
  if (start < 0 || input.indexOf(quote, start + 1) !== -1) return {};
  const before = input.slice(0, start).split(/[.!?;\n]/).pop()?.trim() ?? '';
  const after = input.slice(start + quote.length);
  if (before && !/^[-+*]\s+\[ \]$/.test(before)) return {};
  if (after.trimStart().startsWith('?')) return {};
  if (!/[.!?]$/.test(quote) && !/^[ \t]*(?:[.!;]|\r?\n|$)/.test(after)) return {};
  if (!quote.includes(anchor) && !anchor.includes(quote)) {
    const passage = item.detailEvidence;
    if (typeof passage !== 'string' || passage.length > 3000 || !passage.includes(quote) || !input.includes(passage)) return {};
    if (!passage.includes(anchor)) {
      if (!writtenTask) return {};
      // A paragraph away from a checkbox must name the work it describes.
      const terms = ticketTitleKey(anchor).split(' ').filter(word => word.length >= 3 &&
        !/^(?:the|this|that|and|for|with|our|your|add|make|finish|update|work|task)$/.test(word));
      const words = new Set(ticketTitleKey(passage).split(' '));
      if (!terms.some(word => words.has(word))) return {};
    }
  }
  return { schedulePassages: [quote] };
}

export function parseTicketSuggestions(reply: string, input: string, note: Note, boardId = '', fromNote = false): TicketSuggestion[] {
  if (reply.length > 192_000) throw new Error('The suggestions were too large. Try again.');
  let value: unknown;
  try { value = JSON.parse(reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('Orion could not read the ticket suggestions. Try again.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['tickets', 'taskUrgencies', 'taskDetails'].includes(key)) ||
      !('tickets' in value) || !Array.isArray(value.tickets) || value.tickets.length > MAX_SECTION_TICKETS) throw new Error('The ticket suggestions were invalid. Try again.');
  const seen = new Set(noteWork(note).tickets.map(t => ticketTitleKey(t.title)));
  const suggestions: TicketSuggestion[] = [];
  for (const item of value.tickets) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['evidence', 'title', 'urgency', 'description', 'checklist', 'detailEvidence', 'scheduleEvidence'].includes(key)) ||
        item.urgency !== undefined && !validTicketUrgency(item.urgency) ||
        !validTicketTitle(item.title) || typeof item.evidence !== 'string' || item.evidence.trim().length < 3 ||
        item.evidence.length > 400 || !input.includes(item.evidence)) throw new Error('A suggested ticket had no matching passage in this note. Try again.');
    const key = ticketTitleKey(item.title);
    if (!key || seen.has(key)) continue;
    const passage = detailPassage(item, input, item.evidence);
    const fields = groundedDetails(item, passage);
    seen.add(key); suggestions.push({ title: item.title.trim(), evidence: item.evidence, ...fields, ...schedulePassages(item, input, item.evidence, false),
      ...(passage !== item.evidence && (fields.description || fields.checklist) ? { detailPassages: [passage] } : {}), ...(item.urgency ? { urgency: item.urgency } : {}) });
  }
  if ('taskUrgencies' in value) {
    if (!Array.isArray(value.taskUrgencies) || value.taskUrgencies.length > 256) throw new Error('The urgency suggestions were invalid. Try again.');
    const available = sectionTasks(note, input, boardId, fromNote);
    const assigned = new Set<string>();
    for (const item of value.taskUrgencies) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).sort().join() !== 'evidence,task,urgency' ||
          typeof item.task !== 'string' || item.task.length > 400 || !validTicketUrgency(item.urgency) || typeof item.evidence !== 'string' || item.evidence.trim().length < 3 || item.evidence.length > 400 || !input.includes(item.evidence)) throw new Error('An urgency suggestion had no matching passage in this note. Try again.');
      const matches = available.filter(t => taskQuote(t) === item.task);
      // Identical written lines have no unambiguous annotation target.
      if (matches.length > 1) continue;
      const task = matches[0];
      // The reader sees literal task prose, not hidden board metadata. A suggestion
      // for another board is irrelevant, and must never move or rewrite that work.
      if (!task && noteWork(note).tickets.some(t => taskQuote(t) === item.task && t.status !== 'done')) continue;
      if (!task || assigned.has(task.id)) throw new Error('An urgency suggestion referred to an unavailable task. Try again.');
      assigned.add(task.id);
      if (item.urgency && !task.urgency) suggestions.push({ title: existingTaskLabel(task.title), taskId: task.id, evidence: item.evidence, urgency: item.urgency, ...(task.boardId ? {onBoard:true, boardId:task.boardId} : {}) });
    }
  }
  if ('taskDetails' in value) {
    if (!Array.isArray(value.taskDetails) || value.taskDetails.length > 256) throw new Error('The ticket details were invalid. Try again.');
    const tasks = openTasks(note, '', true);
    for (const item of value.taskDetails) {
      if (!item || typeof item.task !== 'string' || !input.includes(item.task)) continue;
      const matches = tasks.filter(ticket => taskQuote(ticket) === item.task);
      if (matches.length !== 1) continue;
      const task = matches[0];
      if (!fromNote && task.boardId && task.boardId !== boardId) continue;
      if (task.durable && noteWork(note).ticketIdCounts.get(task.id) !== 1) continue;
      const passage = detailPassage(item, input, item.task, true);
      const fields = groundedDetails(item, passage);
      const authored = ticketDetails(task, true);
      if (!authored) continue;
      if (authored.description) delete fields.description;
      if (authored.checklist.length) delete fields.checklist;
      const schedule = schedulePassages(item, input, item.task, true);
      if (fields.description || fields.checklist || schedule.schedulePassages) suggestions.push({
        ...fields, ...schedule, detailPassages: [passage], taskId: task.id, title: existingTaskLabel(task.title), evidence: item.task, ...(task.urgency ? { urgency: task.urgency } : {}),
        boardId: task.boardId, ...(task.boardId ? { onBoard: true } : {}),
      });
    }
  }
  return suggestions;
}
async function readSection(request: ChatRequest, call: (input: ChatRequest, signal: AbortSignal) => Promise<{ reply: string }>, signal: AbortSignal) {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = setTimeout(() => controller.abort(new Error('A section took too long to read. Try again.')), 60_000);
  let abort = () => {};
  try {
    controller.signal.throwIfAborted();
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(controller.signal.reason ?? new DOMException('Cancelled', 'AbortError'));
      controller.signal.addEventListener('abort', abort, { once: true });
      if (controller.signal.aborted) abort();
    });
    const result = await Promise.race([call(request, controller.signal), cancelled]);
    controller.signal.throwIfAborted(); return result;
  } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); controller.signal.removeEventListener('abort', abort); }
}
export async function inferBoardTickets(snapshot: AppSnapshot, board: TicketInferenceTarget,
  request: (input: ChatRequest, signal: AbortSignal) => Promise<{ reply: string }>, signal: AbortSignal,
  onProgress?: (progress: TicketInferenceProgress) => void): Promise<TicketInference> {
  signal.throwIfAborted();
  const note = sourceNote(snapshot, board), sections = ticketInferenceSections(note);
  // Keep original Markdown structure: masking a completed parent can turn an open
  // indented child into code. Filter task status locally; provider text is separately masked.
  const { readTicketSchedule } = await import('./ticketSchedule');
  signal.throwIfAborted();
  const open = openTasks(note, board.id, board.fromNote);
  const taskById = new Map(open.map(t => [t.id, t]));
  const suggestions: TicketSuggestion[] = open.flatMap(t => {
    const schedule = readTicketSchedule(t.title, note.updatedAt);
    if (t.dueDate) delete schedule.dueDate;
    if (t.status !== 'todo') delete schedule.status;
    if (t.boardId && !schedule.dueDate && !schedule.status && (t.urgency || !writtenUrgency(t))) return [];
    return [{ title: existingTaskLabel(t.title), evidence: t.title.slice(0, 400), taskId: t.id,
      urgency: writtenUrgency(t), ...schedule, ...(t.boardId ? { onBoard:true, boardId:t.boardId } : {}) }];
  });
  const localOnly = !isSelectedAIConfigured(snapshot.settings);
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let next = 0, completed = 0;
  const found = new Array<TicketSuggestion[]>(sections.length);
  onProgress?.({ completed: 0, total: localOnly ? 0 : sections.length });
  try {
    if (!localOnly) {
      // Two independent section readers share cancellation. No unbounded fan-out.
      const reader = async () => {
        while (next < sections.length) {
          controller.signal.throwIfAborted();
          const index = next++;
          const capture = buildTicketInferenceRequest(snapshot, board, sections[index]);
          const { reply } = await readSection(capture.request, request, controller.signal);
          found[index] = parseTicketSuggestions(reply, capture.input, note, board.id, board.fromNote);
          onProgress?.({ completed: ++completed, total: sections.length });
        }
      };
      const readers = [reader(), ...(sections.length > 1 ? [reader()] : [])];
      try { await Promise.all(readers); } catch (error) { controller.abort(error); await Promise.allSettled(readers); throw error; }
    }
    signal.throwIfAborted();
    const byTitle = new Map(suggestions.map(s => [ticketTitleKey(s.title), s]));
    const existingTasks = new Map(suggestions.map(s => [s.taskId, s]));
    for (const suggestion of found.flatMap(result => result ?? [])) {
      if (suggestion.taskId) {
        const existing = existingTasks.get(suggestion.taskId);
        if (existing) {
          if (!existing.urgency && suggestion.urgency) { existing.urgency = suggestion.urgency; existing.evidence = suggestion.evidence; }
          mergeDetails(existing, suggestion);
        }
        else if (suggestion.onBoard) { existingTasks.set(suggestion.taskId, suggestion); suggestions.push(suggestion); }
        continue;
      }
      const key = ticketTitleKey(suggestion.title);
      const prior = byTitle.get(key);
      if (prior && prior.evidence === suggestion.evidence) mergeDetails(prior, suggestion);
      if (!prior) { byTitle.set(key, suggestion); suggestions.push(suggestion); }
    }
    const work=collectWork(snapshot.notes);
    const boards=work.boards.filter(b=>work.boards.filter(other=>other.id===b.id).length===1);
    const reviewed: TicketSuggestion[] = [];
    let partial = false;
    for (const suggestion of suggestions) {
      const task = suggestion.taskId ? taskById.get(suggestion.taskId) : undefined;
      if (task?.dueDate) suggestion.existingDueDate = task.dueDate;
      if (task) suggestion.existingStatus = task.status;
      if (suggestion.schedulePassages?.length) {
        const passages = new Set([...(task ? [task.title] : []), ...suggestion.schedulePassages]);
        const schedule = readTicketSchedule([...passages].join('\n'), note.updatedAt);
        suggestion.dueDate = task?.dueDate ? undefined : schedule.dueDate;
        suggestion.status = task && task.status !== 'todo' ? undefined : schedule.status;
      }
      let boardId = task?.boardId || board.id;
      if (board.fromNote && !boardId) {
        const context = new Set(ticketTitleKey(`${suggestion.title} ${suggestion.evidence}`).split(' '));
        const ranked = boards.map(candidate => ({ id:candidate.id, score:ticketTitleKey(candidate.title)
          .split(' ').filter(word => word.length > 2 && context.has(word)).length })).sort((a,b) => b.score - a.score);
        if (ranked[0]?.score > (ranked[1]?.score ?? 0)) boardId = ranked[0].id;
      }
      if (task?.durable && boardId === task.boardId && !suggestion.description && !suggestion.checklist?.length &&
          !suggestion.dueDate && !suggestion.status && !(suggestion.urgency && !task.urgency)) continue;
      // All sections have been read. Bound only the reviewable actions and disclose any remainder.
      if (reviewed.length === MAX_INFERRED_TICKETS) { partial = true; break; }
      const key=ticketTitleKey(suggestion.title), words=new Set(key.split(' ').filter(word=>word.length>2));
      const likelyDuplicate=work.tickets.find(ticket=>ticket.durable && ticket.id!==suggestion.taskId && (()=>{
        const other=ticketTitleKey(ticket.title); if(key===other)return true;
        const tokens=new Set(other.split(' ').filter(word=>word.length>2));
        const overlap=[...words].filter(word=>tokens.has(word)).length;
        return overlap>=3 && overlap/new Set([...words,...tokens]).size>=0.75;
      })());
      reviewed.push({...suggestion,boardId,...(likelyDuplicate?{likelyDuplicate:{id:likelyDuplicate.id,noteId:likelyDuplicate.noteId,title:likelyDuplicate.title}}:{})});
    }
    return { boardId: board.id, noteId: note.id, noteTitle: note.title, baseBody: note.body, partial,
      ...(board.fromNote?{fromNote:true as const,boards}:{}), suggestions: reviewed, sectionsRead: completed, totalSections: sections.length, localOnly };
  } finally { signal.removeEventListener('abort', cancel); }
}
/** Promote existing open tasks in place; append only genuinely new actions, in one guarded write. */
export function applyInferredTickets(note: Note, board: TicketInferenceTarget, result: TicketInference,
  rows: TicketReviewRow[], availableBoards: NoteBoard[] = noteWork(note).boards): string | null {
  if (note.id !== board.noteId || result.noteId !== note.id || result.boardId !== board.id ||
      Boolean(result.fromNote) !== Boolean(board.fromNote) || note.body !== result.baseBody || note.title !== result.noteTitle ||
      (!board.fromNote && !noteWork(note).boards.some(b => b.id === board.id)) ||
      !rows.length || rows.length > MAX_INFERRED_TICKETS || new Set(rows.map(r => r.index)).size !== rows.length) return null;
  const work = noteWork(note), existing = new Set(work.tickets.map(t => ticketTitleKey(t.title)));
  let body = note.body;
  const pendingDetails = new Map<number, TicketSuggestion>();
  const additions: string[] = [], promoted = new Set<string>();
  for (const { index, title, urgency, boardId, dueDate, status } of rows) {
    const suggestion = result.suggestions[index];
    if (!Number.isInteger(index) || !suggestion || !validTicketTitle(title) || !validTicketUrgency(urgency) ||
        typeof dueDate !== 'string' || dueDate && !validCalendarDate(dueDate) ||
        !validTicketStatus(status) || status === 'done' || status.startsWith('column-') && status !== suggestion.existingStatus ||
        !board.fromNote && boardId !== board.id || boardId && availableBoards.filter(b => b.id === boardId).length !== 1) return null;
    const taskId = suggestion.taskId;
    if (taskId) {
      if (promoted.has(taskId) || !result.suggestions.some(s => s.taskId === taskId)) return null;
      const ticket = work.tickets.find(t => t.id === taskId && t.status !== 'done' && (!t.durable || !t.boardId || t.boardId === boardId));
      // A collected task keeps its original prose. Renaming it can happen directly in its card.
      if (!ticket || title !== existingTaskLabel(ticket.title)) return null;
      if (ticket.dueDate && ticket.dueDate !== dueDate || ticket.status !== 'todo' && ticket.status !== status) return null;
      const next = patchTicket(body, ticket, { boardId, urgency, dueDate, status }); if (next === null) return null;
      body = next; promoted.add(taskId);
      if (suggestion?.description || suggestion?.checklist?.length) pendingDetails.set(ticket.lineIndex, suggestion);
      continue;
    }
    const key = ticketTitleKey(title);
    if (!key || existing.has(key)) continue;
    existing.add(key); additions.push(newTicketMarkdown(title, boardId, status, dueDate, undefined, urgency) + ticketDetailSuffix(suggestion ?? {}));
  }
  // Resolve the promoted identities before inserting any lines. patchTicket then
  // locates each by ID. A parent must be filled before its captured child changes.
  if (pendingDetails.size) {
    const marked = noteWork({ ...note, body }).tickets.filter(t => t.durable && pendingDetails.has(t.lineIndex));
    if (marked.length !== pendingDetails.size) return null;
    for (const ticket of marked) {
      const next = patchTicket(body, ticket, { detail: { kind: 'fillMissing', fields: pendingDetails.get(ticket.lineIndex)! } });
      if (next === null) return null;
      body = next;
    }
  }
  if (additions.length) body = `${body.trimEnd()}\n\n${additions.join('\n')}\n`;
  return body !== note.body ? body : null;
}
