import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "../lib/icons";

/** Shared live-text glass surface for writing a comment and reopening its discussion. */
export function PassageThreadModal({ anchor, owner, title, passage, onClose, actions, children }: {
  anchor: HTMLElement | { left: number; bottom: number }; owner?: HTMLElement | null;
  title: string; passage: string; onClose: () => void; actions?: ReactNode; children: ReactNode;
}) {
  const id = useId(), panel = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 16, top: 16 });
  useLayoutEffect(() => {
    const previous = document.activeElement;
    const place = () => {
      const rect = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor, modal = panel.current;
      if (!modal) return;
      const next = { left: Math.max(16, Math.min(rect.left, window.innerWidth - modal.offsetWidth - 16)),
        top: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 336)) };
      setPosition(old => old.left === next.left && old.top === next.top ? old : next);
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(place);
    if (panel.current) observer?.observe(panel.current);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect(); window.removeEventListener("resize", place);
      const target = anchor instanceof HTMLElement ? anchor : previous;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    };
  }, [anchor]);
  useEffect(() => {
    if (!panel.current?.contains(document.activeElement)) {
      (panel.current?.querySelector<HTMLElement>("textarea:not(:disabled)") ?? panel.current?.querySelector<HTMLElement>("button:not(:disabled)") ?? panel.current)?.focus({ preventScroll: true });
    }
  });
  return createPortal(<div className="chat-dock passage-thread-modal" data-passage-thread="modal"
    onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} className="chat-dock__panel passage-thread__panel" style={{ ...position, maxHeight: `min(500px, calc(100dvh - ${position.top + 16}px))` }} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1}
      onKeyDown={event => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(':is(button,textarea,input,a[href],summary,[tabindex="0"]):not(:disabled)')]
          .filter(element => !element.closest('details:not([open])') || element.tagName === "SUMMARY");
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className="chat-dock__header"><div><strong id={`${id}-title`}>{title}</strong><span title={passage}>{passage.slice(0, 180)}</span></div>
        <nav aria-label="Discussion controls">{actions}<button type="button" aria-label="Close discussion" onClick={onClose}><X size={16} /></button></nav>
      </header>
      <div className="chat-view chat-view--compact"><div className="chat-view__stage">{children}</div></div>
    </div>
  </div>, owner?.closest(".app-shell, [data-theme]") ?? document.body);
}
