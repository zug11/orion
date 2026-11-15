// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import * as suggestionConnection from "./components/useChatSuggestions";
import { createEmptyVault, createEmptySnapshot } from "./data/defaults";
import type { ComponentProps } from "react";
import type { Sidebar } from "./components/Sidebar";
import type { NoteView } from "./components/NoteView";
import type { HomeView } from "./components/HomeView";
import type { ChatRequest, Note, OrionVault } from "./types";
import type { PassageThreadHandler } from "./lib/passageThreads";
import type { ChatViewProps } from "./components/ChatView";
import { LEGACY_CHAT_THREAD_ID } from "./lib/chatThreads";
import { stableSnapshotVersion } from "./lib/knowledgeOrchestration/context";
import type { VoiceCommit, VoiceReceipt } from "./lib/voiceResearch";

const runtime = vi.hoisted(() => ({ disk: null as OrionVault | null, chatProps: null as ChatViewProps | null,
  sidebarProps: null as ComponentProps<typeof Sidebar> | null,
  noteProps: null as ComponentProps<typeof NoteView> | null,
  homeProps: null as ComponentProps<typeof HomeView> | null,
  updateNote: null as ((note: Note) => void) | null,
  threadAction: null as PassageThreadHandler | null, load: vi.fn(), save: vi.fn(), invoke: vi.fn(), chat: vi.fn() }));
vi.mock("./lib/chatgpt", async original => ({ ...await original<typeof import("./lib/chatgpt")>(),
  chatGPTCommand: (command: string, args?: unknown) => runtime.invoke(command, args) }));
vi.mock("./lib/storage", async original => ({ ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true, loadSnapshot: runtime.load, saveSnapshot: runtime.save, chatWithOrion: runtime.chat }));
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme");
  const { defaultSettings } = await import("./data/defaults");
  const palette = resolveThemePalette(defaultSettings, "dark");
  return { useResolvedTheme: () => ({ palette, glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: (props: ComponentProps<typeof Sidebar>) => { runtime.sidebarProps = props; return null; } }));
vi.mock("./components/HomeView", () => ({ HomeView: (props: ComponentProps<typeof HomeView>) => { runtime.homeProps = props; return <h1>Home fixture</h1>; } }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/NoteView", () => ({ NoteView: (props: ComponentProps<typeof NoteView>) => { runtime.noteProps = props; runtime.threadAction = props.onThreadAction ?? null; runtime.updateNote = props.onUpdateNote; return <h1>{props.note.title}</h1>; } }));
vi.mock("./components/ChatDock", () => ({ ChatDock: (props: ChatViewProps) => { runtime.chatProps = props; return null; } }));
import App from "./App";

beforeEach(() => {
  runtime.noteProps = null; runtime.homeProps = null;
  runtime.load.mockReset(); runtime.save.mockReset(); runtime.chat.mockReset();
  runtime.invoke.mockReset().mockResolvedValue(undefined);
  mockIPC((command, payload) => runtime.invoke(command, payload), { shouldMockEvents: true });
  mockWindows("main");
  const vault = createEmptyVault("Quiet actions");
  vault.spaces[0].settings.apiKeyConfigured = true;
  vault.spaces[0].notes = [{ id: "draft", title: "Original draft", slug: "draft", body: "The river was dark.", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: vault.updatedAt, updatedAt: vault.updatedAt }];
  vault.spaces[0].studio.messages = [
    { id: "question", role: "user", content: "Can you develop this?", cardIds: [], contextCardIds: [], createdAt: vault.updatedAt },
    { id: "reply", role: "assistant", content: "The dark river carried the last of the light.", cardIds: [], contextCardIds: [], createdAt: vault.updatedAt },
  ];
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault) => { runtime.disk = structuredClone(next); });
});
afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks(); window.history.replaceState(null, "", "/");
});
async function launch() {
  window.history.replaceState(null, "", `/?space=${runtime.disk!.activeSpaceId}&note=draft`);
  render(<App />); await screen.findByRole("heading", { name: "Original draft" });
  await waitFor(() => expect(runtime.save).toHaveBeenCalled());
}

