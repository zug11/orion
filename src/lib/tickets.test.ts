import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { boardMarker, collectWork, deleteTicket, newTicketMarkdown, noteWork, parseBoardMarker, patchTicket, ticketMarker, parseTicketMarker } from './tickets';

const note = (body: string, id = 'n', more: Partial<Note> = {}): Note => ({ id, title: id, body, slug: id, summary: '', aliases: [], tags: [], kind: 'article', status: 'ready', conceptIds: [], sourceIds: [], createdAt: '', updatedAt: '', ...more });
const marker = ticketMarker({ id: 'ticket-a', boardId: 'board-a', status: 'progress' });

describe('note-backed tickets', () => {
  it('derives real tasks, preserving markup and ignoring code, quotes and frontmatter', () => {
    const n = note(`---\ntitle: test\n- [ ] YAML\n---\n\n- [ ] **Call** [Jo](https://example.com) ${marker}\n  - [x] Child\n\n\`\`\`md\n- [ ] Fenced\n\`\`\`\n\n~~~\n- [ ] Tilde\n~~~\n\n    - [ ] Indented\n\n> - [ ] Quoted\n\n- [ ] Literal \`${marker}\``);
    const tasks = noteWork(n).tickets;
    expect(tasks.map(t => t.title)).toEqual(['Call Jo', 'Child', `Literal ${marker}`]);
    expect(tasks[0]).toMatchObject({ id: 'ticket-a', status: 'progress', boardId: 'board-a', lineIndex: 5 });
    expect(tasks[1].status).toBe('done');
    expect(tasks[2].durable).toBe(false);
    expect(noteWork(n)).toBe(noteWork(n));
  });
  it('updates the exact durable task after lines move without rewriting prose, frontmatter or newlines', () => {
    const n = note(`---\r\ntitle: Test\r\n---\r\n\r\n- [ ] **Call Jo** ${marker}\r\n\r\nTail.`);
    const ticket = noteWork(n).tickets[0];
    const moved = n.body.replace('- [ ]', 'Intro.\r\n\r\n- [ ]');
    const saved = patchTicket(moved, ticket, { status: 'done' })!;
    expect(saved).toBe(moved.replace('- [ ]', '- [x]').replace(' progress ', ' done '));
    expect(patchTicket(saved, ticket, { boardId: '' })).toBeNull();
    expect(patchTicket(`${n.body}\r\n\r\n${ticket.rawLine}`, ticket, { status: 'done' })).toBeNull();
    expect(patchTicket(`\`\`\`\n${ticket.rawLine}\n\`\`\``, ticket, { status: 'done' })).toBeNull();
  });
  it('promotes ordinary tasks only on a user change and keeps checkbox semantics', () => {
    const n = note('- [ ] Call Jo');
    const t = noteWork(n).tickets[0];
    const body = patchTicket(n.body, t, { boardId: 'board-a', status: 'progress' })!;
    expect(noteWork(note(body)).tickets[0]).toMatchObject({ durable: true, boardId: 'board-a', status: 'progress' });
    expect(noteWork(note(body.replace('[ ]', '[x]'))).tickets[0].status).toBe('done');
    expect(noteWork(note(body.replace('progress', 'done'))).tickets[0].status).toBe('todo');
    expect(n.body).toBe('- [ ] Call Jo');
    const checked = body.replace('[ ]', '[x]');
    const completed = noteWork(note(checked)).tickets[0];
    expect(patchTicket(checked, completed, { status: 'todo' })).toContain('todo board-a -->');
  });
  it('preserves literal titles and rejects malformed board payloads', () => {
    const title = 'Release <script> and [x] * -- 日本語';
    expect(noteWork(note(newTicketMarkdown(title))).tickets[0].title).toBe(title);
    expect(parseBoardMarker(boardMarker({ id: 'board-a', title }))).toEqual({ id: 'board-a', title });
    expect(parseBoardMarker('<!-- orion-kanban:v1 b %xx -->')).toBeNull();
    expect(parseBoardMarker('<!-- orion-kanban:v1 b %0A -->')).toBeNull();
    for (const title of ['# Heading', '- nested list', '1. numbered item', '> quotation']) {
      expect(noteWork(note(newTicketMarkdown(title))).tickets[0].title).toBe(title);
    }
  });
  it('keeps recurring tasks separate, collapses established derivations, and fails closed on duplicated boards', () => {
    const body = '- [ ] Check this';
    const n = note(body, 'n', { sourceIds: ['s'] });
    const wiki = note(body, 'wiki', { kind: 'wiki', sourceIds: ['s'] });
    expect(collectWork([wiki, n]).tickets.map(t => t.noteId)).toEqual(['n']);
    expect(collectWork([n, note(body, 'unrelated')]).tickets).toHaveLength(2);
    const explicit = newTicketMarkdown('Check this');
    expect(collectWork([note(explicit, 'one', { sourceIds: ['s'] }), note(newTicketMarkdown('Check this'), 'two', { sourceIds: ['s'] })]).tickets).toHaveLength(2);
    const board = boardMarker({ id: 'board-a', title: 'Launch' });
    expect(collectWork([note(board), note(board, 'copy')]).boards).toEqual([]);
    const space = [n];
    expect(collectWork(space)).toBe(collectWork(space));
    expect(collectWork([]).tickets).toEqual([]);
  });
});

