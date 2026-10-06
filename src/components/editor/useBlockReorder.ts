import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { listNoteBlocks, moveNoteBlockTo, type NoteBlock } from "./noteBlocks";

export function useBlockReorder(editor: Editor, onAnnounce: (message: string) => void) {
  const cancelRef = useRef<(() => void) | null>(null);
  const [drop, setDrop] = useState<{ left: number; top: number; width: number } | null>(null);
  useEffect(() => () => cancelRef.current?.(), [editor]);
  function start(event: ReactPointerEvent<HTMLButtonElement>, source: NoteBlock) {
    if (event.button !== 0 || editor.isDestroyed || !editor.isEditable) return;
    if (source.node.type.name !== "noteBlock" || !listNoteBlocks(editor.state.doc).some(block =>
      block.from === source.from && block.to === source.to && block.node === source.node)) return;
    event.preventDefault(); event.stopPropagation(); cancelRef.current?.();
    const dom = editor.view.dom, host = dom.closest<HTMLElement>(".rich-note-editor");
    if (!host) return;
    const original = editor.state.doc, id = event.pointerId, handle = event.currentTarget;
    let point = { x: event.clientX, y: event.clientY }, position: number | null = null, frame = 0, moved = false, stopped = false;
    const startY = event.clientY;
    const scroller = dom.closest<HTMLElement>(".workspace-content");
    const choose = () => {
      const origin = host.getBoundingClientRect(), column = dom.getBoundingClientRect();
      const blocks = listNoteBlocks(editor.state.doc);
      let boundary = { position: original.content.size, top: column.bottom - 54 };
      for (const block of blocks) {
        const element = editor.view.nodeDOM(block.from);
        if (!(element instanceof HTMLElement)) continue;
        const rect = element.getBoundingClientRect();
        // Floated images can extend below a frame's ordinary flow height.
        // Use their visible extent when choosing either side of that frame.
        let top = rect.top, bottom = rect.bottom;
        for (const image of element.querySelectorAll<HTMLElement>(".note-image-view")) {
          const imageRect = image.getBoundingClientRect();
          if (imageRect.width && imageRect.height) { top = Math.min(top, imageRect.top); bottom = Math.max(bottom, imageRect.bottom); }
        }
        if (point.y < (top + bottom) / 2) { boundary = { position: block.from, top: top - 10 }; break; }
        boundary = { position: block.to, top: bottom + 10 };
      }
      position = boundary.position >= source.from && boundary.position <= source.to ? null : boundary.position;
      setDrop(position === null ? null : { left: column.left - origin.left, top: boundary.top - origin.top, width: column.width });
    };
    const tick = () => {
      if (stopped) return;
      if (editor.isDestroyed || !editor.isEditable || editor.state.doc !== original || !host.isConnected) { cleanup(); return; }
      if (moved) {
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          const delta = point.y < rect.top + 60 ? -Math.min(16, (rect.top + 60 - point.y) / 4)
            : point.y > rect.bottom - 60 ? Math.min(16, (point.y - rect.bottom + 60) / 4) : 0;
          if (delta) scroller.scrollTop += delta;
        }
        choose();
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (e: PointerEvent) => {
      if (stopped || e.pointerId !== id) return;
      point = { x: e.clientX, y: e.clientY };
      if (Math.abs(point.y - startY) > 4) moved = true;
      if (moved) { e.preventDefault(); host.classList.add("is-block-dragging"); }
    };
    const finish = (e: PointerEvent) => {
      if (stopped || e.pointerId !== id) return;
      if (editor.isDestroyed || !editor.isEditable || editor.state.doc !== original || !host.isConnected) { cleanup(); return; }
      point = { x: e.clientX, y: e.clientY }; if (moved) choose();
      const destination = position; cleanup();
      if (moved && destination !== null && editor.state.doc === original && moveNoteBlockTo(editor, source, destination)) {
        editor.view.focus(); onAnnounce("Block moved. Undo restores its previous position.");
      }
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cleanup(); } };
    const cancelPointer = (e: PointerEvent) => { if (e.pointerId === id) cleanup(); };
    const changed = () => { if (editor.isDestroyed || !editor.isEditable || editor.state.doc !== original) cleanup(); };
    function cleanup() {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(frame); setDrop(null); host!.classList.remove("is-block-dragging");
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer); window.removeEventListener("blur", cleanup);
      handle.removeEventListener("lostpointercapture", cancelPointer);
      editor.off("transaction", changed);
      window.removeEventListener("keydown", key, true); cancelRef.current = null;
      try { if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id); } catch { /* The native pointer may already be gone. */ }
    }
    cancelRef.current = cleanup;
    window.addEventListener("pointermove", move, { passive: false }); window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer); window.addEventListener("blur", cleanup);
    handle.addEventListener("lostpointercapture", cancelPointer);
    editor.on("transaction", changed);
    try { handle.setPointerCapture?.(id); } catch { /* Window listeners still support hosts without pointer capture. */ }
    window.addEventListener("keydown", key, true); frame = requestAnimationFrame(tick);
  }
  return { start, drop };
}