it("invalidates suggestions immediately on a same-account ChatGPT connection event before status hydration", async () => {
  Object.assign(runtime.disk!.spaces[0].settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
  const invalidate = vi.spyOn(suggestionConnection, "invalidateChatSuggestionConnection");
  try {
    await launch(); await act(async () => { await vi.dynamicImportSettled(); });
    expect(invalidate).not.toHaveBeenCalled();
    let resolve!: (status: unknown) => void;
    runtime.invoke.mockImplementation(command => command === "chatgpt_status" ? new Promise(done => { resolve = done; }) : Promise.resolve(undefined));
    await act(async () => { await emit("chatgpt-connection-changed", {}); });
    expect(invalidate).toHaveBeenCalledExactlyOnceWith("chatgpt");
    expect(resolve).toBeTypeOf("function");
    await act(async () => resolve({ configured: true, activeId: "account-a", accounts: [], firstConnection: false }));
    expect(runtime.chatProps!.snapshot.settings).toMatchObject({ chatgptConfigured: true, chatgptAccountId: "account-a" });
    expect(invalidate).toHaveBeenCalledTimes(1);
  } finally { invalidate.mockRestore(); }
});

it("dismisses a calendar occurrence through normal persistence and Undo preserves later editor changes", async () => {
  await launch();
  const captured = structuredClone(runtime.noteProps!.note), edit = runtime.updateNote!;
  act(() => runtime.sidebarProps!.onViewChange("home")); await screen.findByRole("heading", { name: "Home fixture" });
  const key = "v1:0123456789abcdef:0:1", before = runtime.homeProps!.snapshot;
  let accepted = false;
  act(() => { accepted = runtime.homeProps!.onDismissCalendarMention!(captured, key); });
  expect(accepted).toBe(true);
  const dismissed = runtime.homeProps!.snapshot.notes.find(note => note.id === captured.id)!;
  expect(dismissed).toEqual({ ...captured, dismissedCalendarMentions: [key] });
  expect(runtime.homeProps!.snapshot.updatedAt).not.toBe(before.updatedAt);
  expect(runtime.homeProps!.snapshot.spaceOverview).toEqual(before.spaceOverview);
  await waitFor(() => expect(runtime.disk!.spaces[0].notes[0].dismissedCalendarMentions).toEqual([key]), { timeout: 5000 });
  // Simulate the editor publishing its captured whole Note before receiving the
  // Home metadata update. Its prose edit must not erase the dismissal.
  const updatedAt = "2026-11-16T00:00:00.000Z";
  act(() => edit({ ...captured, body: "A later authored revision.", updatedAt }));
  expect(runtime.homeProps!.snapshot.notes[0]).toMatchObject({ body: "A later authored revision.", updatedAt, dismissedCalendarMentions: [key] });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(runtime.homeProps!.snapshot.notes[0]).toMatchObject({ body: "A later authored revision.", updatedAt, dismissedCalendarMentions: [] });
  await waitFor(() => expect(runtime.disk!.spaces[0].notes[0]).toMatchObject({ body: "A later authored revision.", updatedAt, dismissedCalendarMentions: [] }), { timeout: 5000 });
});

it("rejects stale calendar captures and callbacks from a different active Space", async () => {
  const other = createEmptySnapshot("Other Space", runtime.disk!.updatedAt, "other");
  other.notes = [structuredClone(runtime.disk!.spaces[0].notes[0])]; runtime.disk!.spaces.push(other);
  await launch(); const captured = structuredClone(runtime.noteProps!.note), edit = runtime.updateNote!;
  act(() => runtime.sidebarProps!.onViewChange("home")); await screen.findByRole("heading", { name: "Home fixture" });
  const dismiss = runtime.homeProps!.onDismissCalendarMention!, key = "v1:0123456789abcdef:0:1";
  act(() => edit({ ...captured, body: "Changed before dismissal." }));
  let accepted = true; act(() => { accepted = dismiss(captured, key); }); expect(accepted).toBe(false);
  expect(runtime.homeProps!.snapshot.notes[0].dismissedCalendarMentions).toBeUndefined();
  act(() => runtime.sidebarProps!.onSwitchSpace("other"));
  act(() => { accepted = dismiss(captured, key); }); expect(accepted).toBe(false);
  expect(runtime.chatProps!.snapshot.workspace.id).toBe("other");
  expect(runtime.chatProps!.snapshot.notes[0].dismissedCalendarMentions).toBeUndefined();
});

it("does not undo a dismissal into a different Space with the same note identity", async () => {
  const other = createEmptySnapshot("Other Space", runtime.disk!.updatedAt, "other");
  const key = "v1:0123456789abcdef:0:1";
  other.notes = [{ ...runtime.disk!.spaces[0].notes[0], dismissedCalendarMentions: [key] }]; runtime.disk!.spaces.push(other);
  await launch(); const captured = runtime.noteProps!.note;
  act(() => runtime.sidebarProps!.onViewChange("home"));
  act(() => { expect(runtime.homeProps!.onDismissCalendarMention!(captured, key)).toBe(true); });
  act(() => runtime.sidebarProps!.onSwitchSpace("other"));
  // Space navigation may replace the toast; a retained Undo must still be scoped.
  const undo = screen.queryByRole("button", { name: "Undo" }); if (undo) fireEvent.click(undo);
  expect(runtime.chatProps!.snapshot.notes[0].dismissedCalendarMentions).toEqual([key]);
});

it("starts a new chat without erasing legacy history and sends only the selected conversation", async () => {
  runtime.chat.mockResolvedValue({ reply: "An independent answer.", editIntent: "none" });
  await launch();
  const original = structuredClone(runtime.chatProps!.snapshot.studio.messages);
  act(() => runtime.chatProps!.onClear());
  const threadId = runtime.chatProps!.threadNavigation!.activeThreadId;
  expect(threadId).not.toBe(LEGACY_CHAT_THREAD_ID);
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual([]);
  expect(runtime.chatProps!.threadNavigation!.threads).toHaveLength(2);
  await act(async () => { await runtime.chatProps!.onSend("A different question"); });
  expect(runtime.chat.mock.calls[0][0].history).toEqual([]);
  expect(runtime.chatProps!.snapshot.studio.messages.map(message => message.content)).toEqual(["A different question", "An independent answer."]);
  expect(runtime.chatProps!.snapshot.studio.messages.every(message => message.threadId === threadId)).toBe(true);
  act(() => runtime.chatProps!.threadNavigation!.onSelect(LEGACY_CHAT_THREAD_ID));
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual(original);
  await waitFor(() => expect(runtime.disk!.spaces[0].studio.messages).toHaveLength(4), { timeout: 5000 });
  await act(async () => cleanup());
  await launch();
  expect(runtime.chatProps!.threadNavigation!.threads).toHaveLength(2);
  expect(runtime.chatProps!.threadNavigation!.activeThreadId).toBe(threadId);
  expect(runtime.chatProps!.snapshot.studio.messages).toHaveLength(2);
});

it("keeps the initially empty conversation reachable after New chat", async () => {
  runtime.disk!.spaces[0].studio.messages = [];
  await launch();
  expect(runtime.chatProps!.threadNavigation!.activeThreadId).toBe(LEGACY_CHAT_THREAD_ID);
  act(() => runtime.chatProps!.onClear());
  const newId = runtime.chatProps!.threadNavigation!.activeThreadId;
  expect(newId).not.toBe(LEGACY_CHAT_THREAD_ID);
  expect(runtime.chatProps!.threadNavigation!.threads.map(thread => thread.id)).toContain(LEGACY_CHAT_THREAD_ID);
  act(() => runtime.chatProps!.threadNavigation!.onSelect(LEGACY_CHAT_THREAD_ID));
  expect(runtime.chatProps!.threadNavigation!.activeThreadId).toBe(LEGACY_CHAT_THREAD_ID);
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual([]);
  await waitFor(() => expect(runtime.disk!.spaces[0].studio.threads?.map(thread => thread.id)).toEqual([LEGACY_CHAT_THREAD_ID, newId]), { timeout: 5000 });
});

it("retains independent selections and history in each Space", async () => {
  const firstSpaceId = runtime.disk!.activeSpaceId;
  const other = createEmptySnapshot("Other Space", runtime.disk!.updatedAt, "other");
  other.studio.messages = [{ id: "other-question", role: "user", content: "A private question in the other Space", cardIds: [], contextCardIds: [], createdAt: runtime.disk!.updatedAt }];
  runtime.disk!.spaces.push(other);
  await launch();
  act(() => runtime.chatProps!.onClear());
  const firstThread = runtime.chatProps!.threadNavigation!.activeThreadId;
  act(() => runtime.sidebarProps!.onSwitchSpace("other"));
  await waitFor(() => expect(runtime.chatProps!.snapshot.workspace.id).toBe("other"));
  expect(runtime.chatProps!.threadNavigation!.threads).toHaveLength(1);
  expect(runtime.chatProps!.snapshot.studio.messages[0].id).toBe("other-question");
  expect(runtime.chatProps!.threadNavigation!.threads.some(thread => thread.id === firstThread)).toBe(false);
  act(() => runtime.sidebarProps!.onSwitchSpace(firstSpaceId));
  await waitFor(() => expect(runtime.chatProps!.snapshot.workspace.id).toBe(firstSpaceId));
  expect(runtime.chatProps!.threadNavigation!.activeThreadId).toBe(firstThread);
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual([]);
});

it("rejects a late answer after switching and lets the new chat send immediately", async () => {
  let finishOld!: (result: { reply: string }) => void;
  runtime.chat.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue({ reply: "The new chat's answer.", editIntent: "none" });
  await launch();
  let oldOutcome!: Promise<unknown>;
  act(() => { oldOutcome = runtime.chatProps!.onSend("Old pending question").catch(error => error); });
  await waitFor(() => expect(runtime.chat).toHaveBeenCalledTimes(1));
  act(() => runtime.chatProps!.onClear());
  await act(async () => { await runtime.chatProps!.onSend("New question"); });
  expect(runtime.chat.mock.calls[1][0].history).toEqual([]);
  await act(async () => { finishOld({ reply: "Late old answer" }); });
  expect(await oldOutcome).toBeInstanceOf(Error);
  expect(runtime.chatProps!.busy).toBe(false);
  expect(runtime.chatProps!.snapshot.studio.messages.map(message => message.content)).toEqual(["New question", "The new chat's answer."]);
  act(() => runtime.chatProps!.threadNavigation!.onSelect(LEGACY_CHAT_THREAD_ID));
  expect(runtime.chatProps!.snapshot.studio.messages.map(message => message.id)).toEqual(["question", "reply"]);
});

it("renames and deletes only the selected chat and rejects a delayed voice save to it", async () => {
  await launch();
  act(() => runtime.chatProps!.threadNavigation!.onRename(LEGACY_CHAT_THREAD_ID, "River ideas"));
  expect(runtime.chatProps!.threadNavigation!.threads[0].title).toBe("River ideas");
  act(() => runtime.chatProps!.onClear());
  const newThread = runtime.chatProps!.threadNavigation!.activeThreadId;
  act(() => runtime.chatProps!.threadNavigation!.onDelete(LEGACY_CHAT_THREAD_ID));
  expect(runtime.chatProps!.threadNavigation!.threads.map(thread => thread.id)).toEqual([newThread]);
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(1);
  await act(async () => {
    await expect(runtime.chatProps!.onVoiceCommit!({ id: "late-voice", spaceId: runtime.disk!.activeSpaceId,
      threadId: LEGACY_CHAT_THREAD_ID, version: "old", prompt: "Create a note", result: { reply: "Late" } })).rejects.toThrow(/conversation was deleted/);
  });
  act(() => runtime.chatProps!.threadNavigation!.onDelete(newThread));
  expect(runtime.chatProps!.threadNavigation!.activeThreadId).not.toBe(newThread);
  expect(runtime.chatProps!.threadNavigation!.activeThreadId).not.toBe(LEGACY_CHAT_THREAD_ID);
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual([]);
});

function addPassageThread() {
  runtime.disk!.spaces[0].settings.includeExistingNotesInAIContext = false;
  runtime.disk!.spaces[0].notes[0].discussionThreads = [{ id: "thread", state: "open", anchor: { quote: "The river was dark.", text: "The river was dark." }, createdAt: runtime.disk!.updatedAt, updatedAt: runtime.disk!.updatedAt,
    messages: [{ id: "comment", role: "assistant", content: "Consider what the river hides.", createdAt: runtime.disk!.updatedAt }] }];
}

it("queues a passage article without navigating or copying a reply, and coalesces repeat creation", async () => {
  addPassageThread();
  let finish!: (value: { reply: string }) => void;
  runtime.chat.mockImplementation((request: ChatRequest) => {
    expect(request.mode).toBe("inline-writing");
    expect(request.notes[1].body).toBe("The river was dark.");
    expect(request.notes[2].body).toBe("Consider what the river hides.");
    expect(request.history).toEqual([]);
    return new Promise(resolve => { finish = resolve; });
  });
  await launch();
  const original = structuredClone(runtime.chatProps!.snapshot.studio.messages);
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" }); });
  expect(screen.getByRole("heading", { name: "Original draft" })).toBeVisible();
  expect(runtime.sidebarProps!.generateJobs).toHaveLength(1);
  expect(runtime.sidebarProps!.generateJobs![0].stage).toBe("writing");
  const createdId = runtime.disk!.spaces[0].notes.find(note => note.id === "draft")!.discussionThreads![0].messages[0].createdNoteId!;
  expect(runtime.disk!.spaces[0].notes.find(note => note.id === createdId)!.body).toContain("orion-generate-pending");
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" }); });
  expect(runtime.chat).toHaveBeenCalledTimes(1);
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(2);
  await act(async () => { finish({ reply: "# What the River Hides\n\nDark water makes the unknown tangible." }); });
  await waitFor(() => expect(runtime.chatProps!.snapshot.notes.find(note => note.id === createdId)).toMatchObject({ title: "What the River Hides", body: "Dark water makes the unknown tangible." }));
  expect(runtime.chatProps!.snapshot.notes.find(note => note.id === "draft")!.body).toBe("The river was dark.");
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual(original);
});

it("restarts failed article generation with the same reference and destination", async () => {
  addPassageThread();
  runtime.chat.mockRejectedValueOnce(new Error("Provider unavailable"));
  await launch();
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" }); });
  await waitFor(() => expect(runtime.sidebarProps!.generateJobs![0].stage).toBe("error"));
  const failed = runtime.sidebarProps!.generateJobs![0];
  runtime.chat.mockResolvedValueOnce({ reply: "# Concealment\n\nThe image gives uncertainty a shape." });
  await act(async () => { runtime.sidebarProps!.onRestartGenerate!(failed); });
  await waitFor(() => expect(runtime.chatProps!.snapshot.notes.find(note => note.id === failed.noteId)?.title).toBe("Concealment"));
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(2);
  expect(runtime.sidebarProps!.generateJobs![0].passage).toEqual(failed.passage);
  expect(runtime.chatProps!.snapshot.notes.find(note => note.id === "draft")!.discussionThreads![0].messages[0].createdNoteId).toBe(failed.noteId);
  expect(runtime.chat.mock.calls[1][0].notes).toEqual(runtime.chat.mock.calls[0][0].notes);
});

it("finishes a background article in its original Space after navigation", async () => {
  addPassageThread();
  const sourceSpaceId = runtime.disk!.activeSpaceId;
  runtime.disk!.spaces.push(createEmptySnapshot("Other Space", runtime.disk!.updatedAt, "other"));
  let finish!: (value: { reply: string }) => void;
  runtime.chat.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await launch();
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" }); });
  await act(async () => { runtime.sidebarProps!.onSwitchSpace("other"); });
  await waitFor(() => expect(runtime.chatProps!.snapshot.workspace.id).toBe("other"));
  await act(async () => { finish({ reply: "# Dark Water\n\nAn article in its original Space." }); });
  await waitFor(() => expect(runtime.disk!.spaces.find(space => space.workspace.id === sourceSpaceId)!.notes.some(note => note.title === "Dark Water")).toBe(true), { timeout: 5000 });
  expect(runtime.chatProps!.snapshot.workspace.id).toBe("other");
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(0);
});

it("does not admit an article without the selected provider", async () => {
  addPassageThread(); runtime.disk!.spaces[0].settings.apiKeyConfigured = false;
  await launch();
  await act(async () => { await expect(runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" })).rejects.toThrow(/Connect the selected AI provider/); });
  expect(runtime.chat).not.toHaveBeenCalled();
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(1);
  expect(runtime.sidebarProps!.generateJobs).toHaveLength(0);
});

it("keeps one article receipt when saving the queued request fails", async () => {
  addPassageThread();
  let finish!: (value: { reply: string }) => void;
  runtime.chat.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await launch(); runtime.save.mockRejectedValueOnce(new Error("Disk is full"));
  await act(async () => { await expect(runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" })).rejects.toThrow("Disk is full"); });
  const receipt = runtime.chatProps!.snapshot.notes.find(note => note.id === "draft")!.discussionThreads![0].messages[0].createdNoteId;
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" }); });
  expect(runtime.chat).toHaveBeenCalledTimes(1);
  expect(runtime.disk!.spaces[0].notes).toHaveLength(2);
  expect(runtime.disk!.spaces[0].notes.some(note => note.id === receipt)).toBe(true);
  await act(async () => { finish({ reply: "# A Durable Image\n\nThe river holds the remaining light." }); });
});

it("preserves an article the user edits before the background response arrives", async () => {
  addPassageThread();
  let finish!: (value: { reply: string }) => void;
  runtime.chat.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await launch();
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "create", messageId: "comment" }); });
  const job = runtime.sidebarProps!.generateJobs![0];
  act(() => runtime.sidebarProps!.onOpenNote(job.noteId));
  const article = runtime.chatProps!.snapshot.notes.find(note => note.id === job.noteId)!;
  act(() => runtime.updateNote!({ ...article, body: "My own article text.", updatedAt: new Date().toISOString() }));
  await act(async () => { finish({ reply: "# Replacement\n\nA late generated answer." }); });
  await waitFor(() => expect(runtime.sidebarProps!.generateJobs![0].stage).toBe("error"));
  expect(runtime.chatProps!.snapshot.notes.find(note => note.id === job.noteId)?.body).toBe("My own article text.");
  act(() => runtime.sidebarProps!.onRestartGenerate!(runtime.sidebarProps!.generateJobs![0]));
  expect(runtime.chat).toHaveBeenCalledTimes(1);
  expect(runtime.sidebarProps!.generateJobs![0].error).toMatch(/preserved/);
});

it("App coalesces repeated Keep clicks, preserves the exchange and navigation, and waits for the actual disk save", async () => {
  await launch(); const original = runtime.disk!.spaces[0].studio.messages;
  let finish!: () => void;
  runtime.save.mockImplementationOnce((next: OrionVault) => new Promise<void>(resolve => { finish = () => { runtime.disk = structuredClone(next); resolve(); }; }));
  let first!: ReturnType<ChatViewProps["onSaveReply"]>; let second!: typeof first; let done = false;
  act(() => {
    first = runtime.chatProps!.onSaveReply("reply"); second = runtime.chatProps!.onSaveReply("reply");
    void first.then(() => { done = true; });
  });
  expect(second).toBe(first);
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(done).toBe(false); expect(runtime.disk!.spaces[0].notes).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "Original draft" })).toBeVisible();
  expect(screen.queryByText("Note created")).not.toBeInTheDocument();
  await act(async () => { finish(); await first; });
  const receipt = await first;
  expect(receipt.noteId).toBe(runtime.disk!.spaces[0].studio.messages[1].createdNoteIds![0]);
  expect(runtime.disk!.spaces[0].notes).toHaveLength(2);
  expect(runtime.disk!.spaces[0].studio.messages.map(({ id, role, content }) => ({ id, role, content })))
    .toEqual(original.map(({ id, role, content }) => ({ id, role, content })));
  expect(screen.getByRole("heading", { name: "Original draft" })).toBeVisible();
});

