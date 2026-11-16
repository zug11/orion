import { createContext, useContext } from 'react';
import { ticketCode, type TicketCodes } from '../lib/ticketCodes';
export const TicketCodesContext = createContext<TicketCodes | undefined>(undefined);
export function TicketCode({ id }: { id: string }) {
  const code = ticketCode(useContext(TicketCodesContext), id);
  return code ? <span className="ticket-code" data-narration-ignore="true">{code}</span> : null;
}
