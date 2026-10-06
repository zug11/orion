import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileText, ChevronRight } from "../../lib/icons";
import { matchingSlashItems, type SlashCommand } from "./slashCommands";
import { slashCommandIcons } from "./SlashMenu";

export type BlockInsertCommand = SlashCommand | "paragraph";

/** The same insertion vocabulary as slash, opened at a document boundary. */
export function BlockInsertMenu({ editor, anchor, onChoose, onClose }: {
  editor: Editor; anchor: HTMLElement;
  onChoose: (command: BlockInsertCommand) => void; onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [heading, setHeading] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 430 });
  const items = heading
    ? [1, 2, 3, 4, 5, 6].map(level => ({ id: `h${level}` as BlockInsertCommand, title: `Heading ${level}` }))
    : [{ id: "paragraph" as const, title: "Text" }, ...matchingSlashItems({ from: 0, to: 0, query: "", inTable: false }).filter(item => item.id !== "block")];
  useEffect(() => {
    const dom = editor.view.dom;
    dom.setAttribute("data-block-insert-open", "true");
    const place = () => {
      if (!anchor.isConnected) { onClose(); return; }
      const rect = anchor.getBoundingClientRect();
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)), top: rect.bottom + 6,
        maxHeight: Math.max(0, Math.min(430, window.innerHeight - rect.bottom - 18)) });
    };
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    };
    // Like slash, keep the menu below the insertion point with enough scroll room.
    const scroller = editor.view.dom.closest<HTMLElement>(".workspace-content");
    const room = window.innerHeight - anchor.getBoundingClientRect().bottom - 18;
    if (room < 200 && scroller) scroller.scrollTop += 200 - room;
    place();
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      dom.removeAttribute("data-block-insert-open");
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, editor, onClose]);
  useEffect(() => { menu.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [heading]);
  return createPortal(<div ref={menu} className="editor-slash-menu editor-floating-menu editor-block-insert" style={position}
    role="menu" aria-label="Insert block" onKeyDown={event => {
      if (event.key === "Tab") { event.preventDefault(); onClose(); editor.view.focus(); return; }
      if (event.key === "Escape" || (heading && event.key === "ArrowLeft")) {
        event.preventDefault(); event.stopPropagation();
        if (heading) setHeading(false); else { onClose(); anchor.focus(); }
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    }}>
    <div className="editor-menu-eyebrow">{heading ? "Heading size" : "Insert"}</div>
    <div className="editor-block-insert-options">{items.map(item => {
      const Icon = slashCommandIcons[item.id as keyof typeof slashCommandIcons] ?? FileText;
      return <button key={item.id} type="button" role="menuitem"
        className={/^h[1-6]$/.test(item.id) ? `slash-heading heading-choice-${item.id[1]}` : undefined}
        onClick={() => item.id === "heading" ? setHeading(true) : onChoose(item.id)}>
        <Icon size={17}/><span>{item.title}</span>{item.id === "heading" && <ChevronRight size={13}/>}</button>;
    })}</div>
    <div className="editor-menu-hint">↑ ↓ to choose · Enter to insert · Esc to close</div>
  </div>, editor.view.dom.closest(".app-shell") ?? document.body);
}
