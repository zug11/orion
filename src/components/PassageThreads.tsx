import { commentTextMap, resolveCommentCursor } from "../lib/commentCursor";
import { ChatReply } from "./ChatReply";
import { splitSavedChatPassages } from "../lib/chatCitations";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Note, Source, PassageThread } from "../types";
import { locatePassage, passageCommentText, passageComments, passageIsCurrent, type PassageThreadAction, type PassageThreadHandler } from "../lib/passageThreads";
import { ArrowUp, Bot, Maximize2, MessageCircle, Trash2 } from "../lib/icons";
import { PassageThreadModal } from "./PassageThreadModal";
import "./ChatDock.css";
import "./PassageThreads.css";

const key = new PluginKey("orion-passage-threads");
const EMPTY: PassageThread[] = [];
interface ThreadReferences { notes: readonly Note[]; sources: readonly Source[]; onOpenNote: (id: string) => void; onOpenSource?: (id: string) => void }
const EMPTY_REFERENCES: ThreadReferences = { notes: [], sources: [], onOpenNote: () => {} };
function ThreadReply({ message, references }: { message: PassageThread["messages"][number]; references: ThreadReferences }) {
  const saved = useMemo(() => splitSavedChatPassages(message.content), [message.content]);
  return <ChatReply snapshot={references} message={{ ...message, content: saved.body.replace(/#orion-passage-(e\d+)/g, "#orion-evidence-$1"), evidence: saved.evidence, cardIds: [], contextCardIds: [] }} onOpenNote={references.onOpenNote} onOpenSource={references.onOpenSource} />;
}
function makeHost(id: string) {
  const host = document.createElement("span");
  host.dataset.passageThread = id; host.contentEditable = "false";
  host.className = "passage-thread-host";
  return host;
}
/** Find rendered text in the document model; comments are decorations, never model nodes. */
export function passageEnd(doc: PMNode, text: string): number | undefined {
  let flat = ""; const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && flat) { flat += "\n"; positions.push(pos); }
    if (node.isText) for (let i = 0; i < node.text!.length; i++) { flat += node.text![i]; positions.push(pos + i); }
  });
  const range = locatePassage(flat, text);
  if (!range) return;
  const end = doc.resolve(positions[range.to - 1] + 1);
  for (let depth = end.depth; depth > 0; depth--) if (end.node(depth).isTextblock) return end.after(depth);
}

