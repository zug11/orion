import { nanoid } from "nanoid";
import type { VoiceResearch } from "../voiceResearch";
import type { VoiceReservations } from "../voiceReservations";
import { voiceWorkOrderDetail, type VoiceExternalAuthority, type VoiceWorkOrderControlReceipt, type VoiceWorkOrderSummary } from "../voiceWorkOrderAccess";
import type { TaskView } from "../taskWorkingView";

interface VoiceRequestScope { space_id: string; voice_target_id: string; task_view: TaskView }
export interface VoiceListRequest extends VoiceRequestScope { operation: "list"; offset: number; limit: number; inventory_version?: string | null }
export interface VoiceGetRequest extends VoiceRequestScope { operation: "get"; work_order_id: string; expected_revision: number; max_chars: number }
export interface VoiceControlRequest extends VoiceRequestScope {
  operation: "control"; work_order_id: string; expected_revision: number; expected_control_version: string;
  request_id: string; action: "cancel" | "retry" | "steer"; direction?: string | null;
}
export type VoiceAccessRequest = VoiceListRequest | VoiceGetRequest | VoiceControlRequest;
export type PublicVoiceSummary = VoiceWorkOrderSummary & { controlVersion: string };
export interface VoiceWorkOrderHostOptions {
  spaceId: string; engine: VoiceResearch; reservations: VoiceReservations;
  ready: () => boolean;
  focusedWorker?: () => string | undefined;
  /** Invalidates only routes dependent on the changed reservation, then republishes. */
  reservationChanged: (key: number) => void;
}

/** One Space/window owner. Public versions never include raw prompts, captured
 * passages or checkpoints, and cannot be reused after a reservation handoff. */
