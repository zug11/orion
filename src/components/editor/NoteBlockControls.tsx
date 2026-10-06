import type { Editor, EditorEvents } from "@tiptap/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { Menu, Plus, Trash2 } from "../../lib/icons";
import { createBlockGeometry, type BlockExclusion, type BlockGeometry, type BlockRect } from "./blockGeometry";
import { deleteNoteBlock, insertNoteBlockParagraph, listNoteBlocks, moveNoteBlock, type NoteBlock } from "./noteBlocks";
import { BlockInsertMenu, type BlockInsertCommand } from "./BlockInsertMenu";
import "./NoteBlockControls.css";
import { useBlockReorder } from "./useBlockReorder";

type MeasuredBlock = { block: NoteBlock; geometry: BlockGeometry };
type Insertion = { position: number; anchor: HTMLElement; document: Editor["state"]["doc"] };

/** Chrome is a sibling overlay: never wrap, clip, or resize ProseMirror nodes. */
export function NoteBlockControls({ editor, suspended, onInsert, onAnnounce }: {
  editor: Editor; suspended: boolean;
  onInsert: (command: BlockInsertCommand, position: number) => void;
  onAnnounce: (message: string) => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const reorder = useBlockReorder(editor, onAnnounce);
  const target = useRef<number | null>(null);
  const locked = useRef(false);
  const [measured, setMeasured] = useState<MeasuredBlock[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [insertion, setInsertion] = useState<Insertion | null>(null);
  const closeInsert = useCallback(() => setInsertion(null), []);
  locked.current = Boolean(insertion);

  useEffect(() => {
    const attach = () => {
      if (editor.isDestroyed) return;
      let frame = 0;
      const dom = editor.view.dom;
      const host = dom.closest<HTMLElement>(".rich-note-editor");
      if (!host) return;
      const local = (rect: DOMRect, origin: DOMRect): BlockRect => ({
        left: rect.left - origin.left, right: rect.right - origin.left,
        top: rect.top - origin.top, bottom: rect.bottom - origin.top,
      });
      const measure = () => {
        frame = 0;
        if (editor.isDestroyed || !host.isConnected) return;
        const origin = host.getBoundingClientRect();
        const exclusions: BlockExclusion[] = [];
        // A live drag exclusion contains the actual-size frame even though hidden.
        for (const wrapper of dom.querySelectorAll<HTMLElement>(".orion-note-image-node,.note-image-drag-exclusion")) {
          const style = getComputedStyle(wrapper);
          if (style.display === "none" || !["left", "right"].includes(style.cssFloat)) continue;
          const image = wrapper.matches(".note-image-drag-exclusion")
            ? wrapper.firstElementChild : wrapper.querySelector(".note-image-view");
          if (!(image instanceof HTMLElement)) continue;
          const gap = Math.max(parseFloat(style.paddingBottom) || 0, parseFloat(style.marginBottom) || 0);
          const fullBand = wrapper.dataset.placement === "break";
          const rect = local(image.getBoundingClientRect(), origin);
          rect.left += 4; rect.right -= 4;
          exclusions.push({ rect, gap, side: fullBand ? "both" : style.cssFloat as "left" | "right" });
        }
        const blocks = listNoteBlocks(editor.state.doc);
        const visible: MeasuredBlock[] = [];
        for (const block of blocks) {
          if (block.node.type.name !== "noteBlock") continue;
          const nodeDOM = editor.view.nodeDOM(block.from);
          if (!(nodeDOM instanceof HTMLElement) || getComputedStyle(nodeDOM).display === "none") continue;
          const imageOnly = block.node.childCount === 1 && block.node.firstChild?.type.name === "image";
          const element = imageOnly ? nodeDOM.querySelector<HTMLElement>(".note-image-view") ?? nodeDOM : nodeDOM;
          const rect = element.getBoundingClientRect();
          if (rect.bottom < -180 || rect.top > window.innerHeight + 180 || !rect.width) continue;
          const box = local(rect, origin);
          // Control anchors follow the text lane without changing document layout.
          box.left -= 5; box.right += 5; box.bottom += 3;
          if (box.bottom - box.top < 24) box.bottom = box.top + 24;
          const ownImages = nodeDOM.querySelector(".orion-note-image-node");
          const canWrap = !ownImages;
          const paragraph = block.node.childCount === 1 && block.node.firstChild?.type.name === "paragraph";
          // Floats exclude a whole line when they intersect any part of it. Snap
          // control anchors to those line boxes so they remain outside the prose.
          const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
          const lanes = paragraph && Number.isFinite(lineHeight) && lineHeight > 0
            ? exclusions.map(exclusion => {
                const gap = exclusion.gap ?? 0;
                return { ...exclusion, rect: { ...exclusion.rect,
                  top: box.top + Math.floor((exclusion.rect.top - gap - box.top) / lineHeight) * lineHeight + gap,
                  bottom: box.top + Math.ceil((exclusion.rect.bottom + gap - box.top) / lineHeight) * lineHeight - gap,
                } };
              }) : exclusions;
          const geometry = createBlockGeometry(box, canWrap ? lanes : []);
          if (geometry.path) visible.push({ block, geometry });
        }
        setMeasured(visible);
        const selection = editor.state.selection;
        const selected = blocks.find(block => selection.from >= block.from && selection.from < block.to && block.node.type.name === "noteBlock");
        if (!locked.current) target.current = selected?.from ?? null;
        setActive(target.current);
      };
      const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
      const selectedBlock = () => listNoteBlocks(editor.state.doc).find(block => block.node.type.name === "noteBlock" &&
        editor.state.selection.from >= block.from && editor.state.selection.from < block.to);
      target.current = selectedBlock()?.from ?? null;
      const transaction = ({ transaction: tr }: EditorEvents["transaction"]) => {
        if (tr.docChanged) {
          setInsertion(null);
          target.current = selectedBlock()?.from ?? null;
        }
        schedule();
      };
      const pointerDown = (event: PointerEvent) => {
        if (locked.current || !(event.target instanceof HTMLElement)) return;
        // Keep the text lane live while an adjacent image is moved/resized.
        if (event.target.closest(".orion-note-image-node")) return;
        const block = listNoteBlocks(editor.state.doc).find(item => item.from === target.current);
        if (!block) return;
        const element = editor.view.nodeDOM(block.from);
        if (!(element instanceof HTMLElement)) return;
        const rect = (element.querySelector(".note-image-view") ?? element).getBoundingClientRect();
        if (event.clientY > rect.bottom + 6) {
          // Clicking blank space after the final block creates an ordinary line.
          if (block.to === editor.state.doc.content.size && event.target === dom) {
            event.preventDefault(); insertNoteBlockParagraph(editor, block.to); editor.view.focus();
          }
        }
      };
      const select = () => { schedule(); };
      const observer = new MutationObserver(schedule);
      observer.observe(dom, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["style", "class"] });
      const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
      resize?.observe(dom); resize?.observe(host);
      editor.on("transaction", transaction); editor.on("selectionUpdate", select);
      dom.addEventListener("pointerdown", pointerDown);
      dom.addEventListener("load", schedule, true);
      document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
      document.fonts?.addEventListener("loadingdone", schedule);
      schedule();
      return () => {
        cancelAnimationFrame(frame); observer.disconnect(); resize?.disconnect();
        editor.off("transaction", transaction); editor.off("selectionUpdate", select);
        dom.removeEventListener("pointerdown", pointerDown);
        dom.removeEventListener("load", schedule, true);
        document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule);
        document.fonts?.removeEventListener("loadingdone", schedule);
      };
    };
    let detach: (() => void) | undefined;
    const bind = () => { detach?.(); detach = attach(); };
    const unbind = () => { detach?.(); detach = undefined; };
    editor.on("mount", bind); editor.on("unmount", unbind);
    bind();
    // EditorContent can attach after sibling effects during StrictMode replay.
    const pending = requestAnimationFrame(() => { if (!detach) bind(); });
    return () => {
      cancelAnimationFrame(pending); unbind();
      editor.off("mount", bind); editor.off("unmount", unbind);
    };
  }, [editor]);

  useEffect(() => { if (suspended) setInsertion(null); }, [suspended]);
  const current = measured.find(item => item.block.from === active);
  const first = current?.geometry.bands[0], last = current?.geometry.bands[current.geometry.bands.length - 1];
  // Centre the differently sized controls on one row above table selection rails.
  const controlRowY = first ? first.top - 23 : 0;
  const blockName = current?.block.label === "Block" ? "block" : `${current?.block.label.toLowerCase()} block`;
  const beginInsert = (anchor: HTMLElement, position: number) => {
    if (suspended || !editor.isEditable) return;
    setInsertion({ position, anchor, document: editor.state.doc });
  };
  return <div ref={overlay} className={`note-block-controls${suspended ? " is-suspended" : ""}`} contentEditable={false}>
    {reorder.drop && <div className="note-block-drop" style={reorder.drop} aria-hidden="true"/>}
    {!suspended && current && first && last && <div role="group" aria-label={`${blockName[0].toUpperCase()}${blockName.slice(1)} controls`}>
      <button type="button" className="note-block-move" aria-label="Move block" title="Drag to move block · ↑/↓ to move one position"
        style={{ left: first.left - 28, top: controlRowY - 10 }} onPointerDown={event => reorder.start(event, current.block)}
        onKeyDown={event => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          if (moveNoteBlock(editor, current.block, event.key === "ArrowUp" ? "up" : "down")) onAnnounce("Block moved. Undo restores its position.");
        }}><Menu size={12}/></button>
      <button type="button" className="note-block-add" aria-label={`Insert before ${blockName}`} title="Insert above"
        style={{ left: (first.left + first.right) / 2 - 10, top: controlRowY - 10 }}
        onMouseDown={event => event.preventDefault()} onClick={event => beginInsert(event.currentTarget, current.block.from)}><Plus size={12}/></button>
      <button type="button" className="note-block-delete" aria-label={`Delete ${blockName}`} title={`Delete ${blockName} · Undo restores it`}
        style={{ left: first.right - 28, top: controlRowY - 14 }} onMouseDown={event => event.preventDefault()}
        onClick={() => {
          if (deleteNoteBlock(editor, current.block)) { editor.view.focus(); onAnnounce(`${current.block.label} deleted. Undo restores it.`); }
          else onAnnounce("This block changed. Select it again before deleting.");
        }}><Trash2 size={13}/></button>
      <button type="button" className="note-block-add" aria-label={`Insert after ${blockName}`} title="Insert below"
        style={{ left: (last.left + last.right) / 2 - 10, top: last.bottom + 11 }}
        onMouseDown={event => event.preventDefault()} onClick={event => beginInsert(event.currentTarget, current.block.to)}><Plus size={12}/></button>
    </div>}
    {insertion && !suspended && <BlockInsertMenu editor={editor} anchor={insertion.anchor} onClose={closeInsert} onChoose={command => {
      if (!editor.state.doc.eq(insertion.document)) { setInsertion(null); onAnnounce("This note changed. Choose an insertion point again."); return; }
      const position = insertion.position; setInsertion(null); onInsert(command, position);
    }}/>}
  </div>;
}
