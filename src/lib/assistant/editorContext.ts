import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import type { Note } from "../../types";
import { EDITOR_CONTEXT_MAX_CHARS, editorDocumentVersion, editorSelectionReference, type EditorSelectionSnapshot } from "../editorSelectionContext";

/** Local-only data. The full authored note and unfiltered capture never cross IPC. */
export interface EditorContextDocument {
  note: Note;
  snapshot: EditorSelectionSnapshot;
}
export interface EditorContextSurface extends EditorContextDocument { spaceId: string }
export interface EditorContextRequest {
  id: string; targetId: string; spaceId: string; noteId: string;
  taskView: "working" | "history"; maxChars: number;
}
interface EditorContextPoll { targetId?: string; requests: EditorContextRequest[] }
interface EditorContextHost { getCurrent: () => EditorContextSurface | null }
type Transport = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
const ready = (surface: EditorContextSurface) => !["pending", "unavailable"].includes(surface.snapshot.state);
const target = (surface: EditorContextSurface) => ({ spaceId: surface.spaceId, noteId: surface.note.id, ready: ready(surface) });

/** An explicit read mailbox; it owns no provider, save queue, voice or review. */
export function startEditorContextMailbox(host: EditorContextHost, transport: Transport = invoke) {
  const sessionId = `editor_${nanoid(20)}`;
  let disposed = false, registered = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>();
  async function poll() {
    if (disposed) return;
    try {
      const before = host.getCurrent();
      if (!before) {
        if (registered) {
          registered = false;
          await transport("editor_context_poll", { sessionId, target: null });
        }
        return;
      }
      const version = editorDocumentVersion(before.note), captured = before.snapshot;
      registered = true;
      // Heartbeats contain identity/readiness only, including on an authored edit.
      const response = await transport<EditorContextPoll>("editor_context_poll", { sessionId, target: target(before) });
      if (disposed || !response || !Array.isArray(response.requests)) return;
      for (const request of response.requests.slice(0, 8)) {
        if (!request.id || seen.has(request.id)) continue;
        seen.add(request.id);
        if (seen.size > 128) seen.delete(seen.values().next().value!);
        // Every request belongs to the target returned by this exact heartbeat.
        if (!response.targetId || request.targetId !== response.targetId || request.spaceId !== before.spaceId ||
          request.noteId !== before.note.id || !["working", "history"].includes(request.taskView) ||
          !Number.isSafeInteger(request.maxChars) || request.maxChars < 1 || request.maxChars > EDITOR_CONTEXT_MAX_CHARS) continue;
        const current = host.getCurrent();
        const unchanged = current && current.spaceId === before.spaceId && current.note.id === before.note.id &&
          editorDocumentVersion(current.note) === version && current.snapshot === captured;
        const reference = unchanged
          ? editorSelectionReference(current.snapshot, { taskView: request.taskView, maxChars: request.maxChars }, current.note)
          : { documentVersion: version, state: "unavailable" as const, fragments: [], truncated: false,
            omittedChars: 0, completedTasksOmitted: false, completedTaskChars: 0, reason: "stale-document" };
        // Reading is synchronous after the guarded poll: no flush, navigation or
        // promise can change the displayed reference between capture and send.
        void transport("editor_context_respond", { sessionId, id: request.id, targetId: request.targetId, reference }).catch(() => undefined);
      }
    } catch { /* Unavailable native host simply leaves explicit requests unconfirmed. */ }
    finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 1_000); }
  }
  void poll();
  return {
    dispose() {
      disposed = true; if (timer) clearTimeout(timer);
      if (registered) void transport("editor_context_poll", { sessionId, target: null }).catch(() => undefined);
    },
  };
}
