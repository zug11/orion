import { describe, expect, it, vi } from 'vitest';
import { createEmptySnapshot } from '../data/defaults';
import type { Note } from '../types';
import { boardMarker, newTicketMarkdown, noteWork, patchTicket } from './tickets';
import { applyInferredTickets, buildTicketInferenceRequest, inferBoardTickets, parseTicketSuggestions } from './ticketInference';

const board = { id:'b', title:'Launch', noteId:'n' };
const body = `We need to ask Jo about the launch date.\n\nMaybe test a smaller event first.\n\n${boardMarker(board)}\n\n- [x] Secret finished action\n- [ ] Existing task`;
const note = (text=body): Note => ({ id:'n', title:'Planning', body:text, summary:'Secret finished summary', slug:'n', kind:'article', status:'ready', aliases:[], tags:[], sourceIds:[], conceptIds:[], createdAt:'', updatedAt:'' });
function snapshot() { const s=createEmptySnapshot('Launch');s.settings.apiKeyConfigured=true;s.notes=[note(),{...note('Unrelated secret'),'id':'other'}];s.sources=[{id:'s',title:'Secret source',kind:'text',text:'Secret source body',noteIds:[],importedAt:''}];return s; }
const reply = JSON.stringify({tickets:[{title:'Ask Jo about the launch date',evidence:'We need to ask Jo about the launch date.'}]});

