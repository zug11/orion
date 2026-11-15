// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from '../types';
import * as recognition from '../lib/calendarRecognition';
import { dismissCalendarMention, restoreCalendarMention } from '../lib/calendarDismissal';
import { collectWork, newTicketMarkdown } from '../lib/tickets';
import { HomeCalendar } from './HomeCalendar';

const note = (body: string, id = 'n'): Note => ({ id, title: 'Plans', body, slug: id, summary: '', kind: 'article', status: 'ready',
  aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' });
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 15, 12)); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

function fixture(body: string, fail = false) {
  const original = note(body);
  let latest = original;
  const open = vi.fn();
  function Fixture() {
    const [current, setCurrent] = useState(original);
    const [lastKey, setLastKey] = useState('');
    const fallback = useRef<HTMLDivElement>(null);
    latest = current;
    return <div ref={fallback} tabIndex={-1} data-testid="home-work">
      <HomeCalendar notes={[current]} work={collectWork([current])} onOpenNote={open} focusFallback={fallback}
        onDismissCalendarMention={(captured, key) => {
          if (fail) return false;
          const next = dismissCalendarMention(current, captured, key);
          if (!next) return false;
          setCurrent(next); setLastKey(key); return true;
        }}/>
      {lastKey && <button onClick={() => { const restored = restoreCalendarMention(current, lastKey); if (restored) setCurrent(restored); }}>Undo removal</button>}
    </div>;
  }
  const view = render(<Fixture/>);
  return { ...view, original, open, latest: () => latest };
}

describe('Home calendar dismissal', () => {
  it('removes the last inferred date, hides the calendar, preserves prose/date reference, and supports Undo', async () => {
    const view = fixture('Meet on 20 November 2026.');
    const remove = await screen.findByRole('button', { name: /Remove inferred date/ });
    remove.focus(); fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Calendar' })).toBeNull());
    expect(view.latest().body).toBe(view.original.body);
    expect(view.latest().updatedAt).toBe(view.original.updatedAt);
    expect(view.latest().dismissedCalendarMentions).toHaveLength(1);
    expect(view.open).not.toHaveBeenCalled();
    expect(screen.getByTestId('home-work')).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Undo removal' }));
    expect(await screen.findByRole('region', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByRole('button', { name: /Remove inferred date/ })).toBeVisible();
  });

  it('does not let historical mentions keep the calendar visible after the last current-month mention is removed', async () => {
    const view = fixture('Remember 12 March 2020.\n\nMeet on 1 November 2026.');
    fireEvent.click(await screen.findByRole('button', { name: /Remove inferred date/ }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Calendar' })).toBeNull());
    expect(view.latest().dismissedCalendarMentions).toHaveLength(1);
    expect(view.latest().body).toContain('12 March 2020');
  });

  it('keeps picked dates and ticket deadlines independent of a removed inferred mention on the same day', async () => {
    fixture('Meet on 20 November 2026.\n\n[Appointment](orion-date://2026-11-20)\n\n'+newTicketMarkdown('Publish', '', 'todo', '2026-11-20'));
    fireEvent.click(await screen.findByRole('button', { name: /Remove inferred date/ }));
    expect(screen.getByRole('region', { name: 'Calendar' })).toBeVisible();
    expect(screen.getByText('Picked date')).toBeVisible();
    expect(screen.getByText('Due')).toBeVisible();
    expect(screen.queryByRole('button', { name: /Remove inferred date/ })).toBeNull();
  });

  it('keeps an unfinished overdue ticket on the dashboard even when its date is historical', async () => {
    fixture(newTicketMarkdown('Still needs doing', '', 'todo', '2026-09-20'));
    expect(await screen.findByRole('region', { name: 'Calendar' })).toBeVisible();
    expect(screen.queryByRole('button', { name: /Remove inferred date/ })).toBeNull();
  });

  it('preserves the row and gives an error when the guarded removal fails', async () => {
    const view = fixture('Meet on 20 November 2026.', true);
    fireEvent.click(await screen.findByRole('button', { name: /Remove inferred date/ }));
    expect(screen.getByRole('alert')).toHaveTextContent('This date changed');
    expect(screen.getByRole('region', { name: 'Calendar' })).toBeVisible();
    expect(view.latest()).toBe(view.original);
  });

  it('moves keyboard focus to the remaining entry and reuses the finished scan for metadata-only saves', async () => {
    const scan = vi.spyOn(recognition, 'recognizeNoteDates');
    const view = fixture('First meeting on 20 November 2026.\n\nSecond meeting on 23 November 2026.');
    await screen.findAllByRole('button', { name: /Remove inferred date/ });
    const calls = scan.mock.calls.length;
    const first = screen.getAllByRole('button', { name: /Remove inferred date/ })[0];
    first.focus(); fireEvent.click(first);
    const remaining = screen.getByRole('button', { name: /Second meeting.*Inferred/ });
    expect(remaining).toHaveFocus();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(scan).toHaveBeenCalledTimes(calls);
    fireEvent.click(remaining);
    expect(view.open).toHaveBeenCalledWith('n');
  });
});
