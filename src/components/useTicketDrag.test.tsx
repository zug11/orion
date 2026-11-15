// @vitest-environment jsdom
import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Ticket } from '../lib/tickets';
import { useTicketDrag } from './useTicketDrag';

const ticket: Ticket = {
  id:'ticket-one', noteId:'note-one', noteTitle:'Planning', title:'Call Jo',
  boardId:'board-one', status:'todo', lineIndex:0, rawLine:'- [ ] Call Jo', durable:true,
};
const pointer = { button:0, isPrimary:true, pointerId:1, clientX:10, clientY:10 };

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function selectionStarts() {
  return document.dispatchEvent(new Event('selectstart', {bubbles:true, cancelable:true}));
}

function fixture(writable = true) {
  const onPatch = vi.fn(() => true), onOpen = vi.fn(), onControl = vi.fn();
  function Harness() {
    const root = useRef<HTMLDivElement>(null);
    const drag = useTicketDrag(root, writable ? onPatch : undefined);
    return <div ref={root} data-testid="workspace" onClickCapture={drag.onClickCapture} onKeyDownCapture={drag.onKeyDownCapture}>
      <h4>In progress</h4>
      <article aria-label="Call Jo" tabIndex={0} {...drag.cardProps(ticket)}>
        <button className="ticket-open" onClick={onOpen}>Call Jo</button>
        <button className="ticket-date" onClick={onControl}>Add date</button>
        <select aria-label="Urgency" defaultValue=""><option value="">Set urgency</option><option value="high">High</option></select>
        <input type="checkbox" aria-label="Complete" onChange={onControl}/>
        <button className="ticket-assignment" onClick={onControl}>Choose board</button>
        <button className="ticket-concept" onClick={onControl}>Related concept</button>
        <button className="ticket-delete" onClick={onControl}>Delete ticket</button>
      </article>
      <section aria-label="Done" data-ticket-drop-board="board-one" data-ticket-drop-status="done">Done</section>
      {drag.overlay}
    </div>;
  }
  const view = render(<Harness/>);
  const root = screen.getByTestId('workspace');
  const card = screen.getByRole('article', {name:'Call Jo'});
  const title = screen.getByRole('button', {name:'Call Jo'});
  const destination = screen.getByRole('region', {name:'Done'});
  let captured: number | null = null;
  const setCapture = vi.fn((id: number) => { captured = id; });
  const releaseCapture = vi.fn((id: number) => {
    captured = null;
    // Native release also emits capture loss; cleanup must tolerate re-entry.
    fireEvent.lostPointerCapture(card, {pointerId:id});
  });
  Object.defineProperties(card, {
    setPointerCapture: {configurable:true, value:setCapture},
    hasPointerCapture: {configurable:true, value:(id: number) => captured === id},
    releasePointerCapture: {configurable:true, value:releaseCapture},
  });
  let hit: Element | null = destination;
  Object.defineProperty(document, 'elementFromPoint', {configurable:true, value:() => hit});
  const selectHeading = () => {
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(screen.getByRole('heading', {name:'In progress'}));
    selection.removeAllRanges(); selection.addRange(range);
    return selection;
  };
  const start = () => {
    fireEvent.pointerDown(title, pointer);
    fireEvent.pointerMove(card, {...pointer, clientX:60});
  };
  return { ...view, root, card, title, destination, onPatch, onOpen, onControl, setCapture, releaseCapture,
    selectHeading, start, outside:() => {hit = document.body;}, loseCapture:() => {captured = null; fireEvent.lostPointerCapture(card, {pointerId:1});} };
}

