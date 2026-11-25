import type { AppSnapshot, ChatEditProposal, Note } from "../types";
import { dateKey, dateLabel } from "./calendarDate";
import { displayNoteTitle } from "./noteMetadata";
import { ticketCode } from "./ticketCodes";
import { ticketDetails } from "./ticketDetails";
import { ticketTitleKey, validTicketTitle } from "./ticketInference";
import { boardColumns, collectWork, newTicketMarkdown, type NoteBoard, type Ticket, type TicketPatch, type TicketStatus } from "./tickets";
import type { VoiceTurn } from "./voiceConversation";
import { matchSpokenTickets, spokenTicketAnchor, spokenTicketChoices, uniqueVoiceTicket } from "./voiceTicketCompletion";

export type VoiceWorkWrite =
  | { kind: "patchTicket"; spaceId: string; ticket: Ticket; patch: TicketPatch; board?: NoteBoard }
  | { kind: "append"; spaceId: string; note?: Note; newNoteTitle?: string; markdown: string; board?: NoteBoard }
  | { kind: "moveDate"; spaceId: string; note: Note; from: number; to: number; original: string; replacement: string; oldDate: string; newDate: string };
export interface VoiceWorkResult { message: string; write?: VoiceWorkWrite; proposal?: ChatEditProposal }
type Request =
  | { kind: "calendar" | "tickets"; filter: string }
  | { kind: "createTicket" | "createDate"; text: string }
  | { kind: "move"; target: string; destination: string; dateOnly: boolean }
  | { kind: "externalCalendar" };

