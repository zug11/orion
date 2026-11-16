import { describe, expect, it } from 'vitest';
import { createEmptyVault } from '../data/defaults';
import type { Note, OrionVault } from '../types';
import { allocateTicketCodes, isTicketCodes, ticketCode, withTicketPrefix } from './ticketCodes';
import { persistWindowVault } from './windowVault';
import { ticketMarker } from './tickets';
import { searchLocalSpace } from './localSearch';
const note = (id: string, ticket: string): Note => ({ id, title:id, body:`- [ ] Ship ${ticketMarker({id:ticket,boardId:'',status:'todo'})}`, slug:id, summary:'', aliases:[], tags:[], kind:'article', status:'ready', conceptIds:[], sourceIds:[], createdAt:'', updatedAt:'' });
describe('published Space ticket codes', () => {
  it('changes future prefixes without renaming published references, including a concurrent allocation', () => {
    const base=createEmptyVault();base.spaces[0].notes=[note('a','first')];
    const saved=allocateTicketCodes(base), local=structuredClone(saved);
    local.spaces[0].ticketCodes=withTicketPrefix(local.spaces[0].ticketCodes,'TEAM');
    local.spaces[0].notes.push(note('b','second'));
    const next=allocateTicketCodes(local,saved);
    expect(ticketCode(next.spaces[0].ticketCodes,'first')).toBe('ORION-001');
    expect(ticketCode(next.spaces[0].ticketCodes,'second')).toBe('TEAM-002');
    expect(isTicketCodes(next.spaces[0].ticketCodes)).toBe(true);
    const concurrent=structuredClone(saved);concurrent.spaces[0].notes.push(note('c','third'));
    const remote=allocateTicketCodes(concurrent,saved);
    const merged=structuredClone(next);merged.spaces[0].ticketCodes!.assigned={...remote.spaces[0].ticketCodes!.assigned};merged.spaces[0].ticketCodes!.nextNumber=3;
    merged.spaces[0].notes=remote.spaces[0].notes;
    expect(ticketCode(allocateTicketCodes(merged,remote).spaces[0].ticketCodes,'third')).toBe('ORION-002');
  });
  it('keeps numbers across deletion, reopening and reordering, and gives copied identities new codes', () => {
    const vault = createEmptyVault(); vault.spaces[0].notes=[note('a','ta'),note('b','tb')];
    const first = allocateTicketCodes(vault);
    expect(ticketCode(first.spaces[0].ticketCodes,'ta')).toBe('ORION-001');
    const saved = JSON.parse(JSON.stringify(first)) as OrionVault;
    saved.spaces[0].notes=[note('c','tc'),note('b','tb')];
    const next = allocateTicketCodes(saved);
    expect(ticketCode(next.spaces[0].ticketCodes,'ta')).toBe('ORION-001');
    expect(ticketCode(next.spaces[0].ticketCodes,'tc')).toBe('ORION-003');
    expect(allocateTicketCodes(next)).toBe(next);
    expect(searchLocalSpace(next.spaces[0],'ORION-003')[0].item.id).toBe('c');
  });
  it('allocates under optimistic revision guards when two writers save new tickets concurrently', async () => {
    const base = createEmptyVault();
    const left = structuredClone(base), right = structuredClone(base);
    left.spaces[0].notes=[note('left','left-ticket')]; right.spaces[0].notes=[note('right','right-ticket')];
    let disk = base, writes=0;
    const storage = {load:async()=>structuredClone(disk),save:async(vault:OrionVault,revision:string|null)=>{
      if(disk.updatedAt!==revision) throw new Error('ORION_VAULT_CONFLICT');
      disk=structuredClone(vault);writes++;
    }};
    await Promise.all([persistWindowVault(base,left,storage),persistWindowVault(base,right,storage)]);
    expect(writes).toBe(2);
    expect(disk.spaces[0].notes).toHaveLength(2);
    expect(Object.values(disk.spaces[0].ticketCodes!.assigned).sort()).toEqual([1,2]);
  });
  it('rejects invalid ledgers and does not code ordinary, quoted or duplicated tasks', () => {
    expect(isTicketCodes({version:1,prefix:'ORION',nextNumber:3,assigned:{a:1,b:1}})).toBe(false);
    const vault=createEmptyVault();vault.spaces[0].notes=[note('a','same'),note('b','same')];
    expect(allocateTicketCodes(vault).spaces[0].ticketCodes).toBeUndefined();
    vault.spaces[0].notes=[{...note('q','quote'),body:`> ${note('q','quote').body}\n\n- [ ] Ordinary`}];
    expect(allocateTicketCodes(vault).spaces[0].ticketCodes).toBeUndefined();
  });
  it('supports valid identities that also name JavaScript prototype properties', () => {
    const vault = createEmptyVault(); vault.spaces[0].notes = [note('a', '__proto__'), note('b', 'constructor')];
    const codes = allocateTicketCodes(vault).spaces[0].ticketCodes;
    expect(isTicketCodes(codes)).toBe(true);
    expect(ticketCode(codes, '__proto__')).toBe('ORION-001');
    expect(ticketCode(codes, 'constructor')).toBe('ORION-002');
    expect(isTicketCodes(JSON.parse(JSON.stringify(codes)))).toBe(true);
  });
  it('allocates a formerly duplicated identity when one copy is removed from another note', () => {
    const base = createEmptyVault(); base.spaces[0].notes = [note('a', 'same'), note('b', 'same'), note('c', 'unique')];
    const before = allocateTicketCodes(base);
    expect(ticketCode(before.spaces[0].ticketCodes, 'same')).toBeUndefined();
    const after = structuredClone(before); after.spaces[0].notes[1].body = 'Keep unrelated prose.';
    const saved = allocateTicketCodes(after, before);
    expect(ticketCode(saved.spaces[0].ticketCodes, 'same')).toBe('ORION-002');
  });
});
