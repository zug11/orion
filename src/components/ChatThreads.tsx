import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { Check, PanelRight, PanelRightClose, PenLine, Plus, Trash2, X } from "../lib/icons";
import { MAX_CHAT_THREAD_TITLE_CHARS } from "../lib/chatThreads";
import "./ChatThreads.css";

export interface ChatThreadRow {
  id: string;
  title: string;
  createdAt?: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatThreadNavigation {
  threads: readonly ChatThreadRow[];
  activeThreadId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  disabledReason?: string;
  /** Per-window presentation only; never part of the saved conversation. */
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}

interface Props extends ChatThreadNavigation {
  id: string;
  spaceName: string;
  overlay?: boolean;
  toggleRef?: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormat.format(date) : "";
}
function validTitle(value: string) {
  const title = value.trim();
  return title.length > 0 && Array.from(title).length <= MAX_CHAT_THREAD_TITLE_CHARS && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

/** Only caller-supplied Space threads are displayed. No history retrieval or writes. */
export function ChatThreads({ id, spaceName, threads, activeThreadId, onSelect, onNew, onRename, onDelete,
  disabledReason, overlay = false, expanded = true, onExpandedChange, toggleRef, onClose }: Props) {
  const root = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const controlRef = toggleRef ?? closeButton;
  const newButton = useRef<HTMLButtonElement>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string }>();
  const disabled = Boolean(disabledReason);
  useEffect(() => {
    if (renaming && (!expanded || !threads.some(thread => thread.id === renaming.id))) setRenaming(undefined);
  }, [threads, renaming, expanded]);
  useLayoutEffect(() => {
    if (overlay && expanded) controlRef.current?.focus({ preventScroll: true });
  }, [overlay, expanded, controlRef]);

  function restoreRow(threadId?: string) {
    requestAnimationFrame(() => {
      const rows = root.current?.querySelectorAll<HTMLButtonElement>("[data-thread-select]");
      const target = [...(rows ?? [])].find(button => button.dataset.threadSelect === threadId);
      (target ?? newButton.current)?.focus({ preventScroll: true });
    });
  }
  function finishRename() {
    if (!renaming || disabled || !validTitle(renaming.title)) return;
    onRename(renaming.id, renaming.title.trim());
    restoreRow(renaming.id);
    setRenaming(undefined);
  }
  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (!expanded) return;
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault(); event.stopPropagation();
      if (renaming) { restoreRow(renaming.id); setRenaming(undefined); }
      else onClose();
    }
    if (event.key !== "Tab" || !overlay) return;
    const controls = [...(root.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),[tabindex='0']") ?? [])];
    if (!controls.length) return;
    const first = controls[0], last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <aside id={id} ref={root} className="chat-threads" data-expanded={expanded}
    role={expanded ? overlay ? "dialog" : "complementary" : "presentation"}
    aria-modal={expanded && overlay || undefined} aria-label={expanded ? `Chats in ${spaceName}` : undefined} onKeyDown={handleKey}>
    <button ref={controlRef} type="button" className="chat-view__threads-toggle"
      aria-label={expanded ? "Hide chat threads" : "Show chat threads"} title={expanded ? "Hide chat threads" : "Show chat threads"}
      aria-expanded={expanded} aria-controls={id} onClick={() => expanded ? onClose() : onExpandedChange?.(true)}>
      {expanded ? <PanelRightClose size={18}/> : <PanelRight size={18}/>}
    </button>
    {expanded && <>
    <header className="chat-threads__header">
      <div><h2>Chats</h2><p title={spaceName}>{spaceName}</p></div>
    </header>
    <button ref={newButton} type="button" className="chat-threads__new" disabled={disabled} title={disabledReason} onClick={onNew}><Plus size={15}/>New chat</button>
    <nav className="chat-threads__list" aria-label="Space chat threads">
      {threads.length === 0 ? <p className="chat-threads__empty">Your chats in this Space will appear here.</p> : <ul>
        {threads.map(thread => <li key={thread.id} className={`chat-threads__row${thread.id === activeThreadId ? " is-active" : ""}`}>
          {renaming?.id === thread.id ? <form className="chat-threads__rename" onSubmit={event => { event.preventDefault(); finishRename(); }}>
            <input autoFocus aria-label={`Rename ${thread.title}`} value={renaming.title} disabled={disabled}
              aria-invalid={!validTitle(renaming.title) || undefined} onChange={event => setRenaming({ id: thread.id, title: event.target.value })}/>
            <div><button type="submit" className="chat-threads__icon" disabled={disabled || !validTitle(renaming.title)} aria-label="Save chat name"><Check size={14}/></button>
              <button type="button" className="chat-threads__icon" aria-label="Cancel rename" onClick={() => { restoreRow(thread.id); setRenaming(undefined); }}><X size={14}/></button></div>
            {!validTitle(renaming.title) && <p role="alert">Use 1–{MAX_CHAT_THREAD_TITLE_CHARS} characters.</p>}
          </form> : <>
            <button type="button" className="chat-threads__select" data-thread-select={thread.id}
              aria-current={thread.id === activeThreadId ? "page" : undefined} disabled={disabled}
              title={disabledReason ?? thread.title} onClick={() => onSelect(thread.id)}>
              <span>{thread.title}</span>
              <small>{dateLabel(thread.updatedAt) || "New chat"}</small>
            </button>
            <div className="chat-threads__row-actions">
              <button type="button" className="chat-threads__icon" aria-label={`Rename ${thread.title}`} title="Rename chat" disabled={disabled}
                onClick={() => setRenaming({ id: thread.id, title: thread.title })}><PenLine size={13}/></button>
              <button type="button" className="chat-threads__icon" aria-label={`Delete ${thread.title}`} title="Delete chat" disabled={disabled}
                onClick={() => {
                  if (!window.confirm(`Delete “${thread.title}” and its messages? This cannot be undone.`)) return;
                  const index = threads.findIndex(candidate => candidate.id === thread.id);
                  const next = threads[index + 1] ?? threads[index - 1];
                  onDelete(thread.id); restoreRow(next?.id);
                }}><Trash2 size={13}/></button>
            </div>
          </>}
        </li>)}
      </ul>}
    </nav>
    {disabledReason && <p className="chat-threads__disabled" role="status">{disabledReason}</p>}
    </>}
  </aside>;
}
