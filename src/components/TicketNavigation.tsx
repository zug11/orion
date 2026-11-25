import { createPortal, flushSync } from 'react-dom';
import { X } from '../lib/icons';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppSnapshot } from '../types';
import type { TicketWorkspace } from './Tickets';
import { collectWork, type Ticket } from '../lib/tickets';
import type { VoiceWorkWrite } from '../lib/voiceWorkspace';
import { completeVoiceTickets } from '../lib/voiceTicketCompletion';
import { TicketDetailsDialog } from './TicketDetailsDialog';
import { ticketReferenceIndex, type TicketReferenceTarget } from '../lib/ticketReferences';
import { validTicketPrefix } from '../lib/ticketCodes';

export interface WorkTarget { ticketId?: string; boardId?: string; revealBoard?: boolean }
export type VoiceWorkEditor = Pick<TicketWorkspace, 'onPatch'> & {
  applyVoiceBody: (base: string, next: string) => boolean;
};
type EditorHandle = VoiceWorkEditor & Pick<TicketWorkspace, 'onEditTicket'> & {noteId:string; matches:(ticket: Ticket) => boolean};
interface TicketNavigation {
  index: ReturnType<typeof ticketReferenceIndex>;
  snapshot?: AppSnapshot;
  focusedTicketId?: string;
  writeVoiceWork?: (action: VoiceWorkWrite) => Promise<void>;
  completeTickets?: (tickets: readonly Ticket[]) => Promise<string>;
  openTicket?: (id:string) => void;
  openBoard?: (id:string) => void;
  openSource?: (id:string) => void;
  changePrefix?: (prefix:string) => Promise<void>;
  registerEditor?: (handle:EditorHandle) => () => void;
}
const EMPTY_INDEX = new Map<string, TicketReferenceTarget>();
const EMPTY_WORK = {tickets:[],boards:[]};
const Context = createContext<TicketNavigation>({index:EMPTY_INDEX});
export const useTicketNavigation = () => useContext(Context);

export function TicketNavigationRoot({snapshot,target,openTicket,openBoard,changePrefix,onClose,onOpenNote,onPatch,onConfirmDone,onWriteVoiceWork,children}: {
  snapshot:AppSnapshot;target:WorkTarget;openTicket:(id:string)=>void;openBoard:(id:string)=>void;changePrefix:(prefix:string)=>Promise<void>;
  onClose:()=>void;onOpenNote:(id:string)=>void;onPatch:TicketWorkspace['onPatch'];children:ReactNode;
  onWriteVoiceWork?: (action: VoiceWorkWrite, getEditor: (id: string) => VoiceWorkEditor | undefined) => Promise<void>;
  onConfirmDone?: (spaceId: string, tickets: Ticket[]) => Promise<void>;
}) {
  const editors = useMemo(() => new Map<string, EditorHandle>(), [snapshot.workspace.id]);
  const registerEditor = useCallback((handle: EditorHandle) => {
    editors.set(handle.noteId, handle);
    return () => { if (editors.get(handle.noteId) === handle) editors.delete(handle.noteId); };
  }, [editors]);
  const index = useMemo(()=>ticketReferenceIndex([],snapshot.ticketCodes),[snapshot.ticketCodes]);
  const work=target.ticketId ? collectWork(snapshot.notes) : EMPTY_WORK;
  const selected=work.tickets.filter(ticket=>ticket.durable && ticket.id===target.ticketId);
  useEffect(()=>{
    if(!target.boardId || target.revealBoard===false)return;
    const reveal=()=>{
      const element=[...document.querySelectorAll<HTMLElement>('[data-board-id]')].find(el=>el.dataset.boardId===target.boardId);
      if(!element)return false;
      element.scrollIntoView({block:'start'}); element.focus({preventScroll:true}); return true;
    };
    if(reveal())return;
    const observer=new MutationObserver(()=>{if(reveal())observer.disconnect();});
    observer.observe(document.body,{childList:true,subtree:true});
    const timer=setTimeout(()=>observer.disconnect(),5000);
    return ()=>{clearTimeout(timer);observer.disconnect();};
  },[snapshot.workspace.id,target.boardId,target.revealBoard]);
  const patch: NonNullable<TicketWorkspace['onPatch']> = (ticket, change) => {
    const editor = editors.get(ticket.noteId);
    return editor ? editor.onPatch?.(ticket, change) ?? false : onPatch?.(ticket, change) ?? false;
  };
  const completeTickets = onConfirmDone && ((targets: readonly Ticket[]) =>
    completeVoiceTickets(snapshot, targets, ticket => {
      // Publish each ordinary editor/note update before reading it for the
      // next ticket or flushing the complete request through the save queue.
      let changed = false;
      flushSync(() => { changed = patch(ticket, { status: 'done' }); });
      return changed;
    }, tickets => onConfirmDone(snapshot.workspace.id, tickets), ticket => editors.get(ticket.noteId)?.matches(ticket) ?? true));
  const writeVoiceWork = onWriteVoiceWork && ((action: VoiceWorkWrite) =>
    onWriteVoiceWork(action, id => editors.get(id)));
  return <Context.Provider value={{index,snapshot,writeVoiceWork,openTicket,openBoard,openSource:onOpenNote,changePrefix,registerEditor,
    focusedTicketId:target.ticketId,completeTickets}}>{children}
    {target.ticketId && <TicketDetailsDialog selected={selected.length===1?selected[0]:{id:target.ticketId,noteId:''}} onClose={onClose} workspace={{work,onOpenNote,
      onPatch:patch,
      onEditTicket:ticket=>editors.get(ticket.noteId)?.onEditTicket?.(ticket) ?? false,
    }}/>}
  </Context.Provider>;
}

