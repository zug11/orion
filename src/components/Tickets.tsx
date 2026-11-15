import { DateButton } from './CalendarPicker';
import { createContext, useContext, useLayoutEffect, useEffect, useRef, useState } from 'react';
import type { Note } from '../types';
import { collectWork, TICKET_STATUSES, TICKET_URGENCIES, type TicketUrgency, type NoteBoard, type Ticket, type TicketPatch, type TicketStatus } from '../lib/tickets';
import type { TicketInferenceActions } from '../lib/ticketInference';
import { displayNoteTitle } from '../lib/noteMetadata';
import { ChevronDown, Plus, Trash2, X } from '../lib/icons';
import { useTicketDrag } from './useTicketDrag';
import { TicketInferenceDialog } from './TicketInferenceDialog';
import './Tickets.css';

export type CreateWorkItem = (kind: 'ticket' | 'kanban', title: string, noteId: string, boardId: string, status?: TicketStatus, dueDate?: string, origin?: 'board') => boolean;
export interface TicketWorkspace {
  work: ReturnType<typeof collectWork>;
  onPatch?: (ticket: Ticket, patch: TicketPatch) => boolean;
  onDelete?: (ticket: Ticket) => boolean;
  onOpenNote?: (id: string) => void;
  onEditTicket?: (ticket: Ticket) => boolean;
  onCreateTicket?: (board: NoteBoard, title: string, status: TicketStatus, dueDate?: string) => boolean;
  inference?: TicketInferenceActions;
}
export const EMPTY_WORK: ReturnType<typeof collectWork> = { tickets: [], boards: [] };
export const TicketContext = createContext<TicketWorkspace>({ work: EMPTY_WORK });
export const useTickets = () => useContext(TicketContext);
export const BOARD_PAGE_SIZE = 10;

export function LoadMoreTickets({ remaining, pageSize, label, onLoad }: { remaining: number; pageSize: number; label: string; onLoad: () => void }) {
  return remaining > 0 ? <button type="button" className="ticket-load-more" aria-label={`Load ${Math.min(pageSize, remaining)} more ${label}`} onClick={onLoad}>
    Load {Math.min(pageSize, remaining)} more <span>{remaining} remaining</span>
  </button> : null;
}

