// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TicketInferenceDialog } from './TicketInferenceDialog';
import { KanbanBoard, EMPTY_WORK } from './Tickets';
import type { TicketInference } from '../lib/ticketInference';
const board={id:'b',title:'Launch',noteId:'n'};
const result:TicketInference={boardId:'b',noteId:'n',noteTitle:'Plan',baseBody:'Some prose.',partial:false,suggestions:[{title:'Ask Jo',evidence:'We should ask Jo.'},{title:'Consider a smaller launch',evidence:'Maybe a smaller launch would help.'}]};
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(cleanup);
describe('reviewing inferred board tickets',()=>{
  it('dispatches only once under StrictMode',async()=>{
    const generate=vi.fn(async()=>result);
    render(<StrictMode><TicketInferenceDialog board={board} actions={{generate,apply:vi.fn()}} onClose={vi.fn()}/></StrictMode>);
    await screen.findByRole('textbox',{name:'Ticket 1'});expect(generate).toHaveBeenCalledOnce();
  });
  it('does not create anything until acceptance, and accepts only edited, selected suggestions',async()=>{
    const actions={generate:vi.fn(async()=>result),apply:vi.fn(()=>true)};const onClose=vi.fn();
    render(<TicketInferenceDialog board={board} actions={actions} onClose={onClose}/>);
    const title=await screen.findByRole('textbox',{name:'Ticket 1'});
    expect(actions.apply).not.toHaveBeenCalled();expect(screen.getByText('We should ask Jo.')).toBeVisible();
    fireEvent.change(title,{target:{value:'Ask Jo about the venue'}});fireEvent.click(screen.getByRole('checkbox',{name:'Include suggestion 2'}));
    fireEvent.click(screen.getByRole('button',{name:'Add 1 ticket'}));
    expect(actions.apply).toHaveBeenCalledWith(board,result,['Ask Jo about the venue'],undefined,['']);expect(onClose).toHaveBeenCalledOnce();
  });
  it('shows inferred urgency and lets the user change or clear it before applying', async () => {
    const inferred: TicketInference = { ...result, suggestions: result.suggestions.map(s => ({ ...s, urgency: 'high' })) };
    const apply = vi.fn(() => true);
    render(<TicketInferenceDialog board={board} actions={{generate:async()=>inferred, apply}} onClose={vi.fn()}/>);
    const first = await screen.findByRole('combobox', {name:'Urgency for suggestion 1'});
    expect(first).toHaveValue('high');
    fireEvent.change(first, {target:{value:''}});
    fireEvent.change(screen.getByRole('combobox', {name:'Urgency for suggestion 2'}), {target:{value:'low'}});
    fireEvent.click(screen.getByRole('button', {name:'Add 2 tickets'}));
    expect(apply).toHaveBeenCalledWith(board, inferred, result.suggestions.map(s=>s.title), undefined, ['', 'low']);
  });
  it('keeps a stale review unsaved and allows a fresh inference attempt',async()=>{
    const actions={generate:vi.fn(async()=>result),apply:vi.fn(()=>false)};
    render(<TicketInferenceDialog board={board} actions={actions} onClose={vi.fn()}/>);
    fireEvent.click(await screen.findByRole('button',{name:'Add 2 tickets'}));
    expect(screen.getByRole('alert')).toHaveTextContent('The note changed');
    expect(screen.queryByRole('button',{name:'Add 2 tickets'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Infer again'}));
    await screen.findByRole('button',{name:'Add 2 tickets'});expect(actions.generate).toHaveBeenCalledTimes(2);
  });
  it('aborts on leaving the board and ignores a late response',async()=>{
    let resolve!:(value:TicketInference)=>void;let signal!:AbortSignal;
    const actions={generate:vi.fn((_board,abort)=>{signal=abort;return new Promise<TicketInference>(done=>{resolve=done;});}),apply:vi.fn(()=>true)};
    const view=render(<TicketInferenceDialog board={board} actions={actions} onClose={vi.fn()}/>);
    await waitFor(()=>expect(actions.generate).toHaveBeenCalledOnce());
    expect(signal.aborted).toBe(false);view.unmount();expect(signal.aborted).toBe(true);
    await act(async()=>resolve(result));expect(actions.apply).not.toHaveBeenCalled();
  });
  it('leaves ordinary board creation available with no AI key and never calls inference',()=>{
    const inference={generate:vi.fn(),apply:vi.fn(),unavailableReason:'Add an AI key in Settings to infer tickets.'};
    render(<KanbanBoard board={board} workspace={{work:EMPTY_WORK,inference,onCreateTicket:vi.fn(()=>true)}}/>);
    expect(screen.getByRole('button',{name:'Infer tickets from note'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button',{name:'Add ticket to To do'}));expect(screen.getByRole('textbox',{name:'New ticket in To do'})).toHaveFocus();
    expect(inference.generate).not.toHaveBeenCalled();
  });
  it('reports provider failures without adding tickets',async()=>{
    const apply=vi.fn();render(<TicketInferenceDialog board={board} actions={{generate:async()=>{throw new Error('Offline. Try again.');},apply}} onClose={vi.fn()}/>);
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Offline'));
    expect(apply).not.toHaveBeenCalled();
  });
});
