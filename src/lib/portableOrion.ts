import { nanoid } from 'nanoid';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { AppSnapshot, Note, OrionVault, SourceKind } from '../types';
import { createEmptySnapshot, slugifyTitle } from '../data/defaults';
import { expandOrionWikiLinks, splitMarkdownFrontmatter } from './markdown';
import { decorateAutoLinks, resolveConceptDestination } from './wiki';
import { boardMarker, collectWork, parseBoardMarker, parseTicketMarker, ticketMarker } from './tickets';
import { isTicketCodes, type TicketCodes } from './ticketCodes';
import { readVisualArtifactMarker, visualArtifactMarker } from './visualArtifactMarkdown';
import { parseNoteTableMetadata } from './noteTables';
import { noteImageAssetId } from './noteImages';
import { parseNoteImageTitle, serializeNoteImageTitle } from './noteImageLayout';

export const MAX_PORTABLE_BYTES=128*1024*1024;
const MAX_NOTES=200;
const parser=unified().use(remarkParse).use(remarkGfm);
export interface PortableNote {id:string;title:string;summary:string;body:string;tags:string[];headingLayout?:Note['headingLayout'];sourceIds:string[]}
export interface PortableSource {id:string;title:string;kind:SourceKind;sourceUrl?:string}
export interface PortableCollection {title:string;notes:PortableNote[];sources:PortableSource[];ticketCodes?:TicketCodes}
export interface PortableAsset {id:string;mimeType:string;base64Data:string}
export interface PortableFile {format:'orion';version:1;exportId:string;entryNoteId:string;collection:PortableCollection;assets:PortableAsset[]}
export interface PortableImportIdentity {version:1;exportId:string;collectionHash:string}
const ID=/^[\w-]{1,96}$/;
const EXPORT_ID=/^[A-Za-z0-9_-]{16,64}$/;
const safePublicUrl=(raw:string|undefined):string|undefined=>{
  try{const url=new URL(raw??'');return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}
};
const literal=(text:string)=>text.replace(/[\\`*_[\]<>#~!|]/g,'\\$&');
type MdNode={type:string;value?:string;url?:string;title?:string;alt?:string;identifier?:string;children?:MdNode[];position?:{start:{offset:number};end:{offset:number}}};
const nodeText=(node:MdNode):string=>node.value??node.alt??node.children?.map(nodeText).join('')??'';

/** Rendered content is the boundary. No raw note object, source text, cached
 * context, link title, frontmatter or unknown HTML enters a portable collection. */
function portableBody(note:Note,snapshot:AppSnapshot,included:Set<string>,sources:Set<string>,ticketIds:Set<string>,boardIds:Set<string>,assets:PortableAsset[]):string{
  const input=expandOrionWikiLinks(splitMarkdownFrontmatter(note.body).content,snapshot.notes,snapshot.concepts);
  const tree=parser.parse(input) as MdNode;
  const edits:Array<{start:number;end:number;text:string}>=[];
  const definitions=new Map<string,MdNode>();
  const findDefinitions=(node:MdNode)=>{if(node.type==='definition'&&node.identifier)definitions.set(node.identifier,node);node.children?.forEach(findDefinitions);};findDefinitions(tree);
  function target(raw:string):string|undefined{
    if(raw.startsWith('orion-note://'))return included.has(raw.slice(13))?raw:undefined;
    if(raw.startsWith('orion-concept://')){const concept=snapshot.concepts.find(c=>c.id===raw.slice(16));const dest=concept&&resolveConceptDestination(concept,snapshot.notes);return dest?.kind==='note'&&included.has(dest.noteId)?`orion-note://${dest.noteId}`:undefined;}
    if(raw.startsWith('orion-ticket://'))return ticketIds.has(raw.slice(15))?raw:undefined;
    if(raw.startsWith('orion-source://'))return sources.has(raw.slice(15))?raw:undefined;
    if(/^orion-date:\/\/\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
    if(raw.startsWith('orion://')){try{const u=new URL(raw),id=u.searchParams.get('note_id');return u.searchParams.get('space_id')===snapshot.workspace.id&&id&&included.has(id)?`orion-note://${id}`:undefined;}catch{return undefined;}}
    if(/^mailto:[^\s<>]+$/.test(raw))return raw;
    return safePublicUrl(raw);
  }
  function metadata(value:string):string{
    const ticket=parseTicketMarker(value);if(ticket)return ticketMarker({...ticket,boardId:boardIds.has(ticket.boardId)?ticket.boardId:''});
    const board=parseBoardMarker(value);if(board)return boardMarker(board);
    const table=parseNoteTableMetadata(value);if(table)return `<!-- orion-table:v1 ${JSON.stringify(table)} -->`;
    if(['<!-- orion-block:v1 -->','<!-- /orion-block -->','<!-- orion-text:v1 justify -->'].includes(value))return value;
    const margin=value.match(/^<!-- orion-(document|paragraph)-margins:v1 (\d{1,2}) (\d{1,2}) -->$/);
    return margin&&Number(margin[2])<=25&&Number(margin[3])<=25?value:'';
  }
  const visit=(node:MdNode,inLink=false,topLevel=false)=>{
    const range=node.position&&{start:node.position.start.offset,end:node.position.end.offset};
    if(node.type==='code'||node.type==='inlineCode')return;
    if(range&&node.type==='definition'){edits.push({...range,text:''});return;}
    if(range&&topLevel&&node.type==='html'){
      const artifact=readVisualArtifactMarker(node.value);
      if(artifact){edits.push({...range,text:visualArtifactMarker(artifact)});return;}
    }
    if(range&&node.type==='html'){edits.push({...range,text:[...(node.value??'').matchAll(/<!--[\s\S]*?-->/g)].map(match=>metadata(match[0])).filter(Boolean).join('\n')});return;}
    if(range&&['link','linkReference','image','imageReference'].includes(node.type)){
      const definition=node.type.endsWith('Reference')?definitions.get(node.identifier??''):node;
      const raw=definition?.url??'';const label=literal(nodeText(node));
      if(node.type.startsWith('image')){
        let url:string|undefined;const id=noteImageAssetId(raw);
        if(id)url=raw;
        else{const data=raw.match(/^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/);if(data){const asset={id:`portable-${nanoid(20)}`,mimeType:data[1],base64Data:data[2]};assets.push(asset);url=`orion-image://localhost/${asset.id}`;}}
        const layout=parseNoteImageTitle(definition?.title??'');
        const title=serializeNoteImageTitle(layout.layout);
        edits.push({...range,text:url?`![${label}](${url}${title?` ${JSON.stringify(title)}`:''})`:label});
      }else{const url=target(raw);edits.push({...range,text:url?`[${label}](${url})`:label});}
      return;
    }
    if(range&&node.type==='text'&&!inLink&&node.value){
      // Freeze only links whose destination is in the deliberately chosen set.
      const segments=decorateAutoLinks(node.value,snapshot.concepts,{excludeNoteIdFromTargets:note.id});
      if(segments.some(segment=>segment.type==='concept')){
        const text=segments.map(segment=>{if(segment.type!=='concept')return literal(segment.text);const concept=snapshot.concepts.find(c=>c.id===segment.conceptId);const dest=concept&&resolveConceptDestination(concept,snapshot.notes);return dest?.kind==='note'&&included.has(dest.noteId)?`[${literal(segment.text)}](orion-note://${dest.noteId})`:literal(segment.text);}).join('');
        edits.push({...range,text});
      }
      return;
    }
    node.children?.forEach(child=>visit(child,inLink,node===tree));
  };visit(tree);
  let body=input;for(const edit of edits.sort((a,b)=>b.start-a.start))body=body.slice(0,edit.start)+edit.text+body.slice(edit.end);
  return body;
}

export function buildPortableCollection(snapshot:AppSnapshot,noteIds:string[],exportId=nanoid(24)):PortableFile{
  if(!EXPORT_ID.test(exportId)||!noteIds.length||noteIds.length>MAX_NOTES||new Set(noteIds).size!==noteIds.length)throw new Error('Choose 1–200 different notes for this export.');
  const notes=noteIds.map(id=>{const matches=snapshot.notes.filter(n=>n.id===id);if(matches.length!==1)throw new Error('A selected note is missing or ambiguous. Choose the notes again.');return matches[0];});
  const included=new Set(noteIds),work=collectWork(notes);
  const ticketIds=new Set(work.tickets.filter(t=>t.durable).map(t=>t.id)),boardIds=new Set(work.boards.map(b=>b.id));
  if(ticketIds.size!==work.tickets.filter(t=>t.durable).length||boardIds.size!==work.boards.length)throw new Error('This selection has duplicate ticket or board identities. Resolve those copies before exporting.');
  const sourceIds=new Set(notes.flatMap(n=>n.sourceIds));
  const sources=snapshot.sources.filter(s=>sourceIds.has(s.id)).map(s=>({id:s.id,title:s.title,kind:s.kind,...(safePublicUrl(s.sourceUrl)?{sourceUrl:safePublicUrl(s.sourceUrl)}:{})}));
  const assets:PortableAsset[]=[];
  const selected=notes.map(n=>({id:n.id,title:n.title,summary:n.summary,body:portableBody(n,snapshot,included,new Set(sources.map(s=>s.id)),ticketIds,boardIds,assets),tags:[...n.tags],...(n.headingLayout?{headingLayout:n.headingLayout}:{}),sourceIds:n.sourceIds.filter(id=>sources.some(s=>s.id===id))}));
  const codes=snapshot.ticketCodes;
  const ticketCodes=codes?{version:1 as const,prefix:codes.prefix,nextNumber:codes.nextNumber,assigned:Object.fromEntries(Object.entries(codes.assigned).filter(([id])=>ticketIds.has(id))),...(codes.assignedPrefixes?{assignedPrefixes:Object.fromEntries(Object.entries(codes.assignedPrefixes).filter(([id])=>ticketIds.has(id)))}:{})}:undefined;
  // Deliberately use the chosen notes' visible titles; a Space name may itself be private.
  return {format:'orion',version:1,exportId,entryNoteId:noteIds[0],collection:{title:notes.length===1?notes[0].title||'Shared note':'Shared Orion notes',notes:selected,sources,...(ticketCodes?{ticketCodes}:{})},assets};
}

function record(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.prototype.hasOwnProperty.call(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw new Error('This .orion file has unsupported fields.');
  return value as Record<string,unknown>;
}
function text(value:unknown,max:number,id=false):value is string{return typeof value==='string'&&value.length<=max&&(!id||ID.test(value));}
export function isPortableImportIdentity(value:unknown):value is PortableImportIdentity{
  if(!value||typeof value!=='object')return false;const v=value as PortableImportIdentity;
  return v.version===1&&typeof v.exportId==='string'&&EXPORT_ID.test(v.exportId)&&typeof v.collectionHash==='string'&&/^[a-f0-9]{64}$/.test(v.collectionHash)&&Object.keys(v).length===3;
}
export function parsePortableFile(raw:string):PortableFile{
  if(new TextEncoder().encode(raw).length>MAX_PORTABLE_BYTES)throw new Error('This .orion file is larger than 128 MB.');
  const value=record(JSON.parse(raw),['format','version','exportId','entryNoteId','collection','assets']);
  const collection=record(value.collection,['title','notes','sources'],['ticketCodes']);
  if(value.format!=='orion'||value.version!==1||typeof value.exportId!=='string'||!EXPORT_ID.test(value.exportId)||!text(value.entryNoteId,96,true)||!text(collection.title,500)||!Array.isArray(collection.notes)||!collection.notes.length||collection.notes.length>MAX_NOTES||!Array.isArray(collection.sources)||collection.sources.length>2000||!Array.isArray(value.assets)||value.assets.length>1000)throw new Error('This .orion file has an unsupported format or size.');
  const notes=collection.notes.map(item=>{
    const n=record(item,['id','title','summary','body','tags','sourceIds'],['headingLayout']);
    if(!text(n.id,96,true)||!text(n.title,2000)||!text(n.summary,100_000)||!text(n.body,8*1024*1024)||!Array.isArray(n.tags)||n.tags.length>500||!n.tags.every(t=>text(t,500))||!Array.isArray(n.sourceIds)||n.sourceIds.length>2000||!n.sourceIds.every(id=>text(id,96,true))||n.headingLayout!==undefined&&!['both','title','subtitle','none'].includes(n.headingLayout as string))throw new Error('This .orion file contains an invalid note.');
    return n as unknown as PortableNote;
  });
  if(new Set(notes.map(n=>n.id)).size!==notes.length||!notes.some(n=>n.id===value.entryNoteId)||notes.reduce((n,item)=>n+item.body.length,0)>16*1024*1024)throw new Error('The collection contains duplicate, missing, or oversized notes.');
  collection.sources.forEach(item=>{const s=record(item,['id','title','kind'],['sourceUrl']);if(!text(s.id,96,true)||!text(s.title,2000)||!['manual','text','markdown','json','csv','html','pdf','docx','image','audio','video','youtube'].includes(s.kind as string)||s.sourceUrl!==undefined&&safePublicUrl(s.sourceUrl as string)!==s.sourceUrl)throw new Error('The collection contains invalid source attribution.');});
  const sources=collection.sources as PortableSource[];if(new Set(sources.map(s=>s.id)).size!==sources.length||notes.some(n=>n.sourceIds.some(id=>!sources.some(s=>s.id===id))))throw new Error('The collection contains missing or duplicate source attribution.');
  if(collection.ticketCodes!==undefined){record(collection.ticketCodes,['version','prefix','nextNumber','assigned'],['assignedPrefixes']);if(!isTicketCodes(collection.ticketCodes))throw new Error('Ticket codes collide or are invalid in this file. Export a fresh collection to resolve them.');}
  const work=collectWork(notes as Note[]),tickets=work.tickets.filter(ticket=>ticket.durable),ticketIds=new Set(tickets.map(ticket=>ticket.id));
  if(ticketIds.size!==tickets.length||new Set(work.boards.map(board=>board.id)).size!==work.boards.length)throw new Error('This collection has duplicate ticket or board identities. Export a fresh collection to resolve them.');
  if(collection.ticketCodes&&Object.keys((collection.ticketCodes as TicketCodes).assigned).some(id=>!ticketIds.has(id)))throw new Error('This collection contains ticket codes without their source tickets.');
  const assetIds=new Set<string>();value.assets.forEach(item=>{const a=record(item,['id','mimeType','base64Data']);if(!text(a.id,80,true)||a.id.length<12||assetIds.has(a.id)||!['image/png','image/jpeg','image/gif','image/webp'].includes(a.mimeType as string)||typeof a.base64Data!=='string'||!a.base64Data.length||a.base64Data.length>16*1024*1024||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(a.base64Data))throw new Error('The collection contains invalid or duplicate attachments.');assetIds.add(a.id);});
  const refs=portableImageIds(notes);if(refs.size!==assetIds.size||[...refs].some(id=>!assetIds.has(id)))throw new Error('An attachment is missing or is not referenced by a selected note.');
  return value as unknown as PortableFile;
}
export function portableImageIds(notes:readonly Pick<PortableNote,'body'>[]):Set<string>{
  const ids=new Set<string>();for(const note of notes){const walk=(node:MdNode)=>{if(node.type==='image'){const id=noteImageAssetId(node.url??'');if(id)ids.add(id);}node.children?.forEach(walk);};walk(parser.parse(note.body) as MdNode);}return ids;
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,v])=>[key,canonical(v)])):value;
export async function portableCollectionHash(file:PortableFile):Promise<string>{
  const bytes=new TextEncoder().encode(JSON.stringify(canonical({collection:file.collection,assets:file.assets})));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
}
/** Imports only into a separate collection Space. Reopening is navigation, never
 * replaying an old package over authored edits or resurrecting deleted notes. */
