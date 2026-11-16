import { DateButton } from './CalendarPicker';
import { HomeCalendar } from './HomeCalendar';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Concept, Note } from '../types';
import { collectWork, type Ticket } from '../lib/tickets';
import { taskConcept } from '../lib/tasks';
import BorderGlow from './BorderGlow';
import { ChevronRight, Columns3, List, ListTodo, Plus, X } from '../lib/icons';
import { UrgencyPicker, KanbanBoard, LoadMoreTickets, WorkItemComposer, type CreateWorkItem, type TicketWorkspace } from './Tickets';
import { useTicketDrag } from './useTicketDrag';
import type { DismissCalendarMention } from '../lib/calendarDismissal';
import { TicketCode } from './TicketCode';
import { useTicketNavigation } from './TicketNavigation';
import { TicketDetailsDialog } from './TicketDetailsDialog';

export interface HomeWorkPreferences {
  view?: 'list' | 'board'; boardId?: string; todosCompleted?: boolean; ticketsCompleted?: boolean;
}
type SessionPreferences = Map<string, HomeWorkPreferences>;
const rowKey = (ticket: Ticket) => `${ticket.noteId}:${ticket.lineIndex}`;

function WorkList({ tickets, workspace, concepts, completed, onCompletedChange, onAssign, onOpenConcept, drag }: {
  tickets: Ticket[]; workspace: TicketWorkspace; concepts: Map<Ticket, Concept | undefined>;
  completed: boolean; onCompletedChange: (open: boolean) => void; onAssign?: (ticket: Ticket) => void;
  onOpenConcept?: (id: string) => void;
  drag: ReturnType<typeof useTicketDrag>;
}) {
  const navigation=useTicketNavigation();
  const [expanded, setExpanded] = useState<Pick<Ticket, 'id' | 'noteId'> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const disclosure = useRef<HTMLButtonElement>(null);
  const restore = useRef<string | 'completed' | null>(null);
  const completedId = useId();
  const open = tickets.filter(t => t.status !== 'done');
  const done = tickets.filter(t => t.status === 'done');
  const [error, setError] = useState('');
  const [openLimit, setOpenLimit] = useState(20);
  const [doneLimit, setDoneLimit] = useState(20);
  useLayoutEffect(() => {
    if (!restore.current) return;
    const row = [...(root.current?.querySelectorAll<HTMLElement>('[data-work-key]') ?? [])].find(e => e.dataset.workKey === restore.current);
    (row?.querySelector<HTMLElement>('input') ?? disclosure.current)?.focus({ preventScroll: true });
    restore.current = null;
  }, [tickets, openLimit, doneLimit]);
  function toggle(ticket: Ticket, checked: boolean) {
    const focused = root.current?.contains(document.activeElement);
    const ok = workspace.onPatch?.(ticket, { status: checked ? 'done' : 'todo' });
    setError(ok ? '' : 'This item changed. Try again.');
    if (ok && focused) {
      const index = open.indexOf(ticket);
      const next = open[index + 1] ?? open[index - 1];
      restore.current = checked && !completed ? next ? rowKey(next) : 'completed' : rowKey(ticket);
    }
  }
  function row(ticket: Ticket) {
    const concept = concepts.get(ticket);
    const board = workspace.work.boards.find(b => b.id === ticket.boardId);
    return <div className={`ticket-row${ticket.status === 'done' ? ' is-complete' : ''}`} data-work-key={rowKey(ticket)} key={rowKey(ticket)} {...drag.cardProps(ticket)}>
      <input className="home-work-check" type="checkbox" aria-label={`Complete ${ticket.title}`} checked={ticket.status === 'done'} disabled={!workspace.onPatch} onChange={e => toggle(ticket, e.target.checked)}/>
      <div className="ticket-row-copy">{ticket.durable && <TicketCode id={ticket.id}/>}<button type="button" className="ticket-open" onClick={() => ticket.durable ? navigation.openTicket ? navigation.openTicket(ticket.id) : setExpanded({ id: ticket.id, noteId: ticket.noteId }) : workspace.onOpenNote?.(ticket.noteId)}>{ticket.title}</button>
        <small>{ticket.origin !== 'board' && <span>{ticket.noteTitle}</span>}{ticket.origin !== 'board' && concept && onOpenConcept && <><button type="button" className="ticket-concept" onClick={() => onOpenConcept(concept.id)}>{concept.label}</button></>}{ticket.status === 'progress' && <span className="ticket-progress"> · In progress</span>}</small>
      </div>
      {ticket.durable && workspace.onPatch && <UrgencyPicker value={ticket.urgency} title={ticket.title} onChange={urgency => workspace.onPatch?.(ticket, { urgency }) ?? false}/>}
      {ticket.durable && workspace.onPatch && <DateButton value={ticket.dueDate} label={`Due date for ${ticket.title}`} onChange={dueDate => workspace.onPatch?.(ticket, { dueDate }) ?? false}/>}
      {onAssign && <button type="button" className="ticket-assignment" aria-label={`Move ${ticket.title} to a board`} aria-haspopup="dialog" onClick={() => onAssign(ticket)}>{board?.title ?? 'No board'}</button>}
    </div>;
  }
  return <div ref={root} className="ticket-list">
    {open.slice(0, openLimit).map(row)}
    <LoadMoreTickets remaining={open.length - openLimit} pageSize={20} label="open items" onLoad={() => { restore.current = rowKey(open[openLimit]); setOpenLimit(limit => limit + 20); }}/>
    {!open.length && <p className="kanban-empty">{done.length ? 'All caught up.' : 'No tickets yet.'}</p>}
    {done.length > 0 && <><button ref={disclosure} type="button" className="ticket-completed-toggle" aria-expanded={completed} aria-controls={completedId} onClick={() => onCompletedChange(!completed)}><ChevronRight size={13}/>Completed <span>{done.length}</span></button>
      {completed && <div id={completedId}>{done.slice(0, doneLimit).map(row)}<LoadMoreTickets remaining={done.length - doneLimit} pageSize={20} label="completed items" onLoad={() => { restore.current = rowKey(done[doneLimit]); setDoneLimit(limit => limit + 20); }}/></div>}</>}
    {error && <p role="alert" className="ticket-error">{error}</p>}
    {expanded && <TicketDetailsDialog selected={expanded} workspace={workspace} onClose={() => setExpanded(null)}/>}
  </div>;
}