it("App retries a failed persistence request without making another note or reporting early success", async () => {
  await launch(); runtime.save.mockRejectedValueOnce(new Error("Disk is full"));
  await act(async () => { await expect(runtime.chatProps!.onSaveReply("reply")).rejects.toThrow("Disk is full"); });
  expect(runtime.disk!.spaces[0].notes).toHaveLength(1);
  const retained = runtime.chatProps!.snapshot.studio.messages[1].createdNoteIds![0];
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(2);
  await act(async () => { expect(await runtime.chatProps!.onSaveReply("reply")).toMatchObject({ noteId: retained }); });
  expect(runtime.disk!.spaces[0].notes).toHaveLength(2);
  expect(runtime.disk!.spaces[0].studio.messages).toHaveLength(2);
});

function voiceNoteRequest(id: string): VoiceCommit {
  const snapshot = runtime.chatProps!.snapshot;
  return { id, spaceId: snapshot.workspace.id, threadId: LEGACY_CHAT_THREAD_ID,
    version: stableSnapshotVersion(snapshot), prompt: "Save your findings as a new note",
    result: { reply: "The river image can connect the opening and ending.", noteActions: [
      { title: "River imagery", body: "The river image can connect the opening and ending.", summary: "", aliases: [], tags: [] },
    ] } };
}

