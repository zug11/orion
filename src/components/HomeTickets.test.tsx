// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Note } from '../types';
import { boardMarker, collectWork, newTicketMarkdown, noteWork, patchTicket } from '../lib/tickets';
import { HomeTickets, type HomeWorkPreferences } from './HomeTickets';

const note=(body:string):Note=>({id:'n',title:'Plan',body,slug:'n',summary:'',kind:'article',status:'ready',tags:[],aliases:[],sourceIds:[],conceptIds:[],createdAt:'',updatedAt:''});
const board=boardMarker({id:'b',title:'Launch'});
const props={spaceId:'s',onOpenNote:vi.fn(),onCreate:vi.fn(()=>true),onPatch:vi.fn(()=>true)};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(cleanup);
function home(body:string,extra:Partial<Parameters<typeof HomeTickets>[0]>={}){const notes=[note(body)];return <HomeTickets {...props} notes={notes} work={collectWork(notes)} {...extra}/>;}

describe('adaptive Home work sections',()=>{
  it('stays absent without work and reveals only the sections used in this Space',()=>{
    const view=render(home('Just writing.'));
    expect(screen.queryByRole('region')).toBeNull();
    view.rerender(home('- [ ] Call Jo'));
    expect(screen.getByRole('region',{name:'To-dos'})).toBeVisible();expect(screen.queryByRole('region',{name:'Tickets'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Board'})).toBeNull();
    view.rerender(home(`- [ ] Call Jo\n\n${newTicketMarkdown('Publish')}`));
    expect(within(screen.getByRole('region',{name:'To-dos'})).getByText('Call Jo')).toBeVisible();
    expect(within(screen.getByRole('region',{name:'Tickets'})).getByText('Publish')).toBeVisible();
    expect(screen.queryByRole('combobox',{name:/board/i})).toBeNull();
  });
  it('shows an authored empty board, creates in its chosen column, and preselects it in the header composer',()=>{
    render(home(board));
    expect(screen.getByRole('group',{name:'Launch board'})).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:'Add ticket to In progress'}));
    const field=screen.getByRole('textbox',{name:'New ticket in In progress'});
    fireEvent.change(field,{target:{value:'Prepare release'}});fireEvent.submit(field.closest('form')!);
    expect(props.onCreate).toHaveBeenCalledWith('ticket','Prepare release','n','b','progress','','board');
    fireEvent.click(screen.getByRole('button',{name:'New ticket'}));
    const dialog=screen.getByRole('dialog',{name:'Create ticket'});
    expect(within(dialog).getByLabelText('Board')).toHaveValue('b');expect(within(dialog).getByLabelText('In note')).toHaveValue('n');
  });
  it('folds completion away, preserves keyboard focus and never promotes ordinary to-dos',()=>{
    let latest=note('');
    function Fixture(){const [current,setCurrent]=useState(note('- [ ] First\n- [ ] Second'));latest=current;const notes=[current];return <HomeTickets {...props} notes={notes} work={collectWork(notes)} onPatch={(task,patch)=>{const body=patchTicket(current.body,task,patch);if(body===null)return false;setCurrent({...current,body});return true;}}/>;}
    render(<Fixture/>);
    const first=screen.getByRole('checkbox',{name:'Complete First'});first.focus();fireEvent.click(first);
    expect(screen.getByRole('checkbox',{name:'Complete Second'})).toHaveFocus();
    fireEvent.click(screen.getByRole('checkbox',{name:'Complete Second'}));
    expect(screen.getByText('All caught up.')).toBeVisible();expect(screen.getByRole('button',{name:/Completed/})).toHaveFocus();
    expect(noteWork(latest).tickets.every(t=>!t.durable)).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:/Completed/}));
    fireEvent.click(screen.getByRole('checkbox',{name:'Complete First'}));
    expect(screen.getByRole('checkbox',{name:'Complete First'})).not.toBeChecked();
    expect(screen.queryByRole('region',{name:'Tickets'})).toBeNull();
  });
  it('remembers an explicit view per Space and window, and falls back when a board disappears',()=>{
    const preferences=new Map<string,HomeWorkPreferences>();const body=`${board}\n\n${newTicketMarkdown('Publish','b')}`;
    const view=render(home(body,{preferences}));expect(screen.getByRole('group',{name:'Launch board'})).toBeVisible();fireEvent.click(screen.getByRole('button',{name:'List'}));view.unmount();
    const next=render(home(body,{preferences}));expect(screen.queryByRole('group',{name:'Launch board'})).toBeNull();expect(screen.getByRole('button',{name:'List'})).toHaveAttribute('aria-pressed','true');next.unmount();
    const other=render(home(body,{preferences,spaceId:'other'}));expect(screen.getByRole('group',{name:'Launch board'})).toBeVisible();other.unmount();
    const window=render(home(body,{preferences:new Map()}));expect(screen.getByRole('group',{name:'Launch board'})).toBeVisible();window.unmount();
    render(home(newTicketMarkdown('Publish','missing'),{preferences}));expect(screen.getByRole('checkbox',{name:'Complete Publish'})).toBeVisible();expect(screen.queryByRole('button',{name:'Board'})).toBeNull();
  });
});
