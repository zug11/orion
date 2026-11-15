import type { AppSnapshot, ChatThread, ConceptStudioState, StudioMessage } from "../types";

export const LEGACY_CHAT_THREAD_ID = "chat-legacy";
export const MAX_CHAT_THREAD_TITLE_CHARS = 160;
export interface ChatThreadSummary extends ChatThread { messageCount: number }

export const validChatThreadId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
export const messageChatThreadId = (message: Pick<StudioMessage, "threadId">): string =>
  message.threadId ?? LEGACY_CHAT_THREAD_ID;

const listCache = new WeakMap<ConceptStudioState, ChatThreadSummary[]>();
const revisionCache = new WeakMap<ConceptStudioState, Map<string, string>>();
const threadDate = (value: string | undefined, fallback: string) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
const titleFromPrompt = (text: string) => {
  const clean = text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
  const chars = Array.from(clean);
  return chars.length > 80 ? chars.slice(0, 79).join("") + "…" : clean;
};

/** One derived index per immutable Studio value, never a second message store. */
export function listChatThreads(studio: ConceptStudioState): ChatThreadSummary[] {
  const cached = listCache.get(studio);
  if (cached) return cached;
  const byId = new Map<string, ChatThreadSummary>((studio.threads ?? []).map(thread => [thread.id, { ...thread, messageCount: 0 }]));
  for (const message of studio.messages) {
    const id = messageChatThreadId(message);
    let thread = byId.get(id);
    if (!thread) {
      // Legacy metadata is implicit. A runtime projection may also contain a
      // thread's messages without its directory; never silently hide them.
      thread = { id, title: "", createdAt: message.createdAt, updatedAt: message.createdAt, messageCount: 0 };
      byId.set(id, thread);
    }
    thread.messageCount += 1;
    if (!thread.title && message.role === "user") thread.title = titleFromPrompt(message.content);
    if (!thread.createdAt || message.createdAt < thread.createdAt) thread.createdAt = message.createdAt;
    if (message.createdAt > thread.updatedAt) thread.updatedAt = message.createdAt;
  }
  if (!byId.size) byId.set(LEGACY_CHAT_THREAD_ID, { id: LEGACY_CHAT_THREAD_ID, title: "", createdAt: "", updatedAt: "", messageCount: 0 });
  const result = [...byId.values()].map(thread => ({ ...thread, title: thread.title || "New chat" }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  listCache.set(studio, result);
  return result;
}

export function hasChatThread(studio: ConceptStudioState, id: string): boolean {
  return listChatThreads(studio).some(thread => thread.id === id);
}

/** Transient provider/display projection. Never save this filtered snapshot. */
export function projectChatThread(snapshot: AppSnapshot, id: string): AppSnapshot {
  return { ...snapshot, studio: { ...snapshot.studio,
    messages: snapshot.studio.messages.filter(message => messageChatThreadId(message) === id) } };
}

export function createChatThread(snapshot: AppSnapshot, id: string, now: string): AppSnapshot {
  if (!validChatThreadId(id)) throw new Error("The chat identity is invalid.");
  if (snapshot.studio.threads?.some(thread => thread.id === id)) return snapshot;
  const implicit = listChatThreads(snapshot.studio).find(thread => thread.id === id);
  const thread: ChatThread = { id, title: implicit?.messageCount ? implicit.title : "", createdAt: threadDate(implicit?.createdAt, now), updatedAt: now };
  return { ...snapshot, studio: { ...snapshot.studio, threads: [...snapshot.studio.threads ?? [], thread] }, updatedAt: now };
}

export function renameChatThread(snapshot: AppSnapshot, id: string, title: string, now: string): AppSnapshot {
  const clean = title.trim();
  if (!clean || Array.from(clean).length > MAX_CHAT_THREAD_TITLE_CHARS || /[\u0000-\u001f\u007f-\u009f]/u.test(clean)) throw new Error("Give the chat a title of 1–160 characters.");
  if (!hasChatThread(snapshot.studio, id)) throw new Error("This chat is no longer available.");
  const next = createChatThread(snapshot, id, now);
  return { ...next, studio: { ...next.studio, threads: next.studio.threads!.map(thread => thread.id === id ? { ...thread, title: clean, updatedAt: now } : thread) }, updatedAt: now };
}

export function deleteChatThread(snapshot: AppSnapshot, id: string, now: string): AppSnapshot {
  if (!hasChatThread(snapshot.studio, id)) return snapshot;
  return { ...snapshot, studio: { ...snapshot.studio,
    threads: snapshot.studio.threads?.filter(thread => thread.id !== id),
    messages: snapshot.studio.messages.filter(message => messageChatThreadId(message) !== id) }, updatedAt: now };
}

/** Exact history guard, cached per immutable Studio and bounded to this thread.
 * Metadata-only renames do not invalidate a response; changing any message does. */
export function chatThreadRevision(studio: ConceptStudioState, id: string): string {
  let cached = revisionCache.get(studio);
  if (!cached) { cached = new Map(); revisionCache.set(studio, cached); }
  let revision = cached.get(id);
  if (revision === undefined) {
    revision = JSON.stringify(studio.messages.filter(message => messageChatThreadId(message) === id));
    cached.set(id, revision);
  }
  return revision;
}

/** Called after a reply is validated, against the complete latest Space. */
export function touchChatThread(studio: ConceptStudioState, id: string, prompt: string, now: string): ConceptStudioState {
  if (!validChatThreadId(id)) throw new Error("The chat identity is invalid.");
  const existing = studio.threads?.find(thread => thread.id === id);
  const first = studio.messages.find(message => messageChatThreadId(message) === id && message.role === "user");
  const thread = existing ? { ...existing, title: existing.title || titleFromPrompt(first?.content ?? prompt), updatedAt: now }
    : { id, title: titleFromPrompt(first?.content ?? prompt), createdAt: threadDate(first?.createdAt, now), updatedAt: now };
  return { ...studio, threads: existing ? studio.threads!.map(item => item.id === id ? thread : item) : [...studio.threads ?? [], thread] };
}
