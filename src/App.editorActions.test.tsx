// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEmptyVault } from "./data/defaults";
import type { OrionVault } from "./types";
import type { EditorActionDelivery, EditorActionReceipt } from "./lib/assistant/editorActions";

type ActionTarget = { spaceId: string; noteId: string; ready: boolean; documentVersion: string; selectionVersion: string };

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null, load: vi.fn(), save: vi.fn(), invoke: vi.fn(), chat: vi.fn(),
  target: null as ActionTarget | null,
  capture: null as EditorActionDelivery | null, delivery: null as EditorActionDelivery | null,
  receipt: null as EditorActionReceipt | null, accepted: "", saved: false, failSave: false, failure: "",
}));
vi.mock("./lib/storage", async original => ({ ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true, loadSnapshot: runtime.load, saveSnapshot: runtime.save, chatWithOrion: runtime.chat }));
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme"); const { defaultSettings } = await import("./data/defaults");
  return { useResolvedTheme: () => ({ palette: resolveThemePalette(defaultSettings, "dark"), glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/ChatDock", () => ({ ChatDock: () => null }));
import App from "./App";

beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect(0, 0, 100, 20) },
}));
beforeEach(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-content")) return new DOMRect(0, 0, 1200, 760);
    if (this.classList.contains("rich-note-editor")) return new DOMRect(200, 80, 840, 620);
    if (this.classList.contains("editor-prose")) return new DOMRect(280, 130, 680, 500);
    return new DOMRect(280, 200, 80, 20);
  });
  runtime.load.mockReset(); runtime.save.mockReset(); runtime.invoke.mockReset(); runtime.chat.mockReset();
  runtime.target = null; runtime.capture = null; runtime.delivery = null; runtime.receipt = null;
  runtime.accepted = ""; runtime.saved = false; runtime.failSave = false; runtime.failure = "";
  const vault = createEmptyVault("Editor action integration"), space = vault.spaces[0];
  space.settings.assistantAccess = { enabled: true, allowWrites: true, allowAI: true, spaceIds: [space.workspace.id] };
  space.settings.apiKeyConfigured = true;
  space.notes = [{ id: "draft", title: "Original draft", slug: "draft", body: "The river was dark.\n\n- [x] PRIVATE completed task\n\nThe letter was still warm.", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: vault.updatedAt, updatedAt: vault.updatedAt }];
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault) => {
    if (runtime.failSave && runtime.accepted) throw new Error("Disk unavailable");
    runtime.disk = structuredClone(next);
  });
  runtime.chat.mockResolvedValue({ reply: "The river was bright." });
  const changeState = (state: EditorActionReceipt["state"]) => { runtime.receipt = { ...runtime.receipt!, state }; return runtime.receipt; };
  runtime.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "editor_actions_poll") {
      runtime.target = args.target as ActionTarget | null;
      const captures = runtime.target?.ready && runtime.capture ? [runtime.capture] : [];
      const deliveries = runtime.target?.ready && runtime.delivery ? [runtime.delivery] : [];
      if (captures.length) runtime.capture = null; if (deliveries.length) runtime.delivery = null;
      return { targetId: args.target ? "target-draft" : null, captures, deliveries, receipts: runtime.receipt ? [runtime.receipt] : [] };
    }
    if (command === "editor_actions_capture") return changeState("captured");
    if (command === "editor_actions_claim") return changeState("generating");
    if (command === "editor_actions_authorize") return { ok: true };
    if (command === "editor_actions_review") return changeState("awaiting_review");
    if (command === "editor_actions_decide") return changeState(args.accept ? "accepting" : "discarded");
    if (command === "editor_actions_accepted") { runtime.accepted = args.body as string; return changeState("accepted_in_editor"); }
    if (command === "editor_actions_saved") {
      expect(runtime.disk!.spaces[0].notes[0].body).toBe(runtime.accepted);
      runtime.saved = true; return changeState("saved");
    }
    if (command === "editor_actions_fail") { runtime.failure = String(args.error); return changeState(runtime.accepted ? "save_failed" : "failed"); }
    if (command === "assistant_review_poll") return { deliveries: [], receipts: [] };
    if (command === "editor_context_poll") return { targetId: null, requests: [] };
  });
  mockIPC((command, args) => runtime.invoke(command, args), { shouldMockEvents: true }); mockWindows("main");
});
afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks(); vi.restoreAllMocks(); window.history.replaceState(null, "", "/");
});
async function launch(edit = true) {
  window.history.replaceState(null, "", `/?space=${runtime.disk!.activeSpaceId}&note=draft`);
  render(<App />); await screen.findByRole("heading", { name: "Original draft" });
  await waitFor(() => expect(runtime.save).toHaveBeenCalled());
  if (edit) {
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await screen.findByRole("textbox", { name: "Note body" });
  }
}
async function propose() {
  const editor = (document.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  await waitFor(() => expect(editor.isFocused).toBe(true));
  await waitFor(() => expect(runtime.target?.ready).toBe(true), { timeout: 2500 });
  const previousVersion = runtime.target!.selectionVersion;
  act(() => { editor.commands.setTextSelection({ from: 1, to: 20 }); });
  await waitFor(() => {
    expect(runtime.target?.ready).toBe(true);
    expect(runtime.target?.selectionVersion).not.toBe(previousVersion);
  }, { timeout: 2500 });
  const request: EditorActionDelivery = { id: "action-test", editorTargetId: "target-draft", spaceId: runtime.disk!.activeSpaceId,
    noteId: "draft", action: { kind: "rewrite", preset: "clarify" }, documentVersion: runtime.target!.documentVersion,
    selectionVersion: runtime.target!.selectionVersion, baseNoteVersion: "native-version" };
  runtime.receipt = { ...request, captureId: "native-capture", state: "capture_pending" };
  runtime.capture = request;
  await waitFor(() => expect(runtime.receipt?.state).toBe("captured"), { timeout: 2500 });
  expect(runtime.chat).not.toHaveBeenCalled();
  runtime.delivery = { ...request, captureId: "native-capture" };
  await waitFor(() => expect(runtime.receipt?.state, runtime.failure).toBe("awaiting_review"), { timeout: 2500 });
  return screen.findByRole("button", { name: "Accept AI writing" }, { timeout: 2500 });
}
it("leaves a reading note in reading mode and does not advertise an action target without AI authority", async () => {
  await launch(false);
  await new Promise(resolve => setTimeout(resolve, 1100));
  expect(runtime.target).toBeNull(); expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  cleanup(); runtime.disk!.spaces[0].settings.assistantAccess.allowAI = false;
  await launch(); await new Promise(resolve => setTimeout(resolve, 1100));
  expect(runtime.target).toBeNull(); expect(runtime.chat).not.toHaveBeenCalled();
});
it("uses actual App wiring, selected editor, review and ordinary save queue before confirming saved; Undo remains one step", async () => {
  await launch(); const before = runtime.disk!.spaces[0].notes[0].body;
  const accept = await propose();
  expect(runtime.disk!.spaces[0].notes[0].body).toBe(before);
  expect(runtime.chat.mock.calls[0][2]).toMatchObject({ actionId: "action-test", sessionId: expect.any(String) });
  expect(JSON.stringify(runtime.chat.mock.calls[0][0])).not.toContain("PRIVATE");
  fireEvent.click(accept);
  await waitFor(() => expect(runtime.saved).toBe(true));
  expect(runtime.accepted).toBe(before.replace("The river was dark.", "The river was bright."));
  expect(runtime.disk!.spaces[0].notes[0].body).toBe(runtime.accepted);
  expect(runtime.disk!.spaces[0].studio.messages).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("The river was dark.");
}, 12_000);
it("keeps accepted editor text and Undo when the App save queue fails, without claiming it was saved", async () => {
  await launch(); const before = runtime.disk!.spaces[0].notes[0].body;
  const accept = await propose(); runtime.failSave = true; fireEvent.click(accept);
  await waitFor(() => expect(runtime.failure).toBe("Disk unavailable"));
  expect(runtime.saved).toBe(false); expect(runtime.disk!.spaces[0].notes[0].body).toBe(before);
  expect(screen.getByText("Changes accepted, save not confirmed")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("The river was bright.");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("The river was dark.");
}, 12_000);
