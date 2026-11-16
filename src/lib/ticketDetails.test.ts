import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { noteWork, patchTicket, ticketMarker } from './tickets';
import { ticketDetails } from './ticketDetails';
const note = (body: string): Note => ({ id:'n', title:'Work', body, slug:'work', summary:'', aliases:[], tags:[], kind:'article', status:'ready', conceptIds:[], sourceIds:[], createdAt:'', updatedAt:'' });
const marker = ticketMarker({ id:'t1', boardId:'b1', status:'progress', urgency:'high' });
const body = `Intro.\n\n- [ ] Ship the update ${marker}\n\n  Keep the authored context.\n\n  - [ ] Check build\n    - [x] Check types\n  - [x] Review screenshots\n\n- [ ] Separate task\n\nTail.`;
const ticket = (value = body) => noteWork(note(value)).tickets.find(t => t.id === 't1')!;
describe('ticket details in ordinary Markdown', () => {
  it('derives description, nesting and progress without completing the parent', () => {
    expect(ticketDetails(ticket())).toMatchObject({ description:'Keep the authored context.', completed:2,
      checklist:[{text:'Check build',depth:0,checked:false},{text:'Check types',depth:1,checked:true},{text:'Review screenshots',depth:0,checked:true}] });
    const saved = patchTicket(body,ticket(),{detail:{kind:'check',index:0,checked:true}})!;
    expect(ticket(saved).status).toBe('progress');
    expect(ticketDetails(ticket(saved))?.completed).toBe(3);
    expect(saved).toContain('\n- [ ] Separate task\n\nTail.');
  });
  it('adds, edits, reorders and removes whole subtasks while preserving other prose', () => {
    let saved = patchTicket(body,ticket(),{detail:{kind:'move',index:0,direction:1}})!;
    expect(ticketDetails(ticket(saved))?.checklist.map(t=>t.text)).toEqual(['Review screenshots','Check build','Check types']);
    saved = patchTicket(saved,ticket(saved),{detail:{kind:'rename',index:1,text:'Compile [literal] *text*'}})!;
    expect(ticketDetails(ticket(saved))?.checklist[1].text).toBe('Compile [literal] *text*');
    saved = patchTicket(saved,ticket(saved),{detail:{kind:'remove',index:1}})!;
    expect(ticketDetails(ticket(saved))?.checklist.map(t=>t.text)).toEqual(['Review screenshots']);
    saved = patchTicket(saved,ticket(saved),{detail:{kind:'add',text:'Confirm <release>'}})!;
    expect(ticketDetails(ticket(saved))?.checklist.map(t=>t.text)).toEqual(['Review screenshots','Confirm <release>']);
    expect(saved).toContain('Keep the authored context.');
  });
  it('edits title and description literally, retains metadata and rejects unsupported formatting edits', () => {
    let saved = patchTicket(body,ticket(),{detail:{kind:'title',text:'Ship [safely]'}})!;
    expect(ticket(saved).title).toBe('Ship [safely]');
    saved = patchTicket(saved,ticket(saved),{detail:{kind:'description',text:'New context.\n\nDo not run <script>.'}})!;
    expect(ticketDetails(ticket(saved))?.descriptionText).toBe('New context.\n\nDo not run <script>.');
    expect(ticket(saved)).toMatchObject({id:'t1',boardId:'b1',urgency:'high',status:'progress'});
    expect(ticketDetails(ticket(saved))?.checklist).toHaveLength(3);
    const rich = body.replace('Keep the authored context.', '**Keep** the authored context.');
    expect(ticketDetails(ticket(rich))?.descriptionEditable).toBe(false);
    expect(patchTicket(rich,ticket(rich),{detail:{kind:'description',text:'Replacement'}})).toBeNull();
  });
  it('fails closed on stale nested content, duplicate identities and invalid indexes', () => {
    expect(patchTicket(body.replace('Check types','Run tests'),ticket(),{detail:{kind:'check',index:0,checked:true}})).toBeNull();
    expect(patchTicket(`${body}\n\n${ticket().rawBlock}`,ticket(),{detail:{kind:'add',text:'Do it'}})).toBeNull();
    expect(patchTicket(body,ticket(),{detail:{kind:'check',index:-1,checked:true}})).toBeNull();
    expect(patchTicket(body,ticket(),{detail:{kind:'add',text:'one\n- [ ] injected'}})).toBeNull();
  });
  it('handles nested parent tickets and CRLF without changing surrounding bytes', () => {
    const nested = `- [ ] Outer\r\n  - [ ] Ship ${marker}\r\n    - [ ] Inner\r\n  - [ ] Sibling\r\n\r\nEnd.`;
    const saved = patchTicket(nested,ticket(nested),{detail:{kind:'check',index:0,checked:true}});
    expect(saved).toBe(nested.replace('    - [ ] Inner','    - [x] Inner'));
  });
});