export function importPortableCollection(vault:OrionVault,file:PortableFile,hash:string,imageUrls:Record<string,string>,now=new Date().toISOString()):{vault:OrionVault;spaceId:string;noteId:string|null;reused:boolean}{
  const spaceId=`space-portable-${file.exportId}`;
  const existing=vault.spaces.find(s=>s.workspace.id===spaceId);
  if(existing){
    if(existing.portableImport?.exportId!==file.exportId||existing.portableImport.collectionHash!==hash)throw new Error('Another collection uses this export identity with different content. Export it again to give it a new identity; your existing edits were kept.');
    const noteId=existing.notes.some(n=>n.id===file.entryNoteId)?file.entryNoteId:null;
    return {vault:{...vault,activeSpaceId:spaceId,spaces:vault.spaces.map(s=>s===existing?{...s,activeNoteId:noteId}:s),updatedAt:now},spaceId,noteId,reused:true};
  }
  const space=createEmptySnapshot(file.collection.title,now,spaceId);
  space.portableImport={version:1,exportId:file.exportId,collectionHash:hash};
  space.ticketCodes=file.collection.ticketCodes;
  space.notes=file.collection.notes.map(n=>({id:n.id,title:n.title,summary:n.summary,body:n.body.replace(/orion-image:\/\/localhost\/([A-Za-z0-9_-]{12,80})/g,(url,id)=>Object.prototype.hasOwnProperty.call(imageUrls,id)?imageUrls[id]:url),tags:[...n.tags],...(n.headingLayout?{headingLayout:n.headingLayout}:{}),sourceIds:[...n.sourceIds],slug:slugifyTitle(n.title),aliases:[],kind:'article',status:'ready',conceptIds:[],createdAt:now,updatedAt:now}));
  space.sources=file.collection.sources.map(s=>({...s,text:'',noteIds:space.notes.filter(n=>n.sourceIds.includes(s.id)).map(n=>n.id),importedAt:now}));
  space.activeNoteId=file.entryNoteId;
  return {vault:{...vault,spaces:[...vault.spaces,space],activeSpaceId:spaceId,updatedAt:now},spaceId,noteId:file.entryNoteId,reused:false};
}

export async function exportPortableFiles(snapshot:AppSnapshot,noteIds:string[],workflow?:{jobId:string;sessionId:string}):Promise<{cancelled:boolean;directory:string;exportedCount:number}>{
  const file=buildPortableCollection(snapshot,noteIds);
  if('__TAURI_INTERNALS__' in window){const {invoke}=await import('@tauri-apps/api/core');return invoke('export_orion_files',{file,workflow});}
  parsePortableFile(JSON.stringify(file));
  for(const note of file.collection.notes){const url=URL.createObjectURL(new Blob([JSON.stringify({...file,entryNoteId:note.id})],{type:'application/vnd.orion.collection+json'}));const a=document.createElement('a');a.href=url;a.download=`${slugifyTitle(note.title)||'note'}.orion`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30_000);}
  return {cancelled:false,directory:'Downloads',exportedCount:noteIds.length};
}