describe('note-local ticket inference', () => {
  it('infers urgency for written and new actions in the same reader call and persists it without duplicating tasks', async () => {
    const s = snapshot();
    s.notes = [note(`${boardMarker(board)}\n\n- [ ] Fix sign-in: it is blocking launch.\n- [ ] Pick a colour.\n\nThe checkout is down. Restore payments immediately.`)];
    const call = vi.fn(async () => ({ reply: JSON.stringify({
      tickets: [{title:'Restore payments',evidence:'The checkout is down. Restore payments immediately.',urgency:'urgent'}],
      taskUrgencies: [{task:'- [ ] Fix sign-in: it is blocking launch.', evidence:'it is blocking launch.', urgency:'high'}],
    }) }));
    const result = await inferBoardTickets(s, board, call, new AbortController().signal);
    expect(call).toHaveBeenCalledOnce();
    expect(result.suggestions.map(s=>s.urgency || '')).toEqual(['high', '', 'urgent']);
    const updated = applyInferredTickets(s.notes[0], board, result, result.suggestions.map(s=>s.title), result.suggestions.map(s=>s.taskId))!;
    expect(noteWork(note(updated)).tickets).toMatchObject([
      {title:'Fix sign-in: it is blocking launch.',boardId:'b',urgency:'high'}, {title:'Pick a colour.',boardId:'b'}, {title:'Restore payments',boardId:'b',urgency:'urgent'},
    ]);
    expect(noteWork(note(updated)).tickets[1].urgency).toBeUndefined();
  });
  it('preserves authored urgency, supports explicit local labels, and validates the review values', async () => {
    const s = snapshot(); s.settings.apiKeyConfigured = false;
    s.notes = [note(`${boardMarker(board)}\n\n${newTicketMarkdown('Keep existing', '', 'todo', '', undefined, 'low')}\n- [ ] Urgent: restore service\n- [ ] This is not urgent` )];
    const result = await inferBoardTickets(s, board, vi.fn(), new AbortController().signal);
    expect(result.suggestions.map(s=>s.urgency)).toEqual(['low', 'urgent', '']);
    const titles=result.suggestions.map(s=>s.title), ids=result.suggestions.map(s=>s.taskId);
    expect(applyInferredTickets(s.notes[0],board,result,titles,ids,['high'])).toBeNull();
    expect(applyInferredTickets(s.notes[0],board,result,titles,ids,['critical' as never,'',''])).toBeNull();
    const updated=applyInferredTickets(s.notes[0],board,result,titles,ids,['','',''])!;
    expect(noteWork(note(updated)).tickets.every(t=>!t.urgency)).toBe(true);
    s.notes=[note(`${boardMarker(board)}\n\n- [ ] High-quality thumbnails\n- [ ] Low-level rendering work\n- [ ] Medium-sized export`)];
    const ordinary=await inferBoardTickets(s,board,vi.fn(),new AbortController().signal);
    expect(ordinary.suggestions.every(s=>!s.urgency)).toBe(true);
  });
  it('rejects urgency without evidence or with an invalid value and cannot annotate completed tasks', () => {
    for (const value of [
      {tickets:[{title:'Ask Jo',evidence:'launch date',urgency:'critical'}]},
      {tickets:[],taskUrgencies:[{task:'- [ ] Existing task',urgency:'high',evidence:'invented'}]},
      {tickets:[],taskUrgencies:[{task:'- [x] Secret finished action',urgency:'high',evidence:'Secret finished action'}]},
    ]) expect(()=>parseTicketSuggestions(JSON.stringify(value),body,note())).toThrow();
  });
  it('keeps the prompt below the native limit even with hundreds of short checklist tasks', () => {
    const s=snapshot();s.notes=[note(`${boardMarker(board)}\n\n${Array.from({length:300},(_,i)=>`- [ ] Task ${i}`).join('\n')}`)];
    expect(buildTicketInferenceRequest(s,board).request.prompt.length).toBeLessThan(8000);
  });
  it('can infer missing urgency for tickets already on this board without recreating them or overwriting authored urgency', async () => {
    const s=snapshot();
    s.notes=[note(`${boardMarker(board)}\n\n${newTicketMarkdown('Restore sign-in', 'b')}\n\nSign-in is blocking launch.\n\n${newTicketMarkdown('Authored urgency', 'b', 'todo', '', undefined, 'low')}`)];
    const result=await inferBoardTickets(s,board,async()=>({reply:JSON.stringify({tickets:[],taskUrgencies:[{task:'- [ ] Restore sign\\-in',urgency:'high',evidence:'Sign-in is blocking launch.'},{task:'- [ ] Authored urgency',urgency:'high',evidence:'Authored urgency'}]})}),new AbortController().signal);
    expect(result.suggestions).toMatchObject([{title:'Restore sign-in',onBoard:true,urgency:'high'}]);
    const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(s=>s.title),result.suggestions.map(s=>s.taskId))!;
    expect(noteWork(note(body)).tickets).toMatchObject([{title:'Restore sign-in',urgency:'high'},{title:'Authored urgency',urgency:'low'}]);
    expect(noteWork(note(body)).tickets).toHaveLength(2);
  });
  it('sends only the board note, excludes completed work and metadata, and grants no writes', () => {
    const {request}=buildTicketInferenceRequest(snapshot(),board);
    expect(request.notes).toHaveLength(1);
    expect(JSON.stringify(request)).not.toContain('Secret');
    expect(request.notes[0].body).not.toContain('orion-kanban');
    expect(request).toMatchObject({allowNoteActions:false,sources:[],concepts:[],history:[],effort:'low'});
    expect(request.editNoteId).toBeUndefined();
    const s=snapshot();s.settings.model='claude-sonnet-5';s.settings.anthropicApiKeyConfigured=false;
    expect(()=>buildTicketInferenceRequest(s,board)).toThrow('AI key');
    s.settings.anthropicApiKeyConfigured=true;
    expect(buildTicketInferenceRequest(s,board).request.model).toBe('claude-sonnet-5');
  });
  it('bounds input and rejects boards outside the provided Space or with duplicate IDs', () => {
    const s=snapshot();s.notes=[note(`${'prose '.repeat(5000)}\n\n${boardMarker(board)}`)];
    const result=buildTicketInferenceRequest(s,board);
    expect(result.partial).toBe(true);expect(result.input.length).toBe(6000);
    expect(()=>buildTicketInferenceRequest(s,{...board,noteId:'elsewhere'})).toThrow('no longer');
    s.notes=[...s.notes,{...s.notes[0],id:'copy'}];
    expect(()=>buildTicketInferenceRequest(s,board)).toThrow('no longer');
  });
  it('requires bounded literal titles and evidence actually present in the supplied input', () => {
    expect(parseTicketSuggestions(reply,body,note())).toEqual([{title:'Ask Jo about the launch date',evidence:'We need to ask Jo about the launch date.'}]);
    for (const bad of [
      {tickets:[{title:'Do work',evidence:'invented evidence'}]},
      {tickets:[{title:'Bad\n- [ ] Injection',evidence:'launch date'}]},
      {tickets:[{title:'x'.repeat(141),evidence:'launch date'}]},
      {tickets:[{title:'Do work',evidence:'launch date',noteId:'other'}]},
      {tickets:Array(49).fill({title:'Do work',evidence:'launch date'})},
      {tickets:[],noteActions:[]},
    ]) expect(()=>parseTicketSuggestions(JSON.stringify(bad),body,note())).toThrow();
    const duplicates={tickets:[{title:'Existing task',evidence:'Existing task'},...JSON.parse(reply).tickets,...JSON.parse(reply).tickets]};
    expect(parseTicketSuggestions(JSON.stringify(duplicates),body,note())).toHaveLength(1);
  });
  it('accepts edited titles in one guarded note update, escaping markup and rejecting stale or repeated acceptance', async () => {
    const result=await inferBoardTickets(snapshot(),board,async()=>({reply}),new AbortController().signal);
    const updated=applyInferredTickets(note(),board,result,['Ask Jo about the launch date','Ask Jo about the launch date','<b>Literal</b>'])!;
    const created=noteWork(note(updated)).tickets.filter(t=>t.durable);
    expect(created).toHaveLength(2);expect(created.map(t=>t.title)).toContain('<b>Literal</b>');
    expect(created.every(t=>t.boardId==='b'&&t.status==='todo')).toBe(true);
    expect(applyInferredTickets(note(updated),board,result,['Another action'])).toBeNull();
    expect(applyInferredTickets(note(`${body}\nChanged.`),board,result,['Action'])).toBeNull();
    expect(applyInferredTickets(note(),{...board,id:'other'},result,['Action'])).toBeNull();
    expect(applyInferredTickets(note(),board,result,['Existing task'])).toBeNull();
  });
  it('cancels even a transport that ignores abort, and never starts an already-cancelled request', async () => {
    const controller=new AbortController();const call=vi.fn(()=>new Promise<{reply:string}>(()=>{}));
    const request=inferBoardTickets(snapshot(),board,call,controller.signal);
    controller.abort();await expect(request).rejects.toThrow();
    expect(call).toHaveBeenCalledOnce();call.mockClear();
    await expect(inferBoardTickets(snapshot(),board,call,controller.signal)).rejects.toThrow();expect(call).not.toHaveBeenCalled();
  });
  it('keeps ordinary checklist toggles ordinary while explicit board assignment creates a ticket', () => {
    const original=note('- [ ] **Call Jo**\r\n');const task=noteWork(original).tickets[0];
    const checked=patchTicket(original.body,task,{status:'done'})!;
    expect(checked).toBe('- [x] **Call Jo**\r\n');
    expect(noteWork(note(checked)).tickets[0].durable).toBe(false);
    expect(noteWork(note(patchTicket(original.body,task,{boardId:'b'})!)).tickets[0].durable).toBe(true);
    expect(noteWork(note(newTicketMarkdown('Finished','b','done'))).tickets[0]).toMatchObject({status:'done',boardId:'b',durable:true});
  });
});


