// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import TaskList from '@tiptap/extension-task-list';
import { afterEach, describe, expect, it } from 'vitest';
import { NoteStarterKit, NoteTaskItem } from './NoteStarterKit';
import { NoteMarkdown, NoteMargins } from './NoteMargins';
import { NoteBlock } from './NoteBlock';
import { Slice } from '@tiptap/pm/model';
import { copyWorkIdentities, NoteKanban, insertWorkItem, insertBoardTickets, patchEditorTicket, deleteEditorTicket, deleteEditorTicketNode } from './NoteKanban';
import { boardMarker, noteWork, ticketMarker } from '../../lib/tickets';
import type { Note } from '../../types';
const editors: Editor[] = [];
function create(content: string) {
  const editor = new Editor({ extensions: [NoteStarterKit, TaskList, NoteTaskItem.configure({ nested: true }), NoteBlock, NoteMargins, NoteKanban, NoteMarkdown], content, contentType: 'markdown' });
  editors.push(editor); return editor;
}
afterEach(() => editors.splice(0).forEach(e => e.destroy()));
const n = (body: string): Note => ({ id:'n', title:'Note', body, slug:'n', summary:'', aliases:[], tags:[], sourceIds:[], conceptIds:[], kind:'article', status:'ready', createdAt:'2026-11-13T00:00:00Z', updatedAt:'2026-11-13T00:00:00Z' });

