import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CalendarGrid, CalendarPicker, DateButton } from './CalendarPicker';
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); }; });
afterEach(cleanup);
describe('calendar keyboard navigation', () => {
  it('keeps Escape in a portalled date picker from cancelling its parent ticket form', () => {
    const cancelParent=vi.fn();
    render(<form onKeyDown={event=>{if(event.key==='Escape')cancelParent();}}><DateButton onChange={vi.fn()}/></form>);
    fireEvent.click(screen.getByRole('button',{name:'Due date'}));
    fireEvent.keyDown(document.activeElement!,{key:'Escape'});
    expect(cancelParent).not.toHaveBeenCalled();
    fireEvent(screen.getByRole('dialog'),new Event('cancel',{bubbles:true}));
    expect(screen.queryByRole('dialog')).toBeNull();expect(screen.getByRole('button',{name:'Due date'})).toHaveFocus();
  });
  it('moves by days, weeks and months with one roving focus target', () => {
    const select = vi.fn();
    render(<CalendarGrid value="2026-11-30" onSelect={select} autoFocus/>);
    expect(screen.getByRole('button', { name: '30 November 2026' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('button', { name: '1 December 2026' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: '8 December 2026' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'PageDown' });
    expect(screen.getByRole('button', { name: '8 January 2027' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('button', { name: '4 January 2027' })).toHaveFocus();
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(document.activeElement!); expect(select).toHaveBeenCalledWith('2027-01-04');
  });
  it('keeps a stale picker open and supports clearing without an implicit save', () => {
    const choose = vi.fn(() => false), close = vi.fn();
    render(<CalendarPicker value="2026-11-13" onChoose={choose} onClose={close} allowClear/>);
    fireEvent.click(screen.getByRole('button', { name: 'Remove date' }));
    expect(choose).toHaveBeenCalledWith(''); expect(close).not.toHaveBeenCalled(); expect(screen.getByRole('alert')).toHaveTextContent('changed');
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true })); expect(close).toHaveBeenCalledOnce();
  });
});
