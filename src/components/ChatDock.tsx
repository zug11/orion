import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2, MessageCircle, Minus, Plus, X } from "../lib/icons";
import { isSelectedAIConfigured } from "../lib/ai";
import { ChatView, type ChatViewProps, type ChatComposerDraftContext } from "./ChatView";
import { useNativeChatGlass } from "./useNativeChatGlass";
import { SpaceVoice, type VoiceConversationContent } from "./SpaceVoice";
import type { VoicePresenceStore } from "../lib/voicePresence";
import type { VoiceSelectionStore } from "../lib/voiceSelection";
import type { IconPalette } from "../lib/themeIcon";
import type { AppSnapshot } from "../types";
import { hasChatThread, projectChatThread } from "../lib/chatThreads";
import "./ChatDock.css";
const noSelection = () => undefined;
const noSubscription = () => () => {};
const HISTORY_EXPANDED_KEY = "orion:chat-history-expanded:v1";
function restoredHistoryExpanded(): boolean {
  try { return window.localStorage.getItem(HISTORY_EXPANDED_KEY) === "true"; }
  catch { return false; }
}

interface ChatDockProps extends ChatViewProps {
  /** Full Space state for a retained voice conversation while another text chat is selected. */
  canonicalSnapshot?: AppSnapshot;
  fullPage: boolean;
  flowActive: boolean;
  onExpand: () => void;
  allowExpand?: boolean;
  voiceToggleRequest?: number;
  voicePresence?: VoicePresenceStore;
  voiceSelection?: VoiceSelectionStore;
  voicePalette?: IconPalette;
}

