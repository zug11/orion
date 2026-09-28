import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Bold, Braces, FileCode2, Image as ImageIcon, Italic, Link2, List, ListTodo, ListOrdered, Quote, Redo2, Sheet, Undo2, Unlink } from "../lib/icons";
import { findConceptByPhrase } from "../lib/concepts";
import type { Concept, EntityId, NoteTypeface } from "../types";
import { AIWritingMark } from "./icons/AIWritingMark";
import { NOTE_IMAGE_ACCEPT } from "../lib/noteImages";
import { VoiceMemoButton } from "./VoiceMemoButton";
import { HeadingPicker } from "./editor/HeadingPicker";
import { ImageToolbar } from "./editor/NoteImage";
import { TableToolbar } from "./editor/TablePicker";
import { useMenuHeight } from "./editor/useMenuHeight";
import "./editor/EditorExperience.css";

interface EditorToolbarProps {
  noteTypeface?: NoteTypeface;
  onNoteTypefaceChange?: (typeface: NoteTypeface) => void;
  editor: Editor;
  concepts: readonly Concept[];
  onOpenLink: () => void;
  onUnlink: (conceptId?: EntityId) => void;
  citationAvailable: boolean;
  onOpenCitation: () => void;
  onOpenExcerpt?: () => void;
  onOpenTable?: () => void;
  onInsertImages?: (files: readonly File[]) => void;
  imageBusy?: boolean;
  noteId?: EntityId;
  onVoiceMemoSessionStart?: (sessionId: string) => Promise<void> | void;
  onVoiceMemoSessionEnd?: (sessionId: string) => Promise<void> | void;
  onTranscribeVoiceMemo?: (audio: Blob, sessionId: string) => Promise<string>;
  onCompleteVoiceMemo?: (
    sessionId: string,
    transcript: string,
  ) => Promise<void>;
  aiWritingAvailable?: boolean;
  aiWritingActive?: boolean;
  aiWritingBusy?: boolean;
  aiProviderName?: string;
  onToggleAIWriting?: () => void;
  onAnnounce?: (message: string) => void;
}


  function Tool({label,children,active,disabled,action,menu=false}:{label:string;children:ReactNode;active?:boolean;disabled?:boolean;action:()=>void;menu?:boolean}) {
    return <button type="button" aria-label={label} title={label} className={active?"active":undefined}
      role={menu?"menuitem":undefined} aria-pressed={menu?undefined:active} disabled={disabled}
      onMouseDown={event=>event.preventDefault()} onClick={()=>{action();}}>{menu?<><span className="editor-menu-icon" aria-hidden="true">{children}</span><span>{label}</span></>:children}</button>;
  }

