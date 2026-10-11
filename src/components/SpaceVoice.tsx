import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { AppSnapshot, ChatResult } from "../types";
import { chatWithOrion, isTauriRuntime } from "../lib/storage";
import { isSelectedAIConfigured } from "../lib/ai";
import { VoiceWorkOrderHost } from "../lib/assistant/voiceWorkOrderHost";
import { startVoiceWorkOrderMailbox } from "../lib/assistant/voiceWorkOrders";
import { voiceContextUsageRatio, type VoiceEvent, type VoiceStatus } from "../lib/liveVoice";
import { VoiceResearch, voiceContext, type VoiceCommit, type VoiceReceipt, type VoiceWorkOrder } from "../lib/voiceResearch";
import { MAX_VOICE_WORKERS_PER_REQUEST, MAX_VOICE_BATCH_ASSIGNMENTS, deferredVoiceCancellation, explicitVoiceAssignment, requestedVoiceWorkerCount, localVoiceTurnDecision, routeVoiceTurn, resolveVoiceClarification, voiceControlAction, voiceContinuationRequest, voiceCorrectionMayAffect, likelyVoiceControl, type VoiceTurnDecision } from "../lib/voiceWorkOrders";
import { VoiceConversation, type VoiceTurn, type VoiceDelivery } from "../lib/voiceConversation";
import { VoiceReservations } from "../lib/voiceReservations";
import { VoiceTurnRouter, type RoutingVoiceTurn } from "../lib/voiceTurnRouter";
import { VoiceFindingScheduler } from "../lib/voiceFindingScheduler";
import { VoiceCallLifecycle } from "../lib/voiceCallLifecycle";
import { VoiceContextUpdates } from "../lib/voiceContextUpdates";
import { ChatReply } from "./ChatReply";
import { VoiceConstellation } from "./VoiceConstellation";
import { AudioLines, MessageCircle, Mic2, Square } from "../lib/icons";
import { silentVoiceActivity, type VoicePresenceStore } from "../lib/voicePresence";
import { voiceSelectionReference, type VoiceSelectionStore } from "../lib/voiceSelection";
import type { IconPalette } from "../lib/themeIcon";
import { VoiceOrbMotion } from "../lib/voiceOrbMotion";
import "./SpaceVoice.css";