it("voice save receipts wait for disk and retry the same note after a failed write", async () => {
  await launch();
  const request = voiceNoteRequest("worker-one-save");
  runtime.save.mockRejectedValueOnce(new Error("Disk is full"));
  await act(async () => { await expect(runtime.chatProps!.onVoiceCommit!(request)).rejects.toThrow("Disk is full"); });
  expect(runtime.disk!.spaces[0].notes).toHaveLength(1);
  expect(runtime.chatProps!.snapshot.notes).toHaveLength(2);
  const retainedId = runtime.chatProps!.snapshot.notes.find(note => note.id !== "draft")!.id;

  let finish!: () => void;
  runtime.save.mockImplementationOnce((next: OrionVault) => new Promise<void>(resolve => {
    finish = () => { runtime.disk = structuredClone(next); resolve(); };
  }));
  let pending!: Promise<VoiceReceipt>; let resolved = false;
  act(() => { pending = runtime.chatProps!.onVoiceCommit!(request); void pending.then(() => { resolved = true; }); });
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  expect(resolved).toBe(false);
  expect(runtime.disk!.spaces[0].notes).toHaveLength(1);
  await act(async () => { finish(); await pending; });
  expect(await pending).toEqual({ savedNoteIds: [retainedId], savedTitles: ["River imagery"] });
  expect(runtime.disk!.spaces[0].notes).toHaveLength(2);
  await act(async () => { expect(await runtime.chatProps!.onVoiceCommit!(request)).toEqual(await pending); });
  expect(runtime.disk!.spaces[0].notes).toHaveLength(2);
  expect(screen.getByRole("heading", { name: "Original draft" })).toBeVisible();
});

