import type { Editor } from "@tiptap/core";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, ListTodo, List, ListOrdered, Image, FileCode2, Link2, Quote, Sheet, Trash2, ChevronRight } from "../../lib/icons";
import { getSlashMatch, matchingSlashItems, type SlashMatch, type SlashCommand } from "./slashCommands";
import { BlocksMark } from "../icons/BlocksMark";

export const slashCommandIcons = {heading:FileText,block:BlocksMark,todo:ListTodo,bullet:List,numbered:ListOrdered,divider:FileText,image:Image,code:FileCode2,link:Link2,excerpt:Quote,table:Sheet};
export function SlashMenu({editor, suspended, onCommand}:{editor:Editor;suspended:boolean;onCommand:(command:SlashCommand,range:{from:number;to:number})=>void}) {
  const [match, setMatch] = useState<SlashMatch|null>(null);
  const [active,setActive] = useState(0);
  const [heading,setHeading] = useState(false);
  const [position,setPosition] = useState<{left:number;top:number;maxHeight:number}>({left:0,top:0,maxHeight:430});
  const latest = useRef<((event:KeyboardEvent)=>boolean)|null>(null);
  const dismissed = useRef<string|null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [editorDOM, setEditorDOM] = useState<HTMLElement|null>(null);
  const previousMatch = useRef<string|null>(null);
  const id = useId();
  const items = match ? heading ? [1,2,3,4,5,6].map(level=>({id:`h${level}` as SlashCommand,title:`Heading ${level}`,description:""})) : matchingSlashItems(match) : [];
  function choose(command:SlashCommand) {
    if (!match) return;
    if (command === "heading") {setHeading(true);setActive(0);return;}
    dismissed.current = `${match.from}:${match.to}:${match.query}`;
    setMatch(null); setHeading(false);
    onCommand(command,{from:match.from,to:match.to});
  }
  latest.current = event => {
    if (!match || suspended) return false;
    if (event.isComposing) return false;
    if (event.key === "Escape") {
      if (heading) {setHeading(false);setActive(0);} else {dismissed.current=`${match.from}:${match.to}:${match.query}`;setMatch(null);}
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {setActive(i=>(i+(event.key === "ArrowDown"?1:-1)+Math.max(1,items.length))%Math.max(1,items.length));return true;}
    if (event.key === "ArrowLeft" && heading) {setHeading(false);setActive(0);return true;}
    if (["Enter","Tab"].includes(event.key) && items[active]) {choose(items[active].id);return true;}
    return false;
  };
  useEffect(()=>{
    let mounted = true;
    let dom: HTMLElement|null = null;
    const clearAria = (element: HTMLElement) => {
      element.removeAttribute("aria-controls");
      element.removeAttribute("aria-expanded");
      element.removeAttribute("aria-activedescendant");
      element.removeAttribute("data-slash-open");
    };
    // Capture on the mounted editor element runs before ProseMirror's bubble
    // keymaps, without mutating its plugin list during React StrictMode effects.
    const keydown = (event: KeyboardEvent) => {
      if (!mounted || editor.isDestroyed || !editor.isEditable || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, button")) return;
      if (latest.current?.(event)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const bindDOM = () => {
      let nextDOM: HTMLElement|null = null;
      if (!editor.isDestroyed) {
        try { nextDOM = editor.view.dom; } catch { /* Tiptap is between mounts. */ }
      }
      if (nextDOM === dom) return;
      if (dom) { dom.removeEventListener("keydown", keydown, true); clearAria(dom); }
      dom = nextDOM;
      dom?.addEventListener("keydown", keydown, true);
      if (mounted) setEditorDOM(dom);
    };
    const sync = () => {
      if (!mounted) return;
      bindDOM();
      if (!dom || editor.isDestroyed) {setMatch(null);return;}
      const candidate = getSlashMatch(editor.state);
      const candidateIdentity = candidate ? `${candidate.from}:${candidate.to}:${candidate.query}` : null;
      // Dismiss only the current typed command. A later edit or cursor move
      // starts a new interaction, even if the same command returns at this spot.
      if (dismissed.current && candidateIdentity !== dismissed.current) dismissed.current = null;
      const next = !suspended && editor.isFocused ? candidate : null;
      if (!next || dismissed.current===`${next.from}:${next.to}:${next.query}`) {dom.removeAttribute("data-slash-open");setMatch(null);return;}
      const identity = `${next.from}:${next.query}`;
      const changed = previousMatch.current !== identity;
      if (changed) {setActive(0);setHeading(false);}
      previousMatch.current = identity;
      setMatch(next);
      try {
        dom.setAttribute("data-slash-open", "true");
        let rect=editor.view.coordsAtPos(next.to);
        let availableBelow=window.innerHeight-rect.bottom-20;
        // Reserve scroll room at the end of a note, then bring the caret up
        // only as a command opens/changes. The menu always stays below it.
        const scroller = dom.closest<HTMLElement>(".workspace-content");
        if (changed && availableBelow < 180 && scroller) {
          scroller.scrollTop += 180 - availableBelow;
          rect = editor.view.coordsAtPos(next.to);
          availableBelow = window.innerHeight - rect.bottom - 20;
        }
        const maxHeight=Math.max(0,Math.min(430,availableBelow));
        setPosition({left:Math.max(12,Math.min(rect.left,window.innerWidth-300)),maxHeight,top:rect.bottom+8});
      } catch { setMatch(null); }
    };
    const unmount = () => {
      if (dom) {dom.removeEventListener("keydown",keydown,true);clearAria(dom);}
      dom = null;
      if (mounted) {setEditorDOM(null);setMatch(null);}
    };
    editor.on("transaction",sync);editor.on("focus",sync);editor.on("mount",sync);editor.on("create",sync);editor.on("unmount",unmount);
    const dismissOnOutside=(event:PointerEvent)=>{
      if (!menu.current?.contains(event.target as Node) && !dom?.contains(event.target as Node)) setMatch(null);
    };
    const scroll=()=>sync();
    document.addEventListener("pointerdown",dismissOnOutside);
    window.addEventListener("resize",scroll);document.addEventListener("scroll",scroll,true);
    sync();
    const frame=window.requestAnimationFrame(sync);
    return ()=>{
      mounted=false;window.cancelAnimationFrame(frame);
      editor.off("transaction",sync);editor.off("focus",sync);editor.off("mount",sync);editor.off("create",sync);editor.off("unmount",unmount);
      if(dom){dom.removeEventListener("keydown",keydown,true);clearAria(dom);}
      document.removeEventListener("pointerdown",dismissOnOutside);window.removeEventListener("resize",scroll);document.removeEventListener("scroll",scroll,true);
    };
  },[editor,suspended]);
  useEffect(()=>{menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:"nearest"});},[active,heading]);
  useEffect(()=>{
    const dom=editorDOM;
    if(!dom)return;
    if (match && !suspended) {dom.setAttribute("aria-controls",id);dom.setAttribute("aria-expanded","true");dom.setAttribute("aria-activedescendant",`${id}-${active}`);dom.setAttribute("data-slash-open","true");}
    else {dom.removeAttribute("aria-controls");dom.removeAttribute("aria-expanded");dom.removeAttribute("aria-activedescendant");dom.removeAttribute("data-slash-open");}
    return ()=>{dom.removeAttribute("aria-controls");dom.removeAttribute("aria-expanded");dom.removeAttribute("aria-activedescendant");};
  },[match,active,editorDOM,id,suspended]);
  if (!match || suspended || !editorDOM) return null;
  return createPortal(<div ref={menu} className="editor-slash-menu editor-floating-menu" style={position}>
    <div className="editor-menu-eyebrow">{heading?"Heading size":match.inTable&&match.query.startsWith("d")?"Table":"Insert"}</div>
    <div id={id} role="listbox" aria-label={heading?"Heading levels":"Slash commands"}>
      {items.map((item,index)=>{
        const Icon= item.id.startsWith("delete")?Trash2:slashCommandIcons[item.id as keyof typeof slashCommandIcons]??FileText;
        return <button type="button" role="option" aria-selected={active===index} id={`${id}-${index}`} key={item.id}
          className={/^h[1-6]$/.test(item.id)?`slash-heading heading-choice-${item.id[1]}`:undefined}
          onMouseEnter={()=>setActive(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(item.id)}>
          <Icon size={17}/><span>{item.title}</span>{item.id==="heading"&&<ChevronRight size={13}/>}
        </button>;
      })}
      {items.length===0&&<p className="editor-menu-empty">No matching command</p>}
    </div>
    <div className="editor-menu-hint">{items[active]?.description || "↑ ↓ to choose · Enter to insert · Esc to close"}</div>
  </div>,editorDOM.closest(".app-shell")??editorDOM.ownerDocument.body);
}
