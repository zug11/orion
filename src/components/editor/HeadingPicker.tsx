import type { Editor } from "@tiptap/core";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "../../lib/icons";
import { useMenuHeight } from "./useMenuHeight";

export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type HeadingLevel = typeof HEADING_LEVELS[number];

export function HeadingPicker({ editor, level }: { editor: Editor; level: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const maxHeight = useMenuHeight(open, trigger);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  return <div className="editor-heading-picker" ref={root}>
    <button ref={trigger} type="button" className="editor-heading-trigger" aria-label="Text style" aria-haspopup="menu" aria-expanded={open}
      onMouseDown={(event) => event.preventDefault()} onClick={() => setOpen(!open)}>
      <span>{level ? `Heading ${level}` : "Text"}</span><ChevronDown size={12}/>
    </button>
    {open && <div role="menu" aria-label="Heading levels" className="editor-heading-menu editor-floating-menu" style={{ maxHeight }}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault(); event.stopPropagation();
          const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}>
      {[0, ...HEADING_LEVELS].map((value) => <button type="button" role="menuitemradio" aria-checked={level === value} key={value}
        onMouseDown={(event) => event.preventDefault()} onClick={() => {
          const chain = editor.chain().focus();
          if (value) chain.setHeading({ level: value as HeadingLevel }).run(); else chain.setParagraph().run();
          setOpen(false);
        }}>
        <span className={`heading-choice heading-choice-${value}`}>{value ? `Heading ${value}` : "Body text"}</span>
        {level === value ? <Check size={14}/> : <small>{value ? `H${value}` : "Aa"}</small>}
      </button>)}
    </div>}
  </div>;
}