export function KanbanBoard({ board, workspace, showSource = false }: { board: NoteBoard; workspace: TicketWorkspace; showSource?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<string | null>(null);
  const restoreAfterDelete = useRef<{ key?: string; status: TicketStatus } | null>(null);
  const addButtons = useRef(new Map<TicketStatus, HTMLButtonElement>());
  const focusAdd = useRef<TicketStatus | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inferButton = useRef<HTMLButtonElement>(null);
  const [creating, setCreating] = useState<TicketStatus | null>(null);
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [inferring, setInferring] = useState(false);
  const [error, setError] = useState('');
  const [pages, setPages] = useState({ board: board.id, extra: new Set<string>() });
  const extra = pages.board === board.id ? pages.extra : new Set<string>();
  const ticketKey = (ticket: Ticket) => `${ticket.noteId}:${ticket.id}`;
  const reveal = (tickets: Ticket[]) => setPages(current => ({ board: board.id,
    extra: new Set([...(current.board === board.id ? current.extra : []), ...tickets.map(ticketKey)]) }));
  const pendingCreation = useRef<{ ids: Set<string>; status: TicketStatus } | null>(null);
  const move = (ticket: Ticket, status: TicketStatus) => {
    const focused = root.current?.contains(document.activeElement);
    const changed = workspace.onPatch?.(ticket, { status });
    if (changed) { reveal([ticket]); if (focused) restoreFocus.current = ticketKey(ticket); }
    setError(changed ? '' : 'This ticket changed. Try again.');
  };
  const drag = useTicketDrag(root, workspace.onPatch ? (ticket, patch) => {
    const changed = workspace.onPatch?.(ticket, patch) ?? false;
    if (changed) { reveal([ticket]); restoreFocus.current = ticketKey(ticket); }
    return changed;
  } : undefined);
  const remove = (ticket: Ticket) => {
    const focused = root.current?.contains(document.activeElement);
    const column = workspace.work.tickets.filter(candidate => candidate.boardId === board.id && candidate.status === ticket.status);
    const index = column.indexOf(ticket), next = column[index + 1] ?? column[index - 1];
    if (focused) restoreAfterDelete.current = { key: next ? `${next.noteId}:${next.id}` : undefined, status: ticket.status };
    const deleted = workspace.onDelete?.(ticket) ?? false;
    if (!deleted) restoreAfterDelete.current = null;
    return deleted;
  };
  useLayoutEffect(() => {
    if (pendingCreation.current) {
      const pending = pendingCreation.current;
      const added = workspace.work.tickets.filter(t => t.boardId === board.id && t.status === pending.status && !pending.ids.has(ticketKey(t)));
      if (added.length) { pendingCreation.current = null; reveal(added); }
    }
    if (restoreAfterDelete.current) {
      const pending = restoreAfterDelete.current;
      restoreAfterDelete.current = null;
      const next = [...(root.current?.querySelectorAll<HTMLElement>('[data-ticket-key]') ?? [])]
        .find(element => element.dataset.ticketKey === pending.key);
      (next ?? addButtons.current.get(pending.status) ?? root.current)?.focus({ preventScroll: true });
    }
    if (!restoreFocus.current) return;
    const target = [...(root.current?.querySelectorAll<HTMLElement>('[data-ticket-key]') ?? [])]
      .find(element => element.dataset.ticketKey === restoreFocus.current);
    restoreFocus.current = null;
    target?.focus({ preventScroll: true });
  }, [workspace.work, pages]);
  useLayoutEffect(() => {
    if (creating) input.current?.focus({ preventScroll: true });
    else if (focusAdd.current) { addButtons.current.get(focusAdd.current)?.focus({ preventScroll: true }); focusAdd.current = null; }
  }, [creating]);
  const cancel = () => { focusAdd.current = creating; setCreating(null); setTitle(''); setError(''); };
  return <div ref={root} className="kanban-workspace" role="group" tabIndex={-1} aria-label={`${board.title} board`} data-narration-ignore="true" onClickCapture={drag.onClickCapture} onKeyDownCapture={drag.onKeyDownCapture}>
    {(showSource || workspace.inference) && <div className="kanban-tools">
      {showSource && <button type="button" className="ticket-board-source text-button" onClick={() => workspace.onOpenNote?.(board.noteId)}>Open board’s note</button>}
      {workspace.inference && <button ref={inferButton} type="button" className="text-button ticket-infer-button" disabled={Boolean(workspace.inference.unavailableReason)} title={workspace.inference.unavailableReason} onClick={() => setInferring(true)}>Infer tickets from note</button>}
    </div>}
    <div className="orion-kanban">
      {TICKET_STATUSES.map(([status, label], columnIndex) => {
        const tickets = workspace.work.tickets.filter(t => t.boardId === board.id && t.status === status);
        const visible = tickets.filter((t, i) => i < BOARD_PAGE_SIZE || extra.has(ticketKey(t)));
        const visibleKeys = new Set(visible.map(ticketKey));
        const remaining = tickets.filter(t => !visibleKeys.has(ticketKey(t)));
        return <section key={status} aria-label={label} className="kanban-column" data-ticket-drop-board={board.id} data-ticket-drop-status={status}>
          <h4>{label}<span>{tickets.length}</span></h4>
          {visible.map(t => <article className="kanban-ticket" data-ticket-key={`${t.noteId}:${t.id}`} key={`${t.noteId}:${t.id}`} tabIndex={workspace.onPatch ? 0 : undefined}
            aria-label={t.title} aria-keyshortcuts="ArrowLeft ArrowRight" {...drag.cardProps(t)}
            onKeyDown={event => {
              if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
              const next = TICKET_STATUSES[columnIndex + (event.key === 'ArrowRight' ? 1 : -1)];
              if (next && workspace.onPatch) { event.preventDefault(); move(t, next[0]); }
            }}>
            {workspace.onDelete && <TicketDeleteButton title={t.title} onDelete={() => remove(t)}/>}
            <button type="button" className="ticket-open" disabled={!workspace.onOpenNote && !workspace.onEditTicket} title={workspace.onEditTicket ? 'Edit ticket' : undefined} onClick={() => {
              if (!workspace.onEditTicket?.(t)) workspace.onOpenNote?.(t.noteId);
            }}>{t.title}</button>
            {t.origin !== 'board' && <small>{t.noteTitle}</small>}
            {workspace.onPatch && <div className="kanban-card-footer">
              <DateButton value={t.dueDate} label={`Due date for ${t.title}`} onChange={dueDate => workspace.onPatch?.(t, { dueDate }) ?? false}/>
              <div className="kanban-card-options">
                <UrgencyPicker value={t.urgency} title={t.title} onChange={urgency => workspace.onPatch?.(t, { urgency }) ?? false}/>
              </div>
            </div>}
          </article>)}
          <LoadMoreTickets remaining={remaining.length} pageSize={BOARD_PAGE_SIZE} label={`tickets in ${label}`} onLoad={() => {
            restoreFocus.current = ticketKey(remaining[0]); reveal(remaining.slice(0, BOARD_PAGE_SIZE));
          }}/>
          {creating === status ? <form className="kanban-create" onKeyDown={event => {
            event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); cancel(); }
          }} onSubmit={event => {
            event.preventDefault(); event.stopPropagation(); if (!title.trim()) return;
            pendingCreation.current = { ids: new Set(workspace.work.tickets.map(ticketKey)), status };
            if (workspace.onCreateTicket?.(board, title.trim(), status, dueDate)) { setTitle(''); setDueDate(''); setError(''); input.current?.focus({ preventScroll: true }); }
            else { pendingCreation.current = null; setError('The board changed. Close this field and try again.'); }
          }}>
            <input ref={input} aria-label={`New ticket in ${label}`} placeholder="What needs doing?" maxLength={140} required value={title} onChange={event => setTitle(event.target.value)}/>
            <DateButton value={dueDate} onChange={setDueDate}/>
            <div><button type="submit" className="text-button">Add ticket</button><button type="button" className="icon-button" aria-label="Cancel new ticket" onClick={cancel}><X size={13}/></button></div>
          </form> : workspace.onCreateTicket ? <button ref={node => { if (node) addButtons.current.set(status, node); else addButtons.current.delete(status); }} type="button" className="kanban-add" aria-label={`Add ticket to ${label}`} onClick={() => { setTitle(''); setDueDate(''); setError(''); setCreating(status); }}><Plus size={13}/>Add ticket</button> : !tickets.length && <p className="kanban-empty">No tickets</p>}
        </section>;
      })}
    </div>
    {error && <p role="alert" className="ticket-error">{error}</p>}
    {drag.overlay}
    {inferring && workspace.inference && <TicketInferenceDialog board={board} actions={workspace.inference} onClose={() => { setInferring(false); inferButton.current?.focus({ preventScroll: true }); }}/ >}
  </div>;
}

