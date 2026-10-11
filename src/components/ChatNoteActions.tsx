import { useRef, useState, type PointerEvent } from "react";
import type { AppSnapshot, ChatEditProposal, Note, StudioMessage } from "../types";
import type { ChatNoteReceipt, UseChatReply } from "../lib/chatNoteActions";
import { FileText } from "../lib/icons";
import { ChatEditPreview } from "./ChatEditPreview";
import "./ChatNoteActions.css";

type Action = { status: "working" | "failed" | "ready"; text: string };

/** Reply-local work never submits the composer or appends a Chat exchange. */
export function ChatNoteActions({ snapshot, message, focusNote, busy, onUseReply, onSaveReply, onOpenNote, onReviewEdit }: {
  snapshot: AppSnapshot; message: StudioMessage; focusNote?: Note; busy: boolean;
  onUseReply?: UseChatReply;
  onSaveReply: (messageId: string) => Promise<ChatNoteReceipt>;
  onOpenNote: (noteId: string) => void;
  onReviewEdit?: (proposal: ChatEditProposal) => Promise<boolean>;
}) {
  const [editAction, setEditAction] = useState<Action>();
  const [saveAction, setSaveAction] = useState<Action>();
  const [proposal, setProposal] = useState<ChatEditProposal>();
  const [revision, setRevision] = useState(0);
  const editPending = useRef(false);
  const savePending = useRef(false);
  const editTarget = useRef<string | undefined>(undefined);
  const createdNotes = (message.createdNoteIds ?? []).flatMap(id => snapshot.notes.find(note => note.id === id) ?? []);
  const savedNotes = createdNotes.map(note => ({ noteId: note.id, title: note.title }));

  function preserveComposer(event: PointerEvent<HTMLButtonElement>) {
    // A mouse action beside a reply needn't steal a writing cursor. Keyboard
    // activation retains ordinary focus and tab order.
    if (event.button === 0 && document.activeElement?.matches(".chat-composer textarea")) event.preventDefault();
  }

  async function useReply(retry = false) {
    const target = retry ? editTarget.current : focusNote?.id;
    if (!onUseReply || !onReviewEdit || !target || editPending.current) return;
    editPending.current = true; editTarget.current = target;
    setProposal(undefined);
    setEditAction({ status: "working", text: "Preparing changes…" });
    try {
      const next = await onUseReply(message.id, target, text => setEditAction({ status: "working", text }));
      setProposal(next); setRevision(value => value + 1); setEditAction({ status: "ready", text: "Changes ready to review" });
    } catch (error) { setEditAction({ status: "failed", text: error instanceof Error ? error.message : String(error) }); }
    finally { editPending.current = false; }
  }

  async function saveReply() {
    if (savePending.current) return;
    savePending.current = true;
    setSaveAction({ status: "working", text: "Saving…" });
    try {
      const saved = await onSaveReply(message.id);
      if (!saved?.noteId) throw new Error("The save could not be verified. Retry saving this reply.");
      setSaveAction({ status: "ready", text: "Saved" });
    } catch (error) { setSaveAction({ status: "failed", text: error instanceof Error ? error.message : String(error) }); }
    finally { savePending.current = false; }
  }

  return <div className="chat-note-actions">
    <div className="chat-message__note-actions">
      {focusNote && onReviewEdit && onUseReply && <button type="button" disabled={busy || editAction?.status === "working"}
        onPointerDown={preserveComposer} onClick={() => void useReply()}>Use in note</button>}
      {saveAction?.status !== "working" && saveAction?.status !== "failed" && savedNotes.length ? savedNotes.map(note => (
        <button type="button" key={note.noteId} onClick={() => onOpenNote(note.noteId)} aria-label={`Open note: ${note.title}`}>
          <FileText size={12} /><span>{note.title}</span>
        </button>
      )) : <button type="button" className="chat-message__keep-note" disabled={saveAction?.status === "working"}
        onPointerDown={preserveComposer} onClick={() => void saveReply()}>
        <FileText size={12} />{saveAction?.status === "working" ? "Saving…" : saveAction?.status === "failed" ? "Retry save" : "Keep as note"}
      </button>}
    </div>
    {editAction && editAction.status !== "ready" && <div className="chat-note-actions__status" role={editAction.status === "failed" ? "alert" : "status"}>
      <span>{editAction.text}</span>
      {editAction.status === "failed" && <button type="button" disabled={busy} onPointerDown={preserveComposer} onClick={() => void useReply(true)}>Retry changes</button>}
    </div>}
    {saveAction && (saveAction.status === "failed" || saveAction.status === "ready" && savedNotes.length > 0) && <p className="chat-note-actions__status" role={saveAction.status === "failed" ? "alert" : "status"}>{saveAction.text}</p>}
    {proposal && onReviewEdit && <ChatEditPreview key={revision} proposal={proposal} snapshot={snapshot} busy={busy} onReview={onReviewEdit}
      onDiscard={() => { setProposal(undefined); setEditAction(undefined); }} />}
  </div>;
}
