import {
  ArrowUp,
  Bot,
  BookOpenText,
  FileText,
  MessageCircle,
  Plus,
  Settings2,
} from "../lib/icons";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AppSnapshot, ChatResult } from "../types";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "../lib/ai";

interface ChatViewProps {
  snapshot: AppSnapshot;
  busy: boolean;
  onSend: (prompt: string) => Promise<ChatResult>;
  onClear: () => void;
  onOpenNote: (noteId: string) => void;
  onSaveReply: (messageId: string) => void;
  onOpenSettings: () => void;
}

const QUICK_PROMPTS = [
  "Summarize the most important ideas in this Space.",
  "What connections am I missing?",
  "What should I investigate next?",
  "Challenge a weak assumption in these notes.",
] as const;

const CHAT_MARKDOWN_COMPONENTS: Components = {
  a: ({ children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
};

export function ChatView({
  snapshot,
  busy,
  onSend,
  onClear,
  onOpenNote,
  onSaveReply,
  onOpenSettings,
}: ChatViewProps) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pendingPrompt, setPendingPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({
      behavior: "smooth",
      block: "nearest",
    });
  }, [isSending, messages.length, pendingPrompt]);

  async function submitPrompt(prompt = draft) {
    const normalized = prompt.trim();
    if (!normalized || isSending) {
      return;
    }
    if (!canSend) {
      setError(`Add an ${providerName} API key in Settings to start chatting.`);
      return;
    }

    setDraft("");
    setError(null);
    setPendingPrompt(normalized);
    setSubmitting(true);
    try {
      await onSend(normalized);
      setPendingPrompt("");
    } catch (sendError) {
      setDraft(normalized);
      setError(
        sendError instanceof Error ? sendError.message : String(sendError),
      );
    } finally {
      setSubmitting(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitPrompt();
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitPrompt();
    }
  }

  function startNewChat() {
    onClear();
    setDraft("");
    setPendingPrompt("");
    setError(null);
  }

  return (
    <section className="chat-view view">
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
        <div className="chat-view__thread" aria-live="polite">
          {messages.length === 0 && !pendingPrompt ? (
            <div className="chat-welcome">
              <span className="chat-welcome__mark" aria-hidden="true">
                <BookOpenText size={23} />
              </span>
              <span className="eyebrow">Orion is listening</span>
              <h2>Think with your whole Space.</h2>
              <p>
                {hasKnowledge
                  ? "Ask for a synthesis, trace an idea across notes, or pressure-test what you already know."
                  : "Your Space is empty, but Chat is ready. Import material or create notes, then ask Orion to connect them."}
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
              ) : (
                <div className="chat-welcome__prompts">
                  {QUICK_PROMPTS.map((prompt) => (
                    <button
                      type="button"
                      key={prompt}
                      disabled={isSending}
                      onClick={() => void submitPrompt(prompt)}
                    >
                      <span>{prompt}</span>
                      <ArrowUp size={13} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            messages.map((message) => {
              const createdNotes = (message.createdNoteIds ?? [])
                .map((noteId) => noteById.get(noteId))
                .filter((note) => note !== undefined);
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
                      <div className="chat-message__body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={CHAT_MARKDOWN_COMPONENTS}
                        >
                          {message.content}
                        </ReactMarkdown>
                      </div>
                      <div className="chat-message__note-actions">
                        {createdNotes.length > 0 ? (
                          createdNotes.map((note) => (
                            <button
                              type="button"
                              key={note.id}
                              onClick={() => onOpenNote(note.id)}
                              aria-label={`Open note: ${note.title}`}
                            >
                              <FileText size={12} />
                              <span>{note.title}</span>
                            </button>
                          ))
                        ) : (
                          <button
                            type="button"
                            className="chat-message__keep-note"
                            onClick={() => onSaveReply(message.id)}
                          >
                            <FileText size={12} />
                            Keep as note
                          </button>
                        )}
                      </div>
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
              <span>Reading your Space</span>
              <span className="chat-thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </article>
          )}
          <div ref={messagesEndRef} />
        </div>

        <form className="chat-composer" onSubmit={handleSubmit}>
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
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
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
            <button
              type="submit"
              disabled={!draft.trim() || isSending || !canSend}
              aria-label="Send message"
            >
              <ArrowUp size={16} />
            </button>
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
