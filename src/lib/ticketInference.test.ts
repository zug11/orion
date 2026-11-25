import { describe, expect, it, vi } from 'vitest';
import { createEmptySnapshot } from '../data/defaults';
import type { Note } from '../types';
import { ticketDetails } from './ticketDetails';
import { boardMarker, newTicketMarkdown, noteWork, patchTicket } from './tickets';
import { reviewTicket, applyInferredTickets, buildTicketInferenceRequest, hasInferredTicketWriting, inferBoardTickets, parseTicketSuggestions, noteInferenceTarget } from './ticketInference';

const board = { id:'b', title:'Launch', noteId:'n' };
const body = `We need to ask Jo about the launch date.\n\nMaybe test a smaller event first.\n\n${boardMarker(board)}\n\n- [x] Secret finished action\n- [ ] Existing task`;
const note = (text=body): Note => ({ id:'n', title:'Planning', body:text, summary:'Secret finished summary', slug:'n', kind:'article', status:'ready', aliases:[], tags:[], sourceIds:[], conceptIds:[], createdAt:'', updatedAt:'' });
function snapshot() { const s=createEmptySnapshot('Launch');s.settings.apiKeyConfigured=true;s.notes=[note(),{...note('Unrelated secret'),'id':'other'}];s.sources=[{id:'s',title:'Secret source',kind:'text',text:'Secret source body',noteIds:[],importedAt:''}];return s; }
const reply = JSON.stringify({tickets:[{title:'Ask Jo about the launch date',evidence:'We need to ask Jo about the launch date.'}]});

describe('note-local ticket inference', () => {
  it('credits accepted provider-written titles while preserving local promotions and user-edited titles', async () => {
    const s=snapshot(), original=s.notes[0];
    const result=await inferBoardTickets(s,board,async()=>({reply}),new AbortController().signal);
    const rows=result.suggestions.map(reviewTicket);
    expect(hasInferredTicketWriting(original,result,rows)).toBe(true);
    expect(hasInferredTicketWriting(original,result,rows.filter(row=>result.suggestions[row.index].taskId))).toBe(false);
    expect(hasInferredTicketWriting(original,result,rows.map(row=>({...row,title:"My wording"})))).toBe(false);
    expect(hasInferredTicketWriting(original,{...result,localOnly:true},rows)).toBe(false);
  });
  it('extracts from a note without a board, suggests a destination and flags duplicate candidates across this Space',async()=>{
    const s=snapshot();
    s.notes=[note('We need to test launch checkout.\n\n- [ ] Ask Jo about launch dates'),{...note(`${boardMarker(board)}\n\n${newTicketMarkdown('Test launch checkout','b')}`),id:'other'}];
    const target=noteInferenceTarget(s.notes[0]);
    const call=vi.fn(async(_input: import('../types').ChatRequest)=>({reply:JSON.stringify({tickets:[{title:'Test launch checkout',evidence:'We need to test launch checkout.'}]})}));
    const result=await inferBoardTickets(s,target,call,new AbortController().signal);
    expect(result).toMatchObject({fromNote:true,boards:[{id:'b',noteId:'other'}]});
    expect(result.suggestions[0]).toMatchObject({boardId:'b',taskId:expect.any(String)});
    expect(result.suggestions[1]).toMatchObject({boardId:'b',likelyDuplicate:{noteId:'other',title:'Test launch checkout'}});
    expect(call.mock.calls[0][0].notes).toHaveLength(1);
    const chosen=result.suggestions[0];
    const changed=applyInferredTickets(s.notes[0],target,result,[reviewTicket(chosen,0)],result.boards)!;
    expect(noteWork(note(changed)).tickets).toMatchObject([{title:'Ask Jo about launch dates',durable:true,boardId:'b'}]);
    expect(changed).toContain('We need to test launch checkout.');
    expect(applyInferredTickets(s.notes[0],target,result,[reviewTicket(chosen,0)],[])).toBeNull();
    expect(applyInferredTickets(note(changed),target,result,[reviewTicket(chosen,0)],result.boards)).toBeNull();
  });
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
    const updated = applyInferredTickets(s.notes[0], board, result, result.suggestions.map(reviewTicket))!;
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
    expect(applyInferredTickets(s.notes[0],board,result,[{...reviewTicket(result.suggestions[0],0),index:100}])).toBeNull();
    expect(applyInferredTickets(s.notes[0],board,result,result.suggestions.map((s,i)=>({...reviewTicket(s,i),urgency:'critical' as never})))).toBeNull();
    const updated=applyInferredTickets(s.notes[0],board,result,result.suggestions.map((s,i)=>({...reviewTicket(s,i),urgency:''})))!;
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
    const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(reviewTicket))!;
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
    expect(()=>buildTicketInferenceRequest(s,board)).toThrow('Connect an AI provider');
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
    const result=await inferBoardTickets(snapshot(),board,async()=>({reply:JSON.stringify({tickets:[
      ...JSON.parse(reply).tickets, {title:'Test a smaller event', evidence:'Maybe test a smaller event first.'},
    ]})}),new AbortController().signal);
    const rows=result.suggestions.map(reviewTicket).filter(row=>!result.suggestions[row.index].taskId);
    rows[1].title='<b>Literal</b>';
    const updated=applyInferredTickets(note(),board,result,rows)!;
    const created=noteWork(note(updated)).tickets.filter(t=>t.durable);
    expect(created).toHaveLength(2);expect(created.map(t=>t.title)).toContain('<b>Literal</b>');
    expect(created.every(t=>t.boardId==='b'&&t.status==='todo')).toBe(true);
    expect(applyInferredTickets(note(updated),board,result,rows)).toBeNull();
    expect(applyInferredTickets(note(`${body}\nChanged.`),board,result,rows)).toBeNull();
    expect(applyInferredTickets(note(),{...board,id:'other'},result,rows)).toBeNull();
    expect(applyInferredTickets(note(),board,result,[{...rows[0],title:'Existing task'}])).toBeNull();
  });
  it('cancels even a transport that ignores abort, and never starts an already-cancelled request', async () => {
    const controller=new AbortController();const call=vi.fn(()=>new Promise<{reply:string}>(()=>{}));
    const request=inferBoardTickets(snapshot(),board,call,controller.signal);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
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
    const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(reviewTicket))!;
    const work=noteWork(note(body)); expect(work.tickets.filter(t=>t.durable)).toHaveLength(33);
    expect(work.tickets.filter(t=>t.title==='Written action 0')).toHaveLength(1);
    expect(body).toContain('- [x] PRIVATE FINISHED WORK'); expect(work.tickets.find(t=>t.status==='done')?.durable).toBe(false);
  });
  it('collects written open tasks without a key, in place and without a provider call', async () => {
    const s=snapshot();s.settings.apiKeyConfigured=false; const request=vi.fn();
    const result=await inferBoardTickets(s,board,request,new AbortController().signal);
    expect(request).not.toHaveBeenCalled();expect(result.localOnly).toBe(true);
    expect(result.suggestions).toEqual([expect.objectContaining({title:'Existing task',taskId:expect.any(String)})]);
    const body=applyInferredTickets(s.notes[0],board,result,[reviewTicket(result.suggestions[0],0)])!;
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
  const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(reviewTicket));
  expect(body).not.toBeNull();expect(body).toContain('\n  and include examples');expect(body).toContain(long);
  expect(noteWork(note(body!)).tickets.every(t=>t.durable&&t.boardId==='b')).toBe(true);
});


