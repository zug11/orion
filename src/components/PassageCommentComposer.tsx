import type { CommentCursor } from "../lib/commentCursor";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { nanoid } from "nanoid";
import type { Note, PassageThread } from "../types";
import { captureVoiceSelection, type VoiceSelectionStore } from "../lib/voiceSelection";
import { passageAnchorFromSelection, type PassageCommentHandler, type PassageCommentTarget } from "../lib/passageThreads";
import { createEmptySnapshot } from "../data/defaults";
import { spaceNoteVersion } from "../lib/spaceKnowledge";
import { MessageCircle } from "../lib/icons";
import { PassageThreadModal } from "./PassageThreadModal";
import "./PassageThreads.css";

type Anchor = { left: number; bottom: number };
interface Draft { id: string; selection: PassageCommentTarget; anchor: Anchor; thread: PassageThread; text: string; open: boolean }

function selectionRect(root: HTMLElement | null): DOMRect | undefined {
  const selection = window.getSelection();
  if (!root || !selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (root.contains(range.startContainer) && root.contains(range.endContainer)) return range.getBoundingClientRect();
}

function ReadingCommentButton({ root, store, onOpen, fallback }: {
  root: RefObject<HTMLElement | null>; store: VoiceSelectionStore; onOpen: () => void; fallback?: Anchor;
}) {
  const selection = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [position, setPosition] = useState<Anchor>();
  useLayoutEffect(() => {
    if (!selection) { setPosition(undefined); return; }
    const place = () => {
      const rect = selectionRect(root.current) ?? fallback;
      if (rect) setPosition({ left: Math.max(16, Math.min(rect.left, window.innerWidth - 112)), bottom: Math.max(16, Math.min(rect.bottom + 8, window.innerHeight - 48)) });
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [selection, root, fallback]);
  return selection && position ? <button className="passage-comment-selection" type="button" aria-label="Comment on selected text"
    style={{ left: position.left, top: position.bottom }} onMouseDown={event => event.preventDefault()} onClick={onOpen}>
    <MessageCircle size={14} />Comment
  </button> : null;
}

/** The local draft never becomes a Chat prompt. Only Save comment persists it. */
export function usePassageComment({ note, getNote, root, store, editing, available, onCreate }: {
  note: Note; getNote: () => Note; root: RefObject<HTMLElement | null>; store?: VoiceSelectionStore;
  editing: boolean; available: () => boolean; onCreate?: PassageCommentHandler;
}) {
  const [draft, setDraft] = useState<Draft>();
  const [draftMarker, setDraftMarker] = useState<HTMLElement | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const saving = useRef(false), composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { setDraft(undefined); setOpenThreadId(undefined); setError(""); }, [note.id, store]);
  useLayoutEffect(() => {
    if (composer.current) {
      composer.current.style.height = "auto";
      composer.current.style.height = `${Math.min(160, Math.max(66, composer.current.scrollHeight))}px`;
    }
  }, [draft?.text, draft?.open]);
  function openComment(scope?: "note", cursor?: CommentCursor) {
    if (!store || !onCreate || !available()) return;
    const current = getNote();
    const surface = root.current?.querySelector<HTMLElement>('[data-voice-note-body] .tiptap, [data-voice-note-body="reading"]');
    const live = surface && store.spaceId ? captureVoiceSelection(surface, window.getSelection(), current, store.spaceId) : undefined;
    let selected: PassageCommentTarget | undefined = scope === "note" ? { scope: "note", spaceId: store.spaceId!, noteId: current.id, version: spaceNoteVersion(current) } : live ? { ...live, id: `selection-${nanoid(10)}` } : store.getSnapshot();
    if (!selected || selected.noteId !== current.id || selected.spaceId !== store.spaceId) return;
    if (cursor) selected = { ...selected, cursor };
    const selectedRect = selectionRect(root.current);
    const rect = selectedRect ?? root.current?.getBoundingClientRect();
    const anchor = { left: rect?.left ?? 24, bottom: rect?.bottom ?? 80 };
    const snapshot = createEmptySnapshot("", current.updatedAt, selected.spaceId);
    snapshot.notes = [current];
    const passageAnchor = "scope" in selected ? { scope: "note" as const, quote: "", text: "" } : passageAnchorFromSelection(snapshot, selected);
    if (cursor) passageAnchor.cursor = cursor;
    const id = `thread-${nanoid(12)}`;
    const thread: PassageThread = { id, anchor: passageAnchor, state: "open", createdAt: current.updatedAt, updatedAt: current.updatedAt, messages: [] };
    setError("");
    setDraft(previous => previous && previous.selection.version === selected.version && JSON.stringify(previous.selection.cursor) === JSON.stringify(selected.cursor) && ("scope" in previous.selection && "scope" in selected || !("scope" in previous.selection) && !("scope" in selected) && previous.selection.text === selected.text && previous.selection.range.from === selected.range.from)
      ? { ...previous, open: true, anchor: selectedRect ? anchor : previous.anchor } : { id, selection: selected, anchor, thread, text: "", open: true });
  }
  async function save() {
    if (!draft || !onCreate || !draft.text.trim() || saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await onCreate(draft.selection, draft.text, draft.id);
      setDraft(undefined); setOpenThreadId(draft.id);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { saving.current = false; setBusy(false); }
  }
  const close = () => {
    if (saving.current) return;
    setDraft(previous => previous && { ...previous, open: false });
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-label="Comment on selected text"]')?.focus({ preventScroll: true }));
  };
  const draftThread = draft?.open ? draft.thread : undefined;
  return { draftThread, setDraftMarker, openComment: onCreate && store ? openComment : undefined, openThreadId, active: !!draft?.open,
    ui: <>
      {onCreate && store && !editing && !draft?.open && available() && <ReadingCommentButton root={root} store={store} onOpen={openComment} fallback={draft?.anchor} />}
      {draft?.open && draftMarker?.isConnected && <PassageThreadModal anchor={draftMarker} owner={root.current} title="Add comment" passage={"scope" in draft.selection ? "About this note" : draft.selection.text} onClose={close}>
        <form className="chat-composer passage-comment-create" onSubmit={event => { event.preventDefault(); void save(); }}>
          <label className="passage-thread__author" htmlFor={draft.id}>You</label>
          <div className="chat-composer__field passage-thread__input">
            <textarea ref={composer} id={draft.id} aria-label="Your comment" placeholder={"scope" in draft.selection ? "Leave a thought about this note…" : "Leave a thought about this passage…"} rows={3} maxLength={12000} value={draft.text} readOnly={busy}
              onChange={event => setDraft(previous => previous && { ...previous, text: event.target.value })}
              onKeyDown={event => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          </div>
          <p className="passage-thread__notice">Saved as your comment. Orion responds only when you ask.</p>
          {error && <p className="chat-composer__error" role="alert">{error}</p>}
          <div className="passage-thread__actions passage-comment-create__actions">
            <button type="button" disabled={busy} onClick={close}>Cancel</button>
            <button type="submit" disabled={busy || !draft.text.trim()}>{busy ? "Saving…" : "Save comment"}</button>
          </div>
        </form>
      </PassageThreadModal>}
    </> };
}
