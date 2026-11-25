import type { AppSnapshot, Note, OrionVault } from '../types';
import { noteWork } from './tickets';

/** Identity metadata only. Task prose and completion remain in ordinary notes. */
export interface TicketCodes { version: 1; prefix: string; nextNumber: number; assigned: Record<string, number>; assignedPrefixes?: Record<string, string> }
export const validTicketPrefix = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9]{1,11}$/.test(value);
const MAX_NUMBER = 999_999_999;
export function isTicketCodes(value: unknown): value is TicketCodes {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as TicketCodes;
  if (v.version !== 1 || !validTicketPrefix(v.prefix) || !Number.isSafeInteger(v.nextNumber) || v.nextNumber < 1 || v.nextNumber > MAX_NUMBER || !v.assigned || typeof v.assigned !== 'object' || Array.isArray(v.assigned)) return false;
  if (v.assignedPrefixes !== undefined && (!v.assignedPrefixes || typeof v.assignedPrefixes !== 'object' || Array.isArray(v.assignedPrefixes) || !Object.entries(v.assignedPrefixes).every(([id, prefix]) => Object.prototype.hasOwnProperty.call(v.assigned, id) && validTicketPrefix(prefix)))) return false;
  const entries = Object.entries(v.assigned), numbers = entries.map(([, n]) => n);
  return entries.length <= 100_000 && entries.every(([id, n]) => /^[\w-]{1,96}$/.test(id) && Number.isSafeInteger(n) && n >= 1 && n < v.nextNumber) && new Set(numbers).size === numbers.length;
}
export function ticketCode(codes: TicketCodes | undefined, id: string): string | undefined {
  const number = codes && Object.prototype.hasOwnProperty.call(codes.assigned, id) ? codes.assigned[id] : undefined;
  const prefix = codes?.assignedPrefixes && Object.prototype.hasOwnProperty.call(codes.assignedPrefixes, id) ? codes.assignedPrefixes[id] : codes?.prefix;
  return number ? `${prefix}-${String(number).padStart(3, '0')}` : undefined;
}

/** Prefix changes affect future tickets; existing published references stay valid. */
export function withTicketPrefix(codes: TicketCodes | undefined, prefix: string): TicketCodes {
  if (!validTicketPrefix(prefix)) throw new Error('Use 2–12 uppercase letters or numbers, starting with a letter.');
  if (!codes) return { version: 1, prefix, nextNumber: 1, assigned: {} };
  if (codes.prefix === prefix) return codes;
  return { ...codes, prefix, assignedPrefixes: Object.fromEntries(Object.keys(codes.assigned).map(id => [id, Object.prototype.hasOwnProperty.call(codes.assignedPrefixes ?? {}, id) ? codes.assignedPrefixes![id] : codes.prefix])) };
}

/** Called after merging with current disk, before the revision-guarded write.
 * No speculative number is exposed by the renderer before the save succeeds.
 * Tombstones are retained, so deletion/Undo never recycles another ticket's code.
 */
export function allocateTicketCodes(vault: OrionVault, previous?: OrionVault): OrionVault {
  // A portable collection can contain long prose notes. Only a literal ticket
  // marker can earn a code, so ordinary articles never need a Markdown parse here.
  const durableTickets = (note: Note) => note.body.includes('orion-ticket:v1') ? noteWork(note).tickets.filter(ticket => ticket.durable) : [];
  let changed = false;
  const spaces = vault.spaces.map((space): AppSnapshot => {
    let existing = space.ticketCodes;
    if (existing && !isTicketCodes(existing)) throw new Error('This Space has invalid ticket codes. Nothing was saved.');
    const prior = previous?.spaces.find(prior => prior.workspace.id === space.workspace.id);
    // A concurrent writer may have published a code after this window captured
    // the old prefix. Pin that acknowledged code before allocating new ones.
    if (existing && prior?.ticketCodes && existing.prefix !== prior.ticketCodes.prefix) {
      const assignedPrefixes = Object.assign(Object.create(null), existing.assignedPrefixes);
      for (const id of Object.keys(prior.ticketCodes.assigned)) assignedPrefixes[id] = Object.prototype.hasOwnProperty.call(prior.ticketCodes.assignedPrefixes ?? {}, id) ? prior.ticketCodes.assignedPrefixes![id] : prior.ticketCodes.prefix;
      existing = { ...existing, assignedPrefixes };
      space = { ...space, ticketCodes: existing }; changed = true;
    }
    if (existing && prior?.ticketCodes && prior.notes.length === space.notes.length) {
      const before = new Map(prior.notes.map(note => [note.id, note]));
      const changed = space.notes.filter(note => before.get(note.id)?.body !== note.body);
      // Ordinary typing never reparses the library just to maintain codes.
      if (!changed.some(note => [note, before.get(note.id)].some(version => version && durableTickets(version).some(ticket => !Object.prototype.hasOwnProperty.call(existing.assigned, ticket.id))))) return space;
    }
    const ids = new Map<string, number>();
    for (const note of space.notes) for (const ticket of durableTickets(note)) ids.set(ticket.id, (ids.get(ticket.id) ?? 0) + 1);
    const missing = [...ids].filter(([id, count]) => count === 1 && !Object.prototype.hasOwnProperty.call(existing?.assigned ?? {}, id)).map(([id]) => id).sort();
    if (!missing.length) return space;
    const assigned: Record<string, number> = Object.assign(Object.create(null), existing?.assigned);
    let nextNumber = existing?.nextNumber ?? 1;
    if (Object.keys(assigned).length + missing.length > 100_000 || nextNumber + missing.length > MAX_NUMBER) throw new Error('This Space has reached its ticket-code limit. Your edits remain available.');
    for (const id of missing) assigned[id] = nextNumber++;
    changed = true;
    return { ...space, ticketCodes: { ...existing, version: 1, prefix: existing?.prefix ?? 'ORION', assigned, nextNumber } };
  });
  return changed ? { ...vault, spaces } : vault;
}