it('keeps independently open nested tasks beneath a completed parent', async () => {
  const s=snapshot();s.settings.apiKeyConfigured=false;
  s.notes=[note(`${boardMarker(board)}\n\n- [x] Completed parent\n    - [ ] Still open nested child\n    - [x] Completed child`)];
  const result=await inferBoardTickets(s,board,vi.fn(),new AbortController().signal);
  expect(result.suggestions.map(s=>s.title)).toEqual(['Still open nested child']);
  const body=applyInferredTickets(s.notes[0],board,result,result.suggestions.map(reviewTicket))!;
  expect(noteWork(note(body)).tickets.filter(t=>t.durable).map(t=>t.title)).toEqual(['Still open nested child']);
  expect(body).toContain('- [x] Completed parent');expect(body).toContain('- [x] Completed child');
});

describe('source-grounded ticket details', () => {
  const context = 'Keep the dashboard steady when the last task closes.';
  const steps = ['Pin or hide a section.', 'Show “All caught up”.'];
  const passage = [context, ...steps].join(' ');
  it('keeps only details from this action, even after renaming and deselecting another suggestion', async () => {
    const s = snapshot();
    s.notes = [note([passage, 'Book a room.', '- [x] Secret completed work'].join('\n\n'))];
    const target = noteInferenceTarget(s.notes[0]);
    const result = await inferBoardTickets(s, target, async () => ({ reply: JSON.stringify({ tickets: [
      {title:'Book room', evidence:'Book a room.', checklist:[]},
      {title:'Dashboard controls', evidence:context, detailEvidence:passage, description:context,
        checklist:[...steps, steps[0], 'Book a room.', 'Secret completed work', 'Publish by Friday.']},
    ] }) }), new AbortController().signal);
    expect(result.suggestions[0].checklist).toBeUndefined();
    expect(result.suggestions[1].checklist).toEqual(steps);
    const next = applyInferredTickets(s.notes[0], target, result, [{...reviewTicket(result.suggestions[1],1),title:'Control dashboard sections'}], [])!;
    const [created] = noteWork(note(next)).tickets.filter(t => t.durable);
    expect(created.title).toBe('Control dashboard sections');
    expect(ticketDetails(created)).toMatchObject({descriptionText:context, checklist:steps.map(text => ({text, checked:false}))});
    expect(noteWork(note(next)).tickets.filter(t => t.durable)).toHaveLength(1);
  });

  it('rejects steps that clip a word or remove a stated negation', () => {
    const evidence = "Handle shipping. Don't publish the report. Keep the original.";
    const [suggestion] = parseTicketSuggestions(JSON.stringify({tickets:[{
      title:'Handle shipping', evidence, description:'Handle shipping.',
      checklist:['shipping', 'publish the report.', 'Keep the original.'],
    }]}),evidence,note(evidence));
    expect(suggestion.checklist).toEqual(['shipping', 'Keep the original.']);
    const [partial] = parseTicketSuggestions(JSON.stringify({ tickets:[{
      title:'Handle shipping', evidence, checklist:['ship','pping'],
    }] }),evidence,note(evidence));
    expect(partial.checklist).toBeUndefined();
  });

  it('fills missing fields in place and preserves existing children, priority and ticket identity on another pass', async () => {
    const s = snapshot();
    s.notes = [note([boardMarker(board), passage, newTicketMarkdown('Dashboard controls','b','progress','','board','high') +
      '\n  - [x] My edited step', '- [ ] Review empty state'].join('\n\n'))];
    const target = noteInferenceTarget(s.notes[0]);
    const call = async () => ({reply: JSON.stringify({ tickets:[], taskDetails:[
      {task:'- [ ] Dashboard controls', detailEvidence:passage, description:context, checklist:steps},
      {task:'- [ ] Review empty state', detailEvidence:passage, description:context, checklist:steps},
    ]})});
    const result = await inferBoardTickets(s,target,call,new AbortController().signal);
    const [old] = noteWork(s.notes[0]).tickets;
    const suggestions = result.suggestions;
    const body = applyInferredTickets(s.notes[0],target,result,suggestions.map(reviewTicket),result.boards)!;
    const saved = noteWork(note(body)).tickets.filter(t=>t.durable);
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({id:old.id, boardId:'b', urgency:'high', status:'progress'});
    expect(ticketDetails(saved[0])).toMatchObject({descriptionText:context,checklist:[{text:'My edited step',checked:true}]});
    expect(ticketDetails(saved[1])).toMatchObject({descriptionText:context,checklist:steps.map(text=>({text,checked:false}))});
    s.notes = [note(body)];
    const again = await inferBoardTickets(s,target,call,new AbortController().signal);
    expect(again.suggestions.flatMap(s=>s.checklist ?? [])).toEqual([]);
    expect(again.suggestions.some(s=>steps.includes(s.title))).toBe(false);
  });
});

