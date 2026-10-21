import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2, MessageCircle, Minus, Plus, X } from "../lib/icons";
import { isSelectedAIConfigured } from "../lib/ai";
import { ChatView, type ChatViewProps } from "./ChatView";
import { useNativeChatGlass } from "./useNativeChatGlass";
import { SpaceVoice } from "./SpaceVoice";
import type { VoicePresenceStore } from "../lib/voicePresence";
import type { VoiceSelectionStore } from "../lib/voiceSelection";
import type { IconPalette } from "../lib/themeIcon";
import "./ChatDock.css";
const noSelection = () => undefined;
const noSubscription = () => () => {};

interface ChatDockProps extends ChatViewProps {
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
export function ChatDock({ fullPage, flowActive, onExpand, allowExpand = true, voiceToggleRequest, voicePresence, voicePalette, voiceSelection, ...chat }: ChatDockProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(fullPage);
  const [conversationKey, setConversationKey] = useState(0);
  const [expandedContext, setExpandedContext] = useState(chat.focusNoteId);
  const selection = useSyncExternalStore(voiceSelection?.subscribe ?? noSubscription, voiceSelection?.getSnapshot ?? noSelection);
  const [expandedSelection, setExpandedSelection] = useState(selection);
  const [voiceToggle, setVoiceToggle] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceSceneHost, setVoiceSceneHost] = useState<HTMLDivElement | null>(null);
  const [voiceControlsHost, setVoiceControlsHost] = useState<HTMLDivElement | null>(null);
  const lastVoiceToggleRequest = useRef(voiceToggleRequest);
  useEffect(() => {
    if (lastVoiceToggleRequest.current === voiceToggleRequest) return;
    lastVoiceToggleRequest.current = voiceToggleRequest;
    // A new Space inherits the parent's counter, not the old microphone click.
    if (voiceToggleRequest) setVoiceToggle(value => value + 1);
  }, [voiceToggleRequest]);
  const panelRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const circleRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const available = isSelectedAIConfigured(chat.snapshot.settings) && !flowActive;
  const visible = fullPage || (available && open);
  const nativeGlass = useNativeChatGlass(circleRef, available && !fullPage && !voiceActive, open, chat.busy);

  useEffect(() => { if (visible) setHasOpened(true); }, [visible]);
  useEffect(() => { if (!available) setOpen(false); }, [available]);
  // Expanding a drafted "this note" question must retain its visible context.
  useEffect(() => { if (!fullPage) { setExpandedContext(chat.focusNoteId); setExpandedSelection(selection); } }, [fullPage, chat.focusNoteId, selection]);
  useEffect(() => {
    if (visible && !chat.busy) panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
    // Opening changes focus; a completed response must not steal it from the document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, fullPage, conversationKey, chat.passageChat?.key]);
  useEffect(() => {
    if (visible || !restoreFocus.current) return;
    restoreFocus.current = false;
    const target = returnFocus.current;
    if (target?.isConnected && !target.closest("[hidden]")) target.focus({ preventScroll: true });
    else (voiceActive ? dockRef.current?.querySelector<HTMLButtonElement>('.space-voice-call__pill button[aria-label="Open chat"]') : buttonRef.current)?.focus({ preventScroll: true });
  }, [visible, voiceActive]);

  function close() {
    restoreFocus.current = true;
    setOpen(false);
  }

  return <div ref={dockRef} className={fullPage ? "chat-dock chat-dock--page" : "chat-dock"} data-voice-active={voiceActive}>
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
          {chat.passageChat ? <button type="button" aria-label="Back to passage" title="Back to passage" onClick={chat.passageChat.onReturn}><MessageCircle size={15} /></button> : <button type="button" aria-label="New chat" title="New chat" disabled={chat.busy || !chat.snapshot.studio.messages.length} onClick={() => { chat.onClear(); setConversationKey(value => value + 1); }}><Plus size={15} /></button>}
          {allowExpand && <button type="button" aria-label="Expand chat" title="Expand chat" onClick={onExpand}><Maximize2 size={14} /></button>}
          <button type="button" aria-label="Collapse chat" title="Collapse chat" onClick={close}><Minus size={17} /></button>
        </nav>
      </header>}
      {(hasOpened || visible) && <ChatView key={conversationKey} {...chat} suggestionSeed={conversationKey * 2} focusNoteId={fullPage ? expandedContext : chat.focusNoteId} compact={!fullPage} visible={visible} voiceEnabled={!flowActive}
        selection={fullPage ? expandedSelection : selection}
        voiceControl={{ active: voiceActive, toggle: () => setVoiceToggle(value => value + 1) }}
        voiceSceneRef={setVoiceSceneHost} voiceControlsRef={setVoiceControlsHost} voicePalette={voicePalette}
        onCommentReply={chat.onCommentReply ? async (id, selected) => { await chat.onCommentReply!(id, selected); setOpen(false); } : undefined}
        onReviewEdit={chat.onReviewEdit ? proposal => { setOpen(false); return chat.onReviewEdit!(proposal); } : undefined} />}
    </div>
    <div ref={circleRef} className="chat-dock__circle" data-native-chat-glass={nativeGlass || undefined} hidden={!available || fullPage || voiceActive}>
      <button ref={buttonRef} type="button" className="chat-dock__toggle"
        aria-label={open ? "Close chat" : "Open chat"} title={open ? "Close chat" : "Chat with your Space"}
        aria-expanded={open} aria-controls="space-chat-panel"
        onPointerDown={() => { if (!open && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement; }}
        onClick={() => { if (open) close(); else setOpen(true); }}>
        {open ? <X size={19} /> : <MessageCircle size={20} strokeWidth={1.6} />}
      </button>
      {chat.busy && <span className="chat-dock__working" role="status" aria-label="Chat is working" />}
    </div>
    {chat.onVoiceCommit && <SpaceVoice snapshot={chat.snapshot} focusNoteId={chat.focusNoteId}
      enabled={!flowActive} floating presence={voicePresence} voicePalette={voicePalette} voiceSelection={voiceSelection}
      toggleRequest={voiceToggle} onActiveChange={setVoiceActive} commit={chat.onVoiceCommit}
      onProposal={result => {
        if (!result.editProposal) return;
        if (!chat.onReviewEdit) throw new Error("The note review is unavailable in this view.");
        return chat.onReviewEdit(result.editProposal);
      }}
      onOpenNote={chat.onOpenNote} onOpenSource={chat.onOpenSource} onOpenSettings={chat.onOpenSettings}
      chatVisible={visible} sceneHost={voiceSceneHost} controlsHost={voiceControlsHost}
      onCloseChat={!fullPage ? close : undefined}
      onOpenChat={() => { if (!fullPage) setOpen(true); }} />}
  </div>;
}
