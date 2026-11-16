import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppSnapshot } from '../types';
import type { TicketWorkspace } from './Tickets';
import { collectWork } from '../lib/tickets';
import { TicketDetailsDialog } from './TicketDetailsDialog';
import { ticketReferenceIndex, type TicketReferenceTarget } from '../lib/ticketReferences';
import { validTicketPrefix } from '../lib/ticketCodes';

export interface WorkTarget { ticketId?: string; boardId?: string; revealBoard?: boolean }
type EditorHandle = Pick<TicketWorkspace, 'onPatch' | 'onEditTicket'> & {noteId:string};
interface TicketNavigation {
  index: ReturnType<typeof ticketReferenceIndex>;
  snapshot?: AppSnapshot;
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

export function TicketNavigationRoot({snapshot,target,openTicket,openBoard,changePrefix,onClose,onOpenNote,onPatch,children}: {
  snapshot:AppSnapshot;target:WorkTarget;openTicket:(id:string)=>void;openBoard:(id:string)=>void;changePrefix:(prefix:string)=>Promise<void>;
  onClose:()=>void;onOpenNote:(id:string)=>void;onPatch:TicketWorkspace['onPatch'];children:ReactNode;
}) {
  const editor = useRef<EditorHandle | null>(null);
  const registerEditor = useCallback((handle:EditorHandle) => { editor.current=handle; return () => {if(editor.current===handle)editor.current=null;}; },[]);
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
  return <Context.Provider value={{index,snapshot,openTicket,openBoard,openSource:onOpenNote,changePrefix,registerEditor}}>{children}
    {target.ticketId && <TicketDetailsDialog selected={selected.length===1?selected[0]:{id:target.ticketId,noteId:''}} onClose={onClose} workspace={{work,onOpenNote,
      onPatch:(ticket,patch)=>editor.current?.noteId===ticket.noteId ? editor.current.onPatch?.(ticket,patch)??false : onPatch?.(ticket,patch)??false,
      onEditTicket:ticket=>editor.current?.noteId===ticket.noteId && (editor.current.onEditTicket?.(ticket)??false),
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
  const [draft,setDraft]=useState(snapshot?.ticketCodes?.prefix??'ORION');
  const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>setDraft(snapshot?.ticketCodes?.prefix??'ORION'),[snapshot?.workspace.id,snapshot?.ticketCodes?.prefix]);
  if(!snapshot||!changePrefix)return null;
  return <div className="setting-card ticket-code-settings"><h3>Ticket codes in {snapshot.workspace.name}</h3>
    <p>Choose the prefix for new tickets. Existing ticket codes stay the same.</p>
    <form onSubmit={event=>{event.preventDefault();if(!validTicketPrefix(draft)||busy)return;setBusy(true);setError('');void changePrefix(draft).catch(error=>setError(String(error.message??error))).finally(()=>setBusy(false));}}>
      <label>Prefix <input aria-label="Ticket code prefix" value={draft} maxLength={12} onChange={event=>setDraft(event.target.value.toUpperCase())}/></label>
      <button type="submit" className="button secondary" disabled={busy||!validTicketPrefix(draft)||draft===(snapshot.ticketCodes?.prefix??'ORION')}>{busy?'Saving…':'Save prefix'}</button>
    </form><small>2–12 letters or numbers, starting with a letter.</small>{error&&<p role="alert">{error}</p>}
  </div>;
}