/** One mounted conversation/composer across the circle, panel and full Chat route. */
export function ChatDock({ canonicalSnapshot, fullPage, flowActive, onExpand, allowExpand = true, voiceToggleRequest, voicePresence, voicePalette, voiceSelection, ...chat }: ChatDockProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(fullPage);
  const [conversationKey, setConversationKey] = useState(0);
  const [threadsExpanded, setThreadsExpanded] = useState(restoredHistoryExpanded);
  function rememberThreadsExpanded(expanded: boolean) {
    setThreadsExpanded(expanded);
    // Local presentation preference; no note/vault save or provider request.
    try { window.localStorage.setItem(HISTORY_EXPANDED_KEY, String(expanded)); } catch { /* Keep the current window usable if storage is unavailable. */ }
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftContexts, setDraftContexts] = useState<Record<string, ChatComposerDraftContext | undefined>>({});
  const threadId = chat.threadNavigation?.activeThreadId ?? "chat-legacy";
  const draftKey = `${chat.snapshot.workspace.id}:${threadId}`;
  const selection = useSyncExternalStore(voiceSelection?.subscribe ?? noSubscription, voiceSelection?.getSnapshot ?? noSelection);
  const [expandedContexts, setExpandedContexts] = useState<Record<string, { noteId?: string; selection: typeof selection }>>(() => ({
    [draftKey]: { noteId: chat.focusNoteId, selection },
  }));
  const expandedContext = expandedContexts[draftKey]?.noteId;
  const expandedSelection = expandedContexts[draftKey]?.selection;
  const [voiceToggle, setVoiceToggle] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceVisible, setVoiceVisible] = useState(false);
  const [voiceThreadId, setVoiceThreadId] = useState(threadId);
  const [voiceSceneHost, setVoiceSceneHost] = useState<HTMLDivElement | null>(null);
  const [voiceControlsHost, setVoiceControlsHost] = useState<HTMLDivElement | null>(null);
  const [voiceResultsHost, setVoiceResultsHost] = useState<HTMLDivElement | null>(null);
  const [voiceClarificationHost, setVoiceClarificationHost] = useState<HTMLDivElement | null>(null);
  const [voiceContent, setVoiceContent] = useState<VoiceConversationContent>({ hasContent: false, revision: "" });
  const [voiceRevealRequest, setVoiceRevealRequest] = useState(0);
  const lastVoiceToggleRequest = useRef(voiceToggleRequest);
  useEffect(() => {
    if (lastVoiceToggleRequest.current === voiceToggleRequest) return;
    lastVoiceToggleRequest.current = voiceToggleRequest;
    // A new Space inherits the parent's counter, not the old microphone click.
    if (voiceToggleRequest) toggleVoice();
  }, [voiceToggleRequest]);
  const panelRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const circleRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const available = isSelectedAIConfigured(chat.snapshot.settings) && !flowActive;
  const visible = fullPage || (available && open);
  const navigationDisabled = chat.threadNavigation && voiceActive ? "End the voice call before switching chats." : chat.threadNavigation?.disabledReason;
  const threadNavigation = chat.threadNavigation ? { ...chat.threadNavigation,
    expanded: threadsExpanded, onExpandedChange: rememberThreadsExpanded, disabledReason: navigationDisabled,
    onSelect: (id: string) => { if (!navigationDisabled) chat.threadNavigation!.onSelect(id); },
    onNew: () => { if (!navigationDisabled) chat.threadNavigation!.onNew(); },
    onDelete: (id: string) => { if (!navigationDisabled) chat.threadNavigation!.onDelete(id); },
  } : undefined;
  const voiceThreadExists = !chat.threadNavigation || hasChatThread((canonicalSnapshot ?? chat.snapshot).studio, voiceThreadId);
  const inVoiceThread = voiceThreadId === threadId;
  const voiceSnapshot = useMemo(() => chat.threadNavigation
    ? projectChatThread(canonicalSnapshot ?? chat.snapshot, voiceThreadId) : chat.snapshot,
  [canonicalSnapshot, chat.snapshot, voiceThreadId, Boolean(chat.threadNavigation)]);
  const hasVoiceControls = Boolean(chat.onVoiceCommit && (voiceActive || inVoiceThread && voiceVisible));
  const voiceTitle = chat.threadNavigation?.threads.find(thread => thread.id === voiceThreadId)?.title || "the original chat";
  const nativeGlass = useNativeChatGlass(circleRef, available && !fullPage && !hasVoiceControls, open, chat.busy);

  useEffect(() => { if (visible) setHasOpened(true); }, [visible]);
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  useEffect(() => {
    if (!voiceThreadExists) {
      // Explicit or external deletion revokes the coordinator before a different
      // thread can receive its callbacks. Reset the click counter, not the mic.
      setVoiceToggle(0); setVoiceActive(false); setVoiceVisible(false);
      setVoiceContent({ hasContent: false, revision: "" }); setVoiceThreadId(threadId);
    } else if (!voiceActive && !voiceVisible && !voiceContent.hasContent && !inVoiceThread) {
      setVoiceThreadId(threadId);
    }
  }, [voiceThreadExists, voiceActive, voiceVisible, voiceContent.hasContent, inVoiceThread, threadId]);
  // Expanding a drafted "this note" question must retain its visible context.
  useEffect(() => {
    if (!fullPage) setExpandedContexts(current => current[draftKey]?.noteId === chat.focusNoteId && current[draftKey]?.selection === selection
      ? current : { ...current, [draftKey]: { noteId: chat.focusNoteId, selection } });
  }, [fullPage, chat.focusNoteId, selection, draftKey]);
  useEffect(() => {
    if (visible && !chat.busy) panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    // Opening changes focus; a completed response must not steal it from the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, fullPage, conversationKey, threadId, chat.passageChat?.key]);
  useEffect(() => {
    if (visible || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = returnFocus.current;
    if (target?.isConnected && !target.closest("[hidden]")) target.focus({ preventScroll: true });
    else (hasVoiceControls ? dockRef.current?.querySelector<HTMLButtonElement>('.space-voice-call__pill button[aria-label="Open chat"]') : buttonRef.current)?.focus({ preventScroll: true });
  }, [visible, hasVoiceControls]);

  function close() {
    restoreFocus.current = true;
    setOpen(false);
  }

  function newChat() {
    if (navigationDisabled || chat.busy) return;
    if (threadNavigation) threadNavigation.onNew();
    else {
      chat.onClear();
      setDrafts(current => ({ ...current, [draftKey]: "" }));
      setDraftContexts(current => ({ ...current, [draftKey]: undefined }));
      setConversationKey(value => value + 1);
    }
  }

  function showVoiceThread() {
    if (!voiceThreadExists) return false;
    if (!inVoiceThread) chat.threadNavigation?.onSelect(voiceThreadId);
    chat.passageChat?.onLeave();
    return true;
  }

  function toggleVoice() {
    if (!voiceThreadExists) return;
    if (!inVoiceThread && (voiceActive || voiceVisible || voiceContent.hasContent)) {
      if (chat.threadNavigation?.disabledReason || !showVoiceThread()) return;
    } else if (!inVoiceThread) setVoiceThreadId(threadId);
    setVoiceToggle(value => value + 1);
  }

  return <div ref={dockRef} className={fullPage ? "chat-dock chat-dock--page" : "chat-dock"} data-voice-visible={hasVoiceControls}>
    <div ref={panelRef} id="space-chat-panel" role="region" aria-label={`Chat in ${chat.snapshot.workspace.name}`}
      className="chat-dock__panel" hidden={!visible}
      onKeyDown={event => {
        if (event.key !== "Escape" || fullPage || event.defaultPrevented) return;
        // Citation inspectors and other nested overlays own their own Escape.
        if ((event.target as Element).closest('[role="dialog"],[role="menu"]')) return;
        event.stopPropagation(); close();
      }}>
      {!fullPage && <header className="chat-dock__header">
        <div><strong>Chat</strong><span title={chat.passageChat?.note.title ?? chat.snapshot.workspace.name}>{chat.passageChat?.note.title ?? chat.snapshot.workspace.name}</span></div>
        <nav aria-label="Chat controls">
          {chat.passageChat ? <button type="button" aria-label="Back to passage" title="Back to passage" onClick={chat.passageChat.onReturn}><MessageCircle size={15} /></button> : <button type="button" aria-label="New chat" title={navigationDisabled ?? "New chat"} disabled={chat.busy || !!navigationDisabled || (!threadNavigation && !chat.snapshot.studio.messages.length)} onClick={newChat}><Plus size={15} /></button>}
          {allowExpand && <button type="button" aria-label="Expand chat" title="Expand chat" onClick={onExpand}><Maximize2 size={14} /></button>}
          <button type="button" aria-label="Collapse chat" title="Collapse chat" onClick={close}><Minus size={17} /></button>
        </nav>
      </header>}
      {(hasOpened || visible) && <ChatView key={`${threadId}:${chat.passageChat?.key ?? "space"}:${conversationKey}`} {...chat}
        threadNavigation={threadNavigation} onClear={newChat}
        composerDraft={{ value: drafts[draftKey] ?? "", onChange: value => setDrafts(current => current[draftKey] === value ? current : { ...current, [draftKey]: value }),
          context: draftContexts[draftKey], onContextChange: context => setDraftContexts(current => current[draftKey] === context ? current : { ...current, [draftKey]: context }) }}
        suggestionSeed={conversationKey * 2} focusNoteId={fullPage ? expandedContext : chat.focusNoteId} compact={!fullPage} visible={visible} voiceEnabled={!flowActive}
        selection={fullPage ? expandedSelection : selection}
        voiceControl={{ active: voiceActive && inVoiceThread, toggle: toggleVoice,
          ...(!inVoiceThread && (voiceVisible || voiceContent.hasContent) ? { label: `Resume voice in ${voiceTitle}` } : {}) }}
        dockPanelRef={panelRef}
        voiceSceneRef={setVoiceSceneHost} voiceControlsRef={setVoiceControlsHost} voiceClarificationRef={setVoiceClarificationHost} voicePalette={voicePalette}
        voiceResultsRef={setVoiceResultsHost} voiceContent={!fullPage && inVoiceThread ? voiceContent : undefined} voiceRevealRequest={voiceRevealRequest}
        onCommentReply={chat.onCommentReply ? async (id, selected) => { await chat.onCommentReply!(id, selected); setOpen(false); } : undefined}
        onReviewEdit={chat.onReviewEdit ? proposal => { setOpen(false); return chat.onReviewEdit!(proposal); } : undefined} />}
    </div>
    <div ref={circleRef} className="chat-dock__circle" data-native-chat-glass={nativeGlass || undefined} hidden={!available || fullPage || hasVoiceControls}>
      <button ref={buttonRef} type="button" className="chat-dock__toggle"
        aria-label={open ? "Close chat" : "Open chat"} title={open ? "Close chat" : "Chat with your Space"}
        aria-expanded={open} aria-controls="space-chat-panel"
        onPointerDown={() => { if (!open && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement; }}
        onClick={() => { if (open) close(); else setOpen(true); }}>
        {open ? <X size={19} /> : <MessageCircle size={20} strokeWidth={1.6} />}
      </button>
      {chat.busy && <span className="chat-dock__working" role="status" aria-label="Chat is working" />}
    </div>
    {chat.onVoiceCommit && voiceThreadExists && <SpaceVoice snapshot={voiceSnapshot} conversationId={voiceThreadId} focusNoteId={chat.focusNoteId}
      enabled={!flowActive} floating presence={voicePresence} voicePalette={voicePalette} voiceSelection={voiceSelection}
      presentationHidden={!inVoiceThread && !voiceActive}
      hideConversationText={fullPage}
      toggleRequest={voiceToggle} onActiveChange={setVoiceActive} onVisibleChange={setVoiceVisible} commit={chat.onVoiceCommit}
      onPrepareVoiceConnection={chat.onPrepareVoiceConnection}
      onProposal={result => {
        if (!result.editProposal) return;
        if (!chat.onReviewEdit) throw new Error("The note review is unavailable in this view.");
        return chat.onReviewEdit(result.editProposal);
      }}
      onOpenNote={chat.onOpenNote} onOpenSource={chat.onOpenSource} onOpenSettings={chat.onOpenSettings}
      chatVisible={visible && inVoiceThread} sceneHost={inVoiceThread ? voiceSceneHost : null} controlsHost={inVoiceThread ? voiceControlsHost : null}
      resultsHost={inVoiceThread ? voiceResultsHost : null} clarificationHost={visible && inVoiceThread ? voiceClarificationHost : null} onConversationContentChange={setVoiceContent}
      onShowConversation={() => { if (showVoiceThread()) { setOpen(true); setVoiceRevealRequest(value => value + 1); } }}
      onCloseChat={!fullPage ? close : undefined}
      onOpenChat={() => { if (showVoiceThread() && !fullPage) setOpen(true); }} />}
  </div>;
}