it("independent voice workers save separate notes in the captured chat without replacing authored prose", async () => {
  await launch();
  let first!: VoiceReceipt; let second!: VoiceReceipt;
  await act(async () => { first = await runtime.chatProps!.onVoiceCommit!(voiceNoteRequest("worker-first-save")); });
  await act(async () => { second = await runtime.chatProps!.onVoiceCommit!(voiceNoteRequest("worker-second-save")); });
  expect(new Set([...first.savedNoteIds, ...second.savedNoteIds]).size).toBe(2);
  expect(runtime.disk!.spaces[0].notes).toHaveLength(3);
  expect(runtime.disk!.spaces[0].notes.find(note => note.id === "draft")?.body).toBe("The river was dark.");
  for (const id of ["worker-first-save", "worker-second-save"]) {
    expect(runtime.disk!.spaces[0].studio.messages.find(message => message.id === `${id}-assistant`))
      .toMatchObject({ threadId: LEGACY_CHAT_THREAD_ID, createdNoteIds: [`${id}-note-1`] });
  }
});

it("App prepares Use in note through the existing reader without adding internal prompts or applying the proposal", async () => {
  await launch(); const original = structuredClone(runtime.chatProps!.snapshot);
  let turn = 0;
  runtime.chat.mockImplementation(async (request: ChatRequest) => {
    expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBe("draft");
    if (turn++ === 0) return { reply: "", readRequests: [{ kind: "note", id: "draft", query: "", start: null }] };
    return { reply: "Review in note", editIntent: "focused", noteEdits: [{ before: "The river was dark.", after: "The dark river carried the last of the light." }] };
  });
  let proposal;
  await act(async () => { proposal = await runtime.chatProps!.onUseReply!("reply", "draft", vi.fn()); });
  expect(proposal).toMatchObject({ noteId: "draft", baseBody: "The river was dark." });
  expect(runtime.chatProps!.snapshot.studio.messages).toEqual(original.studio.messages);
  expect(runtime.chatProps!.snapshot.notes).toEqual(original.notes);
  expect(runtime.chatProps!.busy).toBe(false);
  expect(runtime.disk!.spaces[0].studio.messages).toHaveLength(2);
});