export function PassageThreads({ note, root, editor, onAction, references = EMPTY_REFERENCES, reviewActive = false, openThreadId, draftThread, onDraftMarker }: {
  note: Note; root: RefObject<HTMLElement | null>; editor: Editor | null; onAction: PassageThreadHandler; references?: ThreadReferences; reviewActive?: boolean; openThreadId?: string; draftThread?: PassageThread; onDraftMarker?: (marker: HTMLButtonElement | null) => void;
}) {
  const threads = useMemo(() => draftThread && !note.discussionThreads?.some(thread => thread.id === draftThread.id) ? [...note.discussionThreads ?? EMPTY, draftThread] : note.discussionThreads ?? EMPTY, [note.discussionThreads, draftThread]);
  const latest = useRef({ note, threads }); latest.current = { note, threads };
  const hosts = useRef(new Map<string, HTMLSpanElement>());
  const [attached, setAttached] = useState(new Set<string>());
  const refresh = () => {
    const next = new Set([...hosts.current].filter(([, host]) => host.isConnected).map(([id]) => id));
    setAttached(old => old.size === next.size && [...old].every(id => next.has(id)) ? old : next);
  };
  const hostFor = (id: string) => { let host = hosts.current.get(id); if (!host) { host = makeHost(id); hosts.current.set(id, host); } return host; };
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const decorations = (doc: PMNode) => DecorationSet.create(doc, latest.current.threads.flatMap(thread => {
      if (!thread.anchor.cursor && !passageIsCurrent(latest.current.note, thread.anchor)) return [];
      const mapped = thread.anchor.cursor ? commentTextMap(doc) : undefined;
      const offset = mapped && resolveCommentCursor(mapped.text, thread.anchor.cursor!);
      const position = mapped ? offset === undefined ? undefined : mapped.positions[offset] : thread.anchor.scope === "note" ? doc.content.size : passageEnd(doc, thread.anchor.text);
      hostFor(thread.id).classList.toggle("passage-thread-host--inline", !!thread.anchor.cursor);
      return position === undefined ? [] : [Decoration.widget(position, hostFor(thread.id), {
        key: thread.id, side: 1, ignoreSelection: true, stopEvent: () => true,
      })];
    }));
    let disposed = false;
    editor.registerPlugin(new Plugin({ key,
      state: { init: (_, state) => decorations(state.doc), apply: (tr, old) => tr.docChanged || tr.getMeta(key) ? decorations(tr.doc) : old },
      props: { decorations: state => key.getState(state), handleDOMEvents: { keydown: (view, event) => {
        if (!["Backspace", "Delete"].includes(event.key) || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.isComposing || !view.state.selection.empty) return false;
        const { $from, from } = view.state.selection;
        if (!$from.depth) return false;
        const candidates = key.getState(view.state) as DecorationSet;
        const adjacent = candidates.find().find(widget => widget.from === from ||
          (event.key === "Backspace" && $from.parentOffset === 0 && widget.from === $from.before()) ||
          (event.key === "Delete" && $from.parentOffset === $from.parent.content.size && widget.from === $from.after()));
        const button = adjacent && hosts.current.get(adjacent.spec.key)?.querySelector<HTMLButtonElement>(".passage-thread__icon");
        if (!button) return false;
        event.preventDefault(); button.focus({ preventScroll: true }); return true;
      } } },
      view: () => ({ update: () => queueMicrotask(() => { if (!disposed) refresh(); }) }),
    }));
    refresh();
    return () => { disposed = true; if (!editor.isDestroyed) editor.unregisterPlugin(key); };
    // Hosts and callbacks intentionally use the mounted instance and latest note.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, note.id]);
  useEffect(() => {
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(key, true).setMeta("addToHistory", false)); return;
    }
    const body = root.current?.querySelector<HTMLElement>('[data-voice-note-body="reading"]');
    if (!body) { refresh(); return; }
    for (const thread of threads) if (thread.anchor.cursor) hosts.current.get(thread.id)?.remove();
    let flat = "";
    const segments: { node: Node; start: number; end: number }[] = [];
    const blocks = [...body.querySelectorAll("p,li,h1,h2,h3,h4,h5,h6,pre,td,th")].filter(block => !block.closest("[data-passage-thread]") && !block.querySelector("p,li,pre,td,th"));
    for (const [index, block] of blocks.entries()) {
      if (index) flat += "\n";
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest("[data-passage-thread]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
      let node: Node | null; let found = false;
      while ((node = walker.nextNode())) { found = true; const start = flat.length; flat += node.textContent ?? ""; segments.push({ node, start, end: flat.length }); }
      if (!found) segments.push({ node: block, start: flat.length, end: flat.length });
    }
    const placed = new Set<string>();
    const lastHost = new Map<Element, Element>();
    // Insert from the end so splitting a text node cannot invalidate earlier offsets.
    const ordered = [...threads].sort((a, b) =>
      (b.anchor.cursor ? resolveCommentCursor(flat, b.anchor.cursor) ?? -1 : -1) -
      (a.anchor.cursor ? resolveCommentCursor(flat, a.anchor.cursor) ?? -1 : -1));
    for (const thread of ordered) {
      if (!thread.anchor.cursor && !passageIsCurrent(note, thread.anchor)) continue;
      const host = hostFor(thread.id);
      host.classList.toggle("passage-thread-host--inline", !!thread.anchor.cursor);
      if (thread.anchor.cursor) {
        const offset = resolveCommentCursor(flat, thread.anchor.cursor);
        const segment = offset === undefined ? undefined : segments.find(item => item.start <= offset && item.end >= offset);
        if (segment) {
          if (!host.isConnected) {
            const range = document.createRange();
            range.setStart(segment.node, segment.node.nodeType === Node.TEXT_NODE ? offset! - segment.start : 0);
            range.collapse(true); range.insertNode(host);
          }
          placed.add(thread.id);
        } else if (offset === 0 && segments.length === 0) {
          body.prepend(host); placed.add(thread.id);
        }
        continue;
      }
      if (thread.anchor.scope === "note") {
        body.append(hostFor(thread.id)); placed.add(thread.id); continue;
      }
      const range = locatePassage(flat, thread.anchor.text);
      const end = range && segments.find(item => item.end >= range.to && item.start < range.to);
      const block = end?.node.parentElement?.closest("p,li,h1,h2,h3,h4,h5,h6,pre,table,blockquote");
      if (block && body.contains(block)) {
        const host = hostFor(thread.id), previous = lastHost.get(block) ?? block;
        if (previous.nextElementSibling !== host) previous.after(host);
        lastHost.set(block, host); placed.add(thread.id);
      }
    }
    for (const [id, host] of hosts.current) if (!placed.has(id)) host.remove();
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, note.id, note.body, threads, root]);
  useEffect(() => () => { for (const host of hosts.current.values()) host.remove(); hosts.current.clear(); }, []);
  const act = async (threadId: string, action: PassageThreadAction) => {
    await onAction(note.id, threadId, action);
    if (action.kind === "delete" && editor && !editor.isDestroyed) editor.view.focus();
  };
  return <>
    {threads.map(thread => attached.has(thread.id) && hosts.current.get(thread.id)
      ? createPortal(thread.id === draftThread?.id ? <span className="passage-thread" contentEditable={false}><button ref={onDraftMarker} type="button" className="passage-thread__icon" aria-label="Comment position" aria-expanded="true"><MessageCircle size={15} /></button></span> : <ThreadPanel autoOpen={thread.id === openThreadId} reviewActive={reviewActive} references={references} key={thread.id} thread={thread} current={passageIsCurrent(note, thread.anchor)} onAction={action => act(thread.id, action)} />, hosts.current.get(thread.id)!, thread.id)
      : <div key={thread.id} className="passage-thread-detached"><ThreadPanel autoOpen={thread.id === openThreadId} reviewActive={reviewActive} references={references} thread={thread} current={thread.anchor.scope === "note" && !thread.anchor.cursor} onAction={action => act(thread.id, action)} /></div>)}
  </>;
}

