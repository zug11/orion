import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { recognizeNoteDates } from './calendarRecognition';
import { dateKey, localDate, shiftDate, shiftMonth, validCalendarDate } from './calendarDate';
import { newTicketMarkdown, noteWork, patchTicket } from './tickets';
const note = (body: string): Note => ({ id: 'n', title: 'Plans', summary: '', body, slug: 'plans', aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: 'article', status: 'ready', createdAt: '2026-11-13T01:00:00Z', updatedAt: '2026-11-13T01:00:00Z' });
function read(n: Note) { const iterator = recognizeNoteDates(n); let result = iterator.next(); while (!result.done) result = iterator.next(); return result.value; }
describe('local calendar recognition', () => {
  it('uses saved writing time for relative prose and day/month for numeric dates', () => {
    const dates = read(note('Meet next Friday.\n\nCall tomorrow.\n\nThe appointment is 12/11/2026.'));
    expect(dates.map(d => d.date)).toEqual(['2026-11-20', '2026-11-14', '2026-11-12']);
    expect(dates.every(d => d.kind === 'mentioned' && d.referenceDate === '2026-11-13')).toBe(true);
  });
  it('keeps picked dates fixed without also inferring their label, and retains ranges', () => {
    const dates = read(note('Meet [13 November 2026](orion-date://2026-11-13).\n\nTravel 18–20 November 2026.'));
    expect(dates).toHaveLength(2);
    expect(dates[0]).toMatchObject({ date: '2026-11-13', kind: 'picked' });
    expect(dates[1]).toMatchObject({ date: '2026-11-18', endDate: '2026-11-20', kind: 'mentioned' });
  });
  it('ignores code, quotations, frontmatter, completed work, and duplicate dates on due tickets', () => {
    const dates = read(note('---\ndate: 2026-11-16\n---\n\n`tomorrow`\n\n```\n18 November 2026\n```\n\n> next Friday\n\n- [x] Done tomorrow\n\n'+newTicketMarkdown('Call tomorrow','', 'todo','2026-11-20')));
    expect(dates).toEqual([]);
  });
  it('keeps dates of open nested tasks under a completed parent', () => {
    const dates=read(note('- [x] Parent tomorrow\n    - [ ] Child next Friday\n    - [x] Finished child tomorrow'));
    expect(dates.map(d=>d.date)).toEqual(['2026-11-20']);
  });
  it('does not reinterpret invalid timestamps or bare numbers as a relative date', () => {
    expect(read({ ...note('Tomorrow. 2026. 3pm. Version 2.6.'), updatedAt: '' })).toEqual([]);
    expect(read(note('500 MB, version 2.6. In November, at 3pm.'))).toEqual([]);
  });
  it('reuses completed immutable note scans and reads beyond a long opening', () => {
    const n = note('ordinary prose '.repeat(4000) + '\n\nMeet on 23 November 2026.');
    const dates = read(n); expect(dates[dates.length-1]?.date).toBe('2026-11-23');
    expect(recognizeNoteDates(n).next()).toEqual({ done: true, value: dates });
  });
  it('anchors dismissal to the full source block instead of its resolved date or document position', () => {
    const original = note('Call next Friday.');
    const key = read(original)[0].dismissalKey;
    expect(key).toMatch(/^v1:[a-f0-9]{16}:\d+:\d+$/);
    expect(read({ ...original, title: 'Renamed', body: 'Unrelated opening.\n\n'+original.body, updatedAt: '2026-12-01T01:00:00Z' })[0].dismissalKey).toBe(key);
    expect(read(note('Visit next Friday.'))[0].dismissalKey).not.toBe(key);
    const prefix = 'ordinary words '.repeat(20);
    expect(read(note(`${prefix} Call next Friday.`))[0].dismissalKey).not.toBe(read(note(`${prefix} Visit next Friday.`))[0].dismissalKey);
  });
  it('distinguishes identical blocks while keeping one key for an already deduplicated date', () => {
    const dates = read(note('Call 20 November 2026.\n\nCall 20 November 2026.'));
    expect(dates).toHaveLength(2);
    expect(new Set(dates.map(entry => entry.dismissalKey)).size).toBe(2);
    expect(read(note('Call 20 November 2026, then meet on 20 November 2026.'))).toHaveLength(1);
  });
  it('keeps duplicate occurrence slots when an earlier task is completed', () => {
    const original = note('- [ ] Call 20 November 2026.\n- [ ] Call 20 November 2026.');
    const before = read(original);
    const after = read({ ...original, body: original.body.replace('[ ]', '[x]') });
    expect(after).toHaveLength(1);
    expect(after[0].dismissalKey).toBe(before[1].dismissalKey);
    expect(after[0].dismissalKey).not.toBe(before[0].dismissalKey);
  });
  it('keeps duplicate occurrence slots when an earlier ticket receives a chosen due date', () => {
    const original = note([newTicketMarkdown('Call 20 November 2026.'), newTicketMarkdown('Call 20 November 2026.')].join('\n'));
    const before = read(original);
    expect(before).toHaveLength(2);
    const body = patchTicket(original.body, noteWork(original).tickets[0], { dueDate: '2026-11-21' });
    expect(body).not.toBeNull();
    const after = read({ ...original, body: body! });
    expect(after).toHaveLength(1);
    expect(after[0].dismissalKey).toBe(before[1].dismissalKey);
    expect(after[0].dismissalKey).not.toBe(before[0].dismissalKey);
  });
  it('resets ambiguous duplicate dismissals after an identical block is removed or added', () => {
    const block = 'Call 20 November 2026.';
    const before = read(note(`${block}\n\n${block}`));
    const oldKeys = new Set(before.map(entry => entry.dismissalKey));
    const removed = read(note(block));
    expect(removed).toHaveLength(1);
    expect(oldKeys.has(removed[0].dismissalKey)).toBe(false);
    const added = read(note(`${block}\n\n${block}\n\n${block}`));
    expect(added).toHaveLength(3);
    expect(added.every(entry => !oldKeys.has(entry.dismissalKey))).toBe(true);
    // Quoted/code examples never become members of the eligible source group.
    expect(read(note(`> ${block}\n\n\`\`\`\n${block}\n\`\`\`\n\n${block}\n\n${block}`)).map(entry => entry.dismissalKey))
      .toEqual(before.map(entry => entry.dismissalKey));
  });
  it('keeps all-day arithmetic local through DST and clamps month navigation', () => {
    expect(shiftDate('2026-10-03', 1)).toBe('2026-10-04');
    expect(shiftMonth('2028-01-31', 1)).toBe('2028-02-29');
    expect(dateKey(localDate('2026-11-13'))).toBe('2026-11-13');
    expect(validCalendarDate('2027-02-29')).toBe(false);
    expect(validCalendarDate('2028-02-29')).toBe(true);
    expect(validCalendarDate('2026-11-13T00:00Z')).toBe(false);
  });
});
