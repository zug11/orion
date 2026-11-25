import { describe, expect, it } from 'vitest';
import { createEmptySnapshot } from '../data/defaults';
import type { AppSnapshot, Note } from '../types';
import { dateLabel } from './calendarDate';
import { portableChatEvidence } from './chatCitations';
import { boardMarker, newTicketMarkdown, noteWork, type NoteBoard } from './tickets';
import { prepareVoiceWorkWrite } from './voiceWorkspaceMutation';
import type { VoiceWorkWrite } from './voiceWorkspace';

const day = (key: string) => `[${dateLabel(key)}](orion-date://${key})`;
const meeting = `Coffee with Lee — ${day('2026-11-26')}`;
function setup(body: string) {
  const space = createEmptySnapshot('Studio');
  const note: Note = { id: 'production', title: 'Production', slug: 'production', summary: '', body,
    kind: 'article', status: 'ready', conceptIds: [], sourceIds: [], aliases: [], tags: [],
    createdAt: space.updatedAt, updatedAt: space.updatedAt };
  space.notes = [note];
  return { space, note, spaceId: space.workspace.id };
}
const withBody = (space: AppSnapshot, note: Note, body: string): AppSnapshot =>
  ({ ...space, notes: space.notes.map(n => n.id === note.id ? { ...n, body } : n) });

describe('voice workspace mutations', () => {
  it('appends to the authored body, preserving exact frontmatter, saved passages and source references', () => {
    const prefix = '---\ntitle: Opening\n---\n\n';
    const sourceFooter = '\n\n## References\n\n1. [Brief](orion-source://brief)';
    const evidence = portableChatEvidence('Claim [1](#orion-evidence-e1)', [{ id: 'e1', kind: 'source',
      entityId: 'brief', title: 'Brief', version: 'rev', start: 0, end: 6, text: 'Quoted', offsetUnit: 'utf16' }]);
    const { space, note, spaceId } = setup(prefix + evidence + sourceFooter);
    const action: VoiceWorkWrite = { kind: 'append', spaceId, note, markdown: meeting };
    const change = prepareVoiceWorkWrite(space, action);
    expect(change.creating).toBe(false);
    expect(change.body).toBe(note.body.replace('\n\n## Cited passages', '\n\n' + meeting + '\n\n## Cited passages'));
    expect(change.verify(withBody(space, note, change.body))).toBe(true);
    expect(change.verify(space)).toBe(false);
    expect(() => prepareVoiceWorkWrite(withBody(space, note, note.body + '!'), action)).toThrow('changed');
    expect(() => prepareVoiceWorkWrite(createEmptySnapshot('Another'), action)).toThrow('changed');
    expect(() => prepareVoiceWorkWrite({ ...space, notes: [note, note] }, action)).toThrow('changed');
  });

  it('checks date receipts by visible block and exact date across serializer changes; existing duplicates do not acknowledge a new one', () => {
    const escaped = meeting.replace('Coffee', 'Q\\.A\\.');
    const { space, note, spaceId } = setup(escaped);
    const change = prepareVoiceWorkWrite(space, { kind: 'append', spaceId, note, markdown: escaped });
    expect(change.verify(space)).toBe(false);
    const canonical = change.body.split('Q\\.A\\.').join('Q.A.');
    expect(change.verify(withBody(space, note, canonical))).toBe(true);
    expect(change.verify(withBody(space, note, escaped + '\n\nOther meeting — ' + day('2026-11-26')))).toBe(false);
    expect(change.verify({ ...withBody(space, note, canonical), workspace: { ...space.workspace, id: 'other' } })).toBe(false);
  });

  it('moves exactly one picked occurrence and checks both the previous and saved event', () => {
    const original = day('2026-11-26'), replacement = day('2026-12-03');
    const { space, note, spaceId } = setup('Other meeting — ' + replacement + '\n\n' + meeting);
    const from = note.body.lastIndexOf(original);
    const action: VoiceWorkWrite = { kind: 'moveDate', spaceId, note, from, to: from + original.length,
      original, replacement, oldDate: '2026-11-26', newDate: '2026-12-03' };
    const change = prepareVoiceWorkWrite(space, action);
    expect(change.body).toBe(note.body.replace(original, replacement));
    expect(change.verify(space)).toBe(false);
    expect(change.verify(withBody(space, note, 'Preamble.\n\n' + change.body))).toBe(true);
    expect(() => prepareVoiceWorkWrite(space, { ...action, to: from + 1 })).toThrow('changed');
    const code = { ...note, body: '`' + original + '`' };
    expect(() => prepareVoiceWorkWrite({ ...space, notes: [code] }, { ...action, note: code, from: 1, to: 1 + original.length })).toThrow('changed');
  });

  it('checks a whole captured ticket and the uniquely identified destination board through persistence', () => {
    const board: NoteBoard = { id: 'tickets', noteId: 'production', title: 'Launch', columns: [{ id: 'column-review', title: 'Review' }] };
    const ticketMd = newTicketMarkdown('Check A.B');
    const { space, note, spaceId } = setup(boardMarker(board) + '\n\n' + ticketMd + '\n  - [ ] Ask Jo');
    const ticket = noteWork(note).tickets[0];
    const action: VoiceWorkWrite = { kind: 'patchTicket', spaceId, ticket, patch: { boardId: board.id, status: 'column-review' }, board };
    const change = prepareVoiceWorkWrite(space, action);
    expect(change.verify(space)).toBe(false);
    expect(change.verify(withBody(space, note, change.body.replace('A\\.B', 'A.B')))).toBe(true);
    for (const stale of [note.body.replace('Ask Jo', 'Ask Lee'), note.body + '\n\n' + ticketMd,
      note.body.replace('Launch', 'Initiatives'), note.body + '\n\n' + boardMarker(board),
      note.body.replace(boardMarker(board), boardMarker({ ...board, columns: [] }))]) {
      expect(() => prepareVoiceWorkWrite(withBody(space, note, stale), action)).toThrow('changed');
    }
    expect(change.verify({ ...space, notes: [{ ...note, body: change.body }, { ...note, id: 'duplicate-ticket' }] })).toBe(false);
  });

  it('gives a new storage note an independent ID and rejects duplicate note names or ticket IDs', () => {
    const { space, note, spaceId } = setup('Old meeting.');
    const markdown = newTicketMarkdown('Book studio');
    const action: VoiceWorkWrite = { kind: 'append', spaceId, newNoteTitle: 'Tickets', markdown };
    const change = prepareVoiceWorkWrite(space, action);
    expect(change.creating).toBe(true);
    expect(change.note.id).not.toBe(note.id);
    const saved = { ...change.note, body: change.body };
    const written = { ...space, notes: [note, saved] };
    expect(change.verify(written)).toBe(true);
    expect(() => prepareVoiceWorkWrite(written, action)).toThrow('changed');
    expect(change.verify({ ...space, notes: [saved, { ...note, title: 'tickets' }] })).toBe(false);
    expect(() => prepareVoiceWorkWrite(withBody(space, note, markdown), action)).toThrow('changed');
  });
});