export function TicketReferenceLink({id,children}: {id:string;children:ReactNode}) {
  const {index,openTicket}=useTicketNavigation();
  const ticket=[...index.values()].find(ticket=>ticket.id===id);
  return ticket && openTicket ? <button type="button" className="wiki-link explicit ticket-reference" title={ticket.title} onClick={()=>openTicket(id)}>{children}</button> : <span>{children}</span>;
}

export function TicketCodeSettings() {
  const {snapshot,changePrefix}=useTicketNavigation();
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const input=useRef<HTMLInputElement>(null);
  const descriptionId=useId();
  const [draft,setDraft]=useState(snapshot?.ticketCodes?.prefix??'ORION');
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{setOpen(false);setError('');},[snapshot?.workspace.id]);
  useEffect(()=>{
    if(!open)return;
    setDraft(snapshot?.ticketCodes?.prefix??'ORION');setError('');
    const element=dialog.current;element?.showModal();input.current?.focus();
    return ()=>{element?.close();if(trigger.current?.isConnected)trigger.current.focus({preventScroll:true});};
  },[open,snapshot?.workspace.id]);
  if(!snapshot||!changePrefix)return null;
  return <>
    <button ref={trigger} type="button" className="text-button" aria-haspopup="dialog" onClick={()=>setOpen(true)}>Ticket codes</button>
    {open&&createPortal(<dialog ref={dialog} className="work-item-composer ticket-code-settings" aria-label="Ticket codes" aria-describedby={descriptionId}
      onCancel={event=>{event.preventDefault();event.stopPropagation();setOpen(false);}} onClick={event=>event.stopPropagation()} onKeyDown={event=>event.stopPropagation()}>
      <header><h2>Ticket codes</h2><button type="button" className="icon-button" aria-label="Close ticket codes" onClick={()=>setOpen(false)}><X size={16}/></button></header>
      <p id={descriptionId}>Choose the prefix for new tickets in {snapshot.workspace.name}. Existing ticket codes stay the same.</p>
      <form onSubmit={event=>{event.preventDefault();if(!validTicketPrefix(draft)||busy)return;setBusy(true);setError('');void changePrefix(draft).then(()=>setOpen(false)).catch(error=>setError(String(error.message??error))).finally(()=>setBusy(false));}}>
        <label>Prefix <input ref={input} aria-label="Ticket code prefix" value={draft} maxLength={12} disabled={busy} onChange={event=>setDraft(event.target.value.toUpperCase())}/></label>
        <button type="submit" className="button secondary" disabled={busy||!validTicketPrefix(draft)||draft===(snapshot.ticketCodes?.prefix??'ORION')}>{busy?'Saving…':'Save prefix'}</button>
      </form><small>2–12 letters or numbers, starting with a letter.</small>{error&&<p role="alert">{error}</p>}
    </dialog>,document.body)}
  </>;
}
