// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEmptyVault } from "./data/defaults";
import type { OrionVault } from "./types";
import type { ImportStudioProps } from "./components/ImportStudio";

const runtime = vi.hoisted(() => ({ disk: null as OrionVault | null, props: null as ImportStudioProps | null,
  load: vi.fn(), save: vi.fn(), invoke: vi.fn() }));
vi.mock("./lib/storage", async original => ({ ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true, loadSnapshot: runtime.load, saveSnapshot: runtime.save }));
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
vi.mock("./components/ImportStudio", async original => ({ ...await original<typeof import("./components/ImportStudio")>(),
  ImportStudio: (props: ImportStudioProps) => { runtime.props = props; return null; } }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/NoteView", () => ({ NoteView: () => null }));
vi.mock("./components/ChatDock", () => ({ ChatDock: () => null }));
import App from "./App";
import { buildImportPayload } from "./components/ImportStudio";
import { parseTextImport } from "./lib/files";

beforeEach(() => {
  runtime.props = null;
  runtime.load.mockReset(); runtime.save.mockReset(); runtime.invoke.mockReset().mockResolvedValue(undefined);
  mockIPC((command, payload) => runtime.invoke(command, payload), { shouldMockEvents: true });
  mockWindows("main");
  const vault = createEmptyVault("Isolated import fixture");
  vault.spaces[0].settings.includeExistingNotesInAIContext = false;
  vault.spaces[0].sources = [{ id: "existing-source", title: "Existing evidence", kind: "markdown", text: "Original full source", importedAt: vault.updatedAt, noteIds: [] }];
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault, expectedRevision: string | null) => {
    if (expectedRevision !== runtime.disk?.updatedAt) throw new Error("ORION_VAULT_CONFLICT");
    runtime.disk = structuredClone(next);
  });
});
afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks(); window.history.replaceState(null, "", "/");
});
async function launch() {
  render(<App />);
  await waitFor(() => expect(runtime.props?.snapshot.sources[0]?.id).toBe("existing-source"));
}
function prepare() {
  const parsed = parseTextImport("import.md", "text/markdown", "# Imported claim\n\nThe claim [Evidence](orion-source://existing-source).");
  return buildImportPayload([{ item: { id: "input", fileName: parsed.fileName, mimeType: parsed.mimeType, byteSize: parsed.byteSize, status: "ready", included: true, parsed } }], runtime.props!.snapshot);
}

it("App's local import saves both citation edges in its ordinary guarded vault update", async () => {
  await launch();
  const payload = prepare();
  const sourceBefore = structuredClone(runtime.props!.snapshot.sources[0]);
  await act(async () => { await runtime.props!.onApply(payload); });
  await waitFor(() => expect(runtime.disk!.spaces[0].notes.some((note) => note.id === payload.notes[0].id)).toBe(true));
  const saved = runtime.disk!.spaces[0];
  expect(saved.notes.find((note) => note.id === payload.notes[0].id)?.sourceIds).toEqual([payload.sources[0].id, "existing-source"]);
  expect(saved.sources.find((source) => source.id === "existing-source")).toEqual({ ...sourceBefore, noteIds: [payload.notes[0].id] });
  expect(saved.sources.find((source) => source.id === payload.sources[0].id)?.noteIds).toEqual([payload.notes[0].id]);
  expect(saved.sources.filter((source) => source.id === "existing-source")).toHaveLength(1);
});

it("App rejects an import result when its captured Space/source context no longer matches", async () => {
  await launch();
  const payload = { ...prepare(), baseSnapshotVersion: "stale-source-version" };
  const before = structuredClone(runtime.disk);
  await act(async () => { expect(() => runtime.props!.onApply(payload)).toThrow("Space changed"); });
  expect(runtime.disk).toEqual(before);
  expect(runtime.props!.snapshot.notes).toHaveLength(0);
  expect(runtime.props!.snapshot.sources[0].noteIds).toEqual([]);
});