export function EditorToolbar({
  noteTypeface = "sans", onNoteTypefaceChange, editor, concepts, onOpenLink, onUnlink,
  citationAvailable, onOpenCitation, onOpenExcerpt, onOpenTable, onInsertImages, imageBusy = false,
  noteId, onVoiceMemoSessionStart, onVoiceMemoSessionEnd, onTranscribeVoiceMemo, onCompleteVoiceMemo,
  aiWritingAvailable = false, aiWritingActive = false, aiWritingBusy = false,
  aiProviderName = "AI", onToggleAIWriting, onAnnounce,
}: EditorToolbarProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [more, setMore] = useState(false);
  const [overflowTarget, setOverflowTarget] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [cramped, setCramped] = useState(false);
  const moreHeight = useMenuHeight(more, moreTrigger);
  const state = useEditorState({ editor, selector: ({ editor: current }) => {
    const { from, to } = current.state.selection;
    const selectedText = from === to ? "" : current.state.doc.textBetween(from,to," ").trim();
    const href = String(current.getAttributes("link").href ?? "");
    const conceptId = href.startsWith("orion-concept://") ? href.slice("orion-concept://".length) : !href && selectedText ? findConceptByPhrase(concepts,selectedText)?.id : undefined;
    return {
      context: current.isActive("image") ? "image" : current.isActive("table") ? "table" : "text",
      heading: current.isActive("heading") ? Number(current.getAttributes("heading").level) : 0,
      bold:current.isActive("bold"),italic:current.isActive("italic"),strike:current.isActive("strike"),code:current.isActive("code"),
      bulletList:current.isActive("bulletList"),orderedList:current.isActive("orderedList"),taskList:current.isActive("taskList"),
      blockquote:current.isActive("blockquote"),codeBlock:current.isActive("codeBlock"),link:current.isActive("link"),
      sourceCitation:href.startsWith("orion-source://"),canUndo:current.can().undo(),canRedo:current.can().redo(),
      canInsertDivider:current.can().setHorizontalRule(),canUnlink:current.isActive("link")||Boolean(conceptId),unlinkConceptId:conceptId,
    };
  }});
  useEffect(() => {
    if (!toolbarRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      setCompact(entry.contentRect.width < 700);
      setNarrow(entry.contentRect.width < 570);
      setCramped(entry.contentRect.width < 430);
    });
    observer.observe(toolbarRef.current); return () => observer.disconnect();
  },[]);
  useEffect(() => { setMore(false); },[state.context]);
  useEffect(() => {
    if (!more) return;
    const dismiss = (event:PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMore(false); };
    document.addEventListener("pointerdown",dismiss);
    moreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => document.removeEventListener("pointerdown",dismiss);
  },[more]);
  const textContext = state.context === "text";
  const fontPicker = onNoteTypefaceChange && <label className="editor-style-select editor-typeface-select">
    <span className="sr-only">Note font</span><select aria-label="Note font" value={noteTypeface}
      onKeyDown={event=>event.stopPropagation()} onChange={event=>{
        const value=event.target.value;if(value==="sans"||value==="serif"){onNoteTypefaceChange(value);editor.commands.focus();}
      }}><option value="sans">Sans serif</option><option value="serif">Serif</option></select>
  </label>;
  const moreMenu = (
        <div className="editor-more" ref={moreRef}>
          <button ref={moreTrigger} type="button" aria-label="More formatting" aria-haspopup="menu" aria-expanded={more} className="editor-more-trigger"
            onMouseDown={event=>event.preventDefault()} onClick={()=>setMore(!more)}>•••</button>
          {more&&<div role="menu" aria-label="More formatting" className="editor-more-menu editor-floating-menu" style={{ maxHeight: moreHeight }} onClick={event=>{if((event.target as HTMLElement).closest('[role="menuitem"]'))setMore(false);}} onKeyDown={event=>{
            if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setMore(false);moreTrigger.current?.focus();}
            if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)){
              event.preventDefault();event.stopPropagation();const choices=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]),select'));
              const index=choices.indexOf(document.activeElement as HTMLElement);const next=event.key==="Home"?0:event.key==="End"?choices.length-1:(index+(event.key==="ArrowDown"?1:-1)+choices.length)%choices.length;choices[next]?.focus();
            }
          }}>
            {compact&&fontPicker}
            {cramped&&<Tool menu label="Italic" action={()=>editor.chain().focus().toggleItalic().run()}><Italic size={15}/></Tool>}
            {cramped&&<Tool menu label="Create reusable link" action={onOpenLink}><Link2 size={15}/></Tool>}
            {compact&&<Tool menu label="Bulleted list" active={state.bulletList} action={()=>editor.chain().focus().toggleBulletList().run()}><List size={16}/></Tool>}
            {narrow&&<Tool menu label="To-do list" action={()=>editor.chain().focus().toggleTaskList().run()}><ListTodo size={16}/></Tool>}
            <Tool menu label="Numbered list" action={()=>editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={16}/></Tool>
            <Tool menu label="Strikethrough" action={()=>editor.chain().focus().toggleStrike().run()}><s>S</s></Tool>
            <Tool menu label="Inline code" action={()=>editor.chain().focus().toggleCode().run()}><Braces size={15}/></Tool>
            <Tool menu label="Quote" action={()=>editor.chain().focus().toggleBlockquote().run()}><Quote size={15}/></Tool>
            {narrow&&<>
              <Tool menu label="Cite a source" disabled={!citationAvailable} action={onOpenCitation}><BookOpen size={15}/></Tool>
              <Tool menu label="Insert image" disabled={imageBusy||!onInsertImages} action={()=>imageInputRef.current?.click()}><ImageIcon size={15}/></Tool>
              <Tool menu label="Insert table" action={()=>onOpenTable?.()}><Sheet size={15}/></Tool>
            </>}
            <Tool menu label="Insert excerpt" disabled={!onOpenExcerpt} action={()=>onOpenExcerpt?.()}><Quote size={15}/></Tool>
            <Tool menu label="Code block" action={()=>editor.chain().focus().toggleCodeBlock().run()}><FileCode2 size={15}/></Tool>
            <Tool menu label="Insert divider" disabled={!state.canInsertDivider} action={()=>{editor.chain().focus().setHorizontalRule().run();onAnnounce?.("Divider inserted.");}}><span>―</span></Tool>
            <Tool menu label="Unlink selected text" disabled={!state.canUnlink} action={()=>onUnlink(state.unlinkConceptId)}><Unlink size={15}/></Tool>
          </div>}
        </div>
  );
  return <div ref={toolbarRef} className="editor-toolbar editor-toolbar-contextual" role="toolbar"
    aria-label={state.context==="image"?"Image formatting":state.context==="table"?"Table formatting":"Text formatting"} data-context={state.context}
    onKeyDown={event=>{
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement || (event.target as HTMLElement).closest('[role="menu"]')) return;
      if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
      const controls=Array.from(toolbarRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled])')??[]).filter(el=>!el.closest('[hidden]'));
      if (!controls.length)return;
      const index=controls.indexOf(document.activeElement as HTMLElement);
      const next=event.key==="Home"?0:event.key==="End"?controls.length-1:(index+(event.key==="ArrowRight"?1:-1)+controls.length)%controls.length;
      event.preventDefault();controls[next]?.focus();
    }}>
    <div className="editor-toolbar-main" inert={aiWritingBusy?true:undefined}>
      {state.context==="image" ? <ImageToolbar editor={editor} overflowTarget={overflowTarget}/> : state.context==="table" ? <TableToolbar editor={editor} overflowTarget={overflowTarget}/> : <>
        {!compact&&fontPicker}
        <HeadingPicker editor={editor} level={state.heading}/>
        <span className="editor-toolbar-separator" aria-hidden="true"/>
        <Tool label="Bold" active={state.bold} action={()=>editor.chain().focus().toggleBold().run()}><Bold size={15}/></Tool>
        {!cramped&&<Tool label="Italic" active={state.italic} action={()=>editor.chain().focus().toggleItalic().run()}><Italic size={15}/></Tool>}
        {!compact&&<Tool label="Bulleted list" active={state.bulletList} action={()=>editor.chain().focus().toggleBulletList().run()}><List size={16}/></Tool>}
        {!narrow&&<Tool label="To-do list" active={state.taskList} action={()=>editor.chain().focus().toggleTaskList().run()}><ListTodo size={16}/></Tool>}
        <span className="editor-toolbar-separator" aria-hidden="true"/>
        {!cramped&&<Tool label="Create reusable link" active={state.link} action={onOpenLink}><Link2 size={15}/></Tool>}
        {!narrow&&<>
          <Tool label="Cite a source" active={state.sourceCitation} disabled={!citationAvailable} action={onOpenCitation}><BookOpen size={15}/></Tool>
          <Tool label="Insert image" disabled={imageBusy||!onInsertImages} action={()=>imageInputRef.current?.click()}><ImageIcon size={15}/></Tool>
          <Tool label="Insert table" action={()=>onOpenTable?.()}><Sheet size={15}/></Tool>
        </>}

      </>}
    </div>
    <input ref={imageInputRef} className="sr-only" type="file" accept={NOTE_IMAGE_ACCEPT} multiple tabIndex={-1} aria-hidden="true"
      onChange={event=>{const files=Array.from(event.currentTarget.files??[]);event.currentTarget.value="";if(files.length)onInsertImages?.(files);}}/>
    {noteId&&onTranscribeVoiceMemo&&onCompleteVoiceMemo&&<div className="editor-toolbar-dictation" role="group" aria-label="Dictation" hidden={!textContext}>
      <VoiceMemoButton noteId={noteId} onSessionStart={onVoiceMemoSessionStart} onSessionEnd={onVoiceMemoSessionEnd} onTranscribe={onTranscribeVoiceMemo} onComplete={onCompleteVoiceMemo}/>
    </div>}
    <div className="editor-toolbar-ai" role="group" aria-label="AI tools" hidden={!textContext}>
      <button type="button" className={`${aiWritingActive?"active ":""}ai-writing-toggle${aiWritingAvailable?"":" is-unavailable"}`}
        aria-label={aiWritingActive?"Turn off AI tools":"Turn on AI tools"} aria-pressed={aiWritingActive} aria-disabled={!aiWritingAvailable}
        title={aiWritingAvailable?"AI tools: write, rewrite and generate images":`Add an ${aiProviderName} key in Settings to use AI tools`}
        onMouseDown={event=>event.preventDefault()} onClick={onToggleAIWriting}><AIWritingMark size={17}/></button>
    </div>
    <div className="editor-toolbar-history" role="group" aria-label="Editing history" inert={aiWritingBusy?true:undefined}>
      <Tool label="Undo" disabled={!state.canUndo} action={()=>editor.chain().focus().undo().run()}><Undo2 size={14}/></Tool>
      <Tool label="Redo" disabled={!state.canRedo} action={()=>editor.chain().focus().redo().run()}><Redo2 size={14}/></Tool>
    </div>
    <div ref={setOverflowTarget} className="editor-toolbar-overflow" inert={aiWritingBusy?true:undefined}>{textContext&&moreMenu}</div>
  </div>;
}
