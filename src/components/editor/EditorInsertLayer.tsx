import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Escape the editor's size container; keep the picker inside the themed app. */
export function EditorInsertLayer({editor,position,children}:{editor:Editor;position:number;children:ReactNode}) {
  const [anchor,setAnchor]=useState({left:16,top:64});
  const layer = useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    const place=()=>{
      try {
        const caret=editor.view.coordsAtPos(Math.min(position,editor.state.doc.content.size));
        const toolbar=editor.view.dom.closest(".rich-note-editor")?.querySelector(".editor-formatting-dock, .editor-toolbar-shell")?.getBoundingClientRect();
        const size = layer.current?.getBoundingClientRect();
        const width = size?.width || 282;
        const height = size?.height || 340;
        const below=Math.max(toolbar?.bottom??16,Math.min(caret.bottom,window.innerHeight-48))+8;
        const top = below + height <= window.innerHeight - 12 ? below : caret.top - height - 8;
        setAnchor({left:Math.max(12,Math.min(caret.left,window.innerWidth-width-12)),top:Math.max(12,Math.min(top,window.innerHeight-height-12))});
      } catch {setAnchor({left:16,top:64});}
    };
    place();window.addEventListener("resize",place);document.addEventListener("scroll",place,true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (layer.current) observer?.observe(layer.current);
    return()=>{observer?.disconnect();window.removeEventListener("resize",place);document.removeEventListener("scroll",place,true);};
  },[editor,position]);
  return createPortal(<div ref={layer} className="editor-insert-layer" style={anchor}>{children}</div>,editor.view.dom.closest(".app-shell")??document.body);
}
