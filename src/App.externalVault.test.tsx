// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/core";
import { createEmptyVault } from "./data/defaults";
import type { Note, OrionVault } from "./types";

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null,
  load: vi.fn(), save: vi.fn(), invoke: vi.fn(),
}));

vi.mock("./lib/storage", async original => ({
  ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true,
  loadSnapshot: runtime.load, saveSnapshot: runtime.save,
}));
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
vi.mock("./components/ChatDock", () => ({ ChatDock: () => null }));
// Keep App's persistence, NoteView, RichNoteEditor and conflict dialog real.
import App from "./App";

const originalBody = "The river was dark.\n\nThe ferry waited by the bank.";
const remoteAddition = "\n\nAn observation saved through MCP — café 🪶.";
const localAddition = " A sentence written in the open editor.";

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ bottom: 0, height: 0, left: 0,
      right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) },
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});

beforeEach(() => {
  runtime.load.mockReset(); runtime.save.mockReset();
  runtime.invoke.mockReset().mockResolvedValue(undefined);
  mockIPC((command, payload) => runtime.invoke(command, payload), { shouldMockEvents: true });
  mockWindows("main");
  const vault = createEmptyVault("External writer fixture");
  vault.spaces[0].settings.includeExistingNotesInAIContext = false;
  vault.spaces[0].notes = [{ id: "open-draft", title: "Open draft", slug: "open-draft", body: originalBody,
    summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt }];
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault, expectedRevision: string | null) => {
    // Model the native atomic revision guard. Nothing reads or writes a real vault.
    if (expectedRevision !== runtime.disk?.updatedAt) throw new Error("ORION_VAULT_CONFLICT");
    runtime.disk = structuredClone(next);
  });
});

afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks(); window.history.replaceState(null, "", "/");
});

const diskNote = () => runtime.disk!.spaces[0].notes[0];
const openEditor = () => (screen.getByRole("textbox", { name: "Note body" }) as HTMLElement & { editor: Editor }).editor;

async function launch() {
  window.history.replaceState(null, "", `/?space=${runtime.disk!.activeSpaceId}&note=open-draft`);
  render(<App />);
  await screen.findByRole("heading", { name: "Open draft" });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  await screen.findByRole("textbox", { name: "Note body" });
  await waitFor(() => expect(runtime.save).toHaveBeenCalled());
  runtime.save.mockClear();
  return openEditor();
}

function externalUpdate(patch: Partial<Note>) {
  const next = structuredClone(runtime.disk!);
  const revision = new Date(Math.max(Date.now(), Date.parse(next.updatedAt) + 1)).toISOString();
  Object.assign(next.spaces[0].notes[0], patch, { updatedAt: revision });
  next.spaces[0].updatedAt = revision;
  next.updatedAt = revision;
  runtime.disk = next;
  return revision;
}

function appendInEditor(editor: Editor, text: string) {
  act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, text); });
}

describe("external MCP changes with a note already open", () => {
  it("coalesces short typing pauses while checkpointing continuous typing within five seconds", async () => {
    const editor = await launch();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    try {
      for (let i = 0; i < 9; i++) {
        appendInEditor(editor, " word");
        await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      }
      expect(runtime.save).not.toHaveBeenCalled();
      appendInEditor(editor, " checkpoint");
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(runtime.save).toHaveBeenCalledOnce();
      expect(diskNote().body).toBe(originalBody + " word".repeat(9) + " checkpoint");
      appendInEditor(editor, " latest");
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(diskNote().body).toBe(originalBody + " word".repeat(9) + " checkpoint latest");
      expect(openEditor()).toBe(editor);
    } finally { vi.useRealTimers(); }
  });
  it.each(["focus", "native"])("refreshes the retained rich editor through %s and preserves the remote addition in a subsequent prose save", async signal => {
    const editor = await launch();
    const body = originalBody + remoteAddition;
    externalUpdate({ body });
    if (signal === "native") await act(async () => { await emit("orion-vault-changed", {}); });
    else fireEvent.focus(window);
    await waitFor(() => expect(editor.getMarkdown()).toBe(body));
    expect(openEditor()).toBe(editor);
    expect(screen.getByRole("textbox", { name: "Note title" })).toHaveValue("Open draft");

    appendInEditor(editor, localAddition);
    await waitFor(() => expect(diskNote().body).toBe(body + localAddition), { timeout: 3_000 });
    expect(runtime.save).toHaveBeenCalled();
    expect(openEditor()).toBe(editor);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("merges a missed external body update with a local title save, then updates the same editor", async () => {
    const editor = await launch();
    const body = originalBody + remoteAddition;
    const remoteRevision = externalUpdate({ body });
    // No focus/notification: the autosave itself must discover the external writer.
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "Local title" } });
    expect(editor.getMarkdown()).toBe(originalBody);
    await waitFor(() => expect(diskNote()).toMatchObject({ title: "Local title", body }));
    expect(runtime.save).toHaveBeenCalledWith(expect.any(Object), remoteRevision);
    expect(editor.getMarkdown()).toBe(body);
    expect(openEditor()).toBe(editor);

    appendInEditor(editor, localAddition);
    await waitFor(() => expect(diskNote()).toMatchObject({ title: "Local title", body: body + localAddition }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps conflicting local prose visible and never overwrites the remote addition before an explicit choice", async () => {
    const editor = await launch();
    appendInEditor(editor, localAddition);
    fireEvent.change(screen.getByRole("textbox", { name: "Note title" }), { target: { value: "Local title" } });
    const body = originalBody + remoteAddition;
    const remoteRevision = externalUpdate({ body });
    await screen.findByRole("dialog", { name: "Choose which changes to keep" });
    expect(runtime.save).not.toHaveBeenCalled();
    expect(diskNote().body).toBe(body);
    expect(editor.getMarkdown()).toBe(originalBody + localAddition);

    fireEvent.click(screen.getByRole("button", { name: "Use other window’s changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(runtime.save).toHaveBeenCalledWith(expect.any(Object), remoteRevision);
    expect(diskNote()).toMatchObject({ title: "Local title", body });
    expect(editor.getMarkdown()).toBe(body);
    expect(openEditor()).toBe(editor);
  });

  it("does not let a stale conflict choice silently erase a newer external revision", async () => {
    const editor = await launch();
    appendInEditor(editor, localAddition);
    externalUpdate({ body: originalBody + remoteAddition });
    await screen.findByRole("dialog", { name: "Choose which changes to keep" });

    const newestBody = originalBody + remoteAddition + "\n\nA second MCP update arrived while choosing.";
    const newestRevision = externalUpdate({ body: newestBody, summary: "New remote metadata" });
    const reads = runtime.load.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Keep this window’s changes" }));
    await waitFor(() => expect(runtime.load.mock.calls.length).toBeGreaterThan(reads));
    await screen.findByText("Changes still need saving");
    expect(screen.getByRole("dialog", { name: "Choose which changes to keep" })).toBeVisible();
    expect(runtime.save).not.toHaveBeenCalled();
    expect(diskNote().body).toBe(newestBody);
    expect(editor.getMarkdown()).toBe(originalBody + localAddition);

    fireEvent.click(screen.getByRole("button", { name: "Use other window’s changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(runtime.disk!.updatedAt).toBe(newestRevision);
    expect(diskNote()).toMatchObject({ body: newestBody, summary: "New remote metadata" });
    expect(editor.getMarkdown()).toBe(newestBody);
    expect(openEditor()).toBe(editor);
  });
});
