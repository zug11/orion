import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import type { Note } from "../../types";
import type { EditorActionCapture, EditorActionHost, EditorActionSpec, EditorActionState } from "./editorActionHost";

export interface EditorActionSurface {
  spaceId: string; noteId: string; editor: EditorActionHost; ready: boolean;
  /** Last successfully persisted local baseline, never inferred from a native delivery. */
  baseNote: Note;
}
export interface EditorActionDelivery {
  id: string; editorTargetId: string; spaceId: string; noteId: string; action: EditorActionSpec;
  documentVersion: string; selectionVersion: string; baseNoteVersion: string; captureId?: string;
}
export type EditorActionReceiptState = "capture_pending" | "captured" | "submitted" | "generating" | "awaiting_review" |
  "accepting" | "accepted_in_editor" | "saved" | "cancelled" | "discarded" | "stale" | "failed" | "save_failed";
export interface EditorActionReceipt {
  id: string; editorTargetId: string; spaceId: string; noteId: string; state: EditorActionReceiptState;
  captureId?: string; documentVersion?: string; error?: string;
}
interface Poll { targetId: string | null; captures: EditorActionDelivery[]; deliveries: EditorActionDelivery[]; receipts: EditorActionReceipt[] }
interface MailboxHost {
  getCurrent: () => EditorActionSurface | null;
  /** Settle ordinary React updates and flush the normal revision-guarded save queue. Never writes a replacement body. */
  flushAccepted: (spaceId: string, noteId: string, expectedBody: string) => Promise<void>;
  onError: (message: string, accepted: boolean) => void;
}
type Transport = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
type Phase = "capturing" | "captured" | "claiming" | "generating" | "review" | "accepting" | "saving" | "stopped";
interface LocalAction { delivery: EditorActionDelivery; editor: EditorActionHost; capture: EditorActionCapture; nativeCaptureId?: string; phase: Phase }
const terminal = new Set<EditorActionReceiptState>(["saved", "cancelled", "discarded", "stale", "failed", "save_failed"]);
const errorText = (reason: unknown) => [...(reason instanceof Error ? reason.message : String(reason))].slice(0, 1_000).join("") || "The editor action could not finish.";
const identifier = (value: unknown): value is string => typeof value === "string" && !!value && value === value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

export function validEditorAction(action: EditorActionSpec): boolean {
  if (!action || typeof action !== "object") return false;
  const keys = Object.keys(action).filter(key => key !== "instruction").sort().join(",");
  if (action.instruction !== undefined && (typeof action.instruction !== "string" || [...action.instruction].length > 1_250 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(action.instruction))) return false;
  if (action.kind === "write") return keys === "amount,kind" && ["sentence", "paragraph", "section"].includes(action.amount);
  if (action.kind === "rewrite") return keys === "kind,preset" && ["rewrite", "clarify", "tighten", "simplify", "expand", "enrich"].includes(action.preset);
  return action.kind === "image" && keys === "context,kind,quality" && ["fast", "detailed"].includes(action.quality) && ["selection", "space"].includes(action.context);
}

/** Separate window-local lane. Capture is read-only; only the real editor's Accept
 * control can claim a mutation. Heartbeats never include authored or generated text. */
