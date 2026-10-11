import { invoke } from "@tauri-apps/api/core";
import { nanoid } from "nanoid";
import type { VoiceExternalAuthority } from "../voiceWorkOrderAccess";
import type { VoiceAccessRequest, VoiceWorkOrderHost } from "./voiceWorkOrderHost";

interface VoiceEnvelope { id: string; targetId: string; request: VoiceAccessRequest }
interface VoiceGrant { id: string; workOrderId: string; revision: number }
interface VoicePoll { targetId: string | null; requests: VoiceEnvelope[]; grants: VoiceGrant[]; allowAI: boolean }
type Transport = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
const identifier = (value: unknown, max = 200): value is string => typeof value === "string" && !!value && value === value.trim() && [...value].length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
function validRequest(request: VoiceAccessRequest): boolean {
  if (!request || !identifier(request.space_id) || !identifier(request.voice_target_id) || !["working", "history"].includes(request.task_view)) return false;
  if (request.operation === "list") return integer(request.offset, 0) && integer(request.limit, 1, 50) &&
    (request.inventory_version == null ? request.offset === 0 : identifier(request.inventory_version));
  if (request.operation !== "get" && request.operation !== "control" || !identifier(request.work_order_id) || !integer(request.expected_revision, 1)) return false;
  if (request.operation === "get") return integer(request.max_chars, 1, 12_000);
  if (!identifier(request.expected_control_version) || !identifier(request.request_id, 128)) return false;
  if (request.action === "cancel" || request.action === "retry") return request.direction == null;
  return request.action === "steer" && typeof request.direction === "string" && !!request.direction.trim() &&
    [...request.direction].length <= 2_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(request.direction);
}

/** Identity-only heartbeat and finite request mailbox. No call lifecycle, audio,
 * navigation, selection mutation, persistence or commentary is controlled here. */
export function startVoiceWorkOrderMailbox(host: VoiceWorkOrderHost, transport: Transport = invoke) {
  const sessionId = `voice_${nanoid(20)}`;
  let disposed = false, targetId: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>(), grants = new Map<string, VoiceGrant>();
  const release = (id: string, target = targetId) => {
    grants.delete(id);
    if (target) void transport("voice_work_orders_release", { sessionId, targetId: target, grantId: id }).catch(() => undefined);
  };
  const revoke = () => { for (const id of grants.keys()) { host.cancelExternal(id); release(id); } };
  const withdraw = () => transport("voice_work_orders_poll", { sessionId, target: null }).catch(() => undefined);
  async function respond(envelope: VoiceEnvelope, value: { result: unknown } | { error: string }) {
    if (disposed || envelope.targetId !== targetId) return;
    await transport("voice_work_orders_respond", { sessionId, id: envelope.id, targetId, ...value });
  }
  async function process(envelope: VoiceEnvelope, allowAI: boolean) {
    if (!identifier(envelope.id) || seen.has(envelope.id)) return;
    seen.add(envelope.id); if (seen.size > 128) seen.delete(seen.values().next().value!);
    const request = envelope.request;
    if (envelope.targetId !== targetId || !validRequest(request) || request.voice_target_id !== targetId || request.space_id !== host.spaceId) return;
    let granted: string | undefined;
    try {
      if (request.operation === "list") return await respond(envelope, { result: host.list(request) });
      if (request.operation === "get") return await respond(envelope, { result: host.inspect(request) });
      if (request.action !== "cancel" && (!allowAI || !host.ready)) throw new Error("External AI access is unavailable. Check Orion's assistant permissions and provider settings.");
      const prepared = host.prepare(request), owner = targetId;
      const claim = await transport<{ claimed: boolean; grantId: string | null }>("voice_work_orders_claim", {
        sessionId, id: envelope.id, targetId: owner, ...(prepared.admittedRevision !== undefined ? { admittedRevision: prepared.admittedRevision } : {}),
      });
      if (claim?.grantId) granted = claim.grantId;
      if (disposed || targetId !== owner || !claim?.claimed) throw new Error("This voice owner changed before admission. Refresh the current work orders.");
      let authority: VoiceExternalAuthority | undefined;
      if (request.action !== "cancel") {
        if (!identifier(granted)) throw new Error("The native host did not grant this research revision.");
        const id = granted;
        grants.set(id, { id, workOrderId: request.work_order_id, revision: prepared.admittedRevision! });
        authority = { grantId: id, taskView: request.task_view, assertCurrent: async () => {
          if (disposed || targetId !== owner || !grants.has(id) || !host.ready) throw new Error("External research authorization is no longer current.");
          const allowed = await transport<boolean>("voice_work_orders_authorize", { sessionId, targetId: owner, grantId: id });
          if (!allowed || disposed || targetId !== owner || !grants.has(id) || !host.ready) throw new Error("External research authorization was revoked.");
        } };
      }
      const result = prepared.execute(authority);
      await respond(envelope, { result });
    } catch (reason) {
      if (granted) { host.cancelExternal(granted); release(granted, envelope.targetId); }
      const error = [...(reason instanceof Error ? reason.message : String(reason))].slice(0, 500).join("") || "The voice request could not be completed.";
      await respond(envelope, { error }).catch(() => undefined);
    }
  }
  async function poll() {
    if (disposed) return;
    try {
      const response = await transport<VoicePoll>("voice_work_orders_poll", { sessionId, target: { spaceId: host.spaceId, ready: host.ready } });
      if (disposed) { await withdraw(); return; }
      if (!response || !Array.isArray(response.requests) || !Array.isArray(response.grants)) throw new Error("Invalid voice mailbox heartbeat.");
      if (targetId !== response.targetId) revoke();
      targetId = response.targetId;
      const authorized = new Map(response.grants.map(grant => [grant.id, grant]));
      for (const [id, grant] of grants) {
        const native = authorized.get(id);
        if (!response.allowAI || !native || native.workOrderId !== grant.workOrderId || native.revision !== grant.revision) {
          host.cancelExternal(id); release(id);
        } else if (!host.externalIsRunning(id, grant.workOrderId, grant.revision)) release(id);
      }
      // Retry cleanup after a lost release response. A serial poll cannot race
      // an admission from this mailbox, and another owner cannot issue its grants.
      for (const grant of response.grants) if (!grants.has(grant.id)) release(grant.id);
      if (!targetId) return;
      for (const envelope of response.requests.slice(0, 8)) {
        if (disposed) break;
        await process(envelope, response.allowAI);
      }
    } catch { revoke(); /* Failed heartbeat cannot leave externally authorized work running. */ }
    finally { if (!disposed) timer = setTimeout(() => { void poll(); }, 1_000); }
  }
  void poll();
  return { dispose() {
    disposed = true; if (timer) clearTimeout(timer); revoke();
    void withdraw();
  } };
}
