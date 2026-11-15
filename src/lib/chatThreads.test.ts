import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { StudioMessage } from "../types";
import { applyChatResult, buildChatRequest, ChatRequestRegistry } from "./chat";
import { chatThreadRevision, createChatThread, deleteChatThread, hasChatThread, LEGACY_CHAT_THREAD_ID,
  listChatThreads, messageChatThreadId, projectChatThread, renameChatThread } from "./chatThreads";

const NOW = "2026-11-13T09:00:00.000Z", LATER = "2026-11-13T10:00:00.000Z";
const message = (id: string, content: string, threadId?: string): StudioMessage => ({
  id, role: "user", content, cardIds: [], contextCardIds: [], createdAt: NOW, ...(threadId ? { threadId } : {}),
});
function legacy() {
  const snapshot = createEmptySnapshot("Main", NOW);
  delete snapshot.studio.threads;
  snapshot.studio.messages = [message("old", "Earlier project thoughts")];
  return snapshot;
}
describe("Space chat threads", () => {
  it("projects legacy history without rewriting or duplicating it", () => {
    const original = legacy();
    expect(listChatThreads(original.studio)).toEqual([{ id: LEGACY_CHAT_THREAD_ID, title: "Earlier project thoughts", createdAt: NOW, updatedAt: NOW, messageCount: 1 }]);
    const created = createChatThread(original, "chat-second", LATER);
    expect(created.studio.messages).toBe(original.studio.messages);
    expect(created.studio.messages[0]).not.toHaveProperty("threadId");
    expect(projectChatThread(created, "chat-second").studio.messages).toEqual([]);
    expect(projectChatThread(created, LEGACY_CHAT_THREAD_ID).studio.messages).toEqual(original.studio.messages);
    expect(listChatThreads(created.studio).map(thread => thread.id)).toEqual(["chat-second", LEGACY_CHAT_THREAD_ID]);
  });
  it("supplies only a virtual empty initial chat, without seeded persisted records", () => {
    const empty = createEmptySnapshot("Empty", NOW);
    expect(empty.studio.messages).toEqual([]);
    expect(empty.studio.threads).toEqual([]);
    expect(listChatThreads(empty.studio)[0]).toMatchObject({ id: LEGACY_CHAT_THREAD_ID, title: "New chat", messageCount: 0 });
    const created = createChatThread(empty, "chat-first", NOW);
    expect(listChatThreads(created.studio).map(thread => thread.id)).toEqual(["chat-first"]);
    expect(hasChatThread(created.studio, LEGACY_CHAT_THREAD_ID)).toBe(false);
  });
  it("materializes valid metadata without rewriting permissive legacy message dates", () => {
    const snapshot = legacy(); snapshot.studio.messages[0].createdAt = "2026";
    const renamed = renameChatThread(snapshot, LEGACY_CHAT_THREAD_ID, "Earlier chat", LATER);
    expect(renamed.studio.threads![0].createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(renamed.studio.messages[0].createdAt).toBe("2026");
  });
  it("tags one captured reply and retains every other thread and dormant Studio field", () => {
    const snapshot = createChatThread(legacy(), "chat-second", NOW);
    snapshot.studio.view = "dialectic";
    let count = 0;
    const replied = applyChatResult(snapshot, "  Plan the launch  ", { reply: "A useful plan." }, LATER, () => `m-${++count}`, undefined, undefined, "chat-second");
    expect(replied.studio.messages.map(messageChatThreadId)).toEqual([LEGACY_CHAT_THREAD_ID, "chat-second", "chat-second"]);
    expect(replied.studio.messages[0]).toBe(snapshot.studio.messages[0]);
    expect(replied.studio.view).toBe("dialectic");
    expect(listChatThreads(replied.studio)[0]).toMatchObject({ id: "chat-second", title: "Plan the launch", createdAt: NOW, updatedAt: LATER, messageCount: 2 });
    expect(buildChatRequest(projectChatThread(replied, "chat-second"), "More").history?.map(item => item.content)).toEqual(["Plan the launch", "A useful plan."]);
    expect(buildChatRequest(projectChatThread(replied, LEGACY_CHAT_THREAD_ID), "More").history?.map(item => item.content)).toEqual(["Earlier project thoughts"]);
  });
  it("renames an implicit legacy chat and keeps that title after later replies", () => {
    const named = renameChatThread(legacy(), LEGACY_CHAT_THREAD_ID, "  Old research  ", LATER);
    expect(named.studio.messages[0]).not.toHaveProperty("threadId");
    const replied = applyChatResult(named, "Another question", { reply: "Answer" }, LATER, () => "new-id", undefined, undefined, LEGACY_CHAT_THREAD_ID);
    expect(listChatThreads(replied.studio)[0].title).toBe("Old research");
    expect(() => renameChatThread(named, LEGACY_CHAT_THREAD_ID, "🌟".repeat(161), LATER)).toThrow(/160/);
    expect(renameChatThread(named, LEGACY_CHAT_THREAD_ID, "🌟".repeat(160), LATER).studio.threads![0].title).toBe("🌟".repeat(160));
  });
  it("deletes only the chosen conversation while leaving created notes and another history intact", () => {
    const snapshot = createChatThread(legacy(), "chat-second", LATER);
    snapshot.studio.messages.push(message("second", "Other conversation", "chat-second"));
    const next = deleteChatThread(snapshot, LEGACY_CHAT_THREAD_ID, LATER);
    expect(next.studio.messages.map(item => item.id)).toEqual(["second"]);
    expect(listChatThreads(next.studio).map(item => item.id)).toEqual(["chat-second"]);
    expect(next.notes).toBe(snapshot.notes);
    expect(snapshot.studio.messages).toHaveLength(2);
  });
  it("guards only the selected history and ignores renames or other-thread replies", () => {
    const snapshot = createChatThread(legacy(), "chat-second", LATER);
    const revision = chatThreadRevision(snapshot.studio, LEGACY_CHAT_THREAD_ID);
    expect(chatThreadRevision(renameChatThread(snapshot, LEGACY_CHAT_THREAD_ID, "New title", LATER).studio, LEGACY_CHAT_THREAD_ID)).toBe(revision);
    const other = { ...snapshot.studio, messages: [...snapshot.studio.messages, message("second", "Other", "chat-second")] };
    expect(chatThreadRevision(other, LEGACY_CHAT_THREAD_ID)).toBe(revision);
    const edited = { ...snapshot.studio, messages: [message("old", "Changed words")] };
    expect(chatThreadRevision(edited, LEGACY_CHAT_THREAD_ID)).not.toBe(revision);
  });
  it("cancels and immediately replaces a request without allowing the old completion to clear it", () => {
    const registry = new ChatRequestRegistry();
    const first = registry.start("space", "same-id")!;
    registry.cancel("space");
    const replacement = registry.start("space", "same-id")!;
    expect(replacement).not.toBeNull();
    expect(registry.isCurrent(first)).toBe(false);
    expect(registry.finish(first)).toBe(false);
    expect(registry.isCurrent(replacement)).toBe(true);
    expect(registry.finish(replacement)).toBe(true);
  });
});
