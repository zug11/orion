import type { AppSnapshot } from "../types";
import { dateKey, dateLabel, localDate, shiftDate } from "./calendarDate";
import { applyChatTextEdits } from "./chatEdits";
import { recognizeNoteDates, spokenCalendarDay, type CalendarEntry } from "./calendarRecognition";
import { collectWork, type Ticket } from "./tickets";
import { ticketTitleKey } from "./ticketInference";
import type { VoiceWorkResult } from "./voiceWorkspace";

type Entry = CalendarEntry & { ticket?: Ticket };

export { spokenCalendarDay };
export const dateLink = (date: string) => `[${dateLabel(date)}](orion-date://${date})`;

async function calendarEntries(space: AppSnapshot, current: () => boolean): Promise<Entry[]> {
  const entries: Entry[] = collectWork(space.notes).tickets.filter(ticket => ticket.dueDate && ticket.status !== "done")
    .map(ticket => ({ id: ticket.id, date: ticket.dueDate!, title: ticket.title, noteId: ticket.noteId, noteTitle: ticket.noteTitle, kind: "ticket", phrase: "", ticket }));
  let started = performance.now();
  for (const note of space.notes) {
    const scan = recognizeNoteDates(note);
    let next = scan.next();
    while (!next.done) {
      if (performance.now() - started >= 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!current()) return [];
        started = performance.now();
      }
      next = scan.next();
    }
    entries.push(...next.value.filter(entry => !entry.dismissalKey || !note.dismissedCalendarMentions?.includes(entry.dismissalKey)));
  }
  return entries.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

export function calendarQueryRange(filter: string, now: Date): [string, string] | undefined {
  const today = dateKey(now);
  if (!filter || /^(?:upcoming|coming up|next)$/i.test(filter)) return [today, "9999-12-31"];
  if (/^(?:all|everything)$/i.test(filter)) return ["1000-01-01", "9999-12-31"];
  const term = filter.replace(/^(?:for|on|during|over|in)\s+/i, "").replace(/^the\s+/i, "");
  const week = /^(this|next|last) week$/i.exec(term);
  if (week) {
    const start = shiftDate(today, -((now.getDay() + 6) % 7) + ({ this: 0, next: 7, last: -7 }[week[1].toLowerCase()] ?? 0));
    return [start, shiftDate(start, 6)];
  }
  const month = /^(this|next|last) month$/i.exec(term);
  if (month) {
    const start = localDate(today); start.setDate(1);
    start.setMonth(start.getMonth() + ({ this: 0, next: 1, last: -1 }[month[1].toLowerCase()] ?? 0));
    const first = dateKey(start); start.setMonth(start.getMonth() + 1);
    return [first, shiftDate(dateKey(start), -1)];
  }
  const day = spokenCalendarDay(term, now);
  if (day) return [day, day];
}

export async function readVoiceCalendar(space: AppSnapshot, filter: string, now: Date, current: () => boolean): Promise<VoiceWorkResult> {
  const range = calendarQueryRange(filter, now);
  if (!range) return { message: "Which day, week or month should I read from this Space’s calendar?" };
  const entries = (await calendarEntries(space, current)).filter(e => e.date <= range[1] && (e.endDate ?? e.date) >= range[0]);
  if (!entries.length) return { message: `There are no calendar entries ${filter || "coming up"} in ${space.workspace.name}.` };
  const rows = entries.slice(0, 8).map(e => `${dateLabel(e.date, true)}${e.endDate ? " to " + dateLabel(e.endDate, true) : ""}, ${e.title}${e.kind === "ticket" ? " (ticket due)" : e.kind === "mentioned" ? " (inferred from " + e.noteTitle + ")" : ""}`);
  return { message: `${entries.length} calendar ${entries.length === 1 ? "entry" : "entries"} in ${space.workspace.name}. ${rows.join(". ")}.${entries.length > rows.length ? " Those are the first eight." : ""}` };
}

export async function moveVoiceDate(space: AppSnapshot, reference: string, date: string, current: () => boolean, matchedTicket?: Ticket, eventOnly = false): Promise<VoiceWorkResult> {
  const title = ticketTitleKey(reference.replace(/^(?:(?:the|my|our|calendar|event|entry|appointment|meeting)\s+)+/i, "").replace(/\s+(?:calendar (?:event|entry)|event|appointment)$/i, ""));
  if (!title) return { message: "Which calendar entry should I move? Say its title and the new date." };
  const entries = (await calendarEntries(space, current)).filter(e => e.kind !== "ticket");
  const named = entries.filter(e => ticketTitleKey(e.title) === title);
  const matches = named.length ? named : entries.filter(e => title.split(" ").every(word => ticketTitleKey(e.title).split(" ").includes(word)));
  if (matchedTicket && !eventOnly) matches.push({ id: matchedTicket.id, date: matchedTicket.dueDate ?? "", title: matchedTicket.title, noteId: matchedTicket.noteId, noteTitle: matchedTicket.noteTitle, kind: "ticket", phrase: "", ticket: matchedTicket });
  if (matches.length !== 1) return { message: matches.length
    ? `Several calendar entries match. ${matches.slice(0, 3).map(e => e.title + " in " + e.noteTitle).join(". ")}. Repeat the move with a distinctive title.`
    : `I couldn’t find “${reference}” in this Space’s calendar.` };
  const [entry] = matches;
  if (entry.kind === "mentioned") {
    const notes = space.notes.filter(n => n.id === entry.noteId);
    const [note] = notes, span = entry.sourceRange;
    if (notes.length === 1 && !entry.endDate && span && note.body.slice(span.from, span.to) === entry.phrase) {
      const before = entry.phrase.replace(/^(?:on|by|until|since|from|before|after)\s+(?:the\s+)?/i, "");
      const edits = [{ before, after: dateLabel(date) }];
      try {
        applyChatTextEdits(note.body, edits);
        return { message: `Review the proposed date change in “${entry.noteTitle}”. Accept it to update the calendar.`,
          proposal: { spaceId: space.workspace.id, noteId: note.id, title: entry.noteTitle, mode: "focused", baseBody: note.body, edits } };
      } catch { /* Duplicate wording, retained evidence and metadata cannot be edited. */ }
    }
    return { message: `I couldn’t isolate one editable date for “${entry.phrase}” in “${entry.noteTitle}”. Open that note and select the passage to reschedule it.` };
  }
  const message = `Moved “${entry.title}” to ${dateLabel(date)}.`;
  if (entry.ticket) return { message, write: { kind: "patchTicket", spaceId: space.workspace.id, ticket: entry.ticket, patch: { dueDate: date } } };
  const note = space.notes.find(n => n.id === entry.noteId);
  if (!note || !entry.sourceRange) return { message: "I couldn’t locate the original date link. Open its note and try again." };
  const { from, to } = entry.sourceRange;
  const original = note.body.slice(from, to);
  // Reference-style links may share a definition. An inline replacement changes only this occurrence.
  return { message, write: { kind: "moveDate", spaceId: space.workspace.id, note, from, to, original, replacement: dateLink(date), oldDate: entry.date, newDate: date } };
}
