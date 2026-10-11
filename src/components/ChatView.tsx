import {
  ArrowUp,
  AudioLines,
  Bot,
  BookOpenText,
  MessageCircle,
  Plus,
  RefreshCw,
  Settings2,
  Square,
} from "../lib/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefCallback,
} from "react";
import { ChatReply } from "./ChatReply";
import type { AppSnapshot, ChatResult, ChatEditProposal } from "../types";
import { SpaceVoice } from "./SpaceVoice";
import { VoiceConstellation } from "./VoiceConstellation";
import type { IconPalette } from "../lib/themeIcon";
import type { VoiceCommit, VoiceReceipt } from "../lib/voiceResearch";
import { ChatEditPreview } from "./ChatEditPreview";
import { ChatNoteActions } from "./ChatNoteActions";
import type { ChatNoteReceipt, UseChatReply } from "../lib/chatNoteActions";
import { useChatSuggestions } from "./useChatSuggestions";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "../lib/ai";

export interface ChatViewProps {
  onVoiceCommit?: (request: VoiceCommit) => Promise<VoiceReceipt>;
  voiceEnabled?: boolean;
  voiceControl?: { active: boolean; toggle: () => void };
  /** Stable portal destinations for the window-owned call. Neither starts audio. */
  voiceSceneRef?: RefCallback<HTMLDivElement>;
  voiceControlsRef?: RefCallback<HTMLDivElement>;
  voicePalette?: IconPalette;
  snapshot: AppSnapshot;
  busy: boolean;
  progress?: string;
  onCancel?: () => void;
  onSend: (prompt: string, focusNoteId?: string) => Promise<ChatResult>;
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

export function ChatView({
  snapshot,
  onVoiceCommit,
  voiceEnabled = true,
  voiceControl,
  voiceSceneRef,
  voiceControlsRef,
  voicePalette,
  busy,
  progress,
  onCancel,
  onSend,
  onReviewEdit,
  onClear,
  onOpenNote,
  onOpenSource,
  onSaveReply,
  onUseReply,
  onOpenSettings,
  compact = false,
  visible = true,
  suggestionSeed = 0,
  focusNoteId,
}: ChatViewProps) {
  const [draft, setDraft] = useState("");
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
  const [suggestedContext, setSuggestedContext] = useState<{ spaceId: string; noteId?: string; title?: string; editing: boolean }>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
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
  const externalVoiceActive = voiceControl?.active === true;
  const hasThreadContent = messages.length > 0 || Boolean(pendingPrompt || error || editProposal) || isSending;
  const focusNote = focusNoteId ? noteById.get(focusNoteId) : undefined;
  const suggestionCount = compact ? 2 : 4;
  const suggestions = useChatSuggestions(snapshot, {
    enabled: visible && canSend && messages.length === 0 && !draft.trim() && !voiceActive && !isSending,
    focusNoteId: focusNote?.id,
    seed: suggestionSeed + suggestionRevision,
  });

  useEffect(() => {
    if (visible) messagesEndRef.current?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
    });
  }, [isSending, messages.length, pendingPrompt, visible, editProposal]);

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

    setDraft("");
    setError(null);
    setPendingPrompt(normalized);
    setSubmitting(true);
    try {
      const result = await (sendNoteId ? onSend(normalized, sendNoteId) : onSend(normalized));
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
    onClear();
    setEditProposal(undefined);
    setDraft("");
    setSuggestedContext(undefined);
    setPendingPrompt("");
    setError(null);
    setSuggestionRevision(value => value + 1);
  }

  return (
    <section className={`chat-view view${compact ? " chat-view--compact" : ""}`}
      data-voice-active={externalVoiceActive} data-voice-empty={!hasThreadContent}>
      <header className="chat-view__header">
        <div className="chat-view__title">
          <span className="eyebrow">
            <MessageCircle size={12} />
            Space intelligence
          </span>
          <h1>Chat</h1>
          <p>
            Ask across everything in{" "}
            <strong>{snapshot.workspace.name}</strong>.
          </p>
        </div>

        <div className="chat-view__header-actions">
          <div className="chat-view__scope" aria-label="Chat knowledge scope">
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
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              className="chat-view__new"
              onClick={startNewChat}
              disabled={isSending}
            >
              <Plus size={14} />
              New chat
            </button>
          )}
        </div>
      </header>

      <div className="chat-view__stage">
        <div className="chat-view__voice-scene" ref={voiceSceneRef} />
        <div className="chat-view__thread" aria-live="polite" hidden={externalVoiceActive && !hasThreadContent}>
          {!externalVoiceActive && messages.length === 0 && !pendingPrompt ? (
            <div className="chat-welcome">
              <div className="chat-welcome__voice" aria-hidden="true">
                <VoiceConstellation status="idle" activity={idleVoiceActivity} muted={false} jobs={[]}
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
          <div ref={messagesEndRef} />
        </div>

        <div className="chat-view__voice-controls" ref={voiceControlsRef} />
        <form className="chat-composer" onSubmit={handleSubmit}>
          {suggestedContext?.noteId && draft.trim() && suggestedContext.noteId !== focusNote?.id && (
            <div className="chat-composer__suggested-target">
              <span>{suggestedContext.editing ? "Editing" : "Attached"}</span>
              <button type="button" disabled={suggestedContext.spaceId !== snapshot.workspace.id || !noteById.has(suggestedContext.noteId)}
                onClick={() => { if (suggestedContext.noteId) onOpenNote(suggestedContext.noteId); }}>{suggestedContext.title}</button>
            </div>
          )}
          {onVoiceCommit && !voiceControl && <SpaceVoice snapshot={snapshot} focusNoteId={focusNote?.id} enabled={voiceEnabled} commit={onVoiceCommit} toggleRequest={voiceToggle} onActiveChange={setVoiceActive}
            onProposal={result => { if (result.editProposal) { setEditProposal(result.editProposal); setEditRevision(value => value + 1); } }}
            onOpenNote={onOpenNote} onOpenSource={onOpenSource} onOpenSettings={onOpenSettings} />}
          {error && (
            <div className="chat-composer__error" role="alert">
              <span>{error}</span>
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
                  : `Add an ${providerName} key to start chatting…`
              }
              aria-label="Message Orion"
              rows={2}
              maxLength={8_000}
              disabled={isSending || !canSend}
            />
            {voiceActive ? <button type="button" className="chat-composer__voice"
              aria-label="Stop voice" title="Stop voice"
              onClick={(event) => { event.preventDefault(); toggleVoice(); }}>
              <Square size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />
            </button> : isSending && onCancel ? <button type="button" onClick={(event) => {
              // Cancelling restores the draft and can turn this same DOM node
              // into Submit before the click's default action runs.
              event.preventDefault();
              onCancel();
            }} aria-label="Stop response" className="chat-composer__stop">Stop</button> : !draft.trim() && onVoiceCommit ? <button
              type="button" className="chat-composer__voice" disabled={!voiceEnabled || isSending}
              aria-label="Talk to Space"
              title="Talk to Space"
              onClick={toggleVoice}>
              <AudioLines size={19} strokeWidth={1.8} />
            </button> : <button
              type="submit"
              disabled={!draft.trim() || isSending || !canSend}
              aria-label="Send message"
            >
              <ArrowUp size={16} />
            </button>}
          </div>
          <div className="chat-composer__footer">
            <span>
              <BookOpenText size={11} />
              Grounded in this Space only
            </span>
            <span>Enter to send · Shift Enter for a new line</span>
          </div>
        </form>
      </div>
    </section>
  );
}