it("Suggest Rewrite carries a real focused reader result into the note review and can be discarded", async () => {
  addPassageThread();
  runtime.disk!.spaces[0].notes[0].body += "\n\nKeep the rest of the story.";
  await launch();
  runtime.chat.mockImplementation(async (request: ChatRequest) => {
    expect(JSON.parse(request.readingContext!).editBoundary).toEqual({ noteId: "draft", passage: "The river was dark." });
    return { reply: "Ready to review.", editIntent: "focused", noteEdits: [{ before: "dark", after: "black beneath the bridge" }] };
  });
  let pending!: Promise<void>;
  await act(async () => { pending = runtime.threadAction!("draft", "thread", { kind: "rewrite", messageId: "comment", signal: new AbortController().signal }); });
  await waitFor(() => expect(runtime.noteProps?.chatEdit?.proposal).toMatchObject({ mode: "focused", edits: [{ before: "dark", after: "black beneath the bridge" }] }));
  expect(runtime.chat).toHaveBeenCalledTimes(1);
  expect(runtime.noteProps!.note.body).toBe("The river was dark.\n\nKeep the rest of the story.");
  await act(async () => { runtime.noteProps!.onChatEditComplete!(runtime.noteProps!.chatEdit!.id, undefined, false); await pending; });
  expect(runtime.noteProps!.chatEdit).toBeUndefined();
  expect(runtime.disk!.spaces[0].notes[0].body).toBe("The river was dark.\n\nKeep the rest of the story.");
});