const readVerb = /^(?:read(?: out)?|show(?: me)?|list|tell me(?: about)?|what(?:'s| is| are| do (?:i|we) have)?|which|do (?:i|we) have)(?:\s|$)/i;
const ticketList = /^(?:(?:all(?: of)?|any|my|our|the|this space's|open|completed|done|overdue|in[ -]progress|to[ -]do)\s+)*tickets?\b/i;
const calendarNoun = /^(?:(?:coming up |scheduled )?(?:in|on)\s+)?(?:(?:the|my|our|this space's)\s+)?(?:calendar|schedule|agenda)\b/i;
const calendarWrite = /^(?:calendar\s+(?:event|entry)|event|appointment)\b/i;
const looksLikeDate = /^(?:on\s+)?(?:today|tomorrow|yesterday|(?:this|next|last)\s+|(?:mon|tues?|wed(?:nes)?|thur?s?|fri|sat(?:ur)?|sun)(?:day)?\b|\d|the\s+\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;

function stripCourtesy(prompt: string) {
  return prompt.trim().replace(/’/g, "'").replace(/[.!?]+$/, "").replace(/(?:,?\s+(?:for me|please|thanks))+$/i, "")
    .replace(/^(?:(?:hey|ok|okay|so|orion|please)[,\s]+)*(?:(?:can|could|would|will) you\s+)?(?:(?:please|just|go ahead and)[,\s]+)*/i, "").trim();
}

/** A complete human utterance authorizes a local command. Provider tool arguments and note text never enter here. */
export function voiceWorkspaceRequest(prompt: string, space: AppSnapshot): Request | undefined {
  if (!prompt || prompt.length > 2_000 || /[\r\n]/.test(prompt)) return;
  const command = stripCourtesy(prompt);
  const externalCalendar = /\b(?:(?:google|outlook|apple|icloud|exchange)(?:[’']s)?\s+calendars?|calendars?\s+(?:in|on|from)\s+(?:google|outlook|apple|icloud|exchange))\b/i;
  if (externalCalendar.test(command) && (readVerb.test(command) || /^(?:create|add|make|schedule|put|move|reschedule|set|change|push|shift)\b/i.test(command))) {
    return { kind: "externalCalendar" };
  }
  const read = readVerb.exec(command);
  if (read) {
    const subject = command.slice(read[0].length).trim();
    if (/^due(?:\s|$)/i.test(subject)) return { kind: "tickets", filter: "tickets " + subject };
    const calendar = calendarNoun.exec(subject);
    if (calendar) return { kind: "calendar", filter: subject.slice(calendar[0].length).trim() };
    const dated = /^(?:scheduled\s+|coming up\s+|on\s+|(?:i|we) have\s+)?(.+)$/i.exec(subject);
    if (dated && /^(?:what|do (?:i|we) have)/i.test(command) && looksLikeDate.test(dated[1])) return { kind: "calendar", filter: dated[1] };
    if (ticketList.test(subject)) return { kind: "tickets", filter: subject };
    return;
  }
  if (/\b(?:if|unless|maybe|perhaps|instead of|don't|do not|and (?:then |also )?(?:create|schedule|move|delete|mark|send|add|put|set|make|reschedule))\b/i.test(command)) return;
  const openExisting = /^open\s+(?:(?:the|my|our)\s+)?(ticket\s+.+)$/i.exec(command);
  if (openExisting) return { kind: "tickets", filter: openExisting[1] };
  const create = /^(?:create|make|add|open)\s+(?:(?:me|a|an|new|another)\s+)*(ticket|calendar event|calendar entry|event|appointment)\b\s*(.*)$/i.exec(command);
  if (create) return { kind: create[1].toLowerCase() === "ticket" ? "createTicket" : "createDate", text: create[2] };
  const schedule = /^schedule\s+(?:(?:an?|the)\s+)?(.+)$/i.exec(command);
  if (schedule && !/^ticket\b/i.test(schedule[1])) return { kind: "createDate", text: schedule[1].replace(calendarWrite, "").trim() };
  const onCalendar = /^(?:put|add)\s+(.+?)\s+(?:on|to)\s+(?:my|the|our) calendar(?:\s+(.+))?$/i.exec(command);
  if (onCalendar) return { kind: "createDate", text: [onCalendar[1], onCalendar[2]].filter(Boolean).join(" ") };
  const moving = /^(move|put|shift|push|reschedule|set|change)\s+(.+)\s+(?:to|into)\s+(.+)$/i.exec(command) ??
    /^(move|put|shift|push|reschedule|set|change)\s+(.+)\s+(?:for|as|in)\s+(.+)$/i.exec(command);
  if (moving) {
    const [, verb, reference, destination] = moving;
    const target = reference.replace(/\s+(?:over|back)$/i, "");
    const dateOnly = /^(?:reschedule|push|shift)$/i.test(verb) || /\b(?:deadline|due date|appointment|event|meeting)\b/i.test(target);
    if (dateOnly || /\b(?:ticket|card|board|column)\b/i.test(target + " " + destination) || looksLikeDate.test(destination) ||
        /^(?:the )?(?:to[ -]?do|in[ -]progress|backlog|doing)$/i.test(destination) ||
        matchSpokenTickets(space, spokenTicketChoices(space), target).length) return { kind: "move", target, destination, dateOnly };
  }
}

function bare(text: string) {
  return text.trim().replace(/^(?:(?:called|named|titled|for|to)\s+)+/i, "").replace(/^["“](.*)["”]$/, "$1").trim();
}

function noteOrBoardName(text: string) {
  return bare(text).replace(/^the\s+/i, "");
}
function matchesBoard(boards: NoteBoard[], name: string) {
  const key = ticketTitleKey(noteOrBoardName(name.replace(/^(?:the\s+)?board\s+(?:called\s+)?|\s+board$/gi, "")));
  return boards.filter(board => ticketTitleKey(board.title) === key);
}
function boardProblem(name: string): VoiceWorkResult {
  return { message: `I couldn’t identify one board called “${name}” in this Space. Repeat the request with its full board name.` };
}
function nameList(items: string[]) { return items.slice(0, 8).join(". ") + (items.length > 8 ? ". Those are the first eight" : ""); }

function findTickets(space: AppSnapshot, ref: string, focused?: string) {
  const tickets = spokenTicketChoices(space);
  const anchor = spokenTicketAnchor(ref);
  return anchor ? tickets.filter(t => anchor !== "recent" && t.id === focused) : matchSpokenTickets(space, tickets, ref);
}
function ambiguousTickets(space: AppSnapshot, tickets: Ticket[]): VoiceWorkResult {
  return { message: tickets.length
    ? `Several tickets match. ${nameList(tickets.map(t => t.title + " (" + (ticketCode(space.ticketCodes, t.id) || t.noteTitle) + ")"))}. Repeat the request with the ticket’s code or a more distinctive title.`
    : "Which ticket did you mean? Repeat the request with its title or code." };
}
function columnKey(text: string) {
  const name = ticketTitleKey(text.replace(/^(?:the\s+)?column\s+|\s+column$/gi, "").replace(/^the\s+/i, ""));
  if (["todo", "to do", "reopened", "open"].includes(name)) return "to do";
  if (["progress", "in progress", "doing", "started"].includes(name)) return "in progress";
  return name;
}
function ticketStatus(ticket: Ticket, boards: NoteBoard[]) {
  const board = boards.find(b => b.id === ticket.boardId);
  return boardColumns(board ?? {}).find(([id]) => id === ticket.status)?.[1] ?? ticket.status;
}

async function readTickets(space: AppSnapshot, query: string, focused: string | undefined, now: Date): Promise<VoiceWorkResult> {
  const due = /\s+(?:are\s+)?due(?:\s+(.*))?$/i.exec(query);
  let range: [string, string] | undefined;
  if (due) {
    const { calendarQueryRange } = await import("./voiceCalendar");
    range = calendarQueryRange(due[1] || "all", now);
    if (!range) return { message: "Which day, week or month should I check for ticket deadlines?" };
    query = query.slice(0, due.index);
  }
  const { boards } = collectWork(space.notes);
  const boardFilter = /\s+(?:on|in(?! progress\b)|from)\s+(.+?)(?:\s+board)?$/i.exec(query);
  const board = boardFilter ? matchesBoard(boards, boardFilter[1]) : [];
  if (boardFilter && board.length !== 1) return boardProblem(boardFilter[1]);
  const filter = (boardFilter ? query.slice(0, boardFilter.index) : query).replace(/\s+(?:do (?:i|we) have|are(?: (?:open|there))?)$/i, "").trim();
  const after = /\btickets?\s+(?:(?:called|named|about|for)\s+)?(.+)$/i.exec(filter)?.[1];
  let tickets = spokenTicketChoices(space).filter(ticket => !boardFilter || ticket.boardId === board[0].id);
  if (after && !/^(?:are\s+)?(?:open|done|completed|overdue|in progress|to do)$/i.test(after)) {
    const named = findTickets(space, after, focused).filter(t => tickets.some(ticket => t.id === ticket.id));
    if (named.length !== 1) return ambiguousTickets(space, named);
    const [ticket] = named, details = ticketDetails(ticket);
    return { message: [ticket.title, ticketStatus(ticket, boards), ticket.dueDate && "Due " + dateLabel(ticket.dueDate), details?.descriptionText, ...(details?.checklist ?? []).slice(0, 5).map(item => (item.checked ? "Done, " : "To do, ") + item.text)].filter(Boolean).join(". ") + "." };
  }
  const key = ticketTitleKey(filter);
  if (/\b(?:done|completed)\b/.test(key)) tickets = tickets.filter(t => t.status === "done");
  else if (!/\ball\b/.test(key)) tickets = tickets.filter(t => t.status !== "done");
  if (/\bin progress\b/.test(key)) tickets = tickets.filter(t => t.status === "progress");
  if (/\bto do\b/.test(key)) tickets = tickets.filter(t => t.status === "todo");
  if (/\boverdue\b/.test(key)) {
    const today = dateKey(now);
    tickets = tickets.filter(t => t.dueDate && t.dueDate < today);
  }
  if (range) {
    const [start, end] = range;
    tickets = tickets.filter(t => t.dueDate && start <= t.dueDate && t.dueDate <= end)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  }
  return { message: tickets.length ? `${tickets.length} matching ${tickets.length === 1 ? "ticket" : "tickets"}. ${nameList(tickets.map(t => t.title + ", " + (due && t.dueDate ? "due " + dateLabel(t.dueDate, true) : ticketStatus(t, boards))))}.` : "There are no matching tickets in this Space." };
}

function destinationNote(space: AppSnapshot, focus: string | undefined, explicit: string | undefined, board: NoteBoard | undefined, defaultName: string) {
  const title = explicit ?? defaultName;
  if (explicit || !focus && !board) {
    const found = space.notes.filter(n => ticketTitleKey(n.title) === ticketTitleKey(title));
    if (found.length === 1) return { note: found[0] };
    if (explicit || found.length > 1) return { message: `I couldn’t identify one note named “${title}”. Repeat the request with its full note title.` };
    return { newNoteTitle: defaultName };
  }
  const found = space.notes.filter(n => n.id === (board?.noteId ?? focus));
  return found.length === 1 ? { note: found[0] } : { message: "The note where you started speaking is no longer available." };
}

function splitDate(text: string, ticket: boolean) {
  // A deadline is optional on a ticket. A calendar addition always needs a day.
  const date = (ticket ? /\s+(?:due(?:\s+(?:on|by))?|by)\s+(.+)$/i : /\s+(?:on|for)\s+(.+)$/i).exec(text);
  if (date) return { title: text.slice(0, date.index), phrase: date[1] };
  if (!ticket) {
    const relative = /\s+((?:(?:this|next)\s+)?(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*)$/i.exec(text);
    if (relative) return { title: text.slice(0, relative.index), phrase: relative[1] };
  }
  return { title: text, phrase: "" };
}

async function create(space: AppSnapshot, request: Extract<Request, {text: string}>, focus: string | undefined, now: Date): Promise<VoiceWorkResult> {
  const ticket = request.kind === "createTicket";
  let text = bare(request.text);
  let board: NoteBoard | undefined, noteName: string | undefined;
  // Peel the explicitly labelled owners from the end. Unlabelled words stay in the title.
  const ownership = /\s+(?:in|on|under)\s+(?:the\s+)?(?:(board|note)\s+(?:called\s+)?(.+?)|((?:(?!\s+(?:in|on|under|by|for|due)\s+).)+?)\s+(board|note))(?=\s+(?:in|on|under|due(?: on| by)?|by|for)\s+|$)/i;
  for (let i = 0; i < 2; i++) {
    const named = ownership.exec(text);
    if (!named) break;
    const type = (named[1] || named[4]).toLowerCase(), name = noteOrBoardName(named[2] || named[3]);
    if (type === "board") {
      const matches = matchesBoard(collectWork(space.notes).boards, name);
      if (!ticket || board || matches.length !== 1) return boardProblem(name);
      board = matches[0];
    } else {
      if (noteName) return { message: "Which one note should hold this item?" };
      noteName = name;
    }
    text = (text.slice(0, named.index) + text.slice(named.index + named[0].length)).trim();
  }
  if (!ticket && /\b(?:at\s+\d|\d{1,2}(?::\d{2}|\s*(?:am|pm))\b|noon|midnight|o.clock|every\s+(?:day|week|month))/.test(text.toLowerCase())) {
    return { message: "Orion’s Space calendar uses individual all-day entries. Repeat the request with one day." };
  }
  const { title: rawTitle, phrase } = splitDate(text, ticket);
  const title = bare(rawTitle);
  if (!validTicketTitle(title)) return { message: `What short title should I use for the ${ticket ? "ticket" : "calendar entry"}? Repeat the request with its title.` };
  const calendar = phrase || !ticket ? await import("./voiceCalendar") : undefined;
  const date = phrase && calendar?.spokenCalendarDay(phrase, now);
  if ((phrase || !ticket) && !date) return { message: "Orion’s Space calendar uses all-day dates. Repeat the request with one day, such as Friday." };
  const destination = destinationNote(space, focus, noteName, board, ticket ? "Tickets" : "Calendar");
  if (destination.message) return { message: destination.message };
  const markdown = ticket ? newTicketMarkdown(title, board?.id, "todo", date || "") :
    title.replace(/[\\`*_[\]<>#~!+|.\-]/g, "\\$&") + " — " + calendar!.dateLink(date!);
  const owner = destination.note ? displayNoteTitle(destination.note) : destination.newNoteTitle;
  return { message: `Added “${title}”${board ? " to the " + board.title + " board" : ""}${date ? " for " + dateLabel(date) : ""} in “${owner}”.`,
    write: { kind: "append", spaceId: space.workspace.id, note: destination.note, newNoteTitle: destination.newNoteTitle, markdown, board } };
}

async function move(space: AppSnapshot, request: Extract<Request, {kind:"move"}>, turn: Pick<VoiceTurn, "focusedTicketId">, now: Date, current: () => boolean): Promise<VoiceWorkResult> {
  const target = request.target.replace(/^(?:the\s+)?(?:deadline|due date)\s+(?:for|of|on)\s+/i, "").replace(/(?:'s)?\s+(?:deadline|due date)$/i, "");
  const explicitlyEvent = /\b(?:calendar (?:event|entry)|event|appointment)\b/i.test(target);
  const explicitlyTicket = /\b(?:ticket|card|due date|deadline)\b/i.test(request.target);
  const matches = explicitlyEvent ? [] : findTickets(space, target, turn.focusedTicketId);
  if (matches.length > 1 || matches.length === 1 && !uniqueVoiceTicket(space, matches[0])) return ambiguousTickets(space, matches);
  const ticket = matches[0], boards = collectWork(space.notes).boards;
  const calendar = request.dateOnly || looksLikeDate.test(request.destination) ? await import("./voiceCalendar") : undefined;
  const date = calendar?.spokenCalendarDay(request.destination, now);
  if (date && !explicitlyTicket && !spokenTicketAnchor(target)) {
    return calendar!.moveVoiceDate(space, target, date, current, ticket, explicitlyEvent);
  }
  if (calendar && !date) return { message: "Please use one all-day date for the move, such as Friday." };
  if (!ticket) return ambiguousTickets(space, matches);
  if (date) return { message: `“${ticket.title}” is due ${dateLabel(date)}.`, write: { kind: "patchTicket", spaceId: space.workspace.id, ticket, patch: { dueDate: date } } };
  const onBoard = /^(.+?)\s+(?:on|in)\s+(?:the\s+)?(.+?)(?:\s+board)?$/i.exec(request.destination);
  const name = onBoard?.[2] ?? request.destination;
  const matchingBoards = matchesBoard(boards, name);
  const explicitlyBoard = /\bboard\b/i.test(name) || !!onBoard;
  if ((explicitlyBoard || matchingBoards.length) && matchingBoards.length !== 1) return boardProblem(name);
  const destBoard = matchingBoards[0], existingBoard = boards.find(b => b.id === ticket.boardId);
  const rawColumn = onBoard?.[1] ?? request.destination;
  const columns = boardColumns(destBoard ?? existingBoard ?? {}).filter(([id, title]) => columnKey(rawColumn) === columnKey(title) || columnKey(rawColumn) === columnKey(id));
  if (!explicitlyBoard && destBoard && columns.length) return { message: "That name matches a board and a column. Say which one you want." };
  let status: TicketStatus | undefined;
  if (!destBoard || onBoard) {
    if (columns.length !== 1) return { message: `I couldn’t identify “${rawColumn}” as a single column. Say the board or column name again.` };
    status = columns[0][0];
  } else if (ticket.status.startsWith("column-") && !boardColumns(destBoard).some(([id]) => id === ticket.status)) status = "todo";
  const patch: TicketPatch = { ...(destBoard && { boardId: destBoard.id }), ...(status && { status }) };
  return { message: `Moved “${ticket.title}” to ${onBoard ? onBoard[1] + " on " : ""}${destBoard?.title ?? columns[0][1]}.`, write: { kind: "patchTicket", spaceId: space.workspace.id, ticket, patch, board: destBoard ?? existingBoard } };
}

export async function resolveVoiceWorkspace(space: AppSnapshot, request: Request, turn: Pick<VoiceTurn, "focusNoteId" | "focusedTicketId">, now: Date, current: () => boolean): Promise<VoiceWorkResult> {
  switch (request.kind) {
    case "externalCalendar": return { message: "Orion voice can read and edit the calendar in this Space. To use it, ask for a Space calendar entry." };
    case "tickets": return readTickets(space, request.filter, turn.focusedTicketId, now);
    case "calendar": return (await import("./voiceCalendar")).readVoiceCalendar(space, request.filter, now, current);
    case "createDate": case "createTicket": return create(space, request, turn.focusNoteId, now);
    case "move": return move(space, request, turn, now, current);

  }
}

/** A queued append may follow an earlier append into the same note. Resolve
 * storage again, retaining every note/board identity bound by the human turn. */
export async function refreshVoiceCreation(captured: AppSnapshot, latest: AppSnapshot, request: Extract<Request, {text: string}>,
  turn: Pick<VoiceTurn, "focusNoteId">, now: Date, original: VoiceWorkResult): Promise<VoiceWorkResult> {
  if (captured === latest || original.write?.kind !== "append") return original;
  const refreshed = await create(latest, request, turn.focusNoteId, now);
  const previous = original.write, next = refreshed.write;
  if (next?.kind !== "append") return refreshed;
  const sameNote = !previous.note || previous.note.id === next.note?.id && previous.note.createdAt === next.note?.createdAt;
  const sameBoard = previous.board?.id === next.board?.id && previous.board?.noteId === next.board?.noteId;
  if (previous.spaceId !== latest.workspace.id || !sameNote || !sameBoard) return { message: "The destination changed while the request was waiting. Repeat the request in the current Space." };
  return { ...refreshed, write: { ...next, markdown: previous.markdown } };
}
