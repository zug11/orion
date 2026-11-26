import { artifactFormatNames } from "../lib/visualArtifacts";
import { readVisualArtifactMarker } from "../lib/visualArtifactMarkdown";
import { visualFollowUp } from "../lib/chatVisualIntent";
import { VisualArtifactView } from "./VisualArtifactView";
import type { ChatVisualPreview } from "../lib/chatVisual";
import { resolveWebResearchProvider, webResearchUnavailableReason } from "../lib/webResearchProvider";
import { isChatGPTModel, manageChatGPTUsage } from "../lib/chatgpt";
import {
  ArrowUp,
  ChevronDown,
  AudioLines,
  Bot,
  BookOpenText,
  Globe,
  Layers3,
  MessageCircle,
  Plus,
  RefreshCw,
  Settings2,
  Square,
} from "../lib/icons";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefCallback,
  type RefObject,
} from "react";
import { useVoiceChatScroll } from "./useVoiceChatScroll";
import "./VoiceChatScroll.css";
import type { VoiceSelection } from "../lib/voiceSelection";
import { PassageThreadConversation, type PassageChatContext } from "./PassageThreads";
import { passageIsCurrent } from "../lib/passageThreads";
import { ChatReply } from "./ChatReply";
import { ChatThreads, type ChatThreadNavigation } from "./ChatThreads";
import type { AppSnapshot, ChatResult, ChatEditProposal } from "../types";
import { SpaceVoice, type VoiceConversationContent } from "./SpaceVoice";
import { VoiceConstellation } from "./VoiceConstellation";
import type { IconPalette } from "../lib/themeIcon";
import type { VoiceCommit, VoiceReceipt } from "../lib/voiceResearch";
import type { PrepareVoiceConnection } from "../lib/liveVoice";
import { ChatEditPreview } from "./ChatEditPreview";
import { ChatNoteActions } from "./ChatNoteActions";
import type { ChatNoteReceipt, UseChatReply } from "../lib/chatNoteActions";
import { useChatSuggestions } from "./useChatSuggestions";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "../lib/ai";

export interface ChatComposerDraftContext {
  spaceId: string;
  noteId?: string;
  title?: string;
  editing: boolean;
}

export interface ChatViewProps {
  passageChat?: PassageChatContext;
  onVoiceCommit?: (request: VoiceCommit) => Promise<VoiceReceipt>;
  onPrepareVoiceConnection?: PrepareVoiceConnection;
  voiceEnabled?: boolean;
  voiceControl?: { active: boolean; toggle: () => void; label?: string };
  threadNavigation?: ChatThreadNavigation;
  composerDraft?: {
    value: string;
    onChange: (value: string) => void;
    context?: ChatComposerDraftContext;
    onContextChange?: (context: ChatComposerDraftContext | undefined) => void;
  };
  /** Stable portal destinations for the window-owned call. Neither starts audio. */
  voiceSceneRef?: RefCallback<HTMLDivElement>;
  voiceControlsRef?: RefCallback<HTMLDivElement>;
  voiceResultsRef?: RefCallback<HTMLDivElement>;
  voiceClarificationRef?: RefCallback<HTMLDivElement>;
  voiceContent?: VoiceConversationContent;
  voiceRevealRequest?: number;
  voicePalette?: IconPalette;
  /** Only the compact dock can grow; full Chat retains its page layout. */
  dockPanelRef?: RefObject<HTMLDivElement | null>;
  snapshot: AppSnapshot;
  busy: boolean;
  progress?: string;
  visualPreview?: ChatVisualPreview;
  onCancel?: () => void;
  onSend: (prompt: string, focusNoteId?: string, selection?: VoiceSelection, webEnabled?: boolean, visualRequested?: boolean) => Promise<ChatResult>;
  selection?: VoiceSelection;
  onCommentReply?: (messageId: string, selection?: VoiceSelection) => Promise<void>;
  onReviewEdit?: (proposal: ChatEditProposal) => Promise<boolean>;
  compact?: boolean;
  visible?: boolean;
  /** Transient parent conversation reset; never persisted. */
  suggestionSeed?: number;
  focusNoteId?: string;
  onClear: () => void;
  onOpenNote: (noteId: string) => void;
  onOpenSource?: (sourceId: string) => void;
  onUseReply?: UseChatReply;
  onSaveReply: (messageId: string) => Promise<ChatNoteReceipt>;
  onOpenSettings: () => void;
}