it("continues an anchored discussion in main Chat and persists replies back to that thread", async () => {
  const initial = { id: "thread", state: "open" as const, anchor: { quote: "The river was dark.", text: "The river was dark." }, createdAt: runtime.disk!.updatedAt, updatedAt: runtime.disk!.updatedAt,
    messages: [{ id: "comment", role: "assistant" as const, content: "Consider what the river hides.", createdAt: runtime.disk!.updatedAt }] };
  runtime.disk!.spaces[0].notes[0].discussionThreads = [initial];
  await launch();
  const original = structuredClone(runtime.chatProps!.snapshot.studio.messages);
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "open-chat", draft: "Could that image return later?" }); });
  expect(runtime.chat).not.toHaveBeenCalled();
  expect(runtime.chatProps!.passageChat).toMatchObject({ note: { id: "draft" }, thread: { id: "thread" }, draft: "Could that image return later?" });
  runtime.chat.mockImplementation(async (request: ChatRequest) => {
    expect(request.history.map(message => message.content).join(" ")).toContain("Consider what the river hides.");
    expect(request.history.map(message => message.content).join(" ")).not.toContain("Can you develop this?");
    expect(request.editNoteId).toBe("draft"); expect(request.allowNoteActions).toBe(false);
    return { reply: "Bring the river back at the ending." };
  });
  await act(async () => { await runtime.chatProps!.passageChat!.onAction({ kind: "reply", text: "Could that image return later?", signal: new AbortController().signal }); });
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads![0].messages.map(message => message.content))
    .toEqual([initial.messages[0].content, "Could that image return later?", "Bring the river back at the ending."]);
  expect(runtime.disk!.spaces[0].studio.messages).toEqual(original);
  expect(runtime.disk!.spaces[0].notes[0].body).toBe("The river was dark.");
  act(() => runtime.chatProps!.passageChat!.onReturn());
  await screen.findByRole("heading", { name: "Original draft" });
  await act(async () => { await runtime.threadAction!("draft", "thread", { kind: "open-chat", draft: "" }); });
  expect(runtime.chatProps!.passageChat!.thread.messages).toHaveLength(3);
  expect(runtime.chat).toHaveBeenCalledTimes(1);
});

