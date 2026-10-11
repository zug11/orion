import { useEffect, useRef, type RefObject } from "react";
import type { Note } from "../types";
import { captureEditorSelection, captureVoiceSelection, VOICE_SELECTION_SETTLE_MS, type VoiceSelectionStore } from "../lib/voiceSelection";
import { editorContextIdentity, editorDocumentVersion, type EditorSelectionOptions } from "../lib/editorSelectionContext";

/** Capture only deliberate body selections; controls may collapse the native
 * selection without revoking the previously captured reference. */
export function useVoiceSelection(scope: RefObject<HTMLElement | null>, note: Note, store?: VoiceSelectionStore, spaceId?: string, displayedNote?: () => Note, editorOptions?: EditorSelectionOptions) {
  const latest = useRef({ note, spaceId, displayedNote, editorOptions }); latest.current = { note, spaceId, displayedNote, editorOptions };
  const invalidate = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!store || !spaceId) return;
    const surface = () => scope.current?.querySelector<HTMLElement>('[data-voice-note-body] .tiptap, [data-voice-note-body="reading"]');
    let timer: ReturnType<typeof setTimeout> | undefined, dragging = false, inNote = false;
    const displayed = () => latest.current.displayedNote?.() ?? latest.current.note;
    const available = () => latest.current.editorOptions?.state() ?? { available: true };
    const pending = () => {
      const state = available(), current = displayed();
      if (!state.available) {
        store.clear(current.id);
        store.captureEditor({ ...editorContextIdentity(current, latest.current.spaceId!), state: "unavailable", reason: state.reason ?? "not-ready" });
        return false;
      }
      store.captureEditor({ ...editorContextIdentity(current, latest.current.spaceId!), state: "pending" });
      return true;
    };
    invalidate.current = () => {
      clearTimeout(timer); dragging = inNote = false; store.clear(latest.current.note.id);
      store.captureEditor({ ...editorContextIdentity(displayed(), latest.current.spaceId!), state: "none" });
    };
    const capture = () => {
      clearTimeout(timer);
      const root = surface(), selected = window.getSelection();
      if (!root || !inNote || !pending()) return;
      if (!selected?.rangeCount || selected.isCollapsed) store.clear(latest.current.note.id);
      if (dragging) return;
      timer = setTimeout(() => {
        const current = surface();
        if (current && !dragging && inNote) {
          const selected = window.getSelection(), note = displayed(), state = available();
          const editor = captureEditorSelection(current, selected, note, latest.current.spaceId!, state);
          store.captureEditor(editor);
          const settled = state.available ? captureVoiceSelection(current, selected, note, latest.current.spaceId!) : undefined;
          if (settled) store.capture(settled); else store.clear(note.id);
        }
      }, VOICE_SELECTION_SETTLE_MS);
    };
    const leaveNote = () => {
      clearTimeout(timer);
      // Controls preserve a settled reference, but an abandoned in-progress
      // drag must not leave the external reader pending indefinitely.
      if (store.getEditorSnapshot().state === "pending") {
        store.clear(latest.current.note.id);
        store.captureEditor({ ...editorContextIdentity(displayed(), latest.current.spaceId!), state: "none" });
      }
    };
    const down = (event: Event) => {
      inNote = Boolean(surface()?.contains(event.target as Node));
      dragging = inNote; clearTimeout(timer);
      if (inNote) pending(); else leaveNote();
    };
    const up = () => { dragging = false; capture(); };
    const key = (event: KeyboardEvent) => {
      inNote = Boolean(surface()?.contains(event.target as Node));
      if (inNote) capture(); else leaveNote();
    };
    document.addEventListener("selectionchange", capture);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", up, true);
    document.addEventListener("pointercancel", up, true);
    document.addEventListener("keydown", key, true);
    return () => {
      clearTimeout(timer); invalidate.current = undefined; store.clear(note.id); store.clearEditor(note.id);
      document.removeEventListener("selectionchange", capture);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", up, true);
      document.removeEventListener("pointercancel", up, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [store, note.id, spaceId, scope]);
  useEffect(() => {
    // An authored change invalidates the captured version. Future requests need
    // a fresh selection; already captured VoiceTurns retain their own value.
    invalidate.current?.();
  }, [note.body, note.updatedAt, store]);
  useEffect(() => {
    if (!store || !spaceId) return;
    const current = displayedNote?.() ?? note, state = editorOptions?.state() ?? { available: true };
    const previous = store.getEditorSnapshot();
    if (!state.available) {
      invalidate.current?.();
      store.captureEditor({ ...editorContextIdentity(current, spaceId), state: "unavailable", reason: state.reason ?? "not-ready" });
    } else if (previous.noteId === note.id && (previous.documentVersion !== editorDocumentVersion(current) || previous.state === "unavailable")) {
      invalidate.current?.();
    }
  });
}
