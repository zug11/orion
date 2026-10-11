// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEmptyVault } from "./data/defaults";
import type { ChatRequest, Note, OrionVault } from "./types";
import type { ChatViewProps } from "./components/ChatView";

const runtime = vi.hoisted(() => ({ disk: null as OrionVault | null, chatProps: null as ChatViewProps | null,
  load: vi.fn(), save: vi.fn(), invoke: vi.fn(), chat: vi.fn() }));
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
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/NoteView", () => ({ NoteView: ({ note }: { note: Note }) => <h1>{note.title}</h1> }));
vi.mock("./components/ChatDock", () => ({ ChatDock: (props: ChatViewProps) => { runtime.chatProps = props; return null; } }));
import App from "./App";

beforeEach(() => {
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