it("persists a human passage comment without credentials or provider work, then reopens the same thread", async () => {
  runtime.disk!.spaces[0].settings.apiKeyConfigured = false;
  await launch();
  const { spaceNoteVersion } = await import("./lib/spaceKnowledge");
  const note = runtime.noteProps!.note;
  const selection = { id: "selected", spaceId: runtime.disk!.activeSpaceId, noteId: note.id, noteTitle: note.title,
    version: spaceNoteVersion(note), range: { from: 0, to: note.body.length, unit: "dom-text-utf16" as const }, text: note.body, hiddenTaskRanges: [] };
  const history = structuredClone(runtime.disk!.spaces[0].studio.messages);
  await act(async () => { await runtime.noteProps!.onCreateComment!(selection, "Keep this image, but question the tone.", "human-thread"); });
  expect(runtime.chat).not.toHaveBeenCalled();
  expect(runtime.disk!.spaces[0].notes[0].body).toBe(note.body);
  expect(runtime.disk!.spaces[0].studio.messages).toEqual(history);
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads![0].messages[0]).toMatchObject({ role: "user", content: "Keep this image, but question the tone." });
  await act(async () => { await runtime.noteProps!.onCreateComment!(selection, "Keep this image, but question the tone.", "human-thread"); });
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads).toHaveLength(1);
  await act(async () => cleanup());
  await launch();
  expect(runtime.noteProps!.note.discussionThreads![0].id).toBe("human-thread");
  expect(runtime.chat).not.toHaveBeenCalled();
  runtime.chat.mockResolvedValue({ reply: "The image can carry a more uncertain tone. [[e1]]", editIntent: "none" });
  await act(async () => { await runtime.threadAction!("draft", "human-thread", { kind: "reply", text: "What do you think of my comment?", signal: new AbortController().signal }); });
  expect(runtime.chat).toHaveBeenCalledTimes(1);
  expect(runtime.chat.mock.calls[0][0].history.some((message: { content: string }) => message.content.includes("Keep this image"))).toBe(true);
  expect(runtime.noteProps!.note.discussionThreads![0].messages).toHaveLength(3);
  expect(runtime.disk!.spaces[0].notes[0].body).toBe(note.body);
});

it("retries a failed local comment save without duplicating the thread or calling a provider", async () => {
  await launch();
  const { spaceNoteVersion } = await import("./lib/spaceKnowledge");
  const note = runtime.noteProps!.note;
  const selection = { id: "selected", spaceId: runtime.disk!.activeSpaceId, noteId: note.id, noteTitle: note.title,
    version: spaceNoteVersion(note), range: { from: 0, to: note.body.length, unit: "dom-text-utf16" as const }, text: note.body, hiddenTaskRanges: [] };
  runtime.save.mockRejectedValueOnce(new Error("Disk is unavailable"));
  await act(async () => { await expect(runtime.noteProps!.onCreateComment!(selection, "Keep this image.", "retry-human")).rejects.toThrow(/Disk is unavailable/); });
  expect(runtime.noteProps!.note.discussionThreads).toHaveLength(1);
  await act(async () => { await runtime.noteProps!.onCreateComment!(selection, "Keep this image.", "retry-human"); });
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads).toHaveLength(1);
  expect(runtime.disk!.spaces[0].notes[0].body).toBe(note.body);
  expect(runtime.chat).not.toHaveBeenCalled();
});

it("edits and deletes a human comment without changing prose, replies, or another thread", async () => {
  const now = runtime.disk!.updatedAt;
  const initial = { id: "human", state: "open" as const, anchor: { quote: "The river was dark.", text: "The river was dark.", cursor: { before: "The river ", after: "was dark." } }, createdAt: now, updatedAt: now,
    messages: [{ id: "comment", role: "user" as const, content: "My first thought.", createdAt: now }, { id: "reply", role: "assistant" as const, content: "An existing reply.", createdAt: now }] };
  runtime.disk!.spaces[0].notes[0].discussionThreads = [initial, { ...initial, id: "other" }];
  await launch();
  await act(async () => { await runtime.threadAction!("draft", "human", { kind: "edit-comment", text: "My revised thought." }); });
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads![0].messages.map(m => m.content)).toEqual(["My revised thought.", "An existing reply."]);
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads![0].anchor).toEqual(initial.anchor);
  await act(async () => { await runtime.threadAction!("draft", "human", { kind: "delete" }); });
  expect(runtime.disk!.spaces[0].notes[0].discussionThreads!.map(t => t.id)).toEqual(["other"]);
  expect(runtime.disk!.spaces[0].notes[0].body).toBe("The river was dark.");
  expect(runtime.chat).not.toHaveBeenCalled();
  await act(async () => cleanup()); await launch();
  expect(runtime.noteProps!.note.discussionThreads!.map(t => t.id)).toEqual(["other"]);
});
