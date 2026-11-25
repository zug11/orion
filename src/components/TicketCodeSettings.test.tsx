import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createEmptySnapshot } from '../data/defaults';
import { TicketCodeSettings, TicketNavigationRoot } from './TicketNavigation';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
});
afterEach(cleanup);

it('closes only the nested codes dialog on Escape and restores its trigger', () => {
  const parentCancel = vi.fn();
  render(<TicketNavigationRoot snapshot={createEmptySnapshot('Writing')} target={{}} openTicket={vi.fn()} openBoard={vi.fn()} changePrefix={vi.fn()} onClose={vi.fn()} onOpenNote={vi.fn()} onPatch={vi.fn()}>
    <dialog open onCancel={parentCancel}><TicketCodeSettings/></dialog>
  </TicketNavigationRoot>);
  const trigger = screen.getByRole('button', { name: 'Ticket codes' });
  fireEvent.click(trigger);
  expect(screen.getByRole('textbox', { name: 'Ticket code prefix' })).toHaveFocus();
  fireEvent(screen.getByRole('dialog', { name: 'Ticket codes' }), new Event('cancel', { bubbles: true, cancelable: true }));
  expect(parentCancel).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'Ticket codes' })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it('saves the normalized prefix through the existing Space action', async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(<TicketNavigationRoot snapshot={createEmptySnapshot('Writing')} target={{}} openTicket={vi.fn()} openBoard={vi.fn()} changePrefix={save} onClose={vi.fn()} onOpenNote={vi.fn()} onPatch={vi.fn()}><TicketCodeSettings/></TicketNavigationRoot>);
  fireEvent.click(screen.getByRole('button', { name: 'Ticket codes' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Ticket code prefix' }), { target: { value: 'write' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save prefix' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Ticket codes' })).not.toBeInTheDocument());
  expect(save).toHaveBeenCalledWith('WRITE');
});
