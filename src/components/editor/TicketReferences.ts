import { Extension } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ticketReferences, ticketIdFromUrl, type TicketReferenceTarget } from '../../lib/ticketReferences';

export const TicketReferences = Extension.create<{getIndex:()=>ReadonlyMap<string,TicketReferenceTarget>;open:(id:string)=>void}>({
  name:'orionTicketReferences',
  addOptions(){return {getIndex:()=>new Map(),open:()=>undefined};},
  addProseMirrorPlugins(){
    const options=this.options;
    let last:{doc:Node;index:ReadonlyMap<string,TicketReferenceTarget>;set:DecorationSet}|undefined;
    let cached=new Map<string,ReturnType<typeof ticketReferences>>();
    return [new Plugin({key:new PluginKey('orionTicketReferences'),props:{
      decorations(state){
        const index=options.getIndex();if(last?.doc===state.doc&&last.index===index)return last.set;
        if(last?.index!==index||cached.size>4000)cached=new Map();
        const decorations:Decoration[]=[];
        state.doc.descendants((node,pos)=>{
          if(node.type.name==='codeBlock')return false;
          if(!node.isText||!node.text||node.marks.some(mark=>['link','code'].includes(mark.type.name)))return;
          let refs=cached.get(node.text);if(!refs){refs=ticketReferences(node.text,index);cached.set(node.text,refs);}
          for(const ref of refs)decorations.push(Decoration.inline(pos+ref.start,pos+ref.end,{class:'editor-auto-link ticket-reference','data-ticket-reference':ref.id,role:'link',tabindex:'0'}));
        });
        const set=DecorationSet.create(state.doc,decorations);last={doc:state.doc,index,set};return set;
      },
      handleClick(_view,_pos,event){
        const element=(event.target as HTMLElement).closest<HTMLElement>('[data-ticket-reference],a[href^="orion-ticket://"]');
        const id=element?.dataset.ticketReference??ticketIdFromUrl(element?.getAttribute('href')??undefined);
        if(!id)return false;event.preventDefault();options.open(id);return true;
      },
      handleDOMEvents:{keydown(_view,event){
        const id=(event.target as HTMLElement).closest<HTMLElement>('[data-ticket-reference]')?.dataset.ticketReference;
        if(!id||!['Enter',' '].includes(event.key))return false;event.preventDefault();options.open(id);return true;
      }},
    }})];
  },
});
