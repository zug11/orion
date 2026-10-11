// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEmptyVault } from "./data/defaults";
import type { OrionVault } from "./types";
import type { EditorContextRequest } from "./lib/assistant/editorContext";
const runtime = vi.hoisted(() => ({ disk: null as OrionVault | null, load: vi.fn(), save: vi.fn(), invoke: vi.fn(), requests: [] as EditorContextRequest[] }));
vi.mock("./lib/storage", async original => ({ ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true, loadSnapshot: runtime.load, saveSnapshot: runtime.save }));
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme"); const { defaultSettings } = await import("./data/defaults");
  return { useResolvedTheme: () => ({ palette: resolveThemePalette(defaultSettings, "dark"), glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: ({ onOpenNote }: { onOpenNote: (id: string) => void }) => <button onClick={() => onOpenNote("other")}>Open another note</button> }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/ChatDock", () => ({ ChatDock: () => <button>Quiet voice control</button> }));
import App from "./App";
beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 100, 20) },
}));
beforeEach(() => {
  runtime.load.mockReset(); runtime.save.mockReset(); runtime.invoke.mockReset(); runtime.requests = [];
  const vault = createEmptyVault("Read-only editor context"), space = vault.spaces[0];
  space.settings.assistantAccess = { enabled: true, allowWrites: false, allowAI: false, spaceIds: [space.workspace.id] };
  space.notes = [{ id: "draft", title: "Original draft", slug: "draft", body: "The river was dark.\n\n- [x] Secret completed task\n- [ ] Visible task", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: vault.updatedAt, updatedAt: vault.updatedAt },
    { id: "other", title: "Other note", slug: "other", body: "A different note.", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: vault.updatedAt, updatedAt: vault.updatedAt }];
  runtime.disk = vault; runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault) => { runtime.disk = structuredClone(next); });
  runtime.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "editor_context_poll") return { targetId: "target", requests: args.target ? runtime.requests.splice(0) : [] };
    if (command === "editor_context_respond") return { ok: true };
  });
  mockIPC((command, args) => runtime.invoke(command, args), { shouldMockEvents: true }); mockWindows("main");
});
afterEach(async () => { await act(async () => { cleanup(); await vi.dynamicImportSettled(); }); window.getSelection()?.removeAllRanges(); clearMocks(); window.history.replaceState(null, "", "/"); });
async function launch() {
  window.history.replaceState(null, "", `/?space=${runtime.disk!.activeSpaceId}&note=draft`);
  render(<App />); await screen.findByRole("heading", { name: "Original draft" });
  await waitFor(() => expect(runtime.save).toHaveBeenCalled());
}
function selectText(text: string, start = 0, end = text.length) {
  const root = document.querySelector('[data-voice-note-body="reading"], [data-voice-note-body] .tiptap')!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = null;
  while ((node = walker.nextNode()) && !node.textContent?.includes(text)) { /* Find rendered prose only. */ }
  if (!node) throw new Error(`Missing text ${text}`);
  const range = document.createRange(), offset = node.textContent!.indexOf(text);
  fireEvent.pointerDown(root); range.setStart(node, offset + start); range.setEnd(node, offset + end);
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(root);
}
async function read(id = "read", taskView: "working" | "history" = "working") {
  runtime.requests.push({ id, targetId: "target", spaceId: runtime.disk!.activeSpaceId, noteId: "draft", taskView, maxChars: 12_000 });
  await waitFor(() => expect(runtime.invoke.mock.calls.some(([name, args]) => name === "editor_context_respond" && args.id === id)).toBe(true), { timeout: 3_000 });
  return runtime.invoke.mock.calls.find(([name, args]) => name === "editor_context_respond" && args.id === id)![1].reference;
}
it("does not poll editor context when local assistant access is disabled or this Space is not granted", async () => {
  runtime.disk!.spaces[0].settings.assistantAccess.spaceIds = [];
  await launch(); await new Promise(resolve => setTimeout(resolve, 1_100));
  expect(runtime.invoke.mock.calls.some(([name]) => name === "editor_context_poll")).toBe(false);
});
it("reads a real note selection without voice, provider keys or write authority and does not save", async () => {
  await launch(); selectText("The river was dark.", 4, 9);
  await new Promise(resolve => setTimeout(resolve, 250));
  const before = runtime.save.mock.calls.length;
  const reference = await read();
  expect(reference).toMatchObject({ state: "selected", documentVersion: expect.stringMatching(/^displayed-v1:/), fragments: [{ text: "river", from: 4, to: 9 }] });
  expect(runtime.save).toHaveBeenCalledTimes(before);
  expect(runtime.invoke.mock.calls.some(([name]) => name === "assistant_review_poll")).toBe(false);
  const polls = runtime.invoke.mock.calls.filter(([name]) => name === "editor_context_poll");
  expect(polls.every(([, args]) => !JSON.stringify(args).includes("river"))).toBe(true);
  fireEvent.pointerDown(screen.getByRole("button", { name: "Quiet voice control" }));
  window.getSelection()!.removeAllRanges(); fireEvent(document, new Event("selectionchange"));
  fireEvent.pointerUp(screen.getByRole("button", { name: "Quiet voice control" }));
  expect((await read("preserved")).fragments).toEqual(reference.fragments);
});
it("masks completed-task selections before IPC while retaining explicit history", async () => {
  await launch(); selectText("Secret completed task"); await new Promise(resolve => setTimeout(resolve, 250));
  const working = await read(); expect(working.fragments).toEqual([]); expect(working.completedTasksOmitted).toBe(true);
  expect(JSON.stringify(working)).not.toContain("Secret");
  expect((await read("history", "history")).fragments[0].text).toBe("Secret completed task");
});
it("returns an exact reading cursor without surrounding prose and clears the old note on navigation", async () => {
  await launch(); selectText("The river was dark.", 4, 4); await new Promise(resolve => setTimeout(resolve, 250));
  expect(await read()).toMatchObject({ state: "cursor", selection: { coordinateSystem: "dom-text-utf16", from: 4, to: 4 }, fragments: [] });
  fireEvent.click(screen.getByRole("button", { name: "Open another note" }));
  await screen.findByRole("heading", { name: "Other note" });
  await waitFor(() => expect(runtime.invoke.mock.calls.some(([name, args]) => name === "editor_context_poll" && args.target?.noteId === "other")).toBe(true), { timeout: 2_000 });
  runtime.requests.push({ id: "other-read", targetId: "target", spaceId: runtime.disk!.activeSpaceId, noteId: "other", taskView: "working", maxChars: 100 });
  await waitFor(() => expect(runtime.invoke.mock.calls.some(([name, args]) => name === "editor_context_respond" && args.id === "other-read")).toBe(true), { timeout: 2_000 });
  expect(runtime.invoke.mock.calls.find(([name, args]) => name === "editor_context_respond" && args.id === "other-read")![1].reference).toMatchObject({ state: "none", fragments: [] });
});
