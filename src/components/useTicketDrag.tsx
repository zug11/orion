import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { validTicketStatus, type Ticket, type TicketPatch } from '../lib/tickets';

/** Pointer dragging also works inside WKWebView's native file-drop interception. */
export function useTicketDrag(root: RefObject<HTMLElement | null>, onPatch?: (ticket: Ticket, patch: TicketPatch) => boolean) {
  const session = useRef<{ ticket: Ticket; x: number; y: number; active: boolean; pointer: number; element: HTMLElement } | null>(null);
  const target = useRef<HTMLElement | null>(null);
  const restoreSelection = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const releaseClick = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [ghost, setGhost] = useState<{ title: string; x: number; y: number } | null>(null);
  const [message, setMessage] = useState('');
  const release = () => {
    target.current?.removeAttribute('data-drag-over'); target.current = null;
    const current = session.current;
    session.current = null;
    restoreSelection.current?.(); restoreSelection.current = null;
    try {
      if (current?.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer);
    } catch { /* A completed move can detach its old editor card before release. */ }
    current?.element.removeAttribute('data-ticket-dragging');
  };
  const clear = () => { release(); setGhost(null); };
  useEffect(() => {
    window.addEventListener('blur', clear);
    return () => { window.removeEventListener('blur', clear); clearTimeout(releaseClick.current); release(); };
  }, []);
  function down(event: ReactPointerEvent<HTMLElement>, ticket: Ticket) {
    if (event.defaultPrevented || !onPatch || event.button !== 0 || !event.isPrimary || !(event.target instanceof Element) || event.target.closest('input,select,textarea,form,.ticket-date,.ticket-delete,.ticket-assignment,.ticket-concept')) return;
    // Cancel native mouse selection before its first movement, including in
    // WebKit. Pointermove cancellation alone is too late for column headings.
    event.preventDefault();
    if (session.current) clear();
    const focusTarget = event.target.closest<HTMLElement>('button:not(:disabled),a[href],[tabindex]');
    if (focusTarget && event.currentTarget.contains(focusTarget)) focusTarget.focus({ preventScroll: true });
    else event.currentTarget.querySelector<HTMLElement>('.ticket-open')?.focus({ preventScroll: true });
    suppressClick.current = false;
    session.current = { ticket, x: event.clientX, y: event.clientY, active: false, pointer: event.pointerId, element: event.currentTarget };
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const current = session.current;
    if (!current || event.pointerId !== current.pointer) return;
    if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 5) return;
    if (!current.active) {
      current.active = true;
      current.element.setPointerCapture?.(event.pointerId);
      current.element.setAttribute('data-ticket-dragging', 'true');
      const document = current.element.ownerDocument, area = root.current;
      const preventSelection = (event: Event) => event.preventDefault();
      area?.setAttribute('data-ticket-drag-active', 'true');
      document.addEventListener('selectstart', preventSelection, true);
      document.getSelection()?.removeAllRanges();
      restoreSelection.current = () => {
        area?.removeAttribute('data-ticket-drag-active');
        document.removeEventListener('selectstart', preventSelection, true);
      };
    }
    event.preventDefault();
    setGhost({ title: current.ticket.title, x: event.clientX, y: event.clientY });
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-ticket-drop-board]') ?? null;
    const next = hit && root.current?.contains(hit) ? hit : null;
    if (target.current !== next) { target.current?.removeAttribute('data-drag-over'); next?.setAttribute('data-drag-over', 'true'); target.current = next; }
  }
  function up(event: ReactPointerEvent<HTMLElement>) {
    const current = session.current;
    if (!current || current.pointer !== event.pointerId) return;
    if (current.active) {
      event.preventDefault(); suppressClick.current = true;
      clearTimeout(releaseClick.current);
      releaseClick.current = setTimeout(() => { suppressClick.current = false; }, 0);
      const drop = target.current;
      if (drop) {
        const status = drop.dataset.ticketDropStatus;
        const patch: TicketPatch = { boardId: drop.dataset.ticketDropBoard ?? '' };
        if (validTicketStatus(status)) patch.status = status as Ticket['status'];
        const ok = onPatch?.(current.ticket, patch);
        setMessage(ok ? 'Ticket moved.' : 'This ticket changed. Try again.');
      }
    }
    clear();
  }
  return {
    cardProps: (ticket: Ticket) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => down(event, ticket), onPointerMove: move, onPointerUp: up,
      onPointerCancel: clear,
      onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => { if (session.current?.pointer === event.pointerId) clear(); },
      // Native HTML dragging would hand this gesture to Tauri's file-drop bridge.
      onDragStart: (event: React.DragEvent) => event.preventDefault(),
    }),
    onClickCapture: (event: React.MouseEvent) => { if (suppressClick.current) { suppressClick.current = false; event.preventDefault(); event.stopPropagation(); } },
    onKeyDownCapture: (event: ReactKeyboardEvent) => { if (event.key === 'Escape' && session.current?.active) { event.preventDefault(); event.stopPropagation(); clear(); } },
    overlay: <>{ghost && createPortal(<div className="ticket-drag-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>{ghost.title}</div>, document.body)}<span className="sr-only" role="status">{message}</span></>,
  };
}