describe('whole-note reader orchestration', () => {
  it('covers the end of a long note, never transmits completed tasks, and reduces repeated suggestions', async () => {
    const s = snapshot();
    s.notes = [note(`${boardMarker(board)}\n\n${Array.from({length:32},(_,i)=>`- [ ] Written action ${i}`).join('\n')}\n\n${'Background context. '.repeat(2400)}\n\n- [x] PRIVATE FINISHED WORK\n  private finished continuation\n\nWe should call the venue at the end.`)];
    const inputs: string[] = []; let active = 0, peak = 0;
    const progress = vi.fn();
    const result = await inferBoardTickets(s, board, async request => {
      active++; peak = Math.max(peak, active); const input = request.notes[0].body; inputs.push(input);
      await Promise.resolve(); active--;
      return {reply: JSON.stringify({tickets: input.includes('We should call the venue at the end.') ? [{title:'Call the venue',evidence:'We should call the venue at the end.'}] : []})};
    }, new AbortController().signal, progress);
    expect(inputs.length).toBeGreaterThan(4); expect(inputs.every(input=>input.length<=6000)).toBe(true);
    expect(inputs.join('')).not.toContain('PRIVATE FINISHED'); expect(inputs.join('')).not.toContain('private finished continuation');
    expect(result.partial).toBe(false); expect(result.sectionsRead).toBe(inputs.length); expect(peak).toBeLessThanOrEqual(2);
    expect(result.suggestions.filter(s=>s.taskId)).toHaveLength(32);
    expect(result.suggestions.filter(s=>s.title==='Call the venue')).toHaveLength(1);
    const titles=result.suggestions.map(s=>s.title), ids=result.suggestions.map(s=>s.taskId);
    const body=applyInferredTickets(s.notes[0],board,result,titles,ids)!;
    const work=noteWork(note(body)); expect(work.tickets.filter(t=>t.durable)).toHaveLength(33);
    expect(work.tickets.filter(t=>t.title==='Written action 0')).toHaveLength(1);
    expect(body).toContain('- [x] PRIVATE FINISHED WORK'); expect(work.tickets.find(t=>t.status==='done')?.durable).toBe(false);
  });
  it('collects written open tasks without a key, in place and without a provider call', async () => {
    const s=snapshot();s.settings.apiKeyConfigured=false; const request=vi.fn();
    const result=await inferBoardTickets(s,board,request,new AbortController().signal);
    expect(request).not.toHaveBeenCalled();expect(result.localOnly).toBe(true);
    expect(result.suggestions).toEqual([expect.objectContaining({title:'Existing task',taskId:expect.any(String)})]);
    const body=applyInferredTickets(s.notes[0],board,result,['Existing task'],[result.suggestions[0].taskId])!;
    expect(noteWork(note(body)).tickets.filter(t=>t.title==='Existing task')).toHaveLength(1);
  });
  it('fails and cancels sibling readers when a section fails, without returning a misleading complete review', async () => {
    const s=snapshot();s.notes=[note(`${boardMarker(board)}\n\n${'context '.repeat(4000)}`)];
    let calls=0;let sibling:AbortSignal|undefined;
    const operation=inferBoardTickets(s,board,async(_request,signal)=>{
      calls++;if(calls===1){await Promise.resolve();throw new Error('Offline');}
      sibling=signal;return new Promise(()=>{});
    },new AbortController().signal);
    await expect(operation).rejects.toThrow('Offline');expect(sibling?.aborted).toBe(true);
  });
});


