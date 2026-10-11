// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEmptyVault } from "./data/defaults";
import type { OrionVault } from "./types";
import type { ExternalEditDelivery } from "./lib/assistant/editReviews";
const runtime = vi.hoisted(() => ({ disk: null as OrionVault | null, load: vi.fn(), save: vi.fn(), invoke: vi.fn(),
  delivery: null as ExternalEditDelivery | null, accepted: "", saved: false, failSave: false, failure: "" }));
vi.mock("./lib/storage", async original => ({ ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true, loadSnapshot: runtime.load, saveSnapshot: runtime.save }));
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
  runtime.load.mockReset(); runtime.save.mockReset(); runtime.invoke.mockReset();
  runtime.accepted = ""; runtime.saved = false; runtime.failSave = false; runtime.failure = "";
  const vault = createEmptyVault("External review"); const space = vault.spaces[0];
  space.settings.assistantAccess = { enabled: true, allowWrites: true, allowAI: false, spaceIds: [space.workspace.id] };
  space.notes = [{ id: "draft", title: "Original draft", slug: "draft", body: "The river was dark.", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: vault.updatedAt, updatedAt: vault.updatedAt }];
  runtime.disk = vault;
  runtime.delivery = { id: "external-review", spaceId: space.workspace.id, noteId: "draft", expectedVersion: "opaque-native-version", title: "Original draft", baseBody: space.notes[0].body, edit: { kind: "focused", edits: [{ before: "dark", after: "bright" }] } };
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault) => {
    if (runtime.failSave && runtime.accepted) throw new Error("Disk unavailable");
    runtime.disk = structuredClone(next);
  });
  runtime.invoke.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "assistant_review_poll") {
      const target = args.target as { ready: boolean; noteId: string } | null;
      const deliveries = target?.ready && runtime.delivery ? [runtime.delivery] : [];
      if (deliveries.length) runtime.delivery = null;
      return { deliveries, receipts: [] };
    }
    if (command === "assistant_review_stage") return { state: "awaiting_review" };
    if (command === "assistant_review_decide") return { state: args.accept ? "accepting" : "discarded" };
    if (command === "assistant_review_accepted") { runtime.accepted = args.body as string; return { state: "accepted_in_editor" }; }
    if (command === "assistant_review_saved") {
      expect(runtime.disk!.spaces[0].notes[0].body).toBe(runtime.accepted);
      runtime.saved = true; return { state: "saved" };
    }
    if (command === "assistant_review_fail") { runtime.failure = String(args.error); return { state: "save_failed" }; }
  });
  mockIPC((command, args) => runtime.invoke(command, args), { shouldMockEvents: true }); mockWindows("main");
});
afterEach(async () => { await act(async () => { cleanup(); await vi.dynamicImportSettled(); }); clearMocks(); window.history.replaceState(null, "", "/"); });
async function launch() {
  window.history.replaceState(null, "", `/?space=${runtime.disk!.activeSpaceId}&note=draft`);
  render(<App />); await screen.findByRole("heading", { name: "Original draft" });
}
it("does not poll the external mailbox unless this Space opted into workflow writes", async () => {
  runtime.disk!.spaces[0].settings.assistantAccess.enabled = false;
  await launch(); await waitFor(() => expect(runtime.save).toHaveBeenCalled());
  expect(runtime.invoke.mock.calls.some(([command]) => command === "assistant_review_poll")).toBe(false);
  expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
});
it("stages in the already-open note and records the real accepted editor body only after the normal save", async () => {
  await launch();
  const accept = await screen.findByRole("button", { name: "Accept changes" }, { timeout: 3500 });
  expect(runtime.disk!.spaces[0].notes[0].body).toBe("The river was dark.");
  expect(runtime.accepted).toBe("");
  fireEvent.click(accept);
  await waitFor(() => expect(runtime.saved).toBe(true));
  expect(runtime.accepted).toBe("The river was bright.");
  expect(runtime.disk!.spaces[0].studio.messages).toHaveLength(0);
  expect(runtime.disk!.spaces[0].notes).toHaveLength(1);
  expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Original draft");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("The river was dark.");
});
it("keeps an accepted edit and its Undo when disk persistence fails, without a saved receipt", async () => {
  await launch();
  const accept = await screen.findByRole("button", { name: "Accept changes" }, { timeout: 3500 });
  runtime.failSave = true; fireEvent.click(accept);
  await waitFor(() => expect(runtime.failure).toBe("Disk unavailable"));
  expect(runtime.saved).toBe(false); expect(runtime.accepted).toBe("The river was bright.");
  expect(runtime.disk!.spaces[0].notes[0].body).toBe("The river was dark.");
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("The river was bright.");
  expect(screen.getByText("Changes accepted, save not confirmed")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("The river was dark.");
});
