import type { Note } from '../types';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { splitMarkdownFrontmatter } from './markdown';
import { ticketCode, type TicketCodes } from './ticketCodes';
export interface TicketReferenceTarget { id:string;code:string;title:string }

export interface TicketReference { start: number; end: number; id: string; code: string }
export function ticketReferenceIndex(_notes: readonly Note[], codes?: TicketCodes): Map<string, TicketReferenceTarget> {
  const index = new Map<string, TicketReferenceTarget>();
  // References use acknowledged identities only. Resolving a live target is an
  // explicit navigation action; ordinary typing never indexes the whole Space.
  for (const id of Object.keys(codes?.assigned??{})) {
    const code=ticketCode(codes,id);if(code)index.set(code,{id,code,title:code});
  }
  return index;
}
export function ticketReferences(text: string, index: ReadonlyMap<string, TicketReferenceTarget>): TicketReference[] {
  const result: TicketReference[] = [];
  for (const match of text.matchAll(/(?<![\w-])[A-Z][A-Z0-9]{1,11}-[0-9]+(?![\w-])/gi)) {
    const code = match[0].toUpperCase(), ticket = index.get(code);
    if (ticket) result.push({start:match.index!,end:match.index!+match[0].length,id:ticket.id,code});
  }
  return result;
}
export function ticketIdFromUrl(url?: string): string | undefined {
  const match = /^orion-ticket:\/\/([\w-]{1,96})$/.exec(url ?? '');
  return match?.[1];
}
export function ticketUrl(id: string): string { return `orion-ticket://${id}`; }

type MdNode = { type: string; value?: string; children?: MdNode[]; url?: string };
const parser=unified().use(remarkParse).use(remarkGfm);
const referencesCache=new WeakMap<Note,{codes:Set<string>;ids:Set<string>}>();
export function ticketBacklinks(notes:readonly Note[],index:ReadonlyMap<string,TicketReferenceTarget>,id:string): Note[] {
  return notes.filter(note=>{
    let refs=referencesCache.get(note);
    if(!refs){
      refs={codes:new Set(),ids:new Set()};
      const visit=(node:MdNode)=>{
        if(['code','inlineCode','html'].includes(node.type))return;
        if(node.type==='link'){const id=ticketIdFromUrl(node.url);if(id)refs!.ids.add(id);return;}
        if(node.type==='text'&&node.value)for(const match of node.value.matchAll(/(?<![\w-])[A-Z][A-Z0-9]{1,11}-[0-9]+(?![\w-])/gi))refs!.codes.add(match[0].toUpperCase());
        node.children?.forEach(visit);
      };
      visit(parser.parse(splitMarkdownFrontmatter(note.body).content) as MdNode);referencesCache.set(note,refs);
    }
    return refs.ids.has(id)||[...refs.codes].some(code=>index.get(code)?.id===id);
  });
}
/** Reading/chat decoration only; literal code and existing links stay untouched. */
export function remarkTicketReferences(index: ReadonlyMap<string, TicketReferenceTarget>) {
  return () => (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!node.children || ['code','inlineCode','link','linkReference','image','html'].includes(node.type)) return;
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        const refs = ticketReferences(child.value, index), parts: MdNode[] = []; let at = 0;
        for (const ref of refs) {
          if (ref.start > at) parts.push({type:'text',value:child.value.slice(at,ref.start)});
          parts.push({type:'link',url:ticketUrl(ref.id),children:[{type:'text',value:child.value.slice(ref.start,ref.end)}]}); at=ref.end;
        }
        if (at < child.value.length) parts.push({type:'text',value:child.value.slice(at)});
        return parts.length ? parts : [child];
      });
    };
    visit(tree);
  };
}
