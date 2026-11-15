import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, CalendarDays, X } from '../lib/icons';
import { dateKey, dateLabel, localDate, shiftDate, shiftMonth, validCalendarDate } from '../lib/calendarDate';
import './Calendar.css';

export function CalendarGrid({ value, onSelect, marks, autoFocus = false, onMonthChange }: {
  value: string; onSelect: (date: string) => void; marks?: ReadonlySet<string>; autoFocus?: boolean; onMonthChange?: (month: string) => void;
}) {
  const [focus, setFocus] = useState(value);
  const [month, setMonth] = useState(value.slice(0, 7));
  const root = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(autoFocus);
  const labelId = useId();
  useEffect(() => { setFocus(value); setMonth(value.slice(0, 7)); }, [value]);
  useEffect(() => { onMonthChange?.(month); }, [month, onMonthChange]);
  useLayoutEffect(() => {
    if (focusRequested.current) { root.current?.querySelector<HTMLButtonElement>(`[data-date="${focus}"]`)?.focus({ preventScroll: true }); focusRequested.current = false; }
  }, [focus, month]);
  const move = (date: string, focusDay = true) => {
    if (!validCalendarDate(date)) return;
    focusRequested.current = focusDay; setFocus(date); setMonth(date.slice(0, 7));
  };
  const first = `${month}-01`;
  const start = shiftDate(first, -(localDate(first).getDay() + 6) % 7);
  const today = dateKey(new Date());
  return <div className="calendar-grid" ref={root}>
    <header><h3 id={labelId} aria-live="polite">{localDate(first).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' })}</h3>
      <button className="icon-button" type="button" aria-label="Previous month" onClick={() => move(shiftMonth(focus, -1), false)}><ArrowLeft size={14}/></button>
      <button className="icon-button" type="button" aria-label="Next month" onClick={() => move(shiftMonth(focus, 1), false)}><ArrowRight size={14}/></button>
    </header>
    <div role="grid" aria-labelledby={labelId} onKeyDown={event => {
      if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
      const weekday = (localDate(focus).getDay() + 6) % 7;
      const delta: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -weekday, End: 6 - weekday };
      const next = event.key in delta ? shiftDate(focus, delta[event.key]) : event.key === 'PageUp' ? shiftMonth(focus, -1) : event.key === 'PageDown' ? shiftMonth(focus, 1) : null;
      if (next) { event.preventDefault(); event.stopPropagation(); move(next); }
    }}>
      <div role="row" className="calendar-week">{['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(day => <span role="columnheader" key={day}>{day}</span>)}</div>
      {Array.from({ length: 6 }, (_, week) => <div role="row" className="calendar-week" key={week}>
        {Array.from({ length: 7 }, (_, day) => {
          const key = shiftDate(start, week * 7 + day), marked = marks?.has(key);
          return <div role="gridcell" key={key} aria-selected={key === value}><button type="button" data-date={key} tabIndex={key === focus ? 0 : -1}
            className={`${key.slice(0, 7) !== month ? 'outside' : ''}${marked ? ' has-dates' : ''}`} aria-current={key === today ? 'date' : undefined}
            aria-label={`${dateLabel(key)}${marked ? ', has entries' : ''}`} onFocus={() => setFocus(key)} onClick={() => { move(key, false); onSelect(key); }}>{localDate(key).getDate()}</button></div>;
        })}
      </div>)}
    </div>
    <button type="button" className="text-button calendar-today" onClick={() => { move(today); onSelect(today); }}>Today</button>
  </div>;
}

export function CalendarPicker({ value, title = 'Choose a date', onChoose, onClose, allowClear = false }: {
  value?: string; title?: string; onChoose: (date: string) => boolean | void; onClose: () => void; allowClear?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState(false);
  useLayoutEffect(() => { const node = dialog.current; node?.showModal(); node?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus(); return () => node?.close(); }, []);
  const choose = (date: string) => { if (onChoose(date) === false) setError(true); else onClose(); };
  return createPortal(<dialog ref={dialog} className="calendar-picker" aria-label={title} onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="calendar-picker-title"><span>{title}</span><button className="icon-button" aria-label="Close calendar" type="button" onClick={onClose}><X size={15}/></button></header>
    <CalendarGrid value={value && validCalendarDate(value) ? value : dateKey(new Date())} onSelect={choose}/>
    {allowClear && value && <button type="button" className="text-button calendar-clear" onClick={() => choose('')}>Remove date</button>}
    <p className="calendar-help">Arrow keys to move · Enter to choose · Esc to close</p>
    {error && <p role="alert" className="ticket-error">This item changed. Close the calendar and try again.</p>}
  </dialog>, document.body);
}

export function DateButton({ value, label = 'Due date', onChange }: { value?: string; label?: string; onChange: (date: string) => boolean | void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return <><button ref={button} type="button" className={`ticket-date${value ? ' has-date' : ''}`} aria-label={`${label}${value ? `: ${dateLabel(value)}` : ''}`} aria-haspopup="dialog" onClick={() => setOpen(true)}><CalendarDays size={13}/>{value ? dateLabel(value, true) : 'Add date'}</button>
    {open && <CalendarPicker value={value} title={label} allowClear onChoose={onChange} onClose={() => { setOpen(false); button.current?.focus({ preventScroll: true }); }}/>}</>;
}