const idleVoiceActivity = { inputActive: false, outputActive: false, measured: false, inputLevel: 0, outputLevel: 0,
  inputMeasured: false, outputMeasured: false, inputMuted: false };
const noVoiceAction = () => {};

function sizeComposer(input: HTMLTextAreaElement) {
  const field = input.parentElement;
  if (!field || !field.clientWidth) return;
  // Measure the one-line layout first so shrinking text can return to a pill.
  // Observe the outer width, not this textarea's width: expanding moves the
  // controls onto their own row and must not create a resize feedback loop.
  field.removeAttribute("data-multiline");
  input.style.height = "auto";
  const style = getComputedStyle(input);
  const oneLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
  if (input.scrollHeight > oneLine + 1) field.setAttribute("data-multiline", "true");
  input.style.height = `${input.scrollHeight}px`;
}


export function ChatView({
  snapshot,
  threadNavigation,
  composerDraft,
  passageChat,
  onVoiceCommit,
  onPrepareVoiceConnection,
  voiceEnabled = true,
  voiceControl,
  voiceSceneRef,
  voiceControlsRef,
  voiceResultsRef,
  voiceClarificationRef,
  voiceContent,
  voiceRevealRequest,
  voicePalette,
  dockPanelRef,
  busy,
  progress,
  visualPreview,
  onCancel,
  onSend,
  onReviewEdit,
  onClear,
  onOpenNote,
  onOpenSource,
  onSaveReply,
  onUseReply,
  onCommentReply,
  onOpenSettings,
  compact = false,
  visible = true,
  suggestionSeed = 0,
  focusNoteId,
  selection,
}: ChatViewProps) {
  const [visualRequested, setVisualRequested] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const draft = composerDraft?.value ?? localDraft;
  const setDraft = composerDraft?.onChange ?? setLocalDraft;
  const [localThreadsOpen, setLocalThreadsOpen] = useState(false);
  const [threadsOverlay, setThreadsOverlay] = useState(false);
  const threadsOpen = threadNavigation?.expanded ?? localThreadsOpen;
  const showThreads = Boolean(threadNavigation && !compact && !passageChat);
  const threadsId = useId();
  const viewRef = useRef<HTMLElement>(null);
  const threadsToggleRef = useRef<HTMLButtonElement>(null);
  function setThreadsOpen(open: boolean) {
    setLocalThreadsOpen(open);
    threadNavigation?.onExpandedChange?.(open);
    if (!open) requestAnimationFrame(() => threadsToggleRef.current?.focus({ preventScroll: true }));
  }
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view || !showThreads) return;
    const measure = () => { if (view.clientWidth > 0) setThreadsOverlay(view.clientWidth < 780); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(view);
    return () => observer.disconnect();
  }, [showThreads]);
  const webRoute = resolveWebResearchProvider(snapshot.settings);
  const webAvailable = !!webRoute;
  const webRouteKey = webRoute ? JSON.stringify([webRoute.provider, webRoute.provider === "openai" ? webRoute.model : null,
    webRoute.label === "ChatGPT plan" ? snapshot.settings.chatgptAccountId ?? "" : null]) : "";
  const [webChoice, setWebChoice] = useState({ spaceId: snapshot.workspace.id, routeKey: webRouteKey, enabled: false });
  const webEnabled = webChoice.spaceId === snapshot.workspace.id && webChoice.routeKey === webRouteKey && webChoice.enabled && webAvailable;
  // A different connection needs a fresh opt-in, including Automatic changing
  // providers after key removal or selecting another ChatGPT account.
  useEffect(() => { setWebChoice({ spaceId: snapshot.workspace.id, routeKey: webRouteKey, enabled: false }); }, [snapshot.workspace.id, webRouteKey]);
  const [threadBusy, setThreadBusy] = useState(false);
  const [voiceToggle, setVoiceToggle] = useState(0);
  const [localVoiceActive, setVoiceActive] = useState(false);
  const voiceActive = voiceControl?.active ?? localVoiceActive;
  const toggleVoice = () => { if (voiceControl) voiceControl.toggle(); else setVoiceToggle(value => value + 1); };
  const [submitting, setSubmitting] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editProposal, setEditProposal] = useState<ChatEditProposal>();
  const [editRevision, setEditRevision] = useState(0);
  const [suggestionRevision, setSuggestionRevision] = useState(0);
  const [localSuggestedContext, setLocalSuggestedContext] = useState<ChatComposerDraftContext>();
  const suggestedContext = composerDraft?.onContextChange ? composerDraft.context : localSuggestedContext;
  const setSuggestedContext = composerDraft?.onContextChange ?? setLocalSuggestedContext;
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Grow only the composer; audio frames never participate in text measurement.
  useLayoutEffect(() => {
    const input = composerRef.current;
    if (input) sizeComposer(input);
  }, [draft, visible, compact, voiceActive]);
  useLayoutEffect(() => {
    const input = composerRef.current;
    const field = input?.parentElement;
    if (!input || !field || typeof ResizeObserver === "undefined") return;
    const actions = field.querySelector<HTMLElement>(".chat-composer__actions");
    let width = field.clientWidth, actionsWidth = actions?.clientWidth ?? 0;
    const observer = new ResizeObserver(() => {
      const nextActionsWidth = actions?.clientWidth ?? 0;
      if (!field.clientWidth || (field.clientWidth === width && nextActionsWidth === actionsWidth)) return;
      width = field.clientWidth; actionsWidth = nextActionsWidth;
      sizeComposer(input);
    });
    observer.observe(field);
    if (actions) observer.observe(actions);
    return () => observer.disconnect();
  }, [passageChat?.key]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messages = snapshot.studio.messages;
  const noteById = useMemo(
    () => new Map(snapshot.notes.map((note) => [note.id, note])),
    [snapshot.notes],
  );
  const hasKnowledge =
    snapshot.notes.length > 0 ||
    snapshot.sources.length > 0 ||
    snapshot.concepts.length > 0;
  const canSend = isSelectedAIConfigured(snapshot.settings);
  const providerName = selectedAIProviderName(snapshot.settings);
  const isSending = busy || submitting;
  const threadDisabledReason = threadNavigation?.disabledReason ?? (isSending ? "Wait for this reply or stop it before changing chats." : undefined);
  const externalVoiceActive = voiceControl?.active === true;
  const hasThreadContent = !!passageChat || messages.length > 0 || Boolean(pendingPrompt || error || editProposal || voiceContent?.hasContent) || isSending;
  const scrollVoice = compact && externalVoiceActive && !passageChat && !!dockPanelRef;
  let latestReply = "";
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === "assistant") { latestReply = `${messages[index].id}:${messages[index].content.length}`; break; }
  }
  const voiceScroll = useVoiceChatScroll({ enabled: scrollVoice, active: externalVoiceActive, visible,
    hasContent: hasThreadContent, panelRef: dockPanelRef, replyKey: `${latestReply}:${voiceContent?.revision ?? ""}`,
    contentKey: `${messages.length}:${messages[messages.length - 1]?.content.length ?? 0}:${isSending}:${!!pendingPrompt}:${editRevision}:${voiceContent?.revision ?? ""}` });
  const latestMessage = messages[messages.length - 1];
  const followUp = useMemo(() => {
    const artifact = latestMessage?.role === "assistant" && latestMessage.visualArtifact && readVisualArtifactMarker(latestMessage.visualArtifact);
    return artifact ? visualFollowUp(artifact) : undefined;
  }, [latestMessage]);
  const lastVoiceRevealRequest = useRef<number | undefined>(0);
  useEffect(() => {
    if (lastVoiceRevealRequest.current === voiceRevealRequest) return;
    lastVoiceRevealRequest.current = voiceRevealRequest;
    if (voiceRevealRequest) {
      if (scrollVoice) voiceScroll.showMessages(true);
      else messagesEndRef.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [voiceRevealRequest, voiceScroll.showMessages]);
  const focusNote = focusNoteId ? noteById.get(focusNoteId) : undefined;
  const suggestionCount = compact ? 2 : 4;
  const suggestions = useChatSuggestions(snapshot, {
    enabled: !passageChat && visible && canSend && messages.length === 0 && !draft.trim() && !voiceActive && !isSending,
    focusNoteId: focusNote?.id,
    seed: suggestionSeed + suggestionRevision,
  });

  useEffect(() => {
    if (visible && !scrollVoice) messagesEndRef.current?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
    });
  }, [isSending, messages.length, pendingPrompt, visible, editProposal, scrollVoice]);

  async function submitPrompt(prompt = draft) {
    const normalized = prompt.trim();
    if (!normalized || isSending) {
      return;
    }
    if (!canSend) {
      setError(`Add an ${providerName} API key in Settings to start chatting.`);
      return;
    }
    const target = suggestedContext && prompt === draft ? suggestedContext : undefined;
    if (target && (target.spaceId !== snapshot.workspace.id || (target.noteId && !noteById.has(target.noteId)))) {
      setError(`This suggestion’s original ${target.title ? `note “${target.title}”` : "Space"} is no longer available here. Clear this draft to start a new request.`);
      return;
    }
    const sendNoteId = target ? target.noteId : focusNote?.id;
    const capturedSelection = selection?.spaceId === snapshot.workspace.id && selection.noteId === sendNoteId
      ? structuredClone(selection) : undefined;

    voiceScroll.previewPrompt();
    setDraft("");
    setError(null);
    setPendingPrompt(normalized);
    setSubmitting(true);
    try {
      const result = await (visualRequested ? onSend(normalized, sendNoteId, capturedSelection, webEnabled, true)
        : webEnabled ? onSend(normalized, sendNoteId, capturedSelection, true)
        : capturedSelection ? onSend(normalized, sendNoteId, capturedSelection)
        : sendNoteId ? onSend(normalized, sendNoteId) : onSend(normalized));
      setVisualRequested(false);
      setEditProposal(result.editProposal);
      setEditRevision(revision => revision + 1);
      setSuggestedContext(undefined);
      setPendingPrompt("");
    } catch (sendError) {
      setDraft(normalized);
      setError(
        sendError instanceof Error ? sendError.message : String(sendError),
      );
    } finally {
      setPendingPrompt("");
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrompt();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void submitPrompt();
    }
  }

  function startNewChat() {
    if (threadDisabledReason) return;
    // With real threads, New chat selects a new empty conversation. The current
    // controlled draft belongs to its original thread and must survive leaving.
    if (threadNavigation) {
      threadNavigation.onNew();
      if (threadsOverlay) setThreadsOpen(false);
      return;
    }
    onClear();
    setEditProposal(undefined);
    setDraft("");
    setSuggestedContext(undefined);
    setPendingPrompt("");
    setError(null);
    setSuggestionRevision(value => value + 1);
  }

  return (
    <section ref={viewRef} className={`chat-view view${passageChat ? " passage-chat" : ""}${compact ? " chat-view--compact" : ""}${showThreads ? " chat-view--threaded" : ""}`}
      data-voice-active={externalVoiceActive} data-voice-empty={!hasThreadContent} data-voice-scroll={scrollVoice}
      data-threads-expanded={showThreads && threadsOpen} data-threads-overlay={showThreads && threadsOverlay}>
      <header className="chat-view__header" inert={showThreads && threadsOpen && threadsOverlay ? true : undefined}>
        <div className="chat-view__title">
          <span className="eyebrow">
            <MessageCircle size={12} />
            {passageChat ? "Passage conversation" : "Space intelligence"}
          </span>
          <h1>Chat</h1>
          {passageChat ? <p><button type="button" className="passage-chat__return" disabled={threadBusy} onClick={passageChat.onReturn}>Back to {passageChat.note.title}</button></p> : <p>
            Ask across everything in{" "}<strong>{snapshot.workspace.name}</strong>.
          </p>}
        </div>

        <div className="chat-view__header-actions">
          {!passageChat && <div className="chat-view__scope" aria-label="Chat knowledge scope">
            <span>
              <strong>{snapshot.notes.length}</strong>
              notes
            </span>
            <span>
              <strong>{snapshot.sources.length}</strong>
              sources
            </span>
            <span>
              <strong>{snapshot.concepts.length}</strong>
              concepts
            </span>
          </div>}
          {passageChat && <button type="button" className="chat-view__new" disabled={threadBusy} onClick={passageChat.onLeave}><MessageCircle size={14} />Space chat</button>}
          {!passageChat && (messages.length > 0 || threadNavigation) && (!showThreads || !threadsOpen) && (
            <button
              type="button"
              className="chat-view__new"
              onClick={startNewChat}
              disabled={Boolean(threadDisabledReason)}
              title={threadDisabledReason}
            >
              <Plus size={14} />
              New chat
            </button>
          )}
        </div>
      </header>

      <div className="chat-view__body">
      <div className="chat-view__stage" ref={voiceScroll.stageRef} tabIndex={scrollVoice ? 0 : undefined}
        inert={showThreads && threadsOpen && threadsOverlay ? true : undefined}
        aria-label={scrollVoice ? "Voice and text conversation" : undefined}>
        <div className="chat-view__voice-intro" inert={scrollVoice && voiceScroll.phase === "messages"}>
          <div className="chat-view__voice-scene" ref={voiceSceneRef} />
          {scrollVoice && hasThreadContent && <button type="button" className="chat-view__conversation-cue"
            onClick={() => voiceScroll.showMessages(voiceScroll.newReply)}>
            {voiceScroll.newReply ? "New reply" : "Conversation"}<ChevronDown size={14} />
          </button>}
        </div>
        {passageChat ? <PassageThreadConversation key={passageChat.key} thread={passageChat.thread}
          current={passageIsCurrent(passageChat.note, passageChat.thread.anchor)} onAction={passageChat.onAction}
          references={{ notes: snapshot.notes, sources: snapshot.sources, onOpenNote, onOpenSource }}
          initialDraft={passageChat.draft} active={visible} onBusyChange={setThreadBusy}
          intro={<blockquote className="passage-chat__anchor">{passageChat.thread.anchor.scope === "note" ? "About this note" : passageChat.thread.anchor.text.slice(0, 600)}</blockquote>}
          between={<><div className="chat-view__clarification" ref={voiceClarificationRef} /><div className="chat-view__voice-controls" ref={voiceControlsRef} /></>} /> : <>
        <div className="chat-view__thread" ref={voiceScroll.threadRef} aria-live="polite" hidden={externalVoiceActive && !hasThreadContent}
          tabIndex={scrollVoice ? 0 : undefined} aria-label={scrollVoice ? "Conversation messages" : undefined}
          inert={scrollVoice && voiceScroll.phase === "voice" && !voiceScroll.peeking}>
          {scrollVoice && <nav className="chat-view__reading-nav" aria-label="Conversation view">
            <button type="button" onClick={voiceScroll.showVoice}><AudioLines size={14} />Voice</button>
            {voiceScroll.newReply && <button type="button" onClick={() => voiceScroll.showMessages(true)}>New reply<ChevronDown size={13} /></button>}
          </nav>}
          <div className="chat-view__thread-content" ref={voiceScroll.contentRef}>
          {!externalVoiceActive && messages.length === 0 && !pendingPrompt && !voiceContent?.hasContent ? (
            <div className="chat-welcome">
              <div className="chat-welcome__voice" aria-hidden="true">
                <VoiceConstellation settings={snapshot.settings} status="idle" activity={idleVoiceActivity} muted={false} jobs={[]}
                  size="expanded" interactive={false} palette={voicePalette} onFocus={noVoiceAction} onDismiss={noVoiceAction} />
              </div>
              <span className="eyebrow">Orion is listening</span>
              <h2>{compact ? "A little room to think." : "Think with your whole Space."}</h2>
              <p>
                {hasKnowledge
                  ? "Follow a connection, develop a draft, or turn what’s here into something new."
                  : "Start with an idea, a question, or a first draft. Your Space can grow from there."}
              </p>

              {!canSend ? (
                <button
                  type="button"
                  className="chat-welcome__settings"
                  onClick={onOpenSettings}
                >
                  <Settings2 size={14} />
                  Configure {providerName} key
                </button>
              ) : !draft.trim() && !voiceActive && (
                <div className="chat-welcome__suggestions">
                  {suggestions.status !== "empty" && <div className="chat-welcome__suggestions-header">
                    <span>{focusNote ? "From this note & Space" : "Ideas for this Space"}</span>
                    <button
                      type="button"
                      className="chat-welcome__refresh"
                      aria-label="Refresh suggested prompts"
                      title="More ideas"
                      disabled={isSending || suggestions.status === "loading"}
                      onClick={suggestions.refresh}
                    ><RefreshCw size={13} aria-hidden="true" /></button>
                  </div>}
                  {suggestions.status === "loading" && <p className="chat-welcome__suggestion-status" role="status">Finding ideas in your Space…</p>}
                  {suggestions.status === "error" && <p className="chat-welcome__suggestion-status" role="status">Couldn’t find suggestions just now. Try Refresh, or start with your own thought.</p>}
                  {suggestions.status === "empty" && hasKnowledge && <p className="chat-welcome__suggestion-status">Ideas will appear as you add writing or source material to this Space.</p>}
                  {suggestions.suggestions.length > 0 && <div className="chat-welcome__prompts" role="group" aria-label="Suggested prompts">
                  {suggestions.suggestions.slice(0, suggestionCount).map((suggestion) => (
                    <button
                      type="button"
                      key={suggestion.prompt}
                      disabled={isSending}
                      onClick={() => {
                        setDraft(suggestion.prompt);
                        const target = suggestions.targetNoteId ? noteById.get(suggestions.targetNoteId) : undefined;
                        setSuggestedContext({ spaceId: snapshot.workspace.id, noteId: target?.id, title: target?.title, editing: suggestion.intent === "edit" });
                        setError(null);
                        composerRef.current?.focus();
                      }}
                    >
                      <span>{suggestion.prompt}</span>
                      <ArrowUp size={13} aria-hidden="true" />
                    </button>
                  ))}
                  </div>}
                </div>
              )}
            </div>
          ) : (
            messages.map((message) => {
              return (
                <article
                  className={`chat-message chat-message--${message.role}`}
                  key={message.id}
                >
                <div className="chat-message__identity">
                  {message.role === "assistant" ? (
                    <>
                      <span className="chat-message__avatar" aria-hidden="true">
                        <Bot size={12} />
                      </span>
                      <span>Orion</span>
                    </>
                  ) : (
                    <span>You</span>
                  )}
                </div>
                  {message.role === "assistant" ? (
                    <>
                      <ChatReply snapshot={snapshot} message={message} onOpenNote={onOpenNote} onOpenSource={onOpenSource} />
                      {followUp && latestMessage === message && !draft && <button type="button" className="chat-visual-follow-up"
                        disabled={isSending} onClick={() => {
                          setSuggestedContext(undefined);
                          setDraft(followUp);
                          composerRef.current?.focus();
                        }}>{followUp}</button>}
                      {onCommentReply && (message.passage || selection) && <button type="button" className="button quiet" disabled={submitting} onClick={() => {
                        setSubmitting(true); setError(null);
                        void onCommentReply(message.id, selection).catch(error => setError(error instanceof Error ? error.message : String(error))).finally(() => setSubmitting(false));
                      }}>Comment on passage</button>}
                      <ChatNoteActions key={`${snapshot.workspace.id}:${message.id}`} snapshot={snapshot} message={message}
                        focusNote={focusNote} busy={isSending} onUseReply={onUseReply} onSaveReply={onSaveReply}
                        onOpenNote={onOpenNote} onReviewEdit={onReviewEdit} />
                    </>
                  ) : (
                    <p className="chat-message__body chat-message__body--plain">
                      {message.content}
                    </p>
                  )}
                </article>
              );
            })
          )}

          {editProposal && onReviewEdit && <ChatEditPreview key={editRevision}
            proposal={editProposal} snapshot={snapshot} busy={isSending} onReview={onReviewEdit}
            onDiscard={() => setEditProposal(undefined)} />}

          {pendingPrompt && (
            <article className="chat-message chat-message--user pending">
              <div className="chat-message__identity">
                <span>You</span>
              </div>
              <p className="chat-message__body chat-message__body--plain">
                {pendingPrompt}
              </p>
            </article>
          )}

          {isSending && visualPreview && <article className="chat-message chat-message--assistant" aria-label="Orion's reply">
            <ChatReply snapshot={snapshot} message={{ ...visualPreview.answer, content: visualPreview.answer.reply, id: "visual-preview", role: "assistant", cardIds: [], contextCardIds: [], createdAt: "" }}
              onOpenNote={onOpenNote} onOpenSource={onOpenSource} />
            {visualPreview.model && <p className="chat-message__status" role="status">Drawing with {visualPreview.model}</p>}
            {visualPreview.artifact ? <VisualArtifactView artifact={visualPreview.artifact} />
              : visualPreview.heading && <section className="visual-artifact" aria-busy="true" aria-label={visualPreview.heading.title}>
                <header className="visual-artifact__header">
                  {visualPreview.heading.format !== "custom" && <span className="visual-artifact__format"><Layers3 size={14} />{artifactFormatNames[visualPreview.heading.format]}</span>}
                  <h3>{visualPreview.heading.title}</h3>
                  {visualPreview.heading.summary && <p>{visualPreview.heading.summary}</p>}
                </header>
              </section>}
          </article>}
          {isSending && (
            <article
              className="chat-message chat-message--assistant chat-message--thinking"
              aria-label="Orion is thinking"
            >
              <span className="chat-message__avatar" aria-hidden="true">
                <Bot size={12} />
              </span>
              <span>{progress || "Reading your Space"}</span>
              <span className="chat-thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </article>
          )}
          <div className="chat-view__voice-results" ref={voiceResultsRef} />
          <div ref={messagesEndRef} />
          </div>
          {scrollVoice && <div className="chat-view__prompt-tail" aria-hidden="true" />}
        </div>

        <div className="chat-composer">
        <div className="chat-view__clarification" ref={voiceClarificationRef} />
        <form onSubmit={handleSubmit}>
          {selection?.spaceId === snapshot.workspace.id && selection.noteId === focusNote?.id && (
            <div className="chat-composer__suggested-target" title={selection.text.slice(0, 240)}>
              <span>Selected text</span><span>{selection.noteTitle}</span>
            </div>
          )}
          {suggestedContext?.noteId && draft.trim() && suggestedContext.noteId !== focusNote?.id && (
            <div className="chat-composer__suggested-target">
              <span>{suggestedContext.editing ? "Editing" : "Attached"}</span>
              <button type="button" disabled={suggestedContext.spaceId !== snapshot.workspace.id || !noteById.has(suggestedContext.noteId)}
                onClick={() => { if (suggestedContext.noteId) onOpenNote(suggestedContext.noteId); }}>{suggestedContext.title}</button>
            </div>
          )}
          {onVoiceCommit && !voiceControl && <SpaceVoice snapshot={snapshot} focusNoteId={focusNote?.id} enabled={voiceEnabled} commit={onVoiceCommit} toggleRequest={voiceToggle} onActiveChange={setVoiceActive}
            onPrepareVoiceConnection={onPrepareVoiceConnection}
            onProposal={result => { if (result.editProposal) { setEditProposal(result.editProposal); setEditRevision(value => value + 1); } }}
            onOpenNote={onOpenNote} onOpenSource={onOpenSource} onOpenSettings={onOpenSettings} />}
          {error && (
            <div className="chat-composer__error" role="alert">
              <span>{error}</span>
              {isChatGPTModel(snapshot.settings.model) && /usage|limit/i.test(error) && <button type="button" onClick={() => void manageChatGPTUsage().catch(onOpenSettings)}>Manage usage</button>}
              {!canSend && (
                <button type="button" onClick={onOpenSettings}>
                  Open settings
                </button>
              )}
            </div>
          )}
          <div className="chat-composer__field">
            <textarea
              ref={composerRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (!event.target.value.trim()) setSuggestedContext(undefined);
              }}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                canSend
                  ? `Ask about ${snapshot.workspace.name}…`
                  : isChatGPTModel(snapshot.settings.model) ? "Connect ChatGPT in Settings to start chatting…" : `Add an ${providerName} key to start chatting…`
              }
              aria-label="Message Orion"
              rows={1}
              maxLength={8_000}
              disabled={isSending || !canSend}
            />
            <div className="chat-composer__actions">
              <div className="chat-view__voice-controls" ref={voiceControlsRef} />
              {isSending && onCancel ? <button key="stop-response" type="button" onClick={(event) => {
                event.preventDefault();
                onCancel();
              }} aria-label="Stop response" title="Stop response" className="chat-composer__stop">
                <Square size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              </button> : draft.trim() ? <button key="send" type="submit" disabled={isSending || !canSend} aria-label="Send message" title="Send message">
                <ArrowUp size={17} aria-hidden="true" />
              </button> : voiceActive ? <button key="stop-voice" type="button" className="chat-composer__voice"
                aria-label="Stop voice" title="Stop voice" onClick={(event) => { event.preventDefault(); toggleVoice(); }}>
                <Square size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              </button> : onVoiceCommit ? <button key="start-voice" type="button" className="chat-composer__voice" disabled={!voiceEnabled || isSending}
                aria-label={voiceControl?.label ?? "Talk to Space"} title={voiceControl?.label ?? "Talk to Space"} onClick={toggleVoice}>
                <AudioLines size={19} strokeWidth={1.8} aria-hidden="true" />
              </button> : <button key="empty-send" type="submit" disabled aria-label="Send message" title="Send message">
                <ArrowUp size={17} aria-hidden="true" />
              </button>}
            </div>
          </div>
          <div className="chat-composer__footer">
            {isChatGPTModel(snapshot.settings.model) && <button type="button" className="chat-web-toggle" onClick={() => void manageChatGPTUsage().catch(onOpenSettings)}>Using ChatGPT plan · Manage usage</button>}
            <button type="button" className="chat-web-toggle" aria-pressed={visualRequested} disabled={isSending || !canSend}
              title="Include an interactive visual with the next reply" onClick={() => setVisualRequested(value => !value)}>
              <Layers3 size={13} aria-hidden="true" />Visualise
            </button>
            <button type="button" className="chat-web-toggle" aria-pressed={webEnabled}
              disabled={isSending} title={webRoute ? `Include web research via ${webRoute.label} when useful for this conversation` : webResearchUnavailableReason(snapshot.settings)}
              onClick={() => {
                if (!webAvailable) { onOpenSettings(); return; }
                setWebChoice({ spaceId: snapshot.workspace.id, routeKey: webRouteKey, enabled: !webEnabled });
              }}><Globe size={13} aria-hidden="true" />Web</button>
            <span>
              <BookOpenText size={11} />
              {webEnabled ? "Space + web" : "Grounded in this Space only"}
            </span>
            <span>Enter to send · Shift Enter for a new line</span>
          </div>
        </form>
        </div>
        </>}
      </div>
      </div>
      {showThreads && threadNavigation && <>
        {threadsOpen && threadsOverlay && <button type="button" className="chat-view__threads-backdrop" aria-label="Close chat threads" tabIndex={-1} onClick={() => setThreadsOpen(false)}/>}
        <ChatThreads {...threadNavigation} id={threadsId} spaceName={snapshot.workspace.name}
          expanded={threadsOpen} onExpandedChange={setThreadsOpen} toggleRef={threadsToggleRef}
          disabledReason={threadDisabledReason} overlay={threadsOverlay} onClose={() => setThreadsOpen(false)}
          onNew={startNewChat} onSelect={id => {
            if (threadDisabledReason) return;
            threadNavigation.onSelect(id);
            if (threadsOverlay) setThreadsOpen(false);
          }}/>
      </>}
    </section>
  );
}
