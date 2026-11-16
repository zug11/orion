import { resolveWebResearchProvider } from "../lib/webResearchProvider";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { AppSnapshot, ChatResult } from "../types";
import { normalizeLiveVoiceProvider } from "../data/defaults";
import { chatWithOrion, isTauriRuntime } from "../lib/storage";
import { isSelectedAIConfigured } from "../lib/ai";
import { chatPromptAllowsNoteCreation } from "../lib/chat";
import { VoiceWorkOrderHost } from "../lib/assistant/voiceWorkOrderHost";
import { startVoiceWorkOrderMailbox } from "../lib/assistant/voiceWorkOrders";
import { voiceContextUsageRatio, type VoiceEvent, type VoiceStatus, type PrepareVoiceConnection } from "../lib/liveVoice";
import { VoiceResearch, voiceContext, voicePromptSavesCurrentFinding, type VoiceCommit, type VoiceReceipt, type VoiceWorkOrder } from "../lib/voiceResearch";
import { MAX_VOICE_WORKERS_PER_REQUEST, MAX_VOICE_BATCH_ASSIGNMENTS, deferredVoiceCancellation, explicitVoiceAssignment, requestedVoiceWorkerCount, workerClarificationAnswer, localVoiceTurnDecision, routeVoiceTurn, resolveVoiceClarification, voiceControlAction, voiceContinuationRequest, voiceCorrectionMayAffect, likelyVoiceControl, type VoiceTurnDecision } from "../lib/voiceWorkOrders";
import { VoiceConversation, type VoiceTurn, type VoiceDelivery } from "../lib/voiceConversation";
import { VoiceReservations, type VoiceReservationClarification } from "../lib/voiceReservations";
import { isCurrentVoiceClarificationChoice, resolveVoiceClarificationChoice } from "../lib/voiceWorkOrders";
import { VoiceTurnRouter, type RoutingVoiceTurn } from "../lib/voiceTurnRouter";
import { VoiceFindingScheduler } from "../lib/voiceFindingScheduler";
import { synthesizeVoiceFindings } from "../lib/voiceFindingSynthesis";
import { VoiceNoteEdits } from "../lib/voiceNoteEdits";
import { directVoiceNoteEdit } from "../lib/voiceWorkOrders";
import { VoiceCallLifecycle } from "../lib/voiceCallLifecycle";
import { VoiceContextUpdates } from "../lib/voiceContextUpdates";
import { ChatReply } from "./ChatReply";
import { VoiceConstellation } from "./VoiceConstellation";
import { VoiceClarification, type VoiceClarificationAnswer } from "./VoiceClarification";
import { AudioLines, Ellipsis, MessageCircle, Mic, MicOff, Square, X } from "../lib/icons";
import { silentVoiceActivity, type VoicePresenceStore } from "../lib/voicePresence";
import { voiceSelectionReference, type VoiceSelectionStore } from "../lib/voiceSelection";
import type { IconPalette } from "../lib/themeIcon";
import { VoiceOrbMotion } from "../lib/voiceOrbMotion";
import "./SpaceVoice.css";

export interface VoiceConversationContent { hasContent: boolean; revision: string }