export function WorkItemComposer({ kind, notes, defaultNoteId, defaultBoardId, boards = [], onCreate, onClose }: {
  kind: 'ticket' | 'kanban'; notes?: readonly Note[]; defaultNoteId?: string; defaultBoardId?: string; boards?: readonly NoteBoard[];
  onCreate: (title: string, noteId: string, boardId: string, dueDate?: string) => boolean; onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [noteId, setNoteId] = useState(defaultNoteId ?? notes?.[0]?.id ?? '');
  const [boardId, setBoardId] = useState(defaultBoardId ?? '');
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const node = dialog.current; node?.showModal(); node?.querySelector('input')?.focus();return () => node?.close(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return <dialog ref={dialog} className="work-item-composer" aria-label={kind === 'ticket' ? 'Create ticket' : 'Create kanban'} onCancel={event => { event.preventDefault();close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <form onSubmit={event => { event.preventDefault();if (!title.trim()) return;if (onCreate(title.trim(), noteId, boardId, dueDate)) close();else setError(true); }}>
      <header><h2>{kind === 'ticket' ? 'New ticket' : 'New kanban'}</h2><button className="icon-button" type="button" aria-label="Cancel" onClick={close}><X size={16}/></button></header>
      <label>{kind === 'ticket' ? 'Ticket' : 'Board name'}<input autoFocus required maxLength={140} value={title} onChange={e => setTitle(e.target.value)} placeholder={kind === 'ticket' ? 'What needs doing?' : 'Name this board'} /></label>
      {notes && <label>In note<select value={noteId} onChange={e => setNoteId(e.target.value)}>{notes.map(n => <option key={n.id} value={n.id}>{displayNoteTitle(n)}</option>)}</select></label>}
      {kind === 'ticket' && boards.length > 0 && <label>Board<select value={boardId} onChange={e => setBoardId(e.target.value)}><option value="">No board</option>{boards.map(b => <option key={`${b.noteId}:${b.id}`} value={b.id}>{b.title}</option>)}</select></label>}
      {kind === 'ticket' && <DateButton value={dueDate} onChange={setDueDate}/>}
      {error && <p role="alert">The note changed. Cancel and choose the insertion point again.</p>}
      <footer><span>Enter to create · Esc to cancel</span><button className="button primary" type="submit">Create {kind === 'ticket' ? 'ticket' : 'board'}</button></footer>
    </form>
  </dialog>;
}


export function TicketCardControls({ status, dueDate, urgency, onPatch }: { status: TicketStatus; dueDate?: string; urgency?: TicketUrgency; onPatch?: (patch: TicketPatch) => boolean }) {
  const [error, setError] = useState(false);
  return <div className="note-ticket-controls" data-narration-ignore="true">
    {onPatch && <DateButton value={dueDate} onChange={dueDate => onPatch({ dueDate })}/>}
    <div className="note-ticket-options">
      <div className="note-ticket-status" aria-label="Ticket status">{TICKET_STATUSES.map(([id, label]) => <button type="button" key={id} aria-pressed={id === status} disabled={!onPatch} onClick={() => setError(!onPatch?.({ status: id }))}>{label}</button>)}</div>
      {onPatch && <UrgencyPicker value={urgency} onChange={urgency => onPatch({ urgency })}/>}
    </div>
    {error && <span className="ticket-error" role="alert">This ticket changed. Try again.</span>}
  </div>;
}

export function UrgencyPicker({ value = '', title = 'ticket', onChange }: { value?: TicketUrgency; title?: string; onChange: (value: TicketUrgency) => boolean }) {
  const [error, setError] = useState(false);
  return <span className="ticket-urgency-field"><span className="ticket-priority-control"><select className={`ticket-urgency${value ? ` is-${value}` : ' is-empty'}`} value={value}
    aria-label={`Urgency for ${title}`} title={value ? `${value[0].toUpperCase()}${value.slice(1)} urgency` : 'Set urgency'} onChange={event => setError(!onChange(event.target.value as TicketUrgency))}>
    <option value="">{value ? 'Clear urgency' : 'Set urgency'}</option>{TICKET_URGENCIES.map(urgency => <option value={urgency} key={urgency}>{urgency[0].toUpperCase()}{urgency.slice(1)}</option>)}
  </select><span className="ticket-priority-dot" aria-hidden="true"/><ChevronDown className="ticket-priority-chevron" size={12} aria-hidden="true"/></span>{error && <span role="alert" className="ticket-error">This ticket changed. Try again.</span>}</span>;
}

export function TicketDeleteButton({ title, onDelete }: { title: string; onDelete: () => boolean }) {
  const [error, setError] = useState(false);
  return <>
    <button type="button" className="ticket-delete" aria-label={`Delete ${title}`} title="Delete ticket" data-narration-ignore="true" onClick={event => {
      event.stopPropagation();
      if (window.confirm(`Delete “${title}” and its contents from its note and all boards?`)) setError(!onDelete());
    }}><Trash2 size={13} aria-hidden="true"/></button>
    {error && <span className="ticket-delete-error ticket-error" role="alert" data-narration-ignore="true">This ticket changed. Try again.</span>}
  </>;
}
