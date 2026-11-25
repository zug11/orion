import { describe, expect, it } from 'vitest';
import { readTicketSchedule } from './ticketSchedule';

const savedDay = '2026-11-24';

describe('dates stated about the work', () => {
  it.each([
    ['Submit by 04/12/2026', '2026-12-04'],
    ['Submit by 4 Dec. 2028', '2028-12-04'],
    ['Submit by 4.12.26', '2026-12-04'],
    ['Deadline: 2028-02-29', '2028-02-29'],
    ['The deadline is on 29 February 2028', '2028-02-29'],
    ['Brief due tomorrow', '2026-11-25'],
    ['The report is due in three days', '2026-11-27'],
    ['Submit no later than Friday', '2026-11-27'],
    ['The “Autumn” proposal is due Friday', '2026-11-27'],
    ['Deliver by the 15th', '2026-12-15'],
    ['We meet on Wednesday and the draft is due on Friday', '2026-11-27'],
    ['Start on Wednesday and deliver by Friday', '2026-11-27'],
  ])('%s', (text, date) => {
    expect(readTicketSchedule(text, savedDay)).toEqual({ dueDate: date });
  });

  it.each([
    'Submit by 12/13/2026', 'Deadline 02/29/2028', 'The brief is due 31/4/2026',
    'Deadline: 2026-02-29', 'Deadline: 2026-13-12', 'Deadline: February 30, 2026', 'Due Friday or Monday', 'Due Friday and Monday', 'Due Friday, Monday',
    'Due 4 to 7 December', 'Due next month', 'Review at the meeting on Friday',
    'Start writing the brief by next Monday', 'Begin implementation no later than Friday',
    'Brief due Friday. Actually there is no deadline.', 'Maybe it is due Friday',
    'The draft is due tomorrow if it gets approved', 'Is the brief due tomorrow?',
    'It is due Friday. It is due Monday.', 'It may be due Friday', 'Is the brief due Friday',
    'The brief is due Friday. We cancelled it.',
  ])('leaves the deadline unset for %s', text => {
    expect(readTicketSchedule(text, savedDay)).toEqual({});
  });

  it.each(['unknown', '2026-02-30', '2026-02-30T12:00:00Z'])('uses only fully specified dates with invalid reference %s', reference => {
    expect(readTicketSchedule('Due tomorrow', reference)).toEqual({});
    expect(readTicketSchedule('Due Friday', reference)).toEqual({});
    expect(readTicketSchedule('Due 4 December 2026', reference)).toEqual({ dueDate: '2026-12-04' });
  });
});

describe('explicit active work', () => {
  it.each([
    'We have already begun the brief', 'I’ve started the brief', 'The work is underway',
    'I am still working on the brief', 'I’ve been working on the brief', '[WIP] Write the brief',
    'Is the brief due Friday? I started the brief.', 'I started the brief. It might be paused later.',
    'I started the brief. The deadline was cancelled.',
  ])('%s', text => {
    expect(readTicketSchedule(text, savedDay)).toEqual({ status: 'progress' });
  });
  it.each([
    'I want to start the brief', 'We are planning to start', 'I haven’t started the brief',
    'I used to work on the brief', 'If the brief is underway, call me',
    'I started the brief. It is now on hold.', 'I’ve started the brief but then finished it',
    'I started the brief. We completed it yesterday.', 'We had been working on the brief',
    'For example, “I have started the brief.”', 'The brief was in progress', 'I started the brief?', 'I started the brief then paused it.', 'I started the brief. Actually I haven’t started it.',
  ])('leaves the status unset for %s', text => {
    expect(readTicketSchedule(text, savedDay)).toEqual({});
  });
});