interface Props {
  snapshot: AppSnapshot; focusNoteId?: string; enabled: boolean;
  toggleRequest?: number; onActiveChange?: (active: boolean) => void;
  commit: (request: VoiceCommit) => Promise<VoiceReceipt>;
  onProposal: (result: ChatResult) => void;
  onOpenNote: (id: string) => void; onOpenSource?: (id: string) => void;
  onOpenSettings: () => void;
  floating?: boolean;
  presence?: VoicePresenceStore;
  voicePalette?: IconPalette;
  voiceSelection?: VoiceSelectionStore;
  onOpenChat?: () => void;
  chatVisible?: boolean;
  onShowWork?: () => void;
  sceneHost?: HTMLDivElement | null;
  controlsHost?: HTMLDivElement | null;
  onCloseChat?: () => void;
}
const noSelectionSubscription = () => () => {};
const noSelection = () => undefined;
export function SpaceVoice(props: Props) {
  const selectedText = useSyncExternalStore(props.voiceSelection?.subscribe ?? noSelectionSubscription, props.voiceSelection?.getSnapshot ?? noSelection);
  const liveProps = useRef(props); liveProps.current = props;
  const [voiceCall] = useState(() => new VoiceCallLifecycle());
  const research = useRef<VoiceResearch | undefined>(undefined);
  const conversation = useRef(new VoiceConversation());
  const conversations = useRef(new Map<string, VoiceConversation>());
  const focusedConversation = useRef<{ id: string; revision: number } | undefined>(undefined);
  const [focusedJobId, setFocusedJobId] = useState<string>();
  const [dismissedJobIds, setDismissedJobIds] = useState<string[]>([]);
  const [activity, setActivity] = useState(silentVoiceActivity);
  const [muted, setMuted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sceneMotion] = useState(() => new VoiceOrbMotion());
  useEffect(() => { if (props.chatVisible) setExpanded(false); }, [props.chatVisible]);
  const [reservations] = useState(() => new VoiceReservations());
  const [routes] = useState(() => new VoiceTurnRouter({
    enabled: () => alive.current && voiceCall.acceptsInput,
    budget: turn => Math.min(300_000, 45_000 * Math.ceil((requestedVoiceWorkerCount(turn.prompt) ?? turn.clarification?.workerCount ?? 1) / MAX_VOICE_BATCH_ASSIGNMENTS)),
    route: routeTurn,
    decide: (turn, decision) => { if (!reservations.isCancelled(turn.key)) applyDecision(turn, decision); },
    failed: reason => setError(reason instanceof Error ? reason.message : String(reason)),
    expired: turn => {
      reservations.expire(turn.key); publishPending();
      setError("Understanding this request took too long. Please repeat the specific assignment.");
      scheduleDelivery();
    },
    settled: turn => { reservations.finishRoute(turn.key); publishPending(); scheduleDelivery(); },
  }));
  const [deliveries] = useState(() => new VoiceFindingScheduler({
    enabled: () => alive.current && voiceCall.status === "listening" && !focusedConversation.current,
    valid: validDelivery,
    // A correction resolves before its old finding; unrelated routing never blocks it.
    correcting: item => routes.pending.some(turn => !!item.id && voiceCorrectionMayAffect(turn.prompt, item.id, research.current?.getJobs() ?? [])),
    sendReference: item => voiceCall.append("thinking", item.reference!, voiceCall.delegation(item.delegationId)),
    send: item => voiceCall.append("commentary", item.text, voiceCall.delegation(item.delegationId)),
  }));
  const contextUpdates = useRef(new VoiceContextUpdates());
  const activeSpace = useRef(props.snapshot.workspace.id);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [jobs, setJobs] = useState<VoiceWorkOrder[]>([]);
  const [routingJobs, setRoutingJobs] = useState<VoiceWorkOrder[]>([]);
  const [error, setError] = useState("");
  const [clarification, setClarification] = useState("");
  const [keeping, setKeeping] = useState<string>();
  const [shownJob, setShownJob] = useState<string>();
  const alive = useRef(true);

  const candidates = useMemo(() => activeSpace.current === props.snapshot.workspace.id ? [...jobs, ...routingJobs.filter(job => !jobs.some(existing => existing.id === job.id))] : [], [jobs, routingJobs, props.snapshot.workspace.id]);
  useEffect(() => { props.presence?.update({ status, activity, muted, jobs: candidates, focusedJobId, dismissedJobIds, motion: sceneMotion }); },
    [props.presence, status, activity, muted, candidates, focusedJobId, dismissedJobIds, sceneMotion]);

  function focusConversation(id?: string, resume = true) {
    let target: { id: string; revision: number } | undefined;
    if (id) {
      const job = research.current?.getJobs().find(job => job.id === id);
      if (!job?.result || job.state !== "completed" || !research.current?.isCurrent(job.id, job.revision)) return;
      target = { id: job.id, revision: job.revision };
      setDismissedJobIds(current => current.filter(candidate => candidate !== id));
    }
    if (focusedConversation.current?.id === id && focusedConversation.current?.revision === target?.revision) return;
    conversations.current.set(focusedConversation.current?.id ?? "main", conversation.current);
    cancelRouting();
    // Tear down the previous audio path before granting the new recipient input.
    voiceCall.dispose(); setStatus("idle"); setActivity(silentVoiceActivity());
    focusedConversation.current = target; setFocusedJobId(id);
    conversation.current = conversations.current.get(id ?? "main") ?? new VoiceConversation();
    if (resume) startCall(true);
  }
  function toggleMute() {
    voiceCall.mute(!voiceCall.isMuted); setMuted(voiceCall.isMuted);
  }

  function syncContext(usageRatio?: number) {
    if (voiceCall.status !== "listening") return;
    const current = liveProps.current;
    contextUpdates.current.update({ snapshot: current.snapshot, focusNoteId: current.focusNoteId,
      jobs: currentContextJobs(), receipts: research.current?.getReceipts() ?? [],
      conversation: conversation.current.text(), usageRatio, selection: current.voiceSelection?.getSnapshot() },
    text => voiceCall.append("thinking", text));
  }
  function pendingJobs() { return reservations.jobs(); }
  function publishPending() { setRoutingJobs(pendingJobs()); syncContext(); }
  function reserveWorkers(turn: VoiceTurn, count: number, phase: "routing" | "clarifying") {
    if (!reservations.reserve(turn, count, phase)) return false;
    publishPending(); return true;
  }
  function currentContextJobs() {
    const known = research.current?.getJobs() ?? [];
    return [...known, ...pendingJobs().filter(job => !known.some(existing => existing.id === job.id))].map(job => job.state === "completed" && !research.current?.isCurrent(job.id, job.revision)
      ? { ...job, state: "failed" as const, progress: "Supporting context changed; retrieve fresh evidence.", result: undefined }
      : job);
  }

  function validDelivery(item: VoiceDelivery) {
    return !item.id || (item.revision !== undefined && research.current?.isCurrent(item.id, item.revision) === true);
  }
  function scheduleDelivery() { deliveries.wake(); }
  function cancelRouting() {
    routes.clear(); reservations.clearPending();
    if (alive.current) setRoutingJobs([]);
    conversation.current.stop();
  }
  function stopCall() {
    cancelRouting(); deliveries.clear(); voiceCall.stop();
    setActivity(silentVoiceActivity());
  }
  function abortReservationRoutes(key: number) {
    for (const dependent of routes.cancelReservation(key)) reservations.markCancelled(dependent);
  }
  function cancelJob(id: string) {
    const pending = reservations.removeMember(id, "cancel");
    if (pending) {
      abortReservationRoutes(pending.key);
      setClarification(reservations.clarification?.question ?? "");
      publishPending();
      voiceCall.append("thinking", `Work order ${id} was cancelled before research began. Do not start its earlier request.`);
    }
    research.current?.cancel(id); deliveries.discardInvalid(validDelivery);
  }

  function dismissJob(id: string) {
    const job = research.current?.getJobs().find(candidate => candidate.id === id)
      ?? pendingJobs().find(candidate => candidate.id === id);
    if (!job) return;
    setDismissedJobIds(current => current.includes(id) ? current : [...current, id]);
    // Returning a finished orb is visual. Its evidence, receipts and optional
    // conversation remain available in the work list for an explicit return.
    if (job.state === "running") cancelJob(id);
    if (focusedConversation.current?.id === id) focusConversation(undefined, voiceCall.acceptsInput);
  }

  useEffect(() => {
    alive.current = true;
    activeSpace.current = props.snapshot.workspace.id;
    setJobs([]); setShownJob(undefined); setError(""); setClarification(""); setStatus("idle");
    conversations.current.clear(); focusedConversation.current = undefined; setFocusedJobId(undefined);
    setDismissedJobIds([]);
    voiceCall.mute(false); setMuted(false); setActivity(silentVoiceActivity());
    const coordinator = new VoiceResearch({
      snapshot: () => liveProps.current.snapshot, driver: chatWithOrion,
      commit: request => liveProps.current.commit(request), onProgress: () => undefined,
      onJobs: next => {
        if (!alive.current) return;
        setJobs(next); deliveries.discardInvalid(validDelivery); scheduleDelivery();
        syncContext();
      },
      onResult: answer => { if (alive.current && answer.editProposal) liveProps.current.onProposal(answer); },
      deliver: (kind, text, providerDelegation, stamp) => {
        if (!alive.current) return;
        // Associate current-call responses precisely; reconnect uses general context.
        const delegationId = voiceCall.delegation(providerDelegation);
        if (kind === "thinking") voiceCall.append("thinking", text, delegationId);
        else deliveries.enqueue({ text, delegationId, ...stamp });
      },
    });
    research.current = coordinator;
    const mailbox = isTauriRuntime() ? startVoiceWorkOrderMailbox(new VoiceWorkOrderHost({
      spaceId: props.snapshot.workspace.id, engine: coordinator, reservations,
      ready: () => alive.current && liveProps.current.enabled && isSelectedAIConfigured(liveProps.current.snapshot.settings),
      focusedWorker: () => focusedConversation.current?.id,
      reservationChanged: key => {
        abortReservationRoutes(key);
        setClarification(reservations.clarification?.question ?? ""); publishPending();
        deliveries.discardInvalid(validDelivery);
      },
    })) : undefined;
    return () => {
      mailbox?.dispose();
      alive.current = false; cancelRouting(); deliveries.clear(); voiceCall.dispose();
      liveProps.current.onActiveChange?.(false);
      liveProps.current.presence?.update({ status: "idle", activity: silentVoiceActivity(), muted: false, jobs: [] });
      conversation.current.clear(); reservations.reset();
      coordinator.dispose();
    };
    // Each mounted Space owns its coordinator and transient conversational state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.snapshot.workspace.id]);

  useEffect(() => {
    if (!props.enabled || !props.snapshot.settings.apiKeyConfigured || activeSpace.current !== props.snapshot.workspace.id) {
      stopCall(); research.current?.cancel(); conversation.current.clear(); reservations.reset();
      setClarification("");
    }
  }, [props.enabled, props.snapshot.settings.apiKeyConfigured, props.snapshot.workspace.id]);

  useEffect(() => {
    if (status === "listening" && props.enabled) syncContext();
    // Cheap identity/delta checks. Typing in the same note never resends its body.
  }, [props.focusNoteId, props.snapshot.notes, props.snapshot.workspace.id, props.enabled, status, selectedText]);

  useEffect(() => {
    if (!props.toggleRequest || !props.enabled) return;
    if (voiceCall.isActive) stopCall();
    else if (props.snapshot.settings.apiKeyConfigured) start();
    else props.onOpenSettings();
    // Only an explicit click may capture the microphone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.toggleRequest]);

  useEffect(() => {
    if (focusedJobId) {
      const job = research.current?.getJobs().find(job => job.id === focusedJobId);
      if (!job?.result || job.state !== "completed" || job.revision !== focusedConversation.current?.revision ||
          !research.current?.isCurrent(job.id, job.revision)) {
        // A changed/evicted result cannot remain the voice's current evidence.
        // Only hand an ongoing call back; never reacquire capture after Stop or
        // disconnection merely because a note or background job changed.
        focusConversation(undefined, voiceCall.acceptsInput);
      }
    }
    const retained = new Set(jobs.map(job => job.id));
    for (const id of conversations.current.keys()) if (id !== "main" && !retained.has(id)) conversations.current.delete(id);
    // A follow-up that starts work hands the conversation back without cancelling that work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, focusedJobId, props.snapshot]);

  function applyDecision(turn: RoutingVoiceTurn, decision: VoiceTurnDecision) {
    if (!alive.current || !voiceCall.acceptsInput) return;
    if (turn.clarification && !reservations.isCurrent(turn.clarification)) return;
    const engine = research.current;
    if (!engine) return;
    if (turn.focusedWorker && (decision.action === "new" || "jobId" in decision && decision.jobId === turn.focusedWorker.id) &&
        !engine.isCurrent(turn.focusedWorker.id, turn.focusedWorker.revision)) {
      setError("This worker's supporting context changed. Return to the main conversation and ask for fresh research."); return;
    }
    conversation.current.remember(turn.prompt, decision.action === "update");
    if (decision.action === "clarify") {
      const deferred = deferredVoiceCancellation(turn.prompt, conversation.current.recentTurns()
        .filter(previous => previous.key < turn.key && !reservations.turn(previous.key) && !reservations.isCancelled(previous.key)));
      if (deferred !== undefined) {
        reservations.markCancelled(deferred); reservations.clearClarification(); setClarification("");
        voiceCall.append("thinking", "The earlier requested assignment was cancelled before delegation. Do not start it or announce a result.");
        return;
      }
      const source = turn.clarification?.turn ?? turn;
      const count = decision.workerCount ?? turn.clarification?.workerCount ?? requestedVoiceWorkerCount(source.prompt);
      if (!voiceControlAction(source.prompt) && (count || reservations.members(source.key).length)) {
        reserveWorkers(source, count ?? reservations.members(source.key).length, "clarifying");
      }
      reservations.ask(source, decision.question, count);
      setClarification(decision.question);
      deliveries.enqueue({ text: decision.question, delegationId: turn.delegationId });
      return;
    }
    if (decision.action === "conversation") return;
    if (reservations.clarification && voiceControlAction(reservations.clarification.turn.prompt)) {
      reservations.clearClarification(); setClarification("");
    }
    if (decision.action === "batch") {
      const source = turn.clarification?.turn ?? turn;
      const previous = reservations.turn(source.key);
      const reserved = reservations.members(source.key);
      const known = engine.getJobs();
      const plan = decision.assignments.map((assignment, index) => ({ assignment,
        id: assignment.jobId ?? reserved[index]?.id ?? previous?.ids?.[index] ?? "voice-" + crypto.randomUUID(),
      }));
      // Recheck every identity and capacity before admitting any sibling.
      if (plan.some(({ assignment }) => assignment.jobId && !known.some(job => job.id === assignment.jobId && job.revision === assignment.revision && job.state !== "cancelled"))) return;
      if (new Set(plan.map(item => item.id)).size !== plan.length) return;
      const ids = plan.map(item => item.id);
      const captured = reservations.handoff(turn, ids, turn.clarification);
      if (!captured) return;
      setClarification(reservations.clarification?.question ?? "");
      const context = conversation.current.text() + "\n" + engine.context();
      for (const { id, assignment } of plan) void engine.run(id, decision.prompt, context, captured.focusNoteId, turn.delegationId, false, captured.selection, assignment);
      publishPending();
    } else if (decision.action === "new") {
      const source = turn.clarification?.turn ?? turn;
      const previous = reservations.turn(source.key);
      // A late continuation of the same utterance revises its own request.
      if (previous && turn.prompt.startsWith(previous.prompt) && engine.getJobs().some(job => job.id === previous.id && job.state === "cancelled")) return;
      const focused = turn.focusedWorker && engine.getJobs().find(job => job.id === turn.focusedWorker!.id && job.revision === turn.focusedWorker!.revision && job.state === "completed" && job.result);
      if (turn.focusedWorker && !focused) return;
      const id = focused?.id ?? (previous && (turn.clarification || turn.prompt.startsWith(previous.prompt)) ? previous.id : "voice-" + crypto.randomUUID());
      const captured = reservations.handoff(turn, [id], turn.clarification, true);
      if (!captured) return;
      setClarification(reservations.clarification?.question ?? "");
      const context = conversation.current.text() + "\n" + engine.context();
      if (focused) {
        const selection = captured.selection ?? focused.selection;
        if (focused.prompt === turn.prompt) void engine.run(id, turn.prompt, context, selection?.noteId ?? focused.focusNoteId, turn.delegationId, false, selection, focused.assignment, { expectedRevision: focused.revision });
        else void engine.run(id, turn.prompt, context, selection?.noteId ?? focused.focusNoteId, turn.delegationId, false, selection, focused.assignment);
      }
      else if (captured.selection) void engine.run(id, turn.prompt, context, captured.focusNoteId, turn.delegationId, false, captured.selection);
      else void engine.run(id, turn.prompt, context, captured.focusNoteId, turn.delegationId);
      publishPending();
    } else {
      const pending = reservations.find(decision.jobId, decision.revision);
      const target = pending?.job ?? engine.getJobs().find(job => job.id === decision.jobId && job.revision === decision.revision);
      if (!target || target.state === "cancelled") return;
      if (pending && decision.action === "cancel") { cancelJob(target.id); return; }
      if (pending && decision.action === "update") {
        const key = pending.key;
        abortReservationRoutes(key);
        reservations.removeMember(target.id, "correct");
        setClarification(reservations.clarification?.question ?? "");
        publishPending();
        voiceCall.append("thinking", `Work order ${target.id} (${target.subject}) was corrected. Do not start or announce its earlier request.`);
      }
      if (decision.action === "cancel") engine.cancel(target.id);
      else if (decision.action === "result") {
        if (!pending && target.state === "running" && target.updates?.length) engine.announceFinding(target.id);
        else if (pending || target.state === "running") {
          deliveries.enqueue({ text: target.phase === "clarifying" ? `${target.subject} is waiting for your direction; research has not started yet.` : `${target.subject} is still in progress. No completed finding is available yet.`, delegationId: turn.delegationId });
        } else if (engine.isCurrent(target.id, target.revision)) engine.announceResult(target.id);
      }
      else if (decision.action === "update") {
        const context = conversation.current.text() + "\nPrevious assignment (reference context): " + target.prompt + "\n" + engine.context();
        if (!pending && voiceContinuationRequest(decision.prompt) && !engine.isCurrent(target.id, target.revision)) {
          setError("This worker's supporting context changed. Ask for fresh research from the main conversation."); return;
        }
        // Remember successful corrections too: a later delegation for this same
        // utterance acknowledges its admission, never grants a fresh iteration.
        if (!reservations.handoff(turn, [target.id])) return;
        const assignment = target.assignment && (voiceContinuationRequest(decision.prompt) ? target.assignment : { subject: target.assignment.subject, focus: decision.prompt });
        if (target.state === "completed" && target.prompt === decision.prompt) void engine.run(target.id, decision.prompt, context, target.focusNoteId, turn.delegationId, false, target.selection, assignment, { expectedRevision: target.revision });
        else if (assignment || target.selection) void engine.run(target.id, decision.prompt, context, target.focusNoteId, turn.delegationId, false, target.selection, assignment);
        else void engine.run(target.id, decision.prompt, context, target.focusNoteId, turn.delegationId);
      }
    }
    deliveries.discardInvalid(validDelivery);
  }
  function routeTurn(turn: RoutingVoiceTurn, signal: AbortSignal) {
    const otherJobs = currentContextJobs().filter(job => !reservations.members(turn.key).some(reserved => reserved.id === job.id));
    const captured = turn.clarification?.turn ?? turn;
    return routeVoiceTurn({ prompt: turn.prompt, focusNoteId: captured.focusNoteId, conversation: conversation.current.text().slice(-2_000) + "\n" + voiceSelectionReference(captured.selection, liveProps.current.snapshot, turn.prompt), jobs: otherJobs.filter(job => !turn.clarification || !reservations.members(turn.clarification.turn.key).some(reserved => reserved.id === job.id)),
      ...(turn.clarification ? { clarification: { prompt: turn.clarification.turn.prompt, question: turn.clarification.question, workerCount: turn.clarification.workerCount } } : {}),
      driver: chatWithOrion, snapshot: liveProps.current.snapshot, delegated: turn.delegated, focusedWorker: turn.focusedWorker, signal,
    });
  }
  function considerTurns() {
    for (const receivedTurn of conversation.current.takeTurns()) {
      const pending = reservations.clarification;
      const turn: RoutingVoiceTurn = { ...receivedTurn, ...((pending && !voiceControlAction(pending.turn.prompt) && !explicitVoiceAssignment(receivedTurn.prompt) && !likelyVoiceControl(receivedTurn.prompt)) ? { clarification: pending } : {}) };
      if (reservations.isCancelled(turn.key)) continue;
      // A delayed provider delegation acknowledges an assignment already started
      // from the transcript. It must not restart it or increment its revision.
      if (reservations.isReplay(turn, research.current?.getJobs() ?? [])) continue;
      routes.replace(turn.key);
      const currentJobs = currentContextJobs().filter(job => !reservations.members(turn.key).some(reserved => reserved.id === job.id));
      const resolved = pending ? resolveVoiceClarification(pending.turn.prompt, turn.prompt, currentJobs) : null;
      const decision = resolved ?? (turn.clarification && !likelyVoiceControl(turn.prompt) ? null : localVoiceTurnDecision({ prompt: turn.prompt, jobs: currentJobs, delegated: turn.delegated, focusedWorker: turn.focusedWorker }));
      if (decision) applyDecision(turn, decision);
      else if (routes.hasCapacity) {
        const count = requestedVoiceWorkerCount(turn.prompt);
        if (!turn.clarification && (turn.delegated || count) && !likelyVoiceControl(turn.prompt) && !reservations.turn(turn.key)) {
          if (!reserveWorkers(turn, count ?? 1, "routing")) {
            setClarification(`Please request between 1 and ${MAX_VOICE_WORKERS_PER_REQUEST.toLocaleString()} workers in one message. Existing workers can continue while you add more.`); continue;
          }
        }
        routes.enqueue(turn);
      }
      else setError("Several requests are still being understood. Please finish or cancel one before adding more.");
    }
    routes.pump();
  }
  function receiveDebounced() { routes.debounce(considerTurns); }
  function receive(event: VoiceEvent) {
    if (!alive.current || !voiceCall.acceptsInput) return;
    const usageRatio = voiceContextUsageRatio(event);
    if (usageRatio !== undefined) { syncContext(usageRatio); return; }
    const current = liveProps.current;
    const selection = current.voiceSelection?.getSnapshot();
    const bound = selection?.spaceId === current.snapshot.workspace.id && selection.noteId === current.focusNoteId ? selection : undefined;
    // Bind to the exact result handed to this call, never a newer revision that
    // may have completed before React observes its intermediate running state.
    if (!conversation.current.receive(event, current.focusNoteId, bound, focusedConversation.current)) return;
    if (event.type === "session.delegation.created" && event.delegation?.id) {
      voiceCall.rememberDelegation(event.delegation.id);
    }
    if (event.type.endsWith("transcript.delta")) {
      deliveries.transcript();
      if (event.type === "session.input_transcript.delta") {
        // Keep the question and its worker identities until routing resolves it.
        deliveries.discardInvalid(item => Boolean(item.id) && validDelivery(item));
      }
    }
    // No provider transcript-done event: accumulate fragments, then match timeline offsets.
    // Assistant backchannels and room noise must not keep delaying a user turn.
    if (event.type === "session.input_transcript.delta" || event.type === "session.delegation.created") receiveDebounced();
    scheduleDelivery();
  }
  function start() { startCall(false); }
  function startCall(preserveFindings: boolean) {
    if (!voiceCall.canStart) return;
    cancelRouting();
    if (preserveFindings) {
      // Findings belong to admitted work, not to a particular audio recipient.
      // Unstamped conversational replies do not carry across a thread switch.
      deliveries.discardInvalid(item => Boolean(item.id) && validDelivery(item));
      deliveries.handoff();
    } else deliveries.reset();
    reservations.reset(); conversation.current.reconnect();
    setError(""); setClarification("");
    const current = liveProps.current;
    let contextSent = false;
    voiceCall.open({
      spaceId: current.snapshot.workspace.id,
      context: voiceContext(current.snapshot, conversation.current.text(), current.focusNoteId, current.voiceSelection?.getSnapshot()),
      onEvent: receive,
      onActivity: next => { setActivity(next); deliveries.audio(next); },
      onStatus: (value, message) => {
        if (!alive.current) return;
        setStatus(value); liveProps.current.onActiveChange?.(voiceCall.isActive);
        if (message) setError(message);
        if (value === "listening") {
          if (!contextSent) {
            const target = focusedConversation.current?.id;
            if (target) {
              const context = research.current?.conversationContext?.(target);
              if (context) voiceCall.append("instructions", "The user selected a finished worker. This call addresses that worker's investigation. Answer from its retained evidence and conversation. Do not start new research or speech solely from this switch. Further research returns to the main conversation.");
              if (context) voiceCall.append("thinking", context);
            }
            contextSent = voiceCall.append("thinking", research.current?.context() ?? "");
            if (contextSent) {
              contextUpdates.current.reset({ snapshot: current.snapshot, focusNoteId: current.focusNoteId,
                jobs: currentContextJobs(), receipts: research.current?.getReceipts() ?? [], selection: current.voiceSelection?.getSnapshot() });
              syncContext();
            }
          }
          scheduleDelivery();
        } else if (value === "idle" || value === "disconnected") {
          setActivity(silentVoiceActivity()); cancelRouting(); deliveries.clear();
        }
      },
    });
  }


  const visible = [...candidates.filter(job => job.state === "running"), ...candidates.filter(job => job.state === "failed" || job.state === "cancelled" || job.state === "completed" && job.result).slice(-6)];
  const active = ["connecting", "listening", "closing"].includes(status);
  const running = candidates.filter(job => job.state === "running" && job.phase !== "clarifying" && job.phase !== "queued").length;
  const waiting = candidates.filter(job => job.phase === "clarifying").length;
  const queued = candidates.filter(job => job.phase === "queued").length;
  const ready = candidates.filter(job => job.state === "completed" && job.result).length;
  if (!visible.length && !error && !clarification && !(props.floating && active)) return null;
  const content = <div className="space-voice">
    {visible.map(job => {
      const latestFinding = job.updates?.[job.updates.length - 1];
      return <div className="space-voice__job" key={job.id}>
      <div className="space-voice__progress">
        <span className="space-voice__subject" title={job.prompt}>{job.subject}</span>
        {job.state === "running" && <><span role="status">{job.progress}</span><button type="button" aria-label={"Cancel research: " + job.subject} onClick={() => cancelJob(job.id)}>Cancel</button></>}
        {job.state === "failed" && <span role="status">{job.progress}</span>}
        {job.state === "cancelled" && <span role="status">Cancelled</span>}
        {(job.state === "failed" || job.state === "cancelled") && !job.receipt && <button type="button" onClick={() => {
          setDismissedJobIds(current => current.filter(id => id !== job.id));
          void research.current?.retry(job.id, conversation.current.text());
        }}>Retry</button>}
      </div>
      {job.state === "running" && latestFinding && <details className="space-voice__finding">
        <summary>Latest finding <span>Still researching</span></summary>
        <div className="space-voice__result"><ChatReply snapshot={props.snapshot} message={{ id: `${job.id}-finding-${latestFinding.sequence}`, role: "assistant", content: latestFinding.reply,
          evidence: latestFinding.evidence, coverage: latestFinding.coverage, cardIds: [], contextCardIds: [], createdAt: "" }} onOpenNote={props.onOpenNote} onOpenSource={props.onOpenSource} /></div>
      </details>}
      {job.state === "cancelled" && job.receipt && <div className="space-voice__result-controls">
        <span>Saved before cancellation</span>
        {job.receipt.savedNoteIds.map((id, index) => <button type="button" key={id} onClick={() => props.onOpenNote(id)}>Saved · {job.receipt!.savedTitles[index]}</button>)}
      </div>}
      {job.state === "completed" && job.result && <>
        <div className="space-voice__result-controls">
          {props.floating && <button type="button" onClick={() => focusConversation(job.id)}>{dismissedJobIds.includes(job.id) ? "Bring back & talk" : "Talk to worker"}</button>}
          <button type="button" aria-expanded={shownJob === job.id} onClick={() => setShownJob(shownJob === job.id ? undefined : job.id)}>{shownJob === job.id ? "Hide research" : "Research & references"}</button>
          {job.receipt ? job.receipt.savedNoteIds.map((id, index) => <button type="button" key={id} onClick={() => props.onOpenNote(id)}>Saved · {job.receipt!.savedTitles[index]}</button>) :
            !job.result.editProposal && <button type="button" disabled={keeping === job.id} onClick={() => {
              setKeeping(job.id); void research.current?.keep(job.id).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setKeeping(undefined));
            }}>{keeping === job.id ? "Saving…" : "Keep as note"}</button>}
        </div>
        {shownJob === job.id && <div className="space-voice__result"><ChatReply snapshot={props.snapshot} message={{ id: job.id, role: "assistant", content: job.result.reply, evidence: job.result.evidence, coverage: job.result.coverage, cardIds: [], contextCardIds: [], createdAt: "" }} onOpenNote={props.onOpenNote} onOpenSource={props.onOpenSource} /></div>}
      </>}
    </div>; })}
    {clarification && <div className="space-voice__clarification" role="status">{clarification}</div>}
    {error && <div className="chat-composer__error" role="alert">
      {error}
      {status === "disconnected" && props.enabled && props.snapshot.settings.apiKeyConfigured &&
        <button type="button" onClick={start}>Reconnect voice</button>}
    </div>}
  </div>;
  if (!props.floating) return content;
  const embedded = Boolean(props.chatVisible && props.sceneHost && props.controlsHost);
  const scene = <VoiceConstellation status={status} activity={activity} muted={muted} jobs={candidates} focusedJobId={focusedJobId}
    dismissedJobIds={dismissedJobIds} palette={props.voicePalette} onFocus={focusConversation} onDismiss={dismissJob} size="expanded" motion={sceneMotion} onShowWorkers={() => setExpanded(true)} />;
  const showWork = () => { if (!embedded && !expanded) props.onShowWork?.(); setExpanded(value => !value); };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if ((event.target as Element).closest('[role="dialog"],[role="menu"]')) return;
    event.stopPropagation();
    if (expanded) setExpanded(false);
    else if (embedded) props.onCloseChat?.();
  };
  const controls = <section className={`space-voice-call${embedded ? " space-voice-call--embedded" : ""}`} aria-label="Space voice conversation" onKeyDown={escape}>
    {expanded && <div className="space-voice-call__expanded">
      {!embedded && scene}
      {(visible.length > 0 || error || clarification) && content}
    </div>}
    <div className="space-voice-call__pill">
      {!embedded && <VoiceConstellation status={status} activity={activity} muted={muted} jobs={candidates} focusedJobId={focusedJobId}
        dismissedJobIds={dismissedJobIds} palette={props.voicePalette} onFocus={focusConversation} onDismiss={dismissJob} size="pill" motion={sceneMotion} />}
      <button type="button" className="space-voice-call__summary" aria-expanded={expanded} onClick={showWork}>
        <strong>{focusedJobId ? candidates.find(job => job.id === focusedJobId)?.subject ?? "Worker conversation" : "Talk to Space"}</strong>
        {selectedText && <span key={selectedText.id} className="space-voice-call__selection" title={selectedText.noteTitle}>Selected text</span>}
        <span>{status === "connecting" ? "Connecting…" : status === "disconnected" ? "Disconnected" : `${running} working · ${ready} ready${waiting ? ` · ${waiting} waiting` : ""}${queued ? ` · ${queued} queued` : ""}`}</span>
      </button>
      {active ? <>
        <button type="button" aria-label={muted ? "Unmute microphone" : "Mute microphone"} title={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted} className={muted ? "is-muted" : undefined} onClick={toggleMute}><Mic2 size={17} /></button>
        <button type="button" aria-label="End voice call" title="End voice call" onClick={stopCall}><Square size={14} fill="currentColor" /></button>
      </> : <button type="button" aria-label="Reconnect voice" title="Reconnect voice" onClick={start}><AudioLines size={18} /></button>}
      {!embedded && <button type="button" aria-label="Open chat" title="Open chat" onClick={() => { setExpanded(false); props.onOpenChat?.(); }}><MessageCircle size={17} /></button>}
    </div>
    {!expanded && (error || clarification) && <button type="button" className="space-voice-call__notice" onClick={() => { if (!embedded) props.onShowWork?.(); setExpanded(true); }}>{error || clarification}</button>}
  </section>;
  // Only presentation moves. The connection, work orders and per-conversation
  // history stay owned by this mounted component through Chat navigation.
  return embedded ? <>
    {createPortal(active ? <div className="space-voice-call__scene" onKeyDown={escape}>{scene}</div> : null, props.sceneHost!)}
    {createPortal(controls, props.controlsHost!)}
  </> : controls;
}
