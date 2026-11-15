import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Note } from '../types';
import type { CalendarEntry } from '../lib/calendarRecognition';
import type { collectWork } from '../lib/tickets';
import { dateKey, dateLabel, shiftDate } from '../lib/calendarDate';
import { CalendarGrid } from './CalendarPicker';
import type { DismissCalendarMention } from '../lib/calendarDismissal';
import { X } from '../lib/icons';

// Dismissal-only saves must reuse the completed scan, including long notes.
function sameCalendarInputs(a: readonly Note[], b: readonly Note[]) {
  return a.length === b.length && a.every((note, index) => {
    const other = b[index];
    return note === other || note.id === other.id && note.title === other.title && note.body === other.body && note.updatedAt === other.updatedAt;
  });
}

export function HomeCalendar({ notes, work, onOpenNote, onDismissCalendarMention, focusFallback }: {
  notes: readonly Note[]; work: ReturnType<typeof collectWork>; onOpenNote: (id: string) => void;
  onDismissCalendarMention?: DismissCalendarMention;
  focusFallback?: RefObject<HTMLElement | null>;
}) {
  const [index, setIndex] = useState<{ notes: readonly Note[]; entries: CalendarEntry[] } | null>(null);
  const [selected, setSelected] = useState(dateKey(new Date()));
  const [month, setMonth] = useState(selected.slice(0, 7));
  const [dayOnly, setDayOnly] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLElement>(null);
  const restoreFocus = useRef<number | null>(null);
  const notesById = useMemo(() => new Map(notes.map(note => [note.id, note])), [notes]);
  const indexCurrent = Boolean(index && sameCalendarInputs(index.notes, notes));
  const changeMonth = useCallback((next: string) => { setMonth(next); if (next !== selected.slice(0, 7)) setDayOnly(false); }, [selected]);
  useEffect(() => {
    if (index && sameCalendarInputs(index.notes, notes)) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    void import('../lib/calendarRecognition').then(({ recognizeNoteDates }) => {
      const entries: CalendarEntry[] = [];
      let next = 0, iterator: ReturnType<typeof recognizeNoteDates> | null = null;
      const batch = () => {
        if (cancelled) return;
        const started = performance.now();
        do {
          if (!iterator && next < notes.length) iterator = recognizeNoteDates(notes[next++]);
          if (!iterator) { setIndex({ notes, entries }); return; }
          const result = iterator.next();
          if (result.done) { entries.push(...result.value); iterator = null; }
        } while (performance.now() - started < 8);
        timer = setTimeout(batch, 16);
      };
      timer = setTimeout(batch, 0);
    }).catch(() => { /* A failed optional index never disrupts Home or editing. */ });
    return () => { cancelled = true; clearTimeout(timer); };
  }, [notes, index]);
  const entries = useMemo<CalendarEntry[]>(() => [
    ...(indexCurrent ? index!.entries.filter(entry => entry.kind !== 'mentioned' || !entry.dismissalKey || !notesById.get(entry.noteId)?.dismissedCalendarMentions?.includes(entry.dismissalKey)) : []),
    ...work.tickets.filter(t => t.dueDate && t.status !== 'done').map(t => ({ id: `${t.noteId}:${t.id}`, date: t.dueDate!, noteId: t.noteId,
      noteTitle: t.origin === 'board' ? '' : t.noteTitle, title: t.title, phrase: '', kind: 'ticket' as const })),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)), [index, indexCurrent, notesById, work]);
  const marks = useMemo(() => {
    const marked = new Set<string>();
    // Mark the visible month only, even for historical multi-year ranges.
    for (let date = `${month}-01`; date.slice(0, 7) === month; date = shiftDate(date, 1)) {
      if (entries.some(entry => entry.date <= date && (entry.endDate ?? entry.date) >= date)) marked.add(date);
    }
    return marked;
  }, [entries, month]);
  // Historical mentions remain browseable, but do not keep an otherwise empty
  // dashboard calendar alive. "Current" includes the whole current month.
  const currentMonthStart = `${dateKey(new Date()).slice(0, 7)}-01`;
  const hasCurrentDates = entries.some(entry => entry.kind === 'ticket' || (entry.endDate ?? entry.date) >= currentMonthStart);
  useLayoutEffect(() => {
    if (restoreFocus.current === null) return;
    const buttons = root.current?.querySelectorAll<HTMLButtonElement>('.calendar-entry') ?? [];
    const next = buttons[Math.min(restoreFocus.current, buttons.length - 1)];
    (next ?? root.current?.querySelector<HTMLButtonElement>('.calendar-today') ?? focusFallback?.current)?.focus({ preventScroll: true });
    restoreFocus.current = null;
  }, [entries, hasCurrentDates, focusFallback]);
  if (!hasCurrentDates) return null;
  const visible = entries.filter(entry => dayOnly ? entry.date <= selected && (entry.endDate ?? entry.date) >= selected
    : entry.date.slice(0, 7) <= month && (entry.endDate ?? entry.date).slice(0, 7) >= month);
  function dismiss(entry: CalendarEntry, position: number) {
    const note = notesById.get(entry.noteId);
    if (!note || !entry.dismissalKey || !onDismissCalendarMention) return;
    restoreFocus.current = position;
    if (!onDismissCalendarMention(note, entry.dismissalKey)) {
      restoreFocus.current = null;
      setError('This date changed. Try removing it again.');
    } else setError('');
  }
  return <section ref={root} className="home-calendar" aria-label="Calendar">
    <header className="home-calendar-heading"><h2>Calendar <span>{entries.length} {entries.length === 1 ? 'date' : 'dates'}</span></h2><span>From your notes and tickets</span></header>
    <div className="home-calendar-body">
      <CalendarGrid value={selected} onSelect={date => { setSelected(date); setDayOnly(true); }} marks={marks} onMonthChange={changeMonth}/>
      <div className="calendar-agenda"><header><h3>{dayOnly ? dateLabel(selected) : 'This month'}</h3>{dayOnly && <button type="button" className="text-button" onClick={() => setDayOnly(false)}>Show month</button>}</header>
        <div className="calendar-entries">
          {visible.map((entry, position) => <div className="calendar-entry-row" key={entry.id}><button type="button" className="calendar-entry" onClick={() => onOpenNote(entry.noteId)}>
            <time dateTime={entry.date}>{dateLabel(entry.date, true)}{entry.endDate ? ` – ${dateLabel(entry.endDate, true)}` : ''}</time>
            <span><strong>{entry.title}</strong><small>{entry.noteTitle && `${entry.noteTitle} · `}<span className={`calendar-kind is-${entry.kind}`} title={entry.kind === 'mentioned' ? `Inferred from “${entry.phrase}”, relative to the note saved on ${dateLabel(entry.referenceDate!)}. This is a mention, not a deadline.` : undefined}>{entry.kind === 'mentioned' ? 'Inferred' : entry.kind === 'ticket' ? 'Due' : 'Picked date'}</span></small></span>
          </button>{entry.kind === 'mentioned' && entry.dismissalKey && onDismissCalendarMention && <button type="button" className="calendar-dismiss" aria-label={`Remove inferred date ${dateLabel(entry.date)}: ${entry.phrase}`} title="Remove from calendar; keep the note text" onClick={() => dismiss(entry, position)}><X size={14} aria-hidden="true"/></button>}</div>)}
          {!visible.length && <p className="calendar-empty">No dates {dayOnly ? 'on this day' : 'this month'}.</p>}
        </div>
        {error && <p role="alert" className="ticket-error">{error}</p>}
      </div>
    </div>
  </section>;
}