function AssignTicket({ ticket, workspace, onClose }: { ticket: Ticket; workspace: TicketWorkspace; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => { const node = dialog.current; node?.showModal(); node?.querySelector<HTMLElement>('[aria-pressed=true]')?.focus(); return () => node?.close(); }, []);
  const close = () => { dialog.current?.close(); onClose(); };
  return <dialog ref={dialog} className="work-item-composer ticket-assign-dialog" aria-label="Move ticket to board" onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>Move ticket</h2><button type="button" className="icon-button" aria-label="Cancel" onClick={close}><X size={16}/></button></header>
    <p>{ticket.title}</p>
    <div className="ticket-board-choices">{[{ id: '', title: 'No board' }, ...workspace.work.boards].map(board => <button key={board.id} type="button" aria-pressed={ticket.boardId === board.id || !board.id && !workspace.work.boards.some(b => b.id === ticket.boardId)} onClick={() => {
      if (workspace.onPatch?.(ticket, { boardId: board.id })) close(); else setError(true);
    }}>{board.title}</button>)}</div>
    {error && <p className="ticket-error" role="alert">This ticket changed. Close and try again.</p>}
  </dialog>;
}

export function HomeTickets({ spaceId, preferences, notes, work, concepts, onOpenConcept, onPatch, onDelete, onOpenNote, onCreate, inference, overview, onDismissCalendarMention }: {
  spaceId: string; preferences?: SessionPreferences; notes: readonly Note[]; work: ReturnType<typeof collectWork>;
  concepts?: readonly Concept[]; onPatch?: TicketWorkspace['onPatch']; onOpenNote: (id: string) => void;
  onDelete?: TicketWorkspace['onDelete'];
  onOpenConcept?: (id: string) => void;
  onCreate?: CreateWorkItem; inference?: TicketWorkspace['inference']; overview?: ReactNode;
  onDismissCalendarMention?: DismissCalendarMention;
}) {
  const [prefs, setPrefs] = useState<HomeWorkPreferences>(() => preferences?.get(spaceId) ?? {});
  const remember = (change: Partial<HomeWorkPreferences>) => { const next = { ...prefs, ...change }; preferences?.set(spaceId, next); setPrefs(next); };
  const [creating, setCreating] = useState<'ticket' | 'kanban' | null>(null);
  const [assigning, setAssigning] = useState<Ticket | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const todos = useMemo(() => work.tickets.filter(t => !t.durable), [work]);
  const tickets = useMemo(() => work.tickets.filter(t => t.durable), [work]);
  const conceptsByTicket = useMemo(() => {
    const byNote = new Map(notes.map(n => [n.id, n]));
    return new Map(work.tickets.map(ticket => { const note = byNote.get(ticket.noteId);
      const concept = concepts && note ? taskConcept(ticket.title, note, concepts) : undefined;
      return [ticket, concept?.label === ticket.noteTitle ? undefined : concept];
    }));
  }, [work, notes, concepts]);
  const workspace: TicketWorkspace = { work, onPatch, onDelete, onOpenNote, inference,
    onCreateTicket: onCreate ? (board, title, status, dueDate) => onCreate('ticket', title, board.noteId, board.id, status, dueDate, 'board') : undefined };
  const drag = useTicketDrag(root, onPatch);
  const hasTickets = Boolean(tickets.length || work.boards.length);
  const view = work.boards.length ? prefs.view ?? 'board' : 'list';
  const board = work.boards.find(b => b.id === prefs.boardId) ?? work.boards[0];
  const create = (kind: 'ticket' | 'kanban') => { returnFocus.current = document.activeElement as HTMLElement; setCreating(kind); };
  const finish = () => { setCreating(null); setAssigning(null); returnFocus.current?.focus({ preventScroll: true }); };
  const creationButtons = onCreate && <div className="ticket-create-actions"><button type="button" className="text-button" onClick={() => create('kanban')}>New board</button><button type="button" className="ticket-add-button" aria-label="New ticket" onClick={() => create('ticket')}><Plus size={14}/>Ticket</button></div>;
  if (!notes.length) return null;
  return <div ref={root} className="home-work" tabIndex={-1} onClickCapture={drag.onClickCapture} onKeyDownCapture={drag.onKeyDownCapture}>
    {hasTickets && <section className="home-tickets" aria-label="Tickets">
      <header><h2>{view === 'board' ? 'Kanban' : 'Tickets'} <span>{tickets.filter(t => t.status !== 'done').length} open</span></h2><div className="ticket-toolbar">
        {work.boards.length > 0 && <div className="ticket-view-switch"><button type="button" aria-pressed={view === 'board'} onClick={() => remember({ view: 'board' })}><Columns3 size={14}/>Board</button><button type="button" aria-pressed={view === 'list'} onClick={() => remember({ view: 'list' })}><List size={14}/>List</button></div>}
        {creationButtons}
      </div></header>
      {work.boards.length > 0 && <div className="ticket-board-strip" aria-label="Boards">
        {view === 'list' && <span className="ticket-board-target" data-ticket-drop-board="">No board</span>}
        {work.boards.map(b => <button type="button" key={b.id} data-ticket-drop-board={b.id} aria-pressed={view === 'board' && b.id === board?.id} onClick={() => remember({ view: 'board', boardId: b.id })}>{b.title}</button>)}
        {view === 'list' && tickets.length > 0 && <span className="ticket-drag-hint">Drag tickets onto a board</span>}
      </div>}
      {view === 'list' ? <WorkList tickets={tickets} workspace={workspace} concepts={conceptsByTicket} onOpenConcept={onOpenConcept} completed={Boolean(prefs.ticketsCompleted)} onCompletedChange={ticketsCompleted => remember({ ticketsCompleted })}
        onAssign={work.boards.length && onPatch ? ticket => { returnFocus.current = document.activeElement as HTMLElement; setAssigning(ticket); } : undefined} drag={drag}/>
        : board && <KanbanBoard key={board.id} board={board} workspace={workspace} showSource/>}
    </section>}
    <HomeCalendar notes={notes} work={work} onOpenNote={onOpenNote} onDismissCalendarMention={onDismissCalendarMention} focusFallback={root}/>
    {!hasTickets && todos.length > 0 && <div className="home-work-create">{creationButtons}</div>}
    {(todos.length > 0 || overview) && <div className={`home-lower-grid home-work-context${!todos.length || !overview ? ' home-overview-row' : ''}`}>
      {todos.length > 0 && <section className="home-todos" aria-label="To-dos">
        <BorderGlow className="task-panel" glowColor="#7bc9b0" secondaryColor="#a8b3ff">
          <div className="section-heading compact"><div><span className="eyebrow neutral">Across this Space</span><h2>To do</h2></div>
            <span className="task-panel-count" aria-label={`${todos.filter(t => t.status !== 'done').length} open to-dos`}>{todos.filter(t => t.status !== 'done').length}<ListTodo size={15}/></span>
          </div>
          <WorkList tickets={todos} workspace={workspace} concepts={conceptsByTicket} onOpenConcept={onOpenConcept} completed={Boolean(prefs.todosCompleted)} onCompletedChange={todosCompleted => remember({ todosCompleted })} drag={drag}/>
        </BorderGlow>
      </section>}
      {overview}
    </div>}
    {creating && onCreate && <WorkItemComposer kind={creating} notes={notes} boards={work.boards} defaultNoteId={view === 'board' ? board?.noteId : undefined} defaultBoardId={view === 'board' && creating === 'ticket' ? board?.id : undefined}
      onCreate={(title, noteId, boardId, dueDate) => onCreate(creating, title, noteId, boardId, 'todo', dueDate, 'board')} onClose={finish}/>}
    {assigning && <AssignTicket ticket={assigning} workspace={workspace} onClose={finish}/>}
    {drag.overlay}
  </div>;
}
