import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ticketDetails, type TicketDetailChange } from '../lib/ticketDetails';
import { TICKET_STATUSES, TICKET_URGENCIES, type Ticket } from '../lib/tickets';
import type { TicketWorkspace } from './Tickets';
import { TicketCode } from './TicketCode';
import { ArrowUp, ArrowDown, Plus, Trash2, X, ExternalLink } from '../lib/icons';
import { DateButton } from './CalendarPicker';
import './TicketDetailsDialog.css';
import { useTicketNavigation } from './TicketNavigation';
import { ticketBacklinks } from '../lib/ticketReferences';
import { displayNoteTitle } from '../lib/noteMetadata';

/** Capture an exact block with each draft; a stale blur may never overwrite another edit. */
function DetailText({ value, label, multiline, wrap, disabled, className, save }: {
  value: string; label: string; multiline?: boolean; wrap?: boolean; disabled?: boolean; className?: string; save: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState(false);
  const capture = useRef<{ value: string; save: (text: string) => boolean } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const fit = () => { element.style.height = 'auto'; element.style.height = `${element.scrollHeight}px`; };
    fit();
    let width = element.clientWidth;
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
      if (element.clientWidth !== width) { width = element.clientWidth; fit(); }
    });
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [draft]);
  useEffect(() => { if (!capture.current) setDraft(value); }, [value]);
  const commit = () => {
    const original = capture.current; capture.current = null;
    if (!original || draft === original.value) { setDraft(value); return; }
    let ok = false;
    flushSync(() => { ok = original.save(draft); });
    setError(!ok);
    if (!ok) setDraft(value);
  };
  const props = {
    'aria-label': label, value: draft, disabled, className, maxLength: multiline ? 20_000 : 1000,
    onFocus: () => { capture.current = { value, save }; setError(false); },
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(multiline ? event.target.value : event.target.value.replace(/[\r\n]+/g, ' ')),
    onBlur: commit,
    onKeyDown: (event: React.KeyboardEvent) => {
      if (event.key === 'Escape' && capture.current && draft !== capture.current.value) { event.preventDefault(); event.stopPropagation(); setDraft(value); capture.current = { value, save }; }
      if (event.key === 'Enter' && (!multiline || event.metaKey || event.ctrlKey)) { event.preventDefault(); (event.currentTarget as HTMLElement).blur(); }
    },
  };
  return <>{multiline || wrap ? <textarea ref={field} {...props} rows={1}/> : <input {...props}/>}{error && <span className="ticket-detail-error" role="alert">This ticket changed. Your edit wasn’t applied. Try again with the current text.</span>}</>;
}