export interface PassageChatContext {
  key: string;
  note: Note;
  thread: PassageThread;
  draft: string;
  onAction: (action: PassageThreadAction) => Promise<void>;
  onReturn: () => void;
  onLeave: () => void;
}

/** A single conversation body is used beside the passage and in main Chat. */
export function PassageThreadConversation({ thread, current, onAction, references = EMPTY_REFERENCES,
  active = true, initialDraft = "", onDraftChange, onBusyChange, onReview, between, intro,
}: { thread: PassageThread; current: boolean; onAction: (action: PassageThreadAction) => Promise<void>;
  references?: ThreadReferences; active?: boolean; initialDraft?: string;
  onDraftChange?: (draft: string) => void; onBusyChange?: (busy: boolean) => void;
  onReview?: () => void; between?: ReactNode; intro?: ReactNode;
}) {
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editingComment, setEditingComment] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  const messages = useRef<HTMLDivElement>(null), composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (active && messages.current) messages.current.scrollTop = messages.current.scrollHeight;
  }, [active, thread.messages.length]);
  useLayoutEffect(() => {
    if (!active || !composer.current) return;
    composer.current.style.height = "auto";
    composer.current.style.height = `${Math.min(96, Math.max(30, composer.current.scrollHeight))}px`;
  }, [active, draft, thread.state]);
  function changeDraft(value: string) { setDraft(value); onDraftChange?.(value); }
  async function run(action: PassageThreadAction) {
    if (busy) return;
    setBusy(true); onBusyChange?.(true); setError(""); setNotice("");
    try {
      await onAction(action);
      if (action.kind === "reply") changeDraft("");
      if (action.kind === "edit-comment") setEditingComment(undefined);
      if (action.kind === "create" && !thread.messages.find(message => message.id === action.messageId)?.createdNoteId) setNotice("Article added to the generation queue.");
      if (action.kind === "addition" || action.kind === "rewrite") onReview?.();
    }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); onBusyChange?.(false); }
  }
  function signal() { controller.current?.abort(); controller.current = new AbortController(); return controller.current.signal; }
  return <>
      <div ref={messages} className="chat-view__thread passage-thread__messages" role="log" aria-label="Discussion messages">
      {intro}
      {thread.anchor.scope === "note" && <div className="passage-thread__notice passage-thread__actions"><button type="button" disabled={busy} onClick={() => void run({ kind: "reattach" })}>Attach to highlighted passage</button></div>}
      {!current && <div className="passage-thread__warning"><p>The original passage is unavailable. Highlight its current location to reattach.</p><blockquote>{thread.anchor.text.slice(0, 300)}</blockquote><button type="button" disabled={busy} onClick={() => void run({ kind: "reattach" })}>Attach to highlighted passage</button></div>}
      {thread.messages.flatMap((message, index) => {
        if (message.role !== "assistant" && index !== 0) return [];
        const human = message.role === "user";
        const response = !message.pending && thread.messages[index - 1]?.role === "user";
        return [<article key={message.id} className={response ? "chat-message chat-message--assistant" : "passage-thread__comment"} aria-label={human ? "Your comment" : response ? "Orion reply" : "Orion comment"}>
        {human && <div className="passage-thread__author">You</div>}
        {response && <div className="chat-message__identity"><span className="chat-message__avatar" aria-hidden="true"><Bot size={12} /></span><span>Orion</span></div>}
        {human && editingComment !== undefined ? <div className="passage-thread__edit">
          <textarea autoFocus aria-label="Edit your comment" maxLength={12000} value={editingComment} readOnly={busy} onChange={event => setEditingComment(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void run({ kind: "edit-comment", text: editingComment }); }
          }} />
          <div className="passage-thread__actions"><button disabled={busy || !editingComment.trim()} onClick={() => void run({ kind: "edit-comment", text: editingComment })}>Save comment</button><button disabled={busy} onClick={() => setEditingComment(undefined)}>Cancel</button></div>
        </div> : <><ThreadReply message={message} references={references} />{human && <button type="button" className="passage-thread__resolve" disabled={busy} onClick={() => setEditingComment(message.content)}>Edit comment</button>}</>}

        {message.proposal && <details><summary>Proposed {message.proposal.kind}</summary><p>{message.proposal.text}</p></details>}
        {thread.state === "open" && current && <div className="chat-message__note-actions passage-thread__actions">
          <button type="button" disabled={busy || thread.anchor.scope === "note"} title={thread.anchor.scope === "note" ? "Attach to a passage first" : undefined} onClick={() => void run({ kind: "addition", messageId: message.id, signal: signal() })}>Add to Note</button>
          <button type="button" disabled={busy} onClick={() => void run({ kind: "create", messageId: message.id })}>{message.createdNoteId ? "Open article" : "Generate article"}</button>
          <button type="button" disabled={busy || thread.anchor.scope === "note"} title={thread.anchor.scope === "note" ? "Attach to a passage first" : undefined} onClick={() => void run({ kind: "rewrite", messageId: message.id, signal: signal() })}>Suggest Rewrite</button>
        </div>}
      </article>]; })}
      {thread.state === "proposed" ? <div className="passage-thread__actions"><button type="button" disabled={busy} onClick={() => void run({ kind: "accept" })}>Accept comment</button><button type="button" disabled={busy} onClick={() => void run({ kind: "discard" })}>Discard</button></div> : <>
        <button type="button" className="passage-thread__resolve" disabled={busy} onClick={() => void run({ kind: "resolve" })}>{thread.state === "resolved" ? "Reopen discussion" : "Resolve discussion"}</button>
      </>}
      <button type="button" className="passage-thread__delete" aria-label="Delete comment" title="Delete comment and discussion" disabled={busy} onClick={() => void run({ kind: "delete" })}><Trash2 size={13} /></button>
      {busy && <div className="chat-message--thinking" role="status"><span>Working…</span><span className="chat-thinking-dots" aria-hidden="true"><i /><i /><i /></span></div>}
      </div>
      {between}
      <form className="chat-composer passage-thread__composer" onSubmit={event => {
        event.preventDefault();
        if (!busy && draft.trim()) {
          event.currentTarget.querySelector("textarea")?.focus({ preventScroll: true });
          void run({ kind: "reply", text: draft, signal: signal() });
        }
      }}>
        {error && <p className="chat-composer__error" role="alert">{error}</p>}
        {notice && <p className="passage-thread__notice" role="status">{notice}</p>}
        {thread.state === "open" && current && <div className="chat-composer__field passage-thread__input">
          <textarea ref={composer} aria-label="Discuss this passage" placeholder={thread.anchor.scope === "note" ? "Discuss this note…" : thread.messages[0]?.role === "user" ? "Ask Orion about this passage…" : "Reply to comment…"} rows={1} value={draft} maxLength={12000} readOnly={busy} onChange={event => changeDraft(event.target.value)} onKeyDown={event => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
          }} />
          <button type="submit" aria-label={thread.messages[0]?.role === "user" ? "Ask Orion about this passage" : "Send message"} disabled={busy || !draft.trim()}><ArrowUp size={16} /></button>
        </div>}
      </form>
  </>;
}

