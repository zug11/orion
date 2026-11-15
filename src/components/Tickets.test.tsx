// @vitest-environment jsdom
import { useState } from 'react';
import type { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Note } from '../types';
import { boardMarker, collectWork, noteWork, patchTicket, ticketMarker } from '../lib/tickets';
import { HomeTickets } from './HomeTickets';
import type { TicketWorkspace } from './Tickets';
import { RichNoteEditor } from './RichNoteEditor';
import { NoteView } from './NoteView';
const note = (body: string, id = 'n'): Note => ({ id, title: id, body, slug: id, summary: '', aliases: [], tags: [], kind: 'article', status: 'ready', conceptIds: [], sourceIds: [], createdAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z' });
const board = boardMarker({id:'b1',title:'Launch'});
const task = `- [ ] Call Jo ${ticketMarker({id:'t1',boardId:'b1',status:'todo'})}`;
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ x:0,y:0,left:0,right:0,top:0,bottom:0,width:0,height:0,toJSON:()=>({}) }) },
  });
});
afterEach(cleanup);
function EditorFixture({body,inference}: {body:string;inference?:TicketWorkspace['inference']}) {
  const [current,setCurrent] = useState(note(body));
  return <RichNoteEditor noteId="n" markdown={current.body} notes={[current]} ticketInference={inference} concepts={[]} sources={[]} attachedSourceIds={[]} onChange={body=>setCurrent(n=>({...n,body}))} onAttachSource={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />;
}
function editorFor(container: HTMLElement) { return (container.querySelector('.tiptap') as HTMLElement & {editor:Editor}).editor; }
async function keyboardCommand(editor: Editor, text: string) {
  // Drain the editor's initial caret/focus frames before simulating a user key.
  await act(async () => {
    await new Promise<void>(done => requestAnimationFrame(() => done()));
    await new Promise<void>(done => requestAnimationFrame(() => done()));
  });
  vi.spyOn(editor.view,'coordsAtPos').mockReturnValue({left:0,right:1,top:0,bottom:20});
  act(()=> {editor.view.focus();});
  await waitFor(()=>expect(editor.isFocused).toBe(true));
  act(()=>{editor.commands.setTextSelection(text.length+1);});
  await screen.findByRole('listbox');
  fireEvent.keyDown(editor.view.dom,{key:'Enter'});
}
describe('tickets in the real Orion surfaces', () => {
  it('confirms inline ticket deletion and restores the card with one Undo', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      const view = render(<EditorFixture body={task}/>);
      const editor = editorFor(view.container);
      const original = editor.getJSON();
      const remove = await screen.findByRole('button', {name:'Delete Call Jo'});
      fireEvent.click(remove);
      expect(editor.getJSON()).toEqual(original);
      confirm.mockReturnValue(true);
      fireEvent.click(remove);
      expect(noteWork(note(editor.getMarkdown())).tickets).toHaveLength(0);
      expect(editor.view.dom).toHaveFocus();
      act(() => editor.commands.undo());
      expect(editor.getJSON()).toEqual(original);
      expect(await screen.findByRole('button', {name:'Delete Call Jo'})).toBeVisible();
    } finally { confirm.mockRestore(); }
  });
  it('deletes from an embedded board through the live editor and keeps Undo', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const view = render(<EditorFixture body={`${task}\n\n${board}`}/>);
      const editor = editorFor(view.container);
      const original = editor.getJSON();
      const boardUI = await screen.findByRole('group', {name:'Launch board'});
      fireEvent.click(within(boardUI).getByRole('button', {name:'Delete Call Jo'}));
      expect(noteWork(note(editor.getMarkdown())).tickets).toHaveLength(0);
      expect(noteWork(note(editor.getMarkdown())).boards).toHaveLength(1);
      act(() => editor.commands.undo());
      expect(editor.getJSON()).toEqual(original);
    } finally { confirm.mockRestore(); }
  });
  it('rejects inline deletion when the confirmed node has changed before React catches up', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      const view = render(<EditorFixture body={task}/>);
      const editor = editorFor(view.container);
      const remove = await screen.findByRole('button', {name:'Delete Call Jo'});
      act(() => {
        editor.view.dispatch(editor.state.tr.insertText('Updated ', 3));
        fireEvent.click(remove);
      });
      expect(noteWork(note(editor.getMarkdown())).tickets[0].title).toBe('Updated Call Jo');
      expect(screen.getByRole('alert')).toHaveTextContent('changed');
    } finally { confirm.mockRestore(); }
  });
  it('reviews inferred tickets inside the editor and adds them in one undoable transaction',async()=>{
    const body=`We need to call Jo.\n\n${board}`;
    const inference={generate:vi.fn(async()=>({boardId:'b1',noteId:'n',noteTitle:'n',baseBody:editor.getMarkdown(),partial:false,suggestions:[{title:'Call Jo',evidence:'We need to call Jo.'}]})),apply:vi.fn(()=>true)};
    const view=render(<EditorFixture body={body} inference={inference}/>);const editor=editorFor(view.container);
    fireEvent.click(await screen.findByRole('button',{name:'Infer tickets from note'}));
    const accept=await screen.findByRole('button',{name:'Add 1 ticket'});
    expect(noteWork(note(editor.getMarkdown())).tickets).toHaveLength(0);
    fireEvent.click(accept);
    expect(noteWork(note(editor.getMarkdown())).tickets[0]).toMatchObject({title:'Call Jo',boardId:'b1'});
    expect(inference.apply).not.toHaveBeenCalled();
    act(()=>editor.commands.undo());expect(noteWork(note(editor.getMarkdown())).tickets).toHaveLength(0);
  });
  it.each(['ticket','kanban'] as const)('creates /%s after prose with keyboard selection and returns to typing', async kind => {
    const original=`Before /${kind}`;
    const view=render(<EditorFixture body={original}/>);
    const editor=editorFor(view.container);
    await keyboardCommand(editor,original);
    const dialog=await screen.findByRole('dialog',{name:kind==='ticket'?'Create ticket':'Create kanban'});
    const title=within(dialog).getByRole('textbox');
    expect(title).toHaveFocus();
    fireEvent.change(title,{target:{value:'Launch'}});
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
    expect(editor.view.dom).toHaveFocus();
    expect(editor.state.doc.firstChild?.textContent).toBe('Before ');
    act(()=>{editor.commands.insertContent('Keep writing.');});
    expect(editor.state.doc.textContent).toContain('Keep writing.');
    act(()=>{editor.commands.undo();editor.commands.undo();});
    expect(editor.state.doc.textContent).toBe(original);
  });
  it('cancels without consuming the slash token and rejects a stale insertion', async () => {
    const view=render(<EditorFixture body="/ticket"/>);
    const editor=editorFor(view.container);
    await keyboardCommand(editor,'/ticket');
    let dialog=await screen.findByRole('dialog');
    fireEvent(dialog,new Event('cancel',{cancelable:true}));
    expect(editor.state.doc.textContent).toBe('/ticket');
    act(()=>{editor.commands.insertContentAt({from:1,to:8},'/kanban');});
    await keyboardCommand(editor,'/kanban');
    dialog=await screen.findByRole('dialog');
    act(()=>{editor.commands.insertContentAt(1,'Changed. ');});
    fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'Board'}});
    fireEvent.submit(dialog.querySelector('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('The note changed');
    expect(noteWork(note(editor.getMarkdown())).boards).toHaveLength(0);
  });
  it('renders the live board in edit mode and status changes remain undoable', async () => {
    const view=render(<EditorFixture body={`${task}\n\n${board}`}/>);
    const editor=editorFor(view.container);
    const boardUI=await screen.findByRole('group',{name:'Launch board'});
    expect(within(boardUI).getByText('Call Jo')).toBeVisible();
    const card = within(boardUI).getByRole('article',{name:'Call Jo'});
    card.focus();
    fireEvent.keyDown(card,{key:'ArrowRight'});
    expect(noteWork(note(editor.getMarkdown())).tickets[0].status).toBe('progress');
    act(()=>{editor.commands.undo();});
    expect(noteWork(note(editor.getMarkdown())).tickets[0].status).toBe('todo');
    expect(within(within(boardUI).getByRole('region',{name:'To do'})).getByText('Call Jo')).toBeVisible();
  });
  it('changes inline status against the live ticket before React commits its latest prose and metadata', async () => {
    const title = 'Finish adding all slash commands';
    const body = `- [ ] ${title} ${ticketMarker({ id:'live-ticket', boardId:'b1', status:'progress' })}`;
    const view = render(<EditorFixture body={body}/>);
    const editor = editorFor(view.container);
    const toDo = await screen.findByRole('button', {name:'To do'});
    const current = editor.state.doc.nodeAt(1)!;
    act(() => {
      editor.view.dispatch(editor.state.tr.setNodeMarkup(1, undefined, {
        ...current.attrs, ticketDueDate:'2026-11-21', ticketUrgency:'high', ticketOrigin:'board',
      }).insertText(' carefully', 3 + title.length));
      // The document is already current, while the rendered click handler still
      // belongs to the previous React render of this same durable ticket.
      fireEvent.click(toDo);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(noteWork(note(editor.getMarkdown())).tickets[0]).toMatchObject({
      id:'live-ticket', title:`${title} carefully`, status:'todo', dueDate:'2026-11-21', urgency:'high', origin:'board',
    });
    act(() => editor.commands.undo());
    expect(noteWork(note(editor.getMarkdown())).tickets[0]).toMatchObject({
      id:'live-ticket', title:`${title} carefully`, status:'progress', dueDate:'2026-11-21', urgency:'high', origin:'board',
    });
  });
  it('rejects inline status changes when the ticket identity is duplicated', async () => {
    const marker = ticketMarker({id:'duplicate-ticket', boardId:'b1', status:'progress'});
    const view = render(<EditorFixture body={`- [ ] First action ${marker}\n- [ ] Second action ${marker}`}/>);
    const editor = editorFor(view.container);
    const buttons = await screen.findAllByRole('button', {name:'To do'});
    const before = editor.getMarkdown();
    fireEvent.click(buttons[0]);
    expect(screen.getByRole('alert')).toHaveTextContent('This ticket changed');
    expect(editor.getMarkdown()).toBe(before);
  });
  it('does not apply a stale inline control to a replacement ticket at the same position', async () => {
    const body = `- [ ] Original ${ticketMarker({id:'original-ticket',boardId:'b1',status:'progress'})}`;
    const view = render(<EditorFixture body={body}/>);
    const editor = editorFor(view.container);
    const toDo = await screen.findByRole('button', {name:'To do'});
    act(() => {
      const current = editor.state.doc.nodeAt(1)!;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(1, undefined, {...current.attrs,ticketId:'replacement-ticket'}));
      fireEvent.click(toDo);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('This ticket changed');
    expect(noteWork(note(editor.getMarkdown())).tickets[0]).toMatchObject({id:'replacement-ticket',status:'progress'});
  });
  it('moves an embedded card through drag and drop without inserting text into the editor', async () => {
    const view = render(<EditorFixture body={`${task}\n\n${board}`}/>);
    const editor = editorFor(view.container);
    const boardUI = await screen.findByRole('group', {name:'Launch board'});
    const card = boardUI.querySelector('.kanban-ticket')!;
    const target = within(boardUI).getByRole('region',{name:'Done'});
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>target});
    fireEvent.pointerDown(card,{button:0,isPrimary:true,pointerId:1,clientX:10,clientY:10});
    fireEvent.pointerMove(card,{pointerId:1,clientX:200,clientY:10});
    expect(target).toHaveAttribute('data-drag-over','true');
    fireEvent.pointerUp(card,{pointerId:1,clientX:200,clientY:10});
    expect(noteWork(note(editor.getMarkdown())).tickets).toHaveLength(1);
    expect(noteWork(note(editor.getMarkdown())).tickets[0].status).toBe('done');
    act(()=>{editor.commands.undo();});
    expect(noteWork(note(editor.getMarkdown())).tickets[0].status).toBe('todo');
  });
  it('renders boards in reading mode with the same source-note ticket actions', () => {
    const n=note(`${board}\n\n${task}`), onPatch=vi.fn(()=>true);
    const view=render(<NoteView note={n} notes={[n]} concepts={[]} onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onUpdateNote={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} onPatchTicket={onPatch}/>);
    const boardUI=screen.getByRole('group',{name:'Launch board'});
    const card = within(boardUI).getByRole('article',{name:'Call Jo'});
    card.focus();
    fireEvent.keyDown(card,{key:'ArrowRight'});
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({id:'t1',noteId:'n'}),{status:'progress'});
    expect(view.container.textContent).not.toContain('orion-ticket:');
  });
  it('assigns an ordinary task from the dashboard and moves that same task in the board', () => {
    function Fixture() {
      const [notes,setNotes]=useState([note(`${board}\n\n- [ ] Call Jo`)]);
      return <HomeTickets spaceId="s" work={collectWork(notes)} notes={notes} onOpenNote={vi.fn()} onPatch={(ticket,patch)=>{
        const body=patchTicket(notes[0].body,ticket,patch);if(body===null)return false;
        setNotes([{...notes[0],body}]);return true;
      }}/>;
    }
    render(<Fixture/>);
    const row = screen.getByRole('checkbox',{name:'Complete Call Jo'}).closest('.ticket-row')!;
    const target = screen.getByRole('button',{name:'Launch'});
    Object.defineProperty(document,'elementFromPoint',{configurable:true,value:()=>target});
    fireEvent.pointerDown(row,{button:0,isPrimary:true,pointerId:1,clientX:10,clientY:10});
    fireEvent.pointerMove(row,{pointerId:1,clientX:200,clientY:10});
    fireEvent.pointerUp(row,{pointerId:1,clientX:200,clientY:10});
    // A real pointer release emits a click which dragging intentionally consumes.
    fireEvent.click(target);
    fireEvent.click(screen.getByRole('button',{name:'Board'}));
    const card = screen.getByRole('article',{name:'Call Jo'});
    card.focus();
    fireEvent.keyDown(card,{key:'ArrowRight'});
    expect(screen.getByRole('article',{name:'Call Jo'})).toHaveFocus();
    expect(within(screen.getByRole('region',{name:'In progress'})).getByText('Call Jo')).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'List'}));
    fireEvent.click(screen.getByRole('button',{name:'Move Call Jo to a board'}));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'No board'}));
    expect(screen.getByRole('button',{name:'Move Call Jo to a board'})).toHaveTextContent('No board');
  });
  it.each(['To do','In progress','Done'])('creates tickets inside the %s column with keyboard entry and Undo', async label => {
    const view = render(<EditorFixture body={board}/>);
    const editor = editorFor(view.container);
    fireEvent.click(await screen.findByRole('button',{name:`Add ticket to ${label}`}));
    const input = screen.getByRole('textbox',{name:`New ticket in ${label}`});
    expect(input).toHaveFocus();
    fireEvent.change(input,{target:{value:'A new action'}});
    fireEvent.submit(input.closest('form')!);
    expect(noteWork(note(editor.getMarkdown())).tickets[0]).toMatchObject({title:'A new action',boardId:'b1',status:label==='Done'?'done':label==='In progress'?'progress':'todo'});
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    fireEvent.keyDown(input,{key:'Escape'});
    expect(screen.getByRole('button',{name:`Add ticket to ${label}`})).toHaveFocus();
    act(()=>editor.commands.undo());
    expect(noteWork(note(editor.getMarkdown())).tickets).toHaveLength(0);
  });
});