describe('guarded ticket deletion', () => {
  it('removes a whole multiline task and nested contents while preserving sibling tasks and prose', () => {
    const block = `- [ ] Call Jo ${marker}\n  Continue with the **details**.\n\n  A second paragraph.\n\n  - [ ] Nested action\n    Child details.`;
    const before = 'Introduction.\n\n- [ ] Keep before\n';
    const after = '- [ ] Keep after\n\n## Following section\n\nDo not change this.';
    const body = `${before}${block}\n${after}`;
    const ticket = noteWork(note(body)).tickets.find(t => t.id === 'ticket-a')!;
    expect(ticket.rawBlock).toBe(block);
    expect(deleteTicket(body, ticket)).toBe(before + after);
  });

  it('finds the durable task after unrelated lines move and preserves frontmatter and CRLF bytes', () => {
    const block = `- [ ] Call Jo ${marker}\r\n  Detail.`;
    const before = '---\r\ntitle: Keep exactly\r\n---\r\n\r\nIntroduction.\r\n\r\n';
    const after = '\r\nTail with  two spaces.\r\n';
    const body = `${before}${block}\r\n${after}`;
    const ticket = noteWork(note(body)).tickets[0];
    const moved = body.replace('Introduction.', 'A new paragraph.\r\n\r\nIntroduction.');
    expect(deleteTicket(moved, ticket)).toBe(moved.replace(block + '\r\n', ''));
    expect(deleteTicket(body, ticket)).toBe(before + after);
  });

  it('removes a nested ticket without changing its parent or sibling indentation', () => {
    const block = `  - [ ] Call Jo ${marker}\n    More details.`;
    const before = '- [ ] Parent\n';
    const after = '  - [ ] Sibling\n\nFollowing prose.';
    const body = `${before}${block}\n${after}`;
    const ticket = noteWork(note(body)).tickets.find(t => t.id === 'ticket-a')!;
    expect(deleteTicket(body, ticket)).toBe(before + after);
  });

  it('rejects changed continuation, changed metadata, missing captures and ordinary tasks', () => {
    const body = `- [ ] Call Jo ${marker}\n  Original details.`;
    const ticket = noteWork(note(body)).tickets[0];
    expect(deleteTicket(body.replace('Original', 'Changed'), ticket)).toBeNull();
    expect(deleteTicket(body.replace(' progress ', ' todo '), ticket)).toBeNull();
    expect(deleteTicket(body, { ...ticket, rawBlock: undefined })).toBeNull();
    const ordinary = '- [ ] Ordinary';
    expect(deleteTicket(ordinary, noteWork(note(ordinary)).tickets[0])).toBeNull();
  });

  it('rejects copied identities, including empty or ambiguous task items', () => {
    const body = `- [ ] Call Jo ${marker}`;
    const ticket = noteWork(note(body)).tickets[0];
    expect(deleteTicket(`${body}\n- [ ] Different title ${marker}`, ticket)).toBeNull();
    expect(deleteTicket(`${body}\n- [ ] ${marker}`, ticket)).toBeNull();
    const other = ticketMarker({ id: 'another', status: 'todo', boardId: '' });
    expect(deleteTicket(`${body}\n- [ ] Ambiguous ${marker} ${other}`, ticket)).toBeNull();
    expect(deleteTicket('Nothing left.', ticket)).toBeNull();
  });

  it('ignores markers in code, quotes and frontmatter when resolving a live ticket', () => {
    const task = `- [ ] Call Jo ${marker}`;
    const before = `---\nexample: ${marker}\n---\n\n\`\`\`md\n${task}\n\`\`\`\n\n> ${task}\n\n`;
    const ticket = noteWork(note(task)).tickets[0];
    expect(deleteTicket(before + task, ticket)).toBe(before);
    expect(deleteTicket(before, ticket)).toBeNull();
  });

  it('deletes the final task without inventing a replacement or trimming surrounding text', () => {
    const task = `- [ ] Call Jo ${marker}`;
    const ticket = noteWork(note(task)).tickets[0];
    expect(deleteTicket(task, ticket)).toBe('');
    expect(deleteTicket('Keep.\n\n' + task, ticket)).toBe('Keep.\n\n');
  });
});


it('round trips optional due dates, board origin and urgency through moves, and clears only explicit fields', () => {
  const marker=ticketMarker({id:'dated',status:'todo',boardId:'b',dueDate:'2028-02-29',origin:'board',urgency:'high'});
  expect(parseTicketMarker(marker)).toMatchObject({dueDate:'2028-02-29',origin:'board',urgency:'high'});
  expect(parseTicketMarker(marker.replace('2028-02-29','2027-02-29'))).toBeNull();
  expect(parseTicketMarker(marker.replace('urgency=high','urgency=invalid'))).toBeNull();
});