export class VoiceWorkOrderHost {
  private readonly controls = new Map<string, { fingerprint: string; token: string }>();
  private readonly inventories = new Map<TaskView, { fingerprint: string; token: string }>();
  constructor(private readonly options: VoiceWorkOrderHostOptions) {}
  get spaceId() { return this.options.spaceId; }
  get ready() { return this.options.ready(); }
  private summaries(taskView: TaskView): PublicVoiceSummary[] {
    const admitted = this.options.engine.inventory(taskView), ids = new Set(admitted.map(job => job.id));
    const summaries = [...admitted, ...this.options.reservations.inventory(taskView).filter(job => !ids.has(job.id))];
    const live = new Set(summaries.map(job => job.id));
    for (const id of this.controls.keys()) if (!live.has(id)) this.controls.delete(id);
    return summaries.map(job => {
      // A public view switch must not invalidate controls; use view-independent
      // revision, state and original group generation as the semantic identity.
      const fingerprint = JSON.stringify([job.revision, job.state, job.stage, job.current,
        job.checkpointSequence, job.savedNoteIds, this.options.reservations.controlVersion(job.id) ?? "admitted"]);
      let version = this.controls.get(job.id);
      if (!version || version.fingerprint !== fingerprint) {
        version = { fingerprint, token: `voice-control_${nanoid(20)}` }; this.controls.set(job.id, version);
      }
      return { ...job, controlVersion: version.token };
    });
  }
  inventory(taskView: TaskView = "working") { return this.summaries(taskView); }
  list(request: VoiceListRequest) {
    this.scope(request);
    const all = this.summaries(request.task_view), fingerprint = JSON.stringify(all);
    let version = this.inventories.get(request.task_view);
    if (!version || version.fingerprint !== fingerprint) {
      version = { fingerprint, token: `voice-inventory_${nanoid(20)}` }; this.inventories.set(request.task_view, version);
    }
    if (request.offset > 0 && !request.inventory_version || request.inventory_version && request.inventory_version !== version.token) {
      throw new Error("Voice inventory changed. Read the first page again before continuing.");
    }
    const items = all.slice(request.offset, request.offset + request.limit);
    return { spaceId: this.spaceId, voiceTargetId: request.voice_target_id, taskView: request.task_view,
      inventoryVersion: version.token, offset: request.offset, limit: request.limit, total: all.length,
      nextOffset: request.offset + items.length < all.length ? request.offset + items.length : null, items };
  }
  inspect(request: VoiceGetRequest) {
    this.scope(request);
    const summary = this.exact(request.work_order_id, request.expected_revision, request.task_view);
    const pending = this.options.reservations.find(request.work_order_id, request.expected_revision);
    const detail = pending
      ? voiceWorkOrderDetail(pending.job, undefined, { taskView: request.task_view, maxChars: request.max_chars, current: true })
      : this.options.engine.inspect(request.work_order_id, request.expected_revision, { taskView: request.task_view, maxChars: request.max_chars });
    return { spaceId: this.spaceId, voiceTargetId: request.voice_target_id, taskView: request.task_view,
      workOrder: { ...detail, controlVersion: summary.controlVersion } };
  }
  prepare(request: VoiceControlRequest) {
    const check = () => {
      this.scope(request);
      const summary = this.exact(request.work_order_id, request.expected_revision, request.task_view);
      if (summary.controlVersion !== request.expected_control_version) throw new Error("This voice work order changed. Inspect it again before controlling it.");
      if (request.action !== "cancel" && this.options.focusedWorker?.() === request.work_order_id) {
        throw new Error("This worker is the current voice conversation. Return to the main conversation in Orion before steering or retrying it externally.");
      }
      if (request.action !== "cancel" && !this.ready) throw new Error("Research is unavailable in the owning Orion window. Configure its AI provider first.");
      return summary;
    };
    check();
    const pending = this.options.reservations.find(request.work_order_id, request.expected_revision);
    if (pending && request.action === "retry") throw new Error("This worker is waiting for its assignment. Use steer with an explicit research direction.");
    const admittedRevision = request.action === "cancel" ? undefined : pending ? 1 : request.expected_revision + 1;
    return { admittedRevision, execute: (authority?: VoiceExternalAuthority) => {
      check(); // No asynchronous boundary between this guard and the mutation.
      let receipt: VoiceWorkOrderControlReceipt;
      if (request.action === "cancel") {
        if (pending) {
          this.options.reservations.removeMember(pending.job.id, "cancel");
          this.options.reservationChanged(pending.key);
          receipt = { id: pending.job.id, revision: pending.job.revision, action: "cancel", state: "cancelled", changed: true };
        } else receipt = this.options.engine.cancelVersion(request.work_order_id, request.expected_revision);
      } else {
        if (!authority) throw new Error("External research requires a current native permission grant.");
        if (pending) {
          // Admission can reject without erasing the waiting orb. Successful
          // admission and consumption occur together before yielding to a provider.
          receipt = this.options.engine.admitExternalReserved(pending.job.id, request.direction!,
            { focusNoteId: pending.job.focusNoteId, selection: pending.job.selection }, authority);
          this.options.reservations.removeMember(pending.job.id, "correct");
          this.options.reservationChanged(pending.key);
        } else if (request.action === "retry") receipt = this.options.engine.retryExternal(request.work_order_id, request.expected_revision, authority);
        else receipt = this.options.engine.steerExternal(request.work_order_id, request.expected_revision, request.direction!, authority);
      }
      const next = this.summaries(request.task_view).find(job => job.id === receipt.id);
      return { spaceId: this.spaceId, voiceTargetId: request.voice_target_id, requestId: request.request_id,
        controlVersion: next?.controlVersion ?? `voice-control_${nanoid(20)}`, ...receipt };
    } };
  }
  cancelExternal(grantId?: string) { this.options.engine.cancelExternal(grantId); }
  externalIsRunning(grantId: string, id: string, revision: number) {
    return this.options.engine.externalIsRunning(grantId, id, revision);
  }
  private scope(request: VoiceAccessRequest) {
    if (request.space_id !== this.spaceId) throw new Error("The owning voice window changed Space.");
  }
  private exact(id: string, revision: number, taskView: TaskView) {
    const job = this.summaries(taskView).find(job => job.id === id && job.revision === revision);
    if (!job) throw new Error("This voice work order is no longer available at the requested revision. List current workers again.");
    return job;
  }
}