describe('ticket and board editor transactions', () => {
  it('deletes the confirmed ticket and its contents, preserves siblings, and restores all of it with one Undo', () => {
    const marker = ticketMarker({id:'delete-me',boardId:'b',status:'progress',urgency:'high'});
    const editor = create(`Before.\n\n- [ ] Call Jo ${marker}\n\n  Keep the agenda.\n\n  - [ ] Nested task\n- [ ] Keep this sibling\n\nAfter.`);
    const original = editor.getJSON();
    const ticket = noteWork(n(editor.getMarkdown())).tickets[0];
    expect(deleteEditorTicket(editor, ticket)).toBe(true);
    expect(editor.state.doc.textContent).not.toContain('Call Jo');
    expect(editor.state.doc.textContent).not.toContain('Keep the agenda');
    expect(noteWork(n(editor.getMarkdown())).tickets.map(t => t.title)).toEqual(['Keep this sibling']);
    expect(editor.state.doc.textContent).toContain('Before.');
    expect(editor.state.doc.textContent).toContain('After.');
    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
  });
  it('removes an empty enclosing list when its final ticket is deleted', () => {
    const editor = create(`- [ ] Only ticket ${ticketMarker({id:'only',boardId:'',status:'todo'})}`);
    const original = editor.getJSON();
    expect(deleteEditorTicket(editor, noteWork(n(editor.getMarkdown())).tickets[0])).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
    expect(editor.state.doc.textContent).toBe('');
    editor.commands.undo();
    // The trailing-paragraph plugin may add an empty writing row on the first
    // transaction; the complete restored ticket must still match exactly.
    expect(editor.getJSON().content?.[0]).toEqual(original.content?.[0]);
    expect(noteWork(n(editor.getMarkdown())).tickets.map(t => t.id)).toEqual(['only']);
    const nested = create(`- [ ] Keep parent\n  - [ ] Child ${ticketMarker({id:'child',boardId:'',status:'todo'})}`);
    expect(deleteEditorTicket(nested, noteWork(n(nested.getMarkdown())).tickets[1])).toBe(true);
    expect(nested.state.doc.firstChild?.firstChild?.childCount).toBe(1);
    expect(noteWork(n(nested.getMarkdown())).tickets.map(t => t.title)).toEqual(['Keep parent']);
  });
  it('rejects changed contents, duplicate identities and replaced or read-only editor nodes', () => {
    const marker = ticketMarker({id:'guarded',boardId:'',status:'todo'});
    const editor = create(`- [ ] Call Jo ${marker}\n\n  Original detail.`);
    const ticket = noteWork(n(editor.getMarkdown())).tickets[0];
    const captured = editor.state.doc.nodeAt(1)!;
    editor.commands.insertContentAt(3, 'Updated ');
    const changed = editor.getJSON();
    expect(deleteEditorTicket(editor, ticket)).toBe(false);
    expect(deleteEditorTicketNode(editor, 1, captured)).toBe(false);
    expect(editor.getJSON()).toEqual(changed);
    const duplicated = create(`- [ ] One ${marker}\n- [ ] Two ${marker}`);
    expect(deleteEditorTicketNode(duplicated, 1, duplicated.state.doc.nodeAt(1)!)).toBe(false);
    const readonlyTicket = noteWork(n(editor.getMarkdown())).tickets[0];
    editor.setEditable(false);
    expect(deleteEditorTicket(editor, readonlyTicket)).toBe(false);
  });
  it('accepts equivalent source formatting while rejecting changed continuation content', () => {
    const body = `+ [ ] __Call Jo__ ${ticketMarker({id:'original',boardId:'b',status:'todo'})}\n    + [ ] Nested action`;
    const editor = create(body);
    const sourceTicket = noteWork(n(body)).tickets[0];
    expect(editor.getMarkdown()).not.toBe(body);
    expect(deleteEditorTicket(editor, sourceTicket)).toBe(true);
    editor.commands.undo();
    let nestedTextPosition = -1;
    editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Nested action') nestedTextPosition = pos; });
    editor.commands.insertContentAt(nestedTextPosition, 'Changed ');
    expect(deleteEditorTicket(editor, sourceTicket)).toBe(false);
    const nestedSource = `- [ ] Parent\n    - [ ] Child ${ticketMarker({id:'nested',boardId:'b',status:'todo'})}`;
    const nestedEditor = create(nestedSource);
    expect(deleteEditorTicket(nestedEditor, noteWork(n(nestedSource)).tickets[1])).toBe(true);
    expect(nestedEditor.state.doc.textContent).toBe('Parent');
  });
  it('adds a reviewed batch next to its unique board in one Undo and preserves prose', () => {
    const body=`Before.\n\n${boardMarker({id:'b',title:'Launch'})}\n\n- [ ] Existing task\n\nAfter.`;
    const editor=create(body);const original=editor.getJSON();
    expect(insertBoardTickets(editor,'b',['New action','Existing task','New action'],'todo',true)).toBe(true);
    expect(noteWork(n(editor.getMarkdown())).tickets.map(t=>t.title)).toEqual(['New action','Existing task']);
    expect(editor.state.doc.textContent).toContain('After.');
    editor.commands.undo();expect(editor.getJSON()).toEqual(original);
    expect(insertBoardTickets(editor,'missing',['New action'])).toBe(false);
    editor.setEditable(false);expect(insertBoardTickets(editor,'b',['New action'])).toBe(false);
    const duplicate=create(`${boardMarker({id:'b',title:'One'})}\n\n${boardMarker({id:'b',title:'Two'})}`);
    expect(insertBoardTickets(duplicate,'b',['New action'])).toBe(false);
  });
  it('round trips ticket identity, nesting and formatting across repeated saves', () => {
    const marker = ticketMarker({ id: 't1', boardId: 'b1', status: 'progress' });
    let editor = create(`- [ ] **Call Jo** <!-- orion-text:v1 justify --> ${marker}\n  - [x] Child\n\n${boardMarker({id:'b1',title:'Launch — plan'})}`);
    const original = editor.getJSON();
    expect(editor.state.doc.firstChild?.firstChild?.attrs).toMatchObject({ ticketId: 't1', ticketBoard: 'b1', ticketStatus: 'progress' });
    expect(editor.state.doc.firstChild?.firstChild?.firstChild?.attrs.textAlign).toBe('justify');
    for (let i = 0; i < 3; i++) {
      editor = create(editor.getMarkdown());
      expect(editor.getJSON()).toEqual(original);
      expect(noteWork(n(editor.getMarkdown())).tickets[0]).toMatchObject({ id: 't1', title: 'Call Jo', boardId: 'b1', status: 'progress' });
    }
  });
  it('preserves ambiguous first-line ticket markers without choosing an identity', () => {
    const first = ticketMarker({ id: 'first', boardId: 'b1', status: 'progress', dueDate: '2026-11-20', urgency: 'high' });
    const second = ticketMarker({ id: 'second', boardId: '', status: 'todo', origin: 'board' });
    const child = ticketMarker({ id: 'child', boardId: 'b1', status: 'todo' });
    let editor = create(`- [ ] **Keep this task** ${first} ${second}\n  - [ ] Child ${child}`);
    for (let i = 0; i < 3; i++) {
      const item = editor.state.doc.firstChild!.firstChild!;
      expect(item.attrs.ticketId).toBeNull();
      expect(item.attrs.ticketDueDate).toBe('');
      expect(item.attrs.ticketUrgency).toBe('');
      const markdown = editor.getMarkdown();
      expect(markdown.split('\n')[0]).toBe(`- [ ] **Keep this task** ${first} ${second}`);
      expect(noteWork(n(markdown)).tickets).toMatchObject([
        { durable: false, title: 'Keep this task' }, { durable: true, id: 'child' },
      ]);
      editor = create(markdown);
    }
    editor.commands.setTextSelection(4);
    editor.commands.insertContent('New ');
    expect(editor.getMarkdown()).toContain(`${first} ${second}`);
    expect(noteWork(n(editor.getMarkdown())).tickets[0].durable).toBe(false);
    const empty = create(`- [ ] ${first} ${second}`);
    expect(empty.state.doc.textContent).toBe('');
    expect(empty.getMarkdown()).toBe(`- [ ] ${first} ${second}`);
  });
  it.each(['ticket', 'kanban'] as const)('inserts %s inline, leaves surrounding prose, and undoes in one step', kind => {
    const original = `Before /${kind} after.`;
    const editor = create(original);
    const from = original.indexOf('/') + 1;
    expect(insertWorkItem(editor, kind, 'Plan', {from,to:from+kind.length+1})).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe('Before ');
    expect(editor.state.doc.textContent).toContain(' after.');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    editor.commands.insertContent('Continue');
    editor.commands.undo();
    expect(editor.state.doc.textContent).not.toContain('Continue');
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe(original);
    editor.commands.redo();
    expect(editor.state.doc.child(1).type.name).toBe(kind === 'ticket' ? 'taskList' : 'noteKanban');
  });
  it('uses normal Undo for board moves and does not duplicate identity on Enter', () => {
    const editor = create(`- [ ] Call Jo ${ticketMarker({id:'t1',boardId:'b1',status:'todo'})}`);
    const ticket = noteWork(n(editor.getMarkdown())).tickets[0];
    expect(patchEditorTicket(editor, ticket, {status:'progress'})).toBe(true);
    expect(noteWork(n(editor.getMarkdown())).tickets[0].status).toBe('progress');
    editor.commands.undo();
    expect(noteWork(n(editor.getMarkdown())).tickets[0].status).toBe('todo');
    editor.commands.setTextSelection(10);
    editor.commands.splitListItem('taskItem');
    const list = editor.state.doc.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.child(1).attrs.ticketId).toBeNull();
  });
  it('gives pasted tickets and boards fresh identities while keeping their assignments together', () => {
    const editor = create(`- [ ] Call Jo ${ticketMarker({id:'t1',boardId:'b1',status:'todo'})}\n\n${boardMarker({id:'b1',title:'Launch'})}`);
    const copied = copyWorkIdentities(new Slice(editor.state.doc.content, 0, 0));
    const ticket = copied.content.child(0).firstChild!;
    const board = copied.content.child(1);
    expect(ticket.attrs.ticketId).not.toBe('t1');
    expect(board.attrs.boardId).not.toBe('b1');
    expect(ticket.attrs.ticketBoard).toBe(board.attrs.boardId);
    expect(editor.state.doc.child(0).firstChild?.attrs.ticketId).toBe('t1');
  });

});