describe('ticket drag selection and cleanup', () => {
  it('prevents native pointer-down selection without breaking a plain title click', () => {
    const {title, card, root, onOpen, onPatch} = fixture();
    expect(fireEvent.pointerDown(title, pointer)).toBe(false);
    expect(title).toHaveFocus();
    fireEvent.pointerMove(card, {...pointer, clientX:13});
    expect(root).not.toHaveAttribute('data-ticket-drag-active');
    expect(selectionStarts()).toBe(true);
    fireEvent.pointerUp(card, {...pointer, clientX:13});
    fireEvent.click(title);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onPatch).not.toHaveBeenCalled();
    expect(selectionStarts()).toBe(true);
  });

  it('leaves date, urgency, checkbox and action controls available to their native interactions', () => {
    const {onControl, onPatch, root} = fixture();
    const controls = [
      screen.getByRole('button', {name:'Add date'}), screen.getByRole('combobox', {name:'Urgency'}),
      screen.getByRole('checkbox', {name:'Complete'}),
      screen.getByRole('button', {name:'Choose board'}), screen.getByRole('button', {name:'Related concept'}),
      screen.getByRole('button', {name:'Delete ticket'}),
    ];
    for (const control of controls) {
      expect(fireEvent.pointerDown(control, pointer)).toBe(true);
      fireEvent.pointerMove(control, {...pointer, clientX:100});
      fireEvent.pointerUp(control, {...pointer, clientX:100});
      expect(root).not.toHaveAttribute('data-ticket-drag-active');
      expect(selectionStarts()).toBe(true);
    }
    fireEvent.click(controls[0]);
    fireEvent.change(controls[1], {target:{value:'high'}});
    fireEvent.click(controls[2]);
    expect(controls[1]).toHaveValue('high');
    expect(controls[2]).toBeChecked();
    expect(onControl).toHaveBeenCalledTimes(2);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it('ignores secondary/non-primary gestures and read-only cards', () => {
    const editable = fixture();
    expect(fireEvent.pointerDown(editable.title, {...pointer, button:2})).toBe(true);
    expect(fireEvent.pointerDown(editable.title, {...pointer, isPrimary:false})).toBe(true);
    fireEvent.pointerMove(editable.card, {...pointer, clientX:100});
    expect(editable.root).not.toHaveAttribute('data-ticket-drag-active');
    editable.unmount();
    const readOnly = fixture(false);
    expect(fireEvent.pointerDown(readOnly.title, pointer)).toBe(true);
    fireEvent.pointerMove(readOnly.card, {...pointer, clientX:100});
    expect(readOnly.root).not.toHaveAttribute('data-ticket-drag-active');
    expect(selectionStarts()).toBe(true);
  });

  it('clears accidental selection once at activation and blocks new selection during movement', () => {
    const {start, card, selectHeading, setCapture} = fixture();
    const selection = selectHeading();
    const clear = vi.spyOn(selection, 'removeAllRanges');
    start();
    expect(selection.toString()).toBe('');
    expect(clear).toHaveBeenCalledOnce();
    expect(setCapture).toHaveBeenCalledWith(1);
    expect(selectionStarts()).toBe(false);
    fireEvent.pointerMove(card, {...pointer, clientX:90});
    expect(clear).toHaveBeenCalledOnce();
  });

  it.each(['drop', 'outside drop', 'Escape', 'pointer cancel', 'blur', 'capture loss', 'unmount'] as const)(
    'restores ordinary selection after %s', reason => {
      const view = fixture();
      view.selectHeading(); view.start();
      expect(view.root).toHaveAttribute('data-ticket-drag-active', 'true');
      expect(view.card).toHaveAttribute('data-ticket-dragging', 'true');
      expect(view.destination).toHaveAttribute('data-drag-over', 'true');
      expect(selectionStarts()).toBe(false);
      if (reason === 'drop') fireEvent.pointerUp(view.card, {...pointer, clientX:60});
      else if (reason === 'outside drop') {
        view.outside();
        fireEvent.pointerMove(view.card, {...pointer, clientX:900});
        fireEvent.pointerUp(view.card, {...pointer, clientX:900});
      } else if (reason === 'Escape') fireEvent.keyDown(view.title, {key:'Escape'});
      else if (reason === 'pointer cancel') fireEvent.pointerCancel(view.card, {pointerId:1});
      else if (reason === 'blur') fireEvent.blur(window);
      else if (reason === 'capture loss') view.loseCapture();
      else view.unmount();
      expect(view.root).not.toHaveAttribute('data-ticket-drag-active');
      expect(view.card).not.toHaveAttribute('data-ticket-dragging');
      expect(view.destination).not.toHaveAttribute('data-drag-over');
      expect(document.querySelector('.ticket-drag-ghost')).toBeNull();
      expect(selectionStarts()).toBe(true);
      if (reason === 'drop') {
        expect(view.onPatch).toHaveBeenCalledExactlyOnceWith(ticket, {boardId:'board-one', status:'done'});
        fireEvent.click(view.title);
        expect(view.onOpen).not.toHaveBeenCalled();
      } else expect(view.onPatch).not.toHaveBeenCalled();
      if (reason !== 'capture loss') expect(view.releaseCapture).toHaveBeenCalledOnce();
    },
  );

  it('ignores capture loss from another pointer', () => {
    const {start, card, root} = fixture();
    start();
    fireEvent.lostPointerCapture(card, {pointerId:99});
    expect(root).toHaveAttribute('data-ticket-drag-active', 'true');
    expect(selectionStarts()).toBe(false);
    fireEvent.pointerCancel(card, {pointerId:1});
    expect(selectionStarts()).toBe(true);
  });
});