interface Props {
  snapshot: AppSnapshot; focusNoteId?: string; enabled: boolean;
  /** Host-owned text conversation; this identity never comes from the provider. */
  conversationId?: string;
  /** Retain research while another text thread is visible, without mixing its UI. */
  presentationHidden?: boolean;
  /** Main Chat presents voice through its orbs and audio, without worker text. */
  hideConversationText?: boolean;
  toggleRequest?: number; onActiveChange?: (active: boolean) => void;
  onVisibleChange?: (visible: boolean) => void;
  commit: (request: VoiceCommit) => Promise<VoiceReceipt>;
  onProposal: (result: ChatResult) => void | Promise<unknown>;
  onOpenNote: (id: string) => void; onOpenSource?: (id: string) => void;
  onOpenSettings: () => void;
  onPrepareVoiceConnection?: PrepareVoiceConnection;
  floating?: boolean;
  presence?: VoicePresenceStore;
  voicePalette?: IconPalette;
  voiceSelection?: VoiceSelectionStore;
  onOpenChat?: () => void;
  chatVisible?: boolean;
  onShowConversation?: () => void;
  resultsHost?: HTMLDivElement | null;
  onConversationContentChange?: (content: VoiceConversationContent) => void;
  sceneHost?: HTMLDivElement | null;
  controlsHost?: HTMLDivElement | null;
  clarificationHost?: HTMLDivElement | null;
  onCloseChat?: () => void;
}
const noSelectionSubscription = () => () => {};
const noSelection = () => undefined;
export function SpaceVoice(props: Props) {
  const voiceProvider = normalizeLiveVoiceProvider(props.snapshot.settings.liveVoiceProvider);
  const webAvailable = !!resolveWebResearchProvider(props.snapshot.settings);
  const voiceKeyConfigured = voiceProvider === "elevenlabs"
    ? props.snapshot.settings.elevenLabsApiKeyConfigured
    : props.snapshot.settings.apiKeyConfigured;
  const previousVoiceProvider = useRef(voiceProvider);
  const selectedText = useSyncExternalStore(props.voiceSelection?.subscribe ?? noSelectionSubscription, props.voiceSelection?.getSnapshot ?? noSelection);
  const liveProps = useRef(props); liveProps.current = props;
  const [voiceCall] = useState(() => new VoiceCallLifecycle());
  const research = useRef<VoiceResearch | undefined>(undefined);
  const conversation = useRef(new VoiceConversation());
  const spokenTargets = useRef(new Map<string, Pick<VoiceTurn, "focusNoteId" | "selection" | "focusedWorker">>());
  const conversations = useRef(new Map<string, VoiceConversation>());
  const focusedConversation = useRef<{ id: string; revision: number } | undefined>(undefined);
  const [focusedJobId, setFocusedJobId] = useState<string>();
  const [dismissedJobIds, setDismissedJobIds] = useState<string[]>([]);
  const [activity, setActivity] = useState(silentVoiceActivity);
  const [muted, setMuted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const summaryButton = useRef<HTMLButtonElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [voiceGeneration, setVoiceGeneration] = useState(0);
  const [sceneMotion, setSceneMotion] = useState(() => new VoiceOrbMotion());
  const [findingVersion, setFindingVersion] = useState(0);
  useEffect(() => { if (props.chatVisible) setExpanded(false); }, [props.chatVisible]);
  useEffect(() => {
    if (!expanded) return;
    const selector = confirmClear ? ".space-voice__clear button" : ".space-voice__options > button";
    summaryButton.current?.closest("section")?.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
  }, [expanded, confirmClear]);
  const [reservations] = useState(() => new VoiceReservations());
  const answering = useRef<number | undefined>(undefined);
  const [answerBusy, setAnswerBusy] = useState(false);
  const [routes] = useState(() => new VoiceTurnRouter({
    enabled: () => alive.current && (voiceCall.acceptsInput || answering.current !== undefined),
    budget: turn => Math.min(300_000, 45_000 * Math.ceil((requestedVoiceWorkerCount(turn.prompt) ?? turn.clarification?.workerCount ?? 1) / MAX_VOICE_BATCH_ASSIGNMENTS)),
    route: routeTurn,
    decide: (turn, decision) => { if (!reservations.isCancelled(turn.key)) applyDecision(turn, decision); },
    failed: reason => setError(reason instanceof Error ? reason.message : String(reason)),
    expired: turn => {
      reservations.expire(turn.key); finishAnswer(turn); publishPending();
      setError(turn.uiAnswer ? "Understanding this answer took too long. You can try again or cancel the question." : "Understanding this request took too long. Please repeat the specific assignment.");
      scheduleDelivery();
    },
    settled: turn => { reservations.finishRoute(turn.key); finishAnswer(turn); publishPending(); scheduleDelivery(); },
  }));
  const [deliveries] = useState(() => new VoiceFindingScheduler({
    enabled: () => alive.current && voiceCall.status === "listening" && !focusedConversation.current,
    valid: validDelivery,
    // A correction resolves before its old finding; unrelated routing never blocks it.
    correcting: item => routes.pending.some(turn => !!item.id && voiceCorrectionMayAffect(turn.prompt, item.id, research.current?.getJobs() ?? [])),
    sendReference: item => voiceCall.append("thinking", item.reference!, voiceCall.delegation(item.delegationId)),
    send: item => voiceCall.append("commentary", item.text, voiceCall.delegation(item.delegationId)),
    conversation: () => ({ key: JSON.stringify([activeSpace.current, liveProps.current.snapshot.settings.model,
      liveProps.current.snapshot.settings.reasoningEffort, conversation.current.recentTurns().slice(-1).map(({ key, prompt }) => [key, prompt])]), text: conversation.current.text() }),
    synthesize: (items, current, previous, signal) => synthesizeVoiceFindings(liveProps.current.snapshot, items, current, previous, signal, chatWithOrion),
    // The scheduler has already waited for the conversational floor. Send the
    // actual contribution as speakable data, not another instruction to wait.
    sendPrepared: (reference, summary, id) => voiceCall.append("thinking", reference, voiceCall.delegation(id))
      && voiceCall.append("commentary", summary, voiceCall.delegation(id)),
    flushContext: () => syncContext(),
    onChange: () => { if (alive.current) setFindingVersion(value => value + 1); },
  }));
  const contextUpdates = useRef(new VoiceContextUpdates());
  const activeSpace = useRef(props.snapshot.workspace.id);
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [jobs, setJobs] = useState<VoiceWorkOrder[]>([]);
  const [routingJobs, setRoutingJobs] = useState<VoiceWorkOrder[]>([]);
  const [error, setError] = useState("");
  const [clarification, setClarification] = useState("");
  const [notice, setNotice] = useState("");
  const noticeTarget = useRef<Pick<VoiceWorkOrder, "id" | "revision" | "state"> | undefined>(undefined);
  const [readyResult, setReadyResult] = useState<{ id: string; revision: number }>();
  const [keeping, setKeeping] = useState<string>();
  const alive = useRef(true);
  const [editProgress, setEditProgress] = useState("");
  const [noteEdits] = useState(() => new VoiceNoteEdits({
    snapshot: () => liveProps.current.snapshot, driver: chatWithOrion,
    progress: message => { if (alive.current) setEditProgress(message); },
    proposal: presentProposal,
    failed: message => { if (alive.current) setError(message); },
  }));

  function presentProposal(result: ChatResult) {
    if (!alive.current || !result.editProposal) return;
    const failed = (error: unknown) => {
      if (alive.current) setError(error instanceof Error ? error.message : "The note review could not be opened.");
      voiceCall.append("thinking", "The requested note review could not be completed. No accepted edit or save is confirmed. The error is visible on screen; do not claim the note was changed.");
    };
    try {
      // Review can remain pending until Accept/Discard. Catch a busy or stale
      // editor rejection instead of dropping its promise and losing the diff.
      void Promise.resolve(liveProps.current.onProposal(result)).catch(failed);
      voiceCall.append("thinking", JSON.stringify({ type: "note_edit_proposal", noteId: result.editProposal.noteId,
        title: result.editProposal.title, applied: false, saved: false,
        notice: "Quiet application result. Proposed changes were sent to the existing note review, with Accept/Discard. No research worker was needed for this edit. Do not read the draft aloud or claim it was applied or saved." }));
    } catch (error) { failed(error); }
  }

  const candidates = useMemo(() => activeSpace.current === props.snapshot.workspace.id ? [...jobs, ...routingJobs.filter(job => !jobs.some(existing => existing.id === job.id))] : [], [jobs, routingJobs, props.snapshot.workspace.id]);
  const thinking = routes.pending.length > 0 || !!editProgress;
  useEffect(() => {
    const target = noticeTarget.current;
    if (!target) return;
    const current = candidates.find(job => job.id === target.id && job.revision === target.revision && job.state === target.state);
    const admitted = research.current?.getJobs().some(job => job.id === target.id);
    if (!current || admitted && !research.current?.isCurrent(target.id, target.revision)) {
      noticeTarget.current = undefined; setNotice(""); setReadyResult(undefined);
    }
  }, [candidates, props.snapshot]);
  useEffect(() => { props.presence?.update({ status, activity, muted, thinking, jobs: candidates, focusedJobId, dismissedJobIds, motion: sceneMotion }); },
    [props.presence, status, activity, muted, thinking, candidates, focusedJobId, dismissedJobIds, sceneMotion]);

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
    voiceCall.pause(); setStatus("idle"); setActivity(silentVoiceActivity());
    focusedConversation.current = target; setFocusedJobId(id);
    conversation.current = conversations.current.get(id ?? "main") ?? new VoiceConversation();
    if (resume) startCall(true);
  }
  function toggleMute() {
    voiceCall.mute(!voiceCall.isMuted); setMuted(voiceCall.isMuted);
  }
  function retryResearch(id: string, revision: number) {
    const current = research.current?.getJobs().find(job => job.id === id && job.revision === revision);
    if (!current || current.receipt || (current.state !== "failed" && current.state !== "cancelled")) return;
    setDismissedJobIds(ids => ids.filter(candidate => candidate !== id));
    void research.current?.retry(id, conversation.current.text()).catch(reason => {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    });
  }
  function hearReadyResult() {
    if (!readyResult || !research.current?.isCurrent(readyResult.id, readyResult.revision)) {
      setReadyResult(undefined); setNotice("That result is no longer current. Ask for fresh research."); return;
    }
    startCall(true);
    research.current.announceResult(readyResult.id);
    setReadyResult(undefined);
  }

  function syncContext(usageRatio?: number, userSpeaking = false) {
    if (voiceCall.status !== "listening") return;
    const current = liveProps.current;
    let waiting = false;
    contextUpdates.current.update({ snapshot: current.snapshot, focusNoteId: current.focusNoteId,
      jobs: currentContextJobs(), receipts: research.current?.getReceipts() ?? [],
      conversation: conversation.current.text(), usageRatio, userSpeaking, selection: conversation.current.userSelection },
    text => {
      // Selection belongs to the current human utterance. Background work and
      // navigation updates wait with the findings until the speaker settles.
      if (!deliveries.canUpdateContext() && !(userSpeaking && text.startsWith('{"type":"selection_update"'))) { waiting = true; return false; }
      return voiceCall.append("thinking", text);
    });
    if (waiting) deliveries.contextChanged();
  }
  function pendingJobs() { return reservations.jobs(); }
  function publishPending() { setRoutingJobs(pendingJobs()); syncContext(); }
  function reserveWorkers(turn: VoiceTurn, count: number, phase: "routing" | "clarifying") {
    if (!reservations.reserve(turn, count, phase)) return false;
    publishPending(); return true;
  }
  function currentContextJobs() {
    const known = research.current?.getJobs() ?? [];
    return [...known.map(job => (job.state === "completed" || job.state === "running") && !research.current?.isCurrent(job.id, job.revision)
      ? { ...job, state: "failed" as const, progress: "Supporting context changed; retrieve fresh evidence.", result: undefined }
      : job), ...pendingJobs().filter(job => !known.some(existing => existing.id === job.id))];
  }

  function validDelivery(item: VoiceDelivery) {
    return !item.id || (item.revision !== undefined && research.current?.isCurrentFinding(item.id, item.revision, item.sequence) === true);
  }
  function scheduleDelivery() { deliveries.wake(); }
  function finishAnswer(turn: RoutingVoiceTurn) {
    if (answering.current === turn.key) { answering.current = undefined; setAnswerBusy(false); }
  }
  function cancelRouting(preserveQuestion = false) {
    const pending = routes.pending;
    routes.clear(); answering.current = undefined;
    if (preserveQuestion && reservations.clarification) {
      for (const turn of pending) reservations.finishRoute(turn.key);
    } else reservations.clearPending();
    if (alive.current) {
      setAnswerBusy(false); setRoutingJobs(pendingJobs());
      setClarification(reservations.clarification?.question ?? "");
    }
    conversation.current.stop();
  }
  function stopCall() {
    spokenTargets.current.clear();
    cancelRouting(true); deliveries.clear(); voiceCall.stop();
    setActivity(silentVoiceActivity());
  }
  function clearVoiceChat() {
    // Explicit confirmation discards only transient voice state. The native
    // writer still owns any save already committed; no note is deleted here.
    stopCall(); cancelRouting(); voiceCall.dispose(); deliveries.reset(); noteEdits.cancel();
    conversations.current.clear(); conversation.current = new VoiceConversation();
    focusedConversation.current = undefined; setFocusedJobId(undefined);
    setJobs([]); setRoutingJobs([]); setKeeping(undefined);
    setError(""); setClarification(""); setNotice(""); setReadyResult(undefined); setConfirmClear(false); setExpanded(false);
    setSceneMotion(new VoiceOrbMotion()); setVoiceGeneration(value => value + 1);
  }
  function abortReservationRoutes(key: number) {
    for (const dependent of routes.cancelReservation(key)) reservations.markCancelled(dependent);
    if (!routes.pending.some(turn => turn.key === answering.current)) { answering.current = undefined; setAnswerBusy(false); }
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
    // conversation remain available in the transcript for an explicit return.
    if (job.state === "running") cancelJob(id);
    if (focusedConversation.current?.id === id) focusConversation(undefined, voiceCall.acceptsInput);
  }

  useEffect(() => {
    alive.current = true;
    activeSpace.current = props.snapshot.workspace.id;
    setJobs([]); setError(""); setClarification(""); setNotice(""); setReadyResult(undefined); setStatus("idle");
    conversations.current.clear(); focusedConversation.current = undefined; setFocusedJobId(undefined);
    setDismissedJobIds([]);
    setConfirmClear(false);
    voiceCall.mute(false); setMuted(false); setActivity(silentVoiceActivity());
    const conversationId = props.conversationId;
    const coordinator = new VoiceResearch({
      snapshot: () => liveProps.current.snapshot, driver: chatWithOrion,
      commit: request => liveProps.current.commit({ ...request, ...(conversationId ? { threadId: conversationId } : {}) }), onProgress: () => undefined,
      onJobs: next => {
        if (!alive.current || research.current !== coordinator) return;
        setJobs(next); deliveries.discardInvalid(validDelivery); scheduleDelivery();
        syncContext();
      },
      onResult: result => { if (research.current === coordinator) presentProposal(result); },
      deliver: (kind, text, providerDelegation, stamp) => {
        if (!alive.current || research.current !== coordinator) return;
        // Associate current-call responses precisely; reconnect uses general context.
        const delegationId = voiceCall.delegation(providerDelegation);
        if (kind === "thinking") {
          deliveries.discardInvalid(validDelivery);
          if (text.startsWith('{"type":"worker_finding"')) {
            const finding = JSON.parse(text);
            deliveries.enqueue({ text: "", delegationId, ...stamp, reference: text, sequence: finding.sequence, background: true, completion: finding.state === "completed" });
          } else deliveries.reference({ text: "", reference: text, delegationId, ...stamp });
        }
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
      coordinator.dispose(); noteEdits.dispose();
    };
    // Each mounted Space owns its coordinator and transient conversational state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.snapshot.workspace.id, props.conversationId, voiceGeneration]);

  useEffect(() => {
    if (!props.enabled || !voiceKeyConfigured || activeSpace.current !== props.snapshot.workspace.id) {
      stopCall();
      const providerChanged = previousVoiceProvider.current !== voiceProvider;
      if (!props.enabled || activeSpace.current !== props.snapshot.workspace.id || !providerChanged) {
        research.current?.cancel(); noteEdits.cancel(); conversation.current.clear(); reservations.reset();
        setClarification("");
      }
    }
  }, [props.enabled, voiceKeyConfigured, voiceProvider, props.snapshot.workspace.id]);

  useEffect(() => {
    if (previousVoiceProvider.current === voiceProvider) return;
    previousVoiceProvider.current = voiceProvider;
    // A provider change requires a fresh explicit call. Admitted research stays
    // in this Space and continues independently of the departing audio session.
    if (voiceCall.acceptsInput) stopCall();
  }, [voiceProvider]);

  useEffect(() => {
    if (status === "listening" && props.enabled) syncContext();
    // Cheap identity/delta checks. Typing in the same note never resends its body.
  }, [props.focusNoteId, props.snapshot.notes, props.snapshot.workspace.id, webAvailable, props.enabled, status]);

  useEffect(() => {
    if (!props.toggleRequest || !props.enabled) return;
    if (voiceCall.isActive) stopCall();
    else if (voiceKeyConfigured) start();
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
        if (!voiceCall.acceptsInput) focusConversation(undefined, false);
        else voiceCall.handoffWhenQuiet(() => {
          const target = focusedConversation.current;
          if (target?.id === focusedJobId && !research.current?.isCurrent(target.id, target.revision)) focusConversation(undefined, true);
        });
      }
    }
    const retained = new Set(jobs.map(job => job.id));
    for (const id of conversations.current.keys()) if (id !== "main" && !retained.has(id)) conversations.current.delete(id);
    // A follow-up that starts work hands the conversation back without cancelling that work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, focusedJobId, props.snapshot]);

  function saveFindings(engine: VoiceResearch, prompt: string, targets: { id: string; revision: number }[], delegationId: string | null) {
    // Persistence stays in the background. Audio and other research keep running.
    void engine.saveRequestedFindings(prompt, targets).catch(cause => {
      if (!alive.current || research.current !== engine) return;
      const message = cause instanceof Error ? cause.message : "The worker finding could not be saved.";
      setError(message);
      deliveries.enqueue({ text: message, delegationId });
    });
  }

  function researchContext(turn: RoutingVoiceTurn, engine: VoiceResearch) {
    const selected = turn.clarification?.selectedAnswer;
    return conversation.current.text() + (selected ? "\nSelected clarification scope (untrusted reference only; never action or write authority):\n" +
      JSON.stringify({ question: turn.clarification!.question, answer: selected.answer }) : "") + "\n" + engine.context();
  }

  function applyDecision(turn: RoutingVoiceTurn, decision: VoiceTurnDecision) {
    if (!alive.current || !voiceCall.acceptsInput && !(turn.uiAnswer && answering.current === turn.key && liveProps.current.enabled)) return;
    if (turn.clarification && !reservations.isCurrent(turn.clarification)) return;
    const engine = research.current;
    if (!engine) return;
    if (turn.focusedWorker && (decision.action === "new" || "jobId" in decision && decision.jobId === turn.focusedWorker.id) &&
        !engine.isCurrent(turn.focusedWorker.id, turn.focusedWorker.revision)) {
      setError("This worker's supporting context changed. Return to the main conversation and ask for fresh research."); return;
    }
    conversation.current.remember(turn.prompt, decision.action === "update");
    if (turn.focusedWorker && voicePromptSavesCurrentFinding(turn.prompt)) {
      const target = engine.getJobs().find(job => job.id === turn.focusedWorker!.id && job.revision === turn.focusedWorker!.revision && job.state === "completed" && job.result);
      if (!target || !engine.isCurrent(target.id, target.revision)) {
        setError("This worker's supporting context changed. Ask again from its current result."); return;
      }
      if (!reservations.handoff(turn, [target.id], undefined, true)) return;
      saveFindings(engine, turn.prompt, [{ id: target.id, revision: target.revision }], turn.delegationId);
      return;
    }
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
      reservations.ask(source, decision.question, count, { choices: decision.choices, controlAction: decision.controlAction });
      setClarification(decision.question);
      publishPending();
      deliveries.enqueue({ text: decision.question, delegationId: turn.delegationId });
      return;
    }
    if (decision.action === "conversation") {
      if (turn.uiAnswer) setError("That answer did not identify a research request. Choose an option or add more detail.");
      return;
    }
    if (decision.action === "notice") {
      noticeTarget.current = undefined; setReadyResult(undefined);
      if (turn.clarification) reservations.expire(turn.clarification.turn.key);
      else if (reservations.clarification && voiceControlAction(reservations.clarification.turn.prompt)) reservations.clearClarification();
      setClarification(reservations.clarification?.question ?? "");
      setNotice(decision.message); publishPending();
      deliveries.enqueue({ text: decision.message, delegationId: turn.delegationId });
      return;
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
      const context = researchContext(turn, engine);
      // Only a validated reference-only answer completes the original spoken
      // request. New commands and generated scopes cannot inherit its authority.
      const original = turn.clarification?.turn.prompt;
      const prompt = original && chatPromptAllowsNoteCreation(original) && workerClarificationAnswer({ prompt: turn.prompt, jobs: known, delegated: turn.delegated,
        clarification: { prompt: original, question: turn.clarification!.question, workerCount: turn.clarification!.workerCount } }) ? original : decision.prompt;
      for (const { id, assignment } of plan) void engine.run(id, prompt, context, assignment.noteIds ? undefined : captured.focusNoteId, turn.delegationId, false, captured.selection, assignment);
      if (chatPromptAllowsNoteCreation(prompt)) {
        const targets = engine.getJobs().filter(job => ids.includes(job.id)).map(({ id, revision }) => ({ id, revision }));
        saveFindings(engine, prompt, targets, turn.delegationId);
      }
      publishPending();
    } else if (decision.action === "new") {
      const source = turn.clarification?.turn ?? turn;
      const previous = reservations.turn(source.key);
      // A late continuation of the same utterance revises its own request.
      if (previous && turn.prompt.startsWith(previous.prompt) && engine.getJobs().some(job => job.id === previous.id && job.state === "cancelled")) return;
      const focused = turn.focusedWorker && engine.getJobs().find(job => job.id === turn.focusedWorker!.id && job.revision === turn.focusedWorker!.revision && job.state === "completed" && job.result);
      if (turn.focusedWorker && !focused) return;
      const createsNewNote = chatPromptAllowsNoteCreation(turn.prompt);
      const id = (createsNewNote ? undefined : focused?.id) ?? (previous && (turn.clarification || turn.prompt.startsWith(previous.prompt)) ? previous.id : "voice-" + crypto.randomUUID());
      const captured = reservations.handoff(turn, [id], turn.clarification, true);
      if (!captured) return;
      setClarification(reservations.clarification?.question ?? "");
      const context = researchContext(turn, engine);
      if (focused && !createsNewNote) {
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
      if (!target || target.state === "cancelled") {
        if (turn.uiAnswer && turn.clarification) {
          cancelClarification(turn.clarification);
          setNotice("That research request changed while the answer was being understood. Ask again to choose a current request.");
        }
        return;
      }
      if (reservations.clarification && voiceControlAction(reservations.clarification.turn.prompt)) {
        reservations.clearClarification(); setClarification("");
      }
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
        if (!pending && (!engine.isCurrent(target.id, target.revision) || target.state === "completed" && !target.result?.reply.trim())) {
          const message = "That research no longer has current evidence. There is no result to wait for; ask for fresh research.";
          setNotice(message); syncContext();
          deliveries.enqueue({ text: message, delegationId: turn.delegationId });
        } else if (!pending && target.state === "running" && target.updates?.length) engine.announceFinding(target.id);
        else if (pending || target.state === "running") {
          const message = target.phase === "clarifying" ? `${target.subject} needs your direction; research has not started yet.`
            : target.phase === "routing" ? `${target.subject} is being planned; research has not started yet.`
            : target.phase === "queued" ? `${target.subject} is queued; research has not started yet.`
            : `${target.subject} is still researching. No completed finding is available yet.`;
          setNotice(message);
          noticeTarget.current = { id: target.id, revision: target.revision, state: target.state };
          deliveries.enqueue({ text: message, delegationId: turn.delegationId });
        } else if (engine.isCurrent(target.id, target.revision)) {
          engine.announceResult(target.id);
          if (turn.uiAnswer && !voiceCall.acceptsInput) {
            setNotice(`${target.subject} has a completed result.`);
            noticeTarget.current = { id: target.id, revision: target.revision, state: target.state };
            setReadyResult({ id: target.id, revision: target.revision });
          }
        }
      }
      else if (decision.action === "update") {
        const context = researchContext(turn, engine) + "\nPrevious assignment (reference context): " + target.prompt;
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
      ...(turn.clarification ? { clarification: { prompt: turn.clarification.turn.prompt, question: turn.clarification.question, workerCount: turn.clarification.workerCount,
        choices: turn.clarification.choices, controlAction: turn.clarification.controlAction, selectedAnswer: turn.clarification.selectedAnswer } } : {}),
      driver: chatWithOrion, snapshot: liveProps.current.snapshot, delegated: turn.delegated, focusedWorker: turn.focusedWorker, signal,
    });
  }
  function cancelClarification(captured: VoiceReservationClarification) {
    if (!reservations.isCurrent(captured)) return;
    abortReservationRoutes(captured.turn.key); reservations.expire(captured.turn.key);
    setClarification(""); setNotice(""); setError(""); setReadyResult(undefined); noticeTarget.current = undefined; publishPending();
    deliveries.discardInvalid(item => Boolean(item.id) && validDelivery(item));
    voiceCall.append("thinking", "The user dismissed the pending question. Its unstarted request is cancelled. No result is expected from that request; already admitted research is unchanged.");
  }
  function answerClarification(captured: VoiceReservationClarification, answer: VoiceClarificationAnswer) {
    if (!alive.current || !liveProps.current.enabled || answering.current !== undefined || !reservations.isCurrent(captured)) return false;
    const text = answer.text.trim();
    const choice = answer.choiceId ? captured.choices?.find(item => item.id === answer.choiceId) : undefined;
    if ((!text && !choice) || text.length > 4_000 || answer.choiceId && !choice) return false;
    const currentJobs = currentContextJobs();
    const direct = choice?.jobId ? resolveVoiceClarificationChoice(captured.turn.prompt, choice, currentJobs) : null;
    if (choice?.jobId && !isCurrentVoiceClarificationChoice(captured.turn.prompt, choice, currentJobs)) {
      cancelClarification(captured);
      setNotice("That research request has changed or no longer has a result. Ask again to see the current requests.");
      return false;
    }
    if (!routes.hasCapacity) { setError("Several requests are still being understood. Try again after one finishes."); return false; }
    // Suggested text narrows scope as reference data. Only exact authored text
    // can grant an action; a button never becomes a generated user command.
    const turn: RoutingVoiceTurn = { ...conversation.current.answer(text || captured.turn.prompt, captured.turn), uiAnswer: true,
      clarification: { ...captured, ...(choice ? { selectedAnswer: { id: choice.id, answer: choice.answer } } : {}) } };
    answering.current = turn.key; setAnswerBusy(true); setError(""); setNotice(""); setReadyResult(undefined); noticeTarget.current = undefined;
    deliveries.discardInvalid(item => Boolean(item.id) && validDelivery(item));
    if (direct && !text) {
      applyDecision(turn, direct); finishAnswer(turn); publishPending();
    } else {
      routes.enqueue(turn); publishPending(); routes.pump();
    }
    return true;
  }
  function considerTurns() {
    for (const receivedTurn of conversation.current.takeTurns()) {
      setNotice(""); setReadyResult(undefined); noticeTarget.current = undefined;
      const pending = reservations.clarification;
      const turn: RoutingVoiceTurn = { ...receivedTurn, ...((pending && !voiceControlAction(pending.turn.prompt) && !explicitVoiceAssignment(receivedTurn.prompt) && !likelyVoiceControl(receivedTurn.prompt)) ? { clarification: pending } : {}) };
      if (reservations.isCancelled(turn.key)) continue;
      // Editing the captured note uses Chat's proposal path directly. It does
      // not reserve an orb, enter a worker conversation or need a router call.
      if (directVoiceNoteEdit(turn.prompt)) {
        routes.replace(turn.key); setError("");
        void noteEdits.run(turn, conversation.current, conversation.current.text());
        continue;
      }
      // A delayed provider delegation acknowledges work already being planned
      // or started from the transcript. Compare the latest pending text too:
      // a genuine continuation can be newer than its original reservation.
      if (reservations.isReplay(turn, research.current?.getJobs() ?? []) ||
          turn.delegated && routes.pending.some(pending => pending.key === turn.key && pending.prompt === turn.prompt)) continue;
      routes.replace(turn.key);
      const currentJobs = currentContextJobs().filter(job => !reservations.members(turn.key).some(reserved => reserved.id === job.id));
      const resolved = pending ? resolveVoiceClarification(pending.turn.prompt, turn.prompt, currentJobs) : null;
      const decision = turn.focusedWorker && voicePromptSavesCurrentFinding(turn.prompt)
        ? { action: "new" as const, prompt: turn.prompt }
        : resolved ?? (turn.clarification && !likelyVoiceControl(turn.prompt) ? null : localVoiceTurnDecision({ prompt: turn.prompt, jobs: currentJobs, delegated: turn.delegated, focusedWorker: turn.focusedWorker }));
      if (decision) applyDecision(turn, decision);
      else if (routes.hasCapacity) {
        const count = requestedVoiceWorkerCount(turn.prompt);
        if (!turn.clarification && (count || turn.delegated || explicitVoiceAssignment(turn.prompt)) && !likelyVoiceControl(turn.prompt) && !reservations.turn(turn.key)) {
          if (!reserveWorkers(turn, count ?? 1, "routing")) {
            setNotice(`Please request between 1 and ${MAX_VOICE_WORKERS_PER_REQUEST.toLocaleString()} workers in one message. Existing workers can continue while you add more.`); continue;
          }
        }
        routes.enqueue(turn);
        publishPending();
      }
      else setError("Several requests are still being understood. Please finish or cancel one before adding more.");
    }
    routes.pump();
  }
  function receiveDebounced() { routes.debounce(considerTurns, conversation.current.settleMs); }
  function receive(event: VoiceEvent) {
    if (!alive.current || !voiceCall.acceptsInput) return;
    const usageRatio = voiceContextUsageRatio(event);
    if (usageRatio !== undefined) { syncContext(usageRatio); return; }
    const current = liveProps.current;
    const selection = current.voiceSelection?.getSnapshot();
    const bound = selection?.spaceId === current.snapshot.workspace.id && selection.noteId === current.focusNoteId ? selection : undefined;
    if (event.type === "session.input_audio.started") {
      const id = event.item_id;
      if (typeof id !== "string" || !id || id.length > 200 || spokenTargets.current.has(id)) return;
      spokenTargets.current.set(id, {
        focusNoteId: current.focusNoteId,
        ...(bound ? { selection: structuredClone(bound) } : {}),
        ...(focusedConversation.current ? { focusedWorker: { ...focusedConversation.current } } : {}),
      });
      if (spokenTargets.current.size > 64) spokenTargets.current.delete(spokenTargets.current.keys().next().value!);
      return;
    }
    const finalizedInput = event.type === "session.input_transcript.delta" &&
      normalizeLiveVoiceProvider(current.snapshot.settings.liveVoiceProvider) === "elevenlabs";
    const spokenTarget = finalizedInput && event.item_id ? spokenTargets.current.get(event.item_id) : undefined;
    if (finalizedInput && !spokenTarget) {
      setError("This spoken request could not be matched to where you started speaking. Please say it again.");
      return;
    }
    // Bind to the exact result handed to this call, never a newer revision that
    // may have completed before React observes its intermediate running state.
    if (!conversation.current.receive(event,
      spokenTarget ? spokenTarget.focusNoteId : current.focusNoteId,
      spokenTarget ? spokenTarget.selection : bound,
      spokenTarget ? spokenTarget.focusedWorker : focusedConversation.current)) return;
    if (event.type === "session.delegation.created" && event.delegation?.id) {
      voiceCall.rememberDelegation(event.delegation.id);
    }
    if (event.type.endsWith("transcript.delta")) {
      deliveries.transcript(event.type === "session.input_transcript.delta" ? "user" : "assistant", conversation.current.settleMs, event.delta);
      if (event.type === "session.input_transcript.delta") {
        // Highlighting is local only. The first actual spoken fragment publishes
        // its captured reference; later highlighting cannot retarget that turn.
        syncContext(undefined, true);
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
    const current = liveProps.current;
    const provider = normalizeLiveVoiceProvider(current.snapshot.settings.liveVoiceProvider);
    const configured = provider === "elevenlabs" ? current.snapshot.settings.elevenLabsApiKeyConfigured : current.snapshot.settings.apiKeyConfigured;
    if (!current.enabled || !configured) { current.onOpenSettings(); return; }
    spokenTargets.current.clear();
    cancelRouting();
    if (preserveFindings) {
      // Findings belong to admitted work, not to a particular audio recipient.
      // Unstamped conversational replies do not carry across a thread switch.
      deliveries.discardInvalid(item => Boolean(item.id) && validDelivery(item));
      deliveries.handoff();
    } else deliveries.reset();
    reservations.reset();
    conversation.current.reconnect();
    setError(""); setClarification(""); setNotice(""); setReadyResult(undefined); noticeTarget.current = undefined;
    let contextSent = false;
    voiceCall.open({
      provider,
      prepareConnection: current.onPrepareVoiceConnection,
      voiceId: provider === "elevenlabs" ? current.snapshot.settings.elevenLabsVoiceId : undefined,
      spaceId: current.snapshot.workspace.id,
      context: voiceContext(current.snapshot, conversation.current.text(), current.focusNoteId),
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
                jobs: currentContextJobs(), receipts: research.current?.getReceipts() ?? [] });
              syncContext();
            }
          }
          scheduleDelivery();
        } else if (value === "idle" || value === "disconnected") {
          setActivity(silentVoiceActivity()); cancelRouting(true); deliveries.clear();
        }
      },
    });
  }


  const active = ["connecting", "listening", "closing"].includes(status);
  const running = candidates.some(job => job.state === "running");
  const results = useMemo(() => candidates.filter(job => job.state === "failed" || job.state === "cancelled" || job.state === "completed" && job.result || job.receipt || job.state === "running" && job.updates?.length), [candidates]);
  const hasConversation = Boolean(results.length || error || clarification || notice || editProgress);
  const conversationRevision = useMemo(() => JSON.stringify([
    results.map(job => [job.id, job.revision, job.state, job.result?.reply.length, job.updates?.[job.updates.length - 1]?.sequence, job.receipt?.savedNoteIds, job.state === "failed" ? job.progress : ""]), error, clarification, notice, editProgress,
  ]), [results, error, clarification, notice, editProgress]);
  const hasContent = Boolean(candidates.length || hasConversation || active);
  const visibleConversation = !props.hideConversationText && hasConversation;
  const visibleConversationRevision = props.hideConversationText ? "" : conversationRevision;
  // Publish meaningful presentation changes, never the incoming audio frames.
  useEffect(() => {
    props.onVisibleChange?.(hasContent);
    return () => props.onVisibleChange?.(false);
  }, [hasContent, props.onVisibleChange]);
  useEffect(() => {
    props.onConversationContentChange?.({ hasContent: visibleConversation, revision: visibleConversationRevision });
  }, [visibleConversation, visibleConversationRevision, props.onConversationContentChange]);
  useEffect(() => () => { liveProps.current.onConversationContentChange?.({ hasContent: false, revision: "" }); }, []);
  // Audio levels update the orb frequently. Keep retained Markdown and citation
  // views stable, including while Chat is collapsed. Actions read the current
  // ref-owned controllers; evidence refreshes with the snapshot and job objects.
  const content = useMemo(() => props.hideConversationText ? null : <div className="voice-conversation-results">
    {hasConversation && <div className="voice-conversation-results__label">From voice</div>}
    {editProgress && <div className="space-voice__progress"><span role="status">{editProgress}</span><button type="button" onClick={() => noteEdits.cancel()}>Cancel note changes</button></div>}
    {results.map(job => {
      const latestFinding = job.updates?.[job.updates.length - 1];
      const offer = deliveries.status(job.id, job.revision);
      return <article className="voice-conversation-result" key={job.id} aria-label={job.subject}>
        <h3>{job.subject}</h3>
        {(job.state === "failed" || job.state === "cancelled" && !job.receipt) && <div className="chat-composer__error" role={job.state === "failed" ? "alert" : "status"}>{job.state === "cancelled" ? "Research stopped." : job.progress}
          {!job.receipt && <button type="button" onClick={() => retryResearch(job.id, job.revision)}>Retry research</button>}
        </div>}
        {job.state === "running" && latestFinding && <details className="space-voice__finding">
          <summary>Latest finding <span>Still researching</span></summary>
          <ChatReply snapshot={props.snapshot} message={{ id: `${job.id}-finding-${latestFinding.sequence}`, role: "assistant", content: latestFinding.reply,
            evidence: latestFinding.evidence, coverage: latestFinding.coverage, cardIds: [], contextCardIds: [], createdAt: "" }} onOpenNote={props.onOpenNote} onOpenSource={props.onOpenSource} />
          <button type="button" aria-label={"Cancel research: " + job.subject} onClick={() => cancelJob(job.id)}>Stop this research</button>
        </details>}
        {job.state === "completed" && job.result && <>
          <ChatReply snapshot={props.snapshot} message={{ id: job.id, role: "assistant", content: job.result.reply,
            evidence: job.result.evidence, coverage: job.result.coverage, cardIds: [], contextCardIds: [], createdAt: "" }} onOpenNote={props.onOpenNote} onOpenSource={props.onOpenSource} />
          <div className="space-voice__result-controls">
            {offer === "failed" && status === "listening" && !focusedJobId && <button type="button" onClick={() => deliveries.retrySummary(job.id)}>Retry voice summary</button>}
            {status === "listening" && !focusedJobId && <button type="button" onClick={() => research.current?.announceResult(job.id)}>Read aloud</button>}
            <button type="button" onClick={() => focusConversation(job.id)}>Discuss by voice</button>
            {!job.receipt && !job.result.editProposal && <button type="button" disabled={keeping === job.id} onClick={() => {
              setKeeping(job.id); void research.current?.keep(job.id).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setKeeping(undefined));
            }}>{keeping === job.id ? "Saving…" : "Keep as note"}</button>}
          </div>
        </>}
        {job.receipt && <div className="space-voice__result-controls">
          {job.state === "cancelled" && <span>Saved before cancellation</span>}
          {job.receipt.savedNoteIds.map((id, index) => <button type="button" key={id} onClick={() => props.onOpenNote(id)}>Saved · {job.receipt!.savedTitles[index]}</button>)}
        </div>}
      </article>;
    })}
    {notice && <div className="space-voice__clarification" role="status">{notice}
      {readyResult && <button type="button" onClick={hearReadyResult}>Hear result</button>}
    </div>}
    {error && <div className="chat-composer__error" role="alert">{error}
      {status === "disconnected" && props.enabled && voiceKeyConfigured && <button type="button" onClick={start}>Reconnect voice</button>}
    </div>}
  </div>, [results, hasConversation, props.hideConversationText, props.snapshot, props.onOpenNote, props.onOpenSource, props.enabled,
    status, focusedJobId, keeping, error, notice, readyResult, editProgress, findingVersion, deliveries, noteEdits]);
  if (!hasContent || props.presentationHidden) return null;
  const embedded = Boolean(props.floating && props.chatVisible && props.sceneHost && props.controlsHost);
  const question = reservations.clarification;
  const questionPanel = question ? <VoiceClarification clarificationId={`${question.epoch}:${question.turn.key}:${question.revision}`}
    question={question.question} choices={question.choices ?? []} busy={answerBusy}
    onSubmit={answer => answerClarification(question, answer)} onCancel={() => cancelClarification(question)} /> : null;
  const options = <div className="space-voice__options" role="group" aria-label="Voice options">
    <div className="space-voice__options-header"><strong>Voice</strong><button type="button" aria-label="Close voice options" onClick={() => { setExpanded(false); summaryButton.current?.focus(); }}><X size={15} /></button></div>
    {confirmClear ? <div className="space-voice__clear" role="group" aria-label="Clear voice chat confirmation">
      <p>End the call and clear voice conversations and unsaved research? Saved notes stay in your Space.</p>
      <button type="button" onClick={clearVoiceChat}>Clear voice chat</button>
      <button type="button" onClick={() => setConfirmClear(false)}>Keep voice chat</button>
    </div> : <>
      {focusedJobId && <button type="button" onClick={() => { focusConversation(undefined); setExpanded(false); }}>Return to Space conversation</button>}
      {!props.hideConversationText && hasConversation && props.onShowConversation && <button type="button" onClick={() => { setExpanded(false); props.onShowConversation?.(); }}>View conversation</button>}
      {embedded && active && <button type="button" onClick={() => { stopCall(); setExpanded(false); }}>End voice call</button>}
      {props.hideConversationText && editProgress && <button type="button" onClick={() => { noteEdits.cancel(); setExpanded(false); }}>Cancel note changes</button>}
      {running && <button type="button" onClick={() => { for (const job of candidates) if (job.state === "running") cancelJob(job.id); setExpanded(false); }}>Stop research</button>}
      <button type="button" onClick={() => setConfirmClear(true)}>Clear voice chat…</button>
    </>}
  </div>;
  if (!props.floating) return hasConversation ? <>{questionPanel}{content}{options}</> : null;
  const scene = <VoiceConstellation settings={props.snapshot.settings} status={status} activity={activity} muted={muted} thinking={thinking} jobs={candidates} focusedJobId={focusedJobId}
    dismissedJobIds={dismissedJobIds} palette={props.voicePalette} onFocus={focusConversation} onDismiss={dismissJob} size="expanded" motion={sceneMotion} onShowConversation={props.hideConversationText ? undefined : props.onShowConversation} />;
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if ((event.target as Element).closest('[role="dialog"],[role="menu"]')) return;
    event.stopPropagation();
    if (expanded) { setExpanded(false); summaryButton.current?.focus(); }
    else if (embedded) props.onCloseChat?.();
  };
  const voiceStatus = status === "connecting" ? "Connecting…" : status === "disconnected" ? "Disconnected" : muted && active ? "Mic muted" : active ? activity.outputActive && (activity.outputMeasured || activity.measured) ? "Speaking" : "Listening" : running ? "Researching…" : hasConversation ? "Conversation available" : "Ready";
  const controls = <section className={`space-voice-call${embedded ? " space-voice-call--embedded" : ""}`} aria-label="Space voice conversation" onKeyDown={escape}>
    {expanded && <div className="space-voice-call__expanded">{options}</div>}
    <div className="space-voice-call__pill">
      {!embedded && <VoiceConstellation settings={props.snapshot.settings} status={status} activity={activity} muted={muted} thinking={thinking} jobs={candidates} focusedJobId={focusedJobId}
        dismissedJobIds={dismissedJobIds} palette={props.voicePalette} onFocus={focusConversation} onDismiss={dismissJob} size="pill" motion={sceneMotion} />}
      {!embedded && <div className="space-voice-call__summary">
        <strong>{focusedJobId ? candidates.find(job => job.id === focusedJobId)?.subject ?? "Research conversation" : "Talk to Space"}</strong>
        {selectedText && <span key={selectedText.id} className="space-voice-call__selection" title={selectedText.noteTitle}>Selected text</span>}
        <span>{voiceStatus}</span>
      </div>}
      {active ? <>
        <button type="button" aria-label={muted ? "Unmute microphone" : "Mute microphone"} title={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted} className={muted ? "is-muted" : undefined} onClick={toggleMute}>{muted ? <MicOff size={17} aria-hidden="true" /> : <Mic size={17} aria-hidden="true" />}</button>
        {!embedded && <button type="button" aria-label="End voice call" title="End voice call" onClick={stopCall}><Square size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" /></button>}
      </> : !embedded && <button type="button" aria-label="Reconnect voice" title="Reconnect voice" onClick={start}><AudioLines size={18} /></button>}
      <button ref={summaryButton} type="button" aria-label="Voice options" title="Voice options" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><Ellipsis size={17} /></button>
      {!embedded && <button type="button" aria-label="Open chat" title="Open chat" onClick={() => { setExpanded(false); props.onOpenChat?.(); }}><MessageCircle size={17} /></button>}
    </div>
    {!props.clarificationHost && questionPanel && <div className="space-voice-call__question">{questionPanel}</div>}
    {props.hideConversationText && (error || notice) ? <div className="space-voice-call__notice" role={error ? "alert" : "status"}>
      {error || notice}
      {!error && readyResult && <button type="button" onClick={hearReadyResult}>Hear result</button>}
      {status === "disconnected" && props.enabled && voiceKeyConfigured && <button type="button" onClick={start}>Reconnect voice</button>}
    </div> : !embedded && (error || notice) && <button type="button" className="space-voice-call__notice" onClick={props.onShowConversation}>{error || notice}</button>}
    {props.hideConversationText && results.filter(job => job.state === "failed").map(job => <div key={job.id}
      className="space-voice-call__notice space-voice-call__research-error" role="alert" aria-label={`Research failed: ${job.subject}`}>
      <strong>{job.subject}</strong><span>{job.progress || "Research could not finish."}</span>
      {!job.receipt && <button type="button" onClick={() => retryResearch(job.id, job.revision)} aria-label={`Retry research: ${job.subject}`}>Retry research</button>}
    </div>)}
  </section>;
  // Only presentation moves. The call and research remain owned here. Outcomes
  // join Chat as transient content rather than a second worker-management panel.
  return <>
    {props.clarificationHost ? createPortal(questionPanel, props.clarificationHost) : null}
    {embedded ? <>
      {createPortal(active ? <div className="space-voice-call__scene" onKeyDown={escape}>{scene}<span className="space-voice-call__readiness" role="status">{voiceStatus}</span></div> : null, props.sceneHost!)}
      {createPortal(controls, props.controlsHost!)}
    </> : controls}
    {!props.hideConversationText && props.resultsHost ? createPortal(content, props.resultsHost) : null}
  </>;
}