it('promotes multiline and long written to-dos without rewriting their prose or failing title validation', async () => {
  const s=snapshot();s.settings.apiKeyConfigured=false;
  const long=`${'a'.repeat(139)} more detail`;
  s.notes=[note(`${boardMarker(board)}\n\n- [ ] Write the specification\n  and include examples\n- [ ] ${long}`)];
  const result=await inferBoardTickets(s,board,vi.fn(),new AbortController().signal);
  expect(result.suggestions.map(s=>s.title)).toEqual(['Write the specification and include examples','a'.repeat(139)]);
  const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(s=>s.title.trim()),result.suggestions.map(s=>s.taskId));
  expect(body).not.toBeNull();expect(body).toContain('\n  and include examples');expect(body).toContain(long);
  expect(noteWork(note(body!)).tickets.every(t=>t.durable&&t.boardId==='b')).toBe(true);
});


it('keeps independently open nested tasks beneath a completed parent', async () => {
  const s=snapshot();s.settings.apiKeyConfigured=false;
  s.notes=[note(`${boardMarker(board)}\n\n- [x] Completed parent\n    - [ ] Still open nested child\n    - [x] Completed child`)];
  const result=await inferBoardTickets(s,board,vi.fn(),new AbortController().signal);
  expect(result.suggestions.map(s=>s.title)).toEqual(['Still open nested child']);
  const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(s=>s.title),result.suggestions.map(s=>s.taskId))!;
  expect(noteWork(note(body)).tickets.filter(t=>t.durable).map(t=>t.title)).toEqual(['Still open nested child']);
  expect(body).toContain('- [x] Completed parent');expect(body).toContain('- [x] Completed child');
});