export function startEditorActionMailbox(host: MailboxHost, transport: Transport = invoke) {
  const sessionId = `action_${nanoid(20)}`;
  const locals = new Map<string, LocalAction>(), seenCaptures = new Set<string>(), seenStarts = new Set<string>();
  let disposed = false, registered = false, targetId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const args = (id: string) => ({ sessionId, id });
  const remember = (set: Set<string>, id: string) => { set.add(id); if (set.size > 128) set.delete(set.values().next().value!); };
  const exactReceipt = (value: EditorActionReceipt, local: LocalAction, state: EditorActionReceiptState) => {
    if (!value || value.id !== local.delivery.id || value.spaceId !== local.delivery.spaceId ||
      value.noteId !== local.delivery.noteId || value.editorTargetId !== local.delivery.editorTargetId || value.state !== state ||
      value.documentVersion !== local.capture.documentVersion || (local.nativeCaptureId && value.captureId !== local.nativeCaptureId)) {
      throw new Error(value?.error ?? "The native editor action did not confirm its exact capture and state.");
    }
  };
  const assertCurrent = (local: LocalAction, requireReady = false) => {
    const surface = host.getCurrent();
    if (disposed || locals.get(local.delivery.id) !== local || local.phase === "stopped" || !surface ||
      surface.spaceId !== local.delivery.spaceId || surface.noteId !== local.delivery.noteId || surface.editor !== local.editor ||
      targetId !== local.delivery.editorTargetId || (requireReady && (!surface.ready || !surface.editor.getState().ready)) ||
      !local.editor.isCaptureCurrent(local.capture.captureId)) {
      throw new Error("The captured passage changed or is no longer open in this window. Capture it again before starting.");
    }
  };
  function cleanup(local: LocalAction) {
    local.phase = "stopped";
    locals.delete(local.delivery.id);
    local.editor.cancel(local.capture.captureId);
    local.editor.release(local.capture.captureId);
  }
  async function fail(local: LocalAction, reason: unknown, notify = false) {
    if (local.phase === "stopped") return;
    const accepted = local.phase === "saving";
    cleanup(local);
    await transport("editor_actions_fail", { ...args(local.delivery.id), error: errorText(reason) }).catch(() => undefined);
    if (notify) host.onError(errorText(reason), accepted);
  }
  function validDelivery(delivery: EditorActionDelivery, surface: EditorActionSurface) {
    return identifier(delivery.id) && delivery.editorTargetId === targetId && delivery.spaceId === surface.spaceId &&
      delivery.noteId === surface.noteId && identifier(delivery.documentVersion) && identifier(delivery.selectionVersion) && validEditorAction(delivery.action);
  }
  async function capture(delivery: EditorActionDelivery) {
    if (seenCaptures.has(delivery.id)) return;
    remember(seenCaptures, delivery.id);
    let local: LocalAction | undefined;
    try {
      const surface = host.getCurrent(), state = surface?.editor.getState();
      if (!surface || !validDelivery(delivery, surface) || !surface.ready || !state?.ready ||
        state.documentVersion !== delivery.documentVersion || state.selectionVersion !== delivery.selectionVersion || locals.size >= 8) {
        throw new Error("The requested editor capture is no longer ready. Refresh the open editor target.");
      }
      const captured = surface.editor.capture(delivery.action);
      local = { delivery, editor: surface.editor, capture: captured, phase: "capturing" };
      locals.set(delivery.id, local);
      if (captured.noteId !== surface.noteId || captured.documentVersion !== delivery.documentVersion || captured.selectionVersion !== delivery.selectionVersion) {
        throw new Error("The editor selection changed during capture.");
      }
      assertCurrent(local, true);
      const receipt = await transport<EditorActionReceipt>("editor_actions_capture", { ...args(delivery.id), targetId, capture: {
        documentVersion: captured.documentVersion, selectionVersion: captured.selectionVersion,
        selection: { coordinateSystem: "prosemirror", from: captured.selection.from, to: captured.selection.to },
        effectiveTarget: { coordinateSystem: "prosemirror", from: captured.effectiveTarget.from, to: captured.effectiveTarget.to },
        baseNote: surface.baseNote, capturedBody: captured.markdown,
      } });
      assertCurrent(local, true); exactReceipt(receipt, local, "captured");
      if (!identifier(receipt.captureId)) throw new Error("The native host did not issue an editor capture.");
      local.nativeCaptureId = receipt.captureId; local.phase = "captured";
    } catch (error) {
      if (local) await fail(local, error);
      else await transport("editor_actions_fail", { ...args(delivery.id), error: errorText(error) }).catch(() => undefined);
    }
  }
  async function stateChanged(local: LocalAction, state: EditorActionState) {
    if (locals.get(local.delivery.id) !== local || local.phase === "stopped" || state.captureId !== local.capture.captureId) return;
    if (state.phase === "discarded") {
      try {
        const receipt = await transport<EditorActionReceipt>("editor_actions_decide", { ...args(local.delivery.id), accept: false });
        exactReceipt(receipt, local, "discarded"); cleanup(local);
      } catch (error) { await fail(local, error, true); }
    } else if (["error", "stale", "cancelled"].includes(state.phase)) {
      await fail(local, state.error ?? "The editor action stopped before acceptance.");
    }
  }
  async function start(delivery: EditorActionDelivery) {
    if (seenStarts.has(delivery.id)) return;
    remember(seenStarts, delivery.id);
    const local = locals.get(delivery.id);
    if (!local) {
      await transport("editor_actions_fail", { ...args(delivery.id), error: "This window no longer holds the captured rich passage. Capture it again." }).catch(() => undefined); return;
    }
    try {
      if (local.phase !== "captured" || delivery.captureId !== local.nativeCaptureId || delivery.editorTargetId !== local.delivery.editorTargetId ||
        delivery.spaceId !== local.delivery.spaceId || delivery.noteId !== local.delivery.noteId ||
        delivery.documentVersion !== local.capture.documentVersion || delivery.selectionVersion !== local.capture.selectionVersion ||
        JSON.stringify(delivery.action) !== JSON.stringify(local.delivery.action)) throw new Error("The submitted action changed its captured scope.");
      assertCurrent(local, true); local.phase = "claiming";
      const receipt = await transport<EditorActionReceipt>("editor_actions_claim", args(delivery.id));
      assertCurrent(local, true); exactReceipt(receipt, local, "generating"); local.phase = "generating";
      const grant = { actionId: delivery.id, sessionId };
      local.editor.start(local.capture.captureId, {
        grant,
        beforeReview: async () => {
          assertCurrent(local);
          const authorization = await transport<{ ok: boolean }>("editor_actions_authorize", { grant, stage: "publish" });
          assertCurrent(local);
          if (!authorization?.ok) throw new Error("External generation is no longer authorized.");
          const review = await transport<EditorActionReceipt>("editor_actions_review", args(delivery.id));
          assertCurrent(local); exactReceipt(review, local, "awaiting_review"); local.phase = "review";
        },
        beforeAccept: async () => {
          assertCurrent(local);
          if (local.phase !== "review") throw new Error("This generated result is not ready to accept.");
          local.phase = "accepting";
          const decision = await transport<EditorActionReceipt>("editor_actions_decide", { ...args(delivery.id), accept: true });
          assertCurrent(local); exactReceipt(decision, local, "accepting");
        },
        afterAccept: async body => {
          if (local.phase !== "accepting") throw new Error("The editor action has no acceptance claim.");
          local.phase = "saving";
          try {
            const accepted = await transport<EditorActionReceipt>("editor_actions_accepted", { ...args(delivery.id), body });
            exactReceipt(accepted, local, "accepted_in_editor");
            await host.flushAccepted(delivery.spaceId, delivery.noteId, body);
            const saved = await transport<EditorActionReceipt>("editor_actions_saved", args(delivery.id));
            exactReceipt(saved, local, "saved"); cleanup(local);
          } catch (error) { await fail(local, error, true); }
        },
        onState: state => { void stateChanged(local, state); },
      });
    } catch (error) { await fail(local, error); }
  }
  async function poll() {
    if (disposed) return;
    try {
      const before = host.getCurrent(), state = before?.editor.getState();
      if (!before && !locals.size && !registered) return;
      registered = Boolean(before);
      const response = await transport<Poll>("editor_actions_poll", { sessionId, target: before && state ? {
        spaceId: before.spaceId, noteId: before.noteId, ready: before.ready && state.ready,
        documentVersion: state.documentVersion, selectionVersion: state.selectionVersion,
      } : null });
      if (disposed) { void transport("editor_actions_poll", { sessionId, target: null }).catch(() => undefined); return; }
      if (!response || !Array.isArray(response.captures) || !Array.isArray(response.deliveries) || !Array.isArray(response.receipts)) throw new Error("The editor action mailbox is unavailable.");
      targetId = response.targetId;
      for (const receipt of response.receipts) {
        const local = locals.get(receipt.id);
        if (local && local.phase !== "saving" && terminal.has(receipt.state)) cleanup(local);
      }
      for (const local of locals.values()) if (local.phase !== "saving") {
        try { assertCurrent(local, local.phase === "captured" || local.phase === "capturing"); }
        catch (error) { await fail(local, error); }
      }
      for (const delivery of response.captures.slice(0, 8)) await capture(delivery);
      for (const delivery of response.deliveries.slice(0, 8)) await start(delivery);
    } catch (error) {
      // A lost mailbox cannot leave paid external work or a stale preview active.
      for (const local of [...locals.values()]) if (local.phase !== "saving") await fail(local, error);
    } finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 1_000); }
  }
  void poll();
  return {
    busy: () => [...locals.values()].some(local => !["capturing", "captured", "stopped"].includes(local.phase)),
    dispose() {
      disposed = true; if (timer) clearTimeout(timer);
      for (const local of [...locals.values()]) if (local.phase !== "saving") void fail(local, "The editor window closed.");
      if (registered) void transport("editor_actions_poll", { sessionId, target: null }).catch(() => undefined);
    },
  };
}
export type EditorActionMailbox = ReturnType<typeof startEditorActionMailbox>;
