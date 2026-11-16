import { describe,expect,it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { createEmptyVault } from '../data/defaults';
import { ticketBacklinks,ticketReferenceIndex,ticketReferences,remarkTicketReferences,ticketIdFromUrl } from './ticketReferences';
import { withTicketPrefix } from './ticketCodes';
import type { Note } from '../types';
const note=(id:string,body:string):Note=>({id,body,title:id,slug:id,summary:'',aliases:[],tags:[],kind:'article',status:'ready',sourceIds:[],conceptIds:[],createdAt:'',updatedAt:''});
const codes={version:1 as const,prefix:'ORION',nextNumber:2,assigned:{t1:1}};
describe('Space-local ticket references',()=>{
  it('resolves complete codes case-insensitively and retains the old prefix after configuration',()=>{
    const index=ticketReferenceIndex([],withTicketPrefix(codes,'WORK'));
    expect(ticketReferences('Review orion-001 and WORK-001 and ORION-0010.',index)).toEqual([{start:7,end:16,id:'t1',code:'ORION-001'}]);
    expect(ticketReferences('ORION-001',ticketReferenceIndex([],createEmptyVault().spaces[0].ticketCodes))).toEqual([]);
    expect(ticketIdFromUrl('orion-ticket://t1')).toBe('t1');
    expect(ticketIdFromUrl('orion-ticket://t1?space_id=elsewhere')).toBeUndefined();
    expect(ticketReferences('OTHER-ORION-001 ORION-001-child X_ORION-001',index)).toEqual([]);
  });
  it('decorates prose while retaining literal code and existing external links',()=>{
    const processor=unified().use(remarkParse).use(remarkTicketReferences(ticketReferenceIndex([],codes)));
    const tree=processor.runSync(processor.parse('ORION-001 and `ORION-001` and [ORION-001](https://example.org)\n\n```\nORION-001\n```'));
    const serialized=JSON.stringify(tree);
    expect(serialized.match(/orion-ticket:\/\/t1/g)).toHaveLength(1);
    expect(serialized).toContain('https://example.org');
    expect(serialized).toContain('inlineCode');
  });
  it('derives real backlinks without treating code or external-link labels as references',()=>{
    const notes=[note('a','See ORION-001.'),note('b','[ticket](orion-ticket://t1)'),note('c','`ORION-001`\n\n```\nORION-001\n```'),note('d','[ORION-001](https://example.org)')];
    expect(ticketBacklinks(notes,ticketReferenceIndex([],codes),'t1').map(note=>note.id)).toEqual(['a','b']);
  });
});
