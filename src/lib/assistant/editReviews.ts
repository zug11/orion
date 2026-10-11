import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import type { AppSnapshot, ChatEditProposal } from "../../types";
import { validateChatEditTarget, type ChatEditApplication } from "../chatEdits";
import { workingTaskText } from "../taskWorkingView";

export interface EditReviewTarget { spaceId: string; noteId: string; ready: boolean }
export interface ExternalEditDelivery {
  id: string; spaceId: string; noteId: string; expectedVersion: string; title: string; baseBody: string;
  taskView?: "working" | "history";
  edit: { kind: "focused"; edits: { before: string; after: string }[] } | { kind: "rewrite"; body: string };
}
export type EditReviewState = "submitted" | "awaiting_review" | "accepting" | "accepted_in_editor" | "saved" |
  "discarded" | "cancelled" | "stale" | "failed" | "save_failed";
export interface EditReviewReceipt {
  id: string; spaceId: string; noteId: string; reviewTargetId: string; state: EditReviewState;
  createdAt: number; updatedAt: number; error?: string; result?: Record<string, unknown>;
}
interface ReviewPoll { targetId?: string; deliveries: ExternalEditDelivery[]; receipts: EditReviewReceipt[] }
interface EditReviewHost {
  getTarget: () => EditReviewTarget | null;
  getSpace: (id: string) => AppSnapshot | undefined;
  /** Uses the same serialized, revision-guarded save queue as ordinary typing. */
  flush: () => Promise<void>;
  present: (application: ChatEditApplication) => void;
  close: (id: string) => void;
  /** Called only after the real editor transaction and its React updates settle. */
  getAcceptedBody: (delivery: ExternalEditDelivery) => string;
  onError: (message: string, accepted: boolean) => void;
}
type Transport = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
interface ActiveReview {
  delivery: ExternalEditDelivery; proposal: ChatEditProposal;
  phase: "staging" | "review" | "claiming" | "claimed" | "saving";
}
const stopped = new Set<EditReviewState>(["discarded", "cancelled", "stale", "failed"]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function externalEditProposal(delivery: ExternalEditDelivery, snapshot: AppSnapshot): ChatEditProposal {
  if (!delivery.id || !delivery.expectedVersion || !delivery.edit || !["focused", "rewrite"].includes(delivery.edit.kind)) {
    throw new Error("The external edit request is invalid.");
  }
  if (delivery.edit.kind === "rewrite" && delivery.taskView !== "history" && workingTaskText(delivery.baseBody) !== delivery.baseBody) {
    throw new Error("A whole-note rewrite needs explicit task history access when completed tasks are hidden.");
  }
  const proposal: ChatEditProposal = {
    spaceId: delivery.spaceId, noteId: delivery.noteId, title: delivery.title, baseBody: delivery.baseBody,
    ...(delivery.edit.kind === "rewrite"
      ? { mode: "rewrite" as const, rewrite: delivery.edit.body, edits: [] }
      : { mode: "focused" as const, edits: delivery.edit.edits }),
  };
  if (!proposal.edits.length && proposal.mode !== "rewrite") throw new Error("The external edit contains no changes.");
  validateChatEditTarget(snapshot, proposal);
  return proposal;
}

/** A window-local review mailbox, independent of the single research executor. */
export function startExternalEditReviews(host: EditReviewHost, transport: Transport = invoke) {
  const sessionId = `review_${nanoid(20)}`;
  let disposed = false;
  let active: ActiveReview | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let registered = false;
  const seen = new Set<string>();
  const args = (id: string) => ({ sessionId, id });
  const assertTarget = (review: ActiveReview, requireReady = false) => {
    const target = host.getTarget();
    if (disposed || active !== review || !target || target.spaceId !== review.delivery.spaceId ||
      target.noteId !== review.delivery.noteId || (requireReady && !target.ready)) {
      throw new Error("The note is no longer open and ready in this window.");
    }
    const snapshot = host.getSpace(target.spaceId);
    if (!snapshot) throw new Error("This Space is no longer available.");
    validateChatEditTarget(snapshot, review.proposal);
  };
  async function fail(review: ActiveReview, error: unknown, notify = false) {
    if (active === review) { active = undefined; host.close(review.delivery.id); }
    await transport("assistant_review_fail", { ...args(review.delivery.id), error: message(error) }).catch(() => undefined);
    if (notify) host.onError(message(error), review.phase === "saving");
  }
  async function stage(delivery: ExternalEditDelivery) {
    if (disposed || seen.has(delivery.id)) return;
    seen.add(delivery.id);
    // Native retention is bounded. Keep duplicate protection bounded too.
    if (seen.size > 128) seen.delete(seen.values().next().value!);
    if (active) {
      await transport("assistant_review_fail", { ...args(delivery.id), error: "Finish the current note review first." }).catch(() => undefined);
      return;
    }
    let review: ActiveReview | undefined;
    try {
      const snapshot = host.getSpace(delivery.spaceId);
      if (!snapshot) throw new Error("This Space is no longer available.");
      review = { delivery, proposal: externalEditProposal(delivery, snapshot), phase: "staging" };
      active = review;
      assertTarget(review, true);
      await host.flush();
      assertTarget(review, true);
      const receipt = await transport<EditReviewReceipt>("assistant_review_stage", args(delivery.id));
      assertTarget(review, true);
      if (receipt.state !== "awaiting_review") throw new Error(receipt.error ?? "This edit is no longer available for review.");
      review.phase = "review";
      host.present({ id: delivery.id, proposal: review.proposal });
    } catch (error) {
      if (review) await fail(review, error);
      else await transport("assistant_review_fail", { ...args(delivery.id), error: message(error) }).catch(() => undefined);
    }
  }
  async function poll() {
    if (disposed) return;
    try {
      const target = host.getTarget();
      // Keep one session for this window across navigation/grant changes. An
      // idle, unregistered mailbox performs no native poll or vault reads.
      if (!target && !active) {
        if (registered) {
          registered = false;
          await transport("assistant_review_poll", { sessionId, target: null });
        }
        return;
      }
      registered = true;
      // ready=false blocks new proposals while retaining this review's ownership.
      const response = await transport<ReviewPoll>("assistant_review_poll", { sessionId, target });
      if (disposed) return;
      for (const receipt of response.receipts) {
        if (active?.delivery.id === receipt.id && active.phase !== "saving" && stopped.has(receipt.state)) {
          const review = active; active = undefined; host.close(review.delivery.id);
        }
      }
      if (active && active.phase !== "saving") {
        try { assertTarget(active); } catch (error) { void fail(active, error); }
      }
      for (const delivery of response.deliveries) void stage(delivery);
    } catch { /* Keep the review visible; acceptance still requires a live native claim. */ }
    finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 1_000); }
  }
  void poll();
  return {
    owns: (id: string) => active?.delivery.id === id,
    busy: () => Boolean(active),
    async beforeAccept(id: string) {
      const review = active;
      if (!review || review.delivery.id !== id || review.phase !== "review") throw new Error("This review is no longer available.");
      assertTarget(review);
      review.phase = "claiming";
      const receipt = await transport<EditReviewReceipt>("assistant_review_decide", { ...args(id), accept: true });
      assertTarget(review);
      if (receipt.state !== "accepting") throw new Error(receipt.error ?? "This edit could not be accepted.");
      review.phase = "claimed";
    },
    async complete(id: string, error?: string, accepted = true) {
      const review = active;
      if (!review || review.delivery.id !== id) return;
      if (error) { await fail(review, error, true); return; }
      if (!accepted) {
        if (review.phase === "claiming" || review.phase === "claimed") {
          await fail(review, "The editor closed before the accepted change was applied."); return;
        }
        active = undefined; host.close(id);
        await transport("assistant_review_decide", { ...args(id), accept: false }).catch(error => host.onError(message(error), false));
        return;
      }
      if (review.phase !== "claimed") { await fail(review, "This edit was not accepted by its review owner."); return; }
      review.phase = "saving";
      try {
        const body = host.getAcceptedBody(review.delivery);
        const accepted = await transport<EditReviewReceipt>("assistant_review_accepted", { ...args(id), body });
        if (accepted.state !== "accepted_in_editor" && accepted.state !== "saved") throw new Error(accepted.error ?? "The accepted edit could not be acknowledged.");
        await host.flush();
        const saved = await transport<EditReviewReceipt>("assistant_review_saved", args(id));
        if (saved.state !== "saved") throw new Error(saved.error ?? "The accepted edit was not confirmed saved.");
        if (active === review) active = undefined;
      } catch (error) {
        await fail(review, error, true);
      }
    },
    dispose() {
      disposed = true; if (timer) clearTimeout(timer);
      if (active && active.phase !== "saving") void fail(active, "The note review window was closed.");
      if (registered) void transport("assistant_review_poll", { sessionId, target: null }).catch(() => undefined);
    },
  };
}
export type ExternalEditReviews = ReturnType<typeof startExternalEditReviews>;
