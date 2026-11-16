import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createEmptyVault} from '../data/defaults';
import type {Note} from '../types';
import {buildPortableCollection,parsePortableFile,portableCollectionHash,importPortableCollection,portableImageIds} from './portableOrion';
import {allocateTicketCodes,ticketCode} from './ticketCodes';
const note=(id:string,body:string):Note=>({id,title:`Note ${id}`,summary:'',body,tags:[],slug:id,aliases:[],kind:'article',status:'ready',sourceIds:[],conceptIds:[],createdAt:'2026-11-16',updatedAt:'2026-11-16'});
function fixture(){const vault=createEmptyVault('PRIVATE_SPACE_NAME');const s=vault.spaces[0];s.notes=Array.from({length:40},(_,i)=>note(`n${i}`,`Authored ${i}`));s.notes[0].body=`[Included](orion-note://n1 "PRIVATE_HOVER") [Excluded](orion-note://n39 "PRIVATE_LINK_METADATA")\n\n[[note:n2|Third]]\n\n<!-- secret PRIVATE_COMMENT -->\n\n<div hidden>PRIVATE_HTML</div>\n\n<!-- orion-kanban:v1 board1 Launch -->\n\n- [ ] Export <!-- orion-ticket:v1 ticket1 progress board1 -->\n  - [ ] Reopen\n\nConcept one`;s.notes[0].sourceIds=['src'];s.notes[0].discussionThreads=[{id:'private-discussion',state:'open',anchor:{text:'private',quote:'PRIVATE_COMMENT_THREAD'},messages:[],createdAt:'',updatedAt:''}];s.notes[39].body='PRIVATE_UNSELECTED';s.notes[1].title='Concept one';s.sources=[{id:'src',kind:'pdf',title:'Public citation',text:'PRIVATE_SOURCE_TEXT',fileName:'PRIVATE_FILE_NAME',importGuidance:'PRIVATE_GUIDANCE',noteIds:['n0','n39'],importedAt:''}];s.concepts=[{id:'c',label:'Concept one',aliases:['PRIVATE_ALIAS'],description:'PRIVATE_DESCRIPTION',noteIds:['n1','n39'],canonicalNoteId:'n1',color:'private',autoLink:true}];s.relationships=[{id:'r',fromNoteId:'n0',toNoteId:'n1',kind:'related',label:'PRIVATE_RELATIONSHIP',context:'PRIVATE_CONTEXT',strength:1}];return allocateTicketCodes(vault);}
describe('portable Orion collections',()=>{
  it('shares the native canonical identity and valid image fixture, including Unicode',async()=>{
    const file=parsePortableFile(readFileSync('src-tauri/tests/fixtures/portable-collection.orion','utf8'));
    expect(await portableCollectionHash(file)).toBe('9fb4d785761795ade427cdc4f29c2b0a3242f5bfe9a5c76a4c2a14ebf1f6a055');
    expect(portableImageIds(file.collection.notes)).toEqual(new Set(['picture_fixture_2026']));
    const duplicate=structuredClone(file);duplicate.collection.notes[1].body=file.collection.notes[0].body;
    expect(()=>parsePortableFile(JSON.stringify(duplicate))).toThrow('duplicate ticket');
    const hidden=structuredClone(file);hidden.collection.ticketCodes!.assigned.hidden=2;hidden.collection.ticketCodes!.nextNumber=3;
    expect(()=>parsePortableFile(JSON.stringify(hidden))).toThrow('without their source tickets');
  });
  it('exports exactly 12 of 40 notes through a whitelist, with selected links and ordinary work but no hidden context',()=>{
    const vault=fixture(),file=buildPortableCollection(vault.spaces[0],Array.from({length:12},(_,i)=>`n${i}`),'collection_123456789');
    const raw=JSON.stringify(file);expect(raw).not.toContain('PRIVATE_');expect(file.collection.notes).toHaveLength(12);
    expect(file.collection.notes[0].body).toContain('[Included](orion-note://n1)');expect(file.collection.notes[0].body).toContain('[Third](orion-note://n2)');expect(file.collection.notes[0].body).toContain('[Concept one](orion-note://n1)');expect(file.collection.notes[0].body).not.toContain('n39');expect(file.collection.notes[0].body).toContain('orion-ticket:v1 ticket1 progress board1');expect(file.collection.notes[0].body).toContain('- [ ] Reopen');
    expect(parsePortableFile(raw)).toEqual(file);expect(ticketCode(file.collection.ticketCodes,'ticket1')).toBe('ORION-001');
  });
  it('opens different per-note files in one imported Space, retaining local edits, completion, new notes and deleted notes',async()=>{
    const original=fixture(),file=buildPortableCollection(original.spaces[0],['n0','n1'],'collection_123456789');const hash=await portableCollectionHash(file);
    const imported=importPortableCollection(original,file,hash,{},'2026-11-17');const space=imported.vault.spaces[imported.vault.spaces.length-1];
    space.notes[0]={...space.notes[0],body:space.notes[0].body.replace('- [ ] Reopen','- [x] Reopen')+'\nLocal edit'};space.notes.push(note('local-new','Local addition'));
    const second={...file,entryNoteId:'n1'};expect(await portableCollectionHash(second)).toBe(hash);
    const reopened=importPortableCollection(imported.vault,second,hash,{});expect(reopened.reused).toBe(true);expect(reopened.noteId).toBe('n1');expect(reopened.vault.spaces).toHaveLength(2);expect(reopened.vault.spaces[1].notes[0].body).toContain('- [x] Reopen');expect(reopened.vault.spaces[1].notes[0].body).toContain('Local edit');expect(reopened.vault.spaces[1].notes.some(n=>n.id==='local-new')).toBe(true);
    space.notes=space.notes.filter(n=>n.id!=='n1');expect(importPortableCollection(imported.vault,second,hash,{}).noteId).toBeNull();
    expect(()=>importPortableCollection(imported.vault,second,'b'.repeat(64),{})).toThrow('different content');expect(original.spaces).toHaveLength(1);
  });
  it('includes only real image attachments and rejects missing, extraneous and colliding package data',()=>{
    const vault=fixture();vault.spaces[0].notes=[note('n','![sample](data:image/png;base64,iVBORw0KGgo=)\n\n`![private](orion-image://localhost/private_image_id)`')];
    const file=buildPortableCollection(vault.spaces[0],['n']);expect(file.assets).toHaveLength(1);expect(portableImageIds(file.collection.notes).size).toBe(1);expect(parsePortableFile(JSON.stringify(file))).toEqual(file);
    const missing=structuredClone(file);missing.assets=[];expect(()=>parsePortableFile(JSON.stringify(missing))).toThrow('missing');
    const extra=structuredClone(file);extra.assets.push({...file.assets[0],id:'other_image_id'});expect(()=>parsePortableFile(JSON.stringify(extra))).toThrow('not referenced');
    const codes=structuredClone(file);codes.collection.ticketCodes={version:1,prefix:'ORION',nextNumber:2,assigned:{a:1,b:1}};expect(()=>parsePortableFile(JSON.stringify(codes))).toThrow('collide');
    expect(()=>parsePortableFile(JSON.stringify({...file,settings:{key:'private'}}))).toThrow('unsupported fields');
  });
});