function ThreadPanel({ thread, current, onAction, references, reviewActive, autoOpen = false }: { reviewActive: boolean; autoOpen?: boolean; references: ThreadReferences; thread: PassageThread; current: boolean; onAction: (action: PassageThreadAction) => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (autoOpen) setOpen(true); }, [autoOpen]);
  useEffect(() => { if (reviewActive) setOpen(false); }, [reviewActive]);
  const comments = passageComments(thread);
  return <span className="passage-thread" data-state={thread.state} aria-label="Passage discussion" contentEditable={false}>
    <button ref={trigger} type="button" className="passage-thread__icon" aria-label={thread.state === "proposed" ? "Review proposed comment" : "Open passage discussion"} aria-haspopup="dialog" aria-expanded={open} onKeyDown={event => {
      if (["Backspace", "Delete"].includes(event.key) && !event.nativeEvent.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation(); if (busy || event.repeat) return;
        setBusy(true); setError("");
        void onAction({ kind: "delete" }).catch(error => { setError(error instanceof Error ? error.message : String(error)); setOpen(true); }).finally(() => setBusy(false));
      }
    }} onClick={() => setOpen(value => !value)}>
      <MessageCircle size={15} /><span className="passage-thread__hover" role="tooltip">{passageCommentText(comments[comments.length - 1]?.content ?? "").slice(0, 220)}</span>
    </button>
    {!current && <span className="passage-thread__detached-label">Passage changed or unavailable</span>}
    {open && trigger.current && <PassageThreadModal anchor={trigger.current} owner={trigger.current}
      title={thread.state === "proposed" ? "Proposed comment" : "Comment"} passage={thread.anchor.scope === "note" ? "About this note" : thread.anchor.text} onClose={() => setOpen(false)}
      actions={<button type="button" aria-label="Continue in Chat" title="Continue in Chat" disabled={busy || thread.state === "proposed" || !current} onClick={() => {
        setError("");
        void onAction({ kind: "open-chat", draft }).then(() => setOpen(false)).catch(error => setError(error instanceof Error ? error.message : String(error)));
      }}><Maximize2 size={14} /></button>}>
      {error && <p className="chat-composer__error" role="alert">{error}</p>}
      <PassageThreadConversation thread={thread} current={current} onAction={onAction} references={references}
        initialDraft={draft} onDraftChange={setDraft} onBusyChange={setBusy} onReview={() => setOpen(false)} />
    </PassageThreadModal>}
  </span>;
}