export function TicketDetailsDialog({ selected, workspace, onClose }: { selected: Pick<Ticket, 'id' | 'noteId'>; workspace: TicketWorkspace; onClose: () => void }) {
  const navigation=useTicketNavigation();
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const [newItem, setNewItem] = useState('');
  const [error, setError] = useState('');
  const candidates = workspace.work.tickets.filter(t => t.durable && t.id === selected.id);
  const ticket = candidates.length === 1 && candidates[0].noteId === selected.noteId ? candidates[0] : undefined;
  const live = useRef({ ticket, workspace });
  live.current = { ticket, workspace };
  const details = ticket && ticketDetails(ticket);
  const backlinks=ticket&&navigation.snapshot?ticketBacklinks(navigation.snapshot.notes,navigation.index,ticket.id).filter(note=>note.id!==ticket.noteId):[];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current; element?.showModal(); closeButton.current?.focus();
    return () => { element?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const patch = (change: TicketDetailChange) => {
    const current = live.current;
    const ok = Boolean(ticket && current.ticket?.rawBlock === ticket.rawBlock && current.workspace.onPatch?.(ticket, { detail: change }));
    setError(ok ? '' : 'This ticket changed. Check its current contents and try again.');
    return ok;
  };
  const editable = Boolean(workspace.onPatch);
  return createPortal(<dialog ref={dialog} className="ticket-detail" aria-label="Ticket details" onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      event.stopPropagation();
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }} onKeyDown={event => event.stopPropagation()}>
    <header className="ticket-detail-header"><span>{ticket ? <TicketCode id={ticket.id}/> : 'Ticket unavailable'}</span><button ref={closeButton} type="button" className="icon-button" aria-label="Close ticket details" onClick={onClose}><X size={19}/></button></header>
    {!ticket || !details ? <p className="ticket-detail-unavailable">This ticket was removed, moved to another note, or has a duplicate identity. Close this view and reopen it from its note.</p> : <>
      <DetailText key={ticket.id} value={ticket.title} label="Ticket title" wrap className="ticket-detail-title" disabled={!editable} save={text => patch({ kind: 'title', text })}/>
      <div className="ticket-detail-properties">
        <label>Priority<select aria-label="Ticket priority" disabled={!editable} value={ticket.urgency ?? ''} onChange={event => {
          const ok = workspace.onPatch?.(ticket, { urgency: event.target.value as Ticket['urgency'] }); setError(ok ? '' : 'The priority changed. Try again.');
        }}><option value="">No priority</option>{TICKET_URGENCIES.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}</select></label>
        <label>Status<select aria-label="Ticket status" disabled={!editable} value={ticket.status} onChange={event => {
          const ok = workspace.onPatch?.(ticket, { status: event.target.value as Ticket['status'] }); setError(ok ? '' : 'The status changed. Try again.');
        }}>{TICKET_STATUSES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <section className="ticket-detail-description"><h3>Description</h3>
        {details.descriptionEditable ? <DetailText value={details.descriptionText} label="Ticket description" multiline disabled={!editable} save={text => patch({ kind: 'description', text })}/>
          : <div className="ticket-detail-rich"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ children }) => <span>{children}</span> }}>{details.description}</ReactMarkdown><p className="ticket-detail-hint">Edit this formatted description in its note.</p></div>}
      </section>
      <section className="ticket-detail-checklist"><div className="ticket-detail-section-heading"><h3>Checklist</h3><span>{details.completed}/{details.checklist.length} completed</span></div>
        {details.checklist.length > 0 && <progress value={details.completed} max={details.checklist.length} aria-label="Checklist completion"/>}
        <div className="ticket-detail-items">{details.checklist.map((item, index) => <div key={index} className={`ticket-detail-item${item.checked ? ' is-complete' : ''}`} style={{ paddingLeft: `${Math.min(item.depth, 6) * 18}px` }}>
          <input type="checkbox" aria-label={`Complete ${item.text}`} disabled={!editable} checked={item.checked} onChange={event => patch({ kind: 'check', index, checked: event.target.checked })}/>
          <div className="ticket-detail-item-text"><DetailText value={item.text} label={`Checklist item ${index + 1}`} wrap disabled={!editable} save={text => patch({ kind: 'rename', index, text })}/></div>
          {editable && <div className="ticket-detail-item-actions"><button type="button" className="icon-button" aria-label={`Move item ${index + 1} up`} disabled={!item.canMoveUp} onClick={() => patch({ kind: 'move', index, direction: -1 })}><ArrowUp size={14}/></button><button type="button" className="icon-button" aria-label={`Move item ${index + 1} down`} disabled={!item.canMoveDown} onClick={() => patch({ kind: 'move', index, direction: 1 })}><ArrowDown size={14}/></button><button type="button" className="icon-button" aria-label={`Delete checklist item ${index + 1}`} onClick={() => { if (!item.hasChildren || window.confirm(`Delete “${item.text}” and its nested contents?`)) patch({ kind: 'remove', index }); }}><Trash2 size={14}/></button></div>}
        </div>)}</div>
        {editable && <form className="ticket-detail-add" onSubmit={event => { event.preventDefault(); if (newItem.trim() && patch({ kind: 'add', text: newItem })) { setNewItem(''); addInput.current?.focus(); } }}><Plus size={16}/><input ref={addInput} aria-label="New checklist item" placeholder="Add a checklist item" maxLength={1000} value={newItem} onChange={event => setNewItem(event.target.value)}/><button type="submit" className="text-button" disabled={!newItem.trim()}>Add</button></form>}
      </section>
      {details.additionalMarkdown && <section className="ticket-detail-rich ticket-detail-updates"><h3>More from this ticket</h3><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:({alt})=><span>{alt}</span>,a:({children})=><span>{children}</span>}}>{details.additionalMarkdown}</ReactMarkdown></section>}
      {backlinks.length>0 && <section className="ticket-detail-backlinks"><h3>Referenced in</h3>{backlinks.map(note=><button key={note.id} type="button" className="text-button" onClick={()=>navigation.openSource?.(note.id)}>{displayNoteTitle(note)}</button>)}</section>}
      {error && <p className="ticket-detail-error" role="alert">{error}</p>}
      <footer className="ticket-detail-footer"><div>{editable && <DateButton value={ticket.dueDate} label="Ticket due date" onChange={dueDate => workspace.onPatch?.(ticket, { dueDate }) ?? false}/>}{ticket.boardId && navigation.openBoard ? <button type="button" className="text-button" onClick={()=>navigation.openBoard?.(ticket.boardId)}>Open {workspace.work.boards.find(board => board.id === ticket.boardId)?.title ?? 'board'}</button> : <span>{workspace.work.boards.find(board => board.id === ticket.boardId)?.title ?? 'No board'}</span>}</div>
        {(workspace.onOpenNote || workspace.onEditTicket) && <button type="button" className="text-button" onClick={() => {
          if(navigation.openSource){navigation.openSource(ticket.noteId);requestAnimationFrame(()=>workspace.onEditTicket?.(ticket));}
          else {onClose();requestAnimationFrame(()=>{if(!workspace.onEditTicket?.(ticket))workspace.onOpenNote?.(ticket.noteId);});}
        }}><ExternalLink size={14}/>{ticket.origin === 'board' ? 'Open in note' : ticket.noteTitle}</button>}
      </footer>
    </>}
  </dialog>, document.body);
}

export function TicketDetailLauncher({ ticket, workspace }: { ticket: Ticket; workspace: TicketWorkspace }) {
  const navigation=useTicketNavigation();
  const [open, setOpen] = useState(false);
  return <><button type="button" className="ticket-detail-open" onClick={() => navigation.openTicket ? navigation.openTicket(ticket.id) : setOpen(true)} aria-label={`Open details for ${ticket.title}`}><TicketCode id={ticket.id}/><span>Details</span></button>
    {open && <TicketDetailsDialog selected={ticket} workspace={workspace} onClose={() => setOpen(false)}/>}</>;
}