describe('reviewing stated deadlines and work underway', () => {
  async function propose(text: string, evidence = text, scheduleEvidence = text) {
    const s = snapshot();
    s.notes = [{ ...note(text), updatedAt:'2026-11-24T12:00:00' }];
    const target = noteInferenceTarget(s.notes[0]);
    const result = await inferBoardTickets(s, target, async () => ({ reply: JSON.stringify({
      tickets:[{ title:'Prepare the venue brief', evidence, scheduleEvidence }],
    }) }), new AbortController().signal);
    return { original:s.notes[0], target, result, row:reviewTicket(result.suggestions[0], 0) };
  }
  it('saves the stated date and status to the renamed ticket and supports overriding either in review', async () => {
    const {original,target,result,row} = await propose("I’ve started the venue brief. It’s due 4 December 2026.");
    expect(row).toMatchObject({dueDate:'2026-12-04',status:'progress'});
    const body = applyInferredTickets(original,target,result,[{...row, title:'Venue briefing'}])!;
    expect(noteWork(note(body)).tickets[0]).toMatchObject({title:'Venue briefing',dueDate:'2026-12-04',status:'progress'});
    const cleared = applyInferredTickets(original,target,result,[{...row,dueDate:'',status:'todo'}])!;
    expect(noteWork(note(cleared)).tickets[0]).not.toHaveProperty('dueDate');
    expect(noteWork(note(cleared)).tickets[0].status).toBe('todo');
    expect(applyInferredTickets(original,target,result,[{...row,dueDate:'2026-02-30'}])).toBeNull();
    expect(applyInferredTickets(original,target,result,[{...row,status:'done'}])).toBeNull();
  });
  it.each([
    'We could start the venue brief on 4 December 2026.',
    'I have not started the venue brief.',
    'The venue meeting is on 4 December 2026.',
    'The brief might be due 4 December 2026.',
    'Is the venue brief due 4 December 2026?',
    'The venue brief has no deadline.',
    'Venue brief due 31 February 2026.',
  ])('leaves unsupported scheduling fields at their defaults for %s', async text => {
    expect((await propose(text)).row).toMatchObject({status:'todo',dueDate:''});
  });
  it('does not use another action’s deadline or a cropped conditional', async () => {
    const text = 'Prepare the brief. The invoice is due tomorrow.';
    expect((await propose(text,'Prepare the brief.', 'The invoice is due tomorrow.')).row.dueDate).toBe('');
    expect((await propose(text,text,'')).row.dueDate).toBe('');
    expect((await propose('Maybe I started the brief yesterday.','I started the brief yesterday.','I started the brief yesterday.')).row.status).toBe('todo');
    expect((await propose('I started the venue brief?', 'I started the venue brief', 'I started the venue brief')).row.status).toBe('todo');
  });
  it('uses the saved local note day for a relative deadline and supports plain written tasks offline', async () => {
    const s=snapshot(); s.settings.apiKeyConfigured=false;
    s.notes=[{...note('- [ ] Submit the brief by tomorrow'),updatedAt:'2026-11-24T12:00:00'}];
    const target=noteInferenceTarget(s.notes[0]), call=vi.fn();
    const result=await inferBoardTickets(s,target,call,new AbortController().signal);
    expect(call).not.toHaveBeenCalled();
    expect(result.suggestions[0].dueDate).toBe('2026-11-25');
    const next=applyInferredTickets(s.notes[0],target,result,result.suggestions.map(reviewTicket))!;
    expect(noteWork(note(next)).tickets).toMatchObject([{dueDate:'2026-11-25',status:'todo'}]);
    s.notes=[{...s.notes[0],body:next}];
    const again=await inferBoardTickets(s,target,call,new AbortController().signal);
    expect(again.suggestions).toHaveLength(0);
  });
  it('enriches the same existing ticket and preserves authored dates and custom columns', async () => {
    const s=snapshot(), b={...board,columns:[{id:'column-review' as const,title:'Review'}]};
    const text='I am working on the brief. It is due 4 December 2026.';
    s.notes=[{...note([boardMarker(b),newTicketMarkdown('Brief','b'),text].join('\n\n')),updatedAt:'2026-11-24T12:00:00'}];
    const target=noteInferenceTarget(s.notes[0]);
    const call=async()=>({reply:JSON.stringify({tickets:[],taskDetails:[{task:'- [ ] Brief',detailEvidence:text,scheduleEvidence:text}]})});
    const result=await inferBoardTickets(s,target,call,new AbortController().signal);
    const previous=noteWork(s.notes[0]).tickets[0];
    const saved=applyInferredTickets(s.notes[0],target,result,result.suggestions.map(reviewTicket),[b])!;
    expect(noteWork(note(saved)).tickets).toMatchObject([{id:previous.id,boardId:'b',dueDate:'2026-12-04',status:'progress'}]);
    s.notes=[{...s.notes[0],body:[boardMarker(b),newTicketMarkdown('Brief','b','column-review','2026-12-09'),text].join('\n\n')}];
    const again=await inferBoardTickets(s,target,call,new AbortController().signal);
    expect(again.suggestions).toEqual([]);
  });
  it('ignores a detached schedule about a different written task', async () => {
    const s=snapshot();
    const passage='The invoice is due tomorrow.';
    s.notes=[{...note('- [ ] Prepare the brief\n\n'+passage),updatedAt:'2026-11-24T12:00:00'}];
    const target=noteInferenceTarget(s.notes[0]);
    const result=await inferBoardTickets(s,target,async()=>({reply:JSON.stringify({tickets:[],taskDetails:[{
      task:'- [ ] Prepare the brief',detailEvidence:passage,scheduleEvidence:passage,
    }]})}),new AbortController().signal);
    expect(result.suggestions.map(reviewTicket)).toMatchObject([{dueDate:'',status:'todo'}]);
  });
});
