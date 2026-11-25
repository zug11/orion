// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { AppSnapshot, Note, OrionVault } from "./types";
import { createEmptyVault } from "./data/defaults";

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null,
  load: vi.fn(),
  save: vi.fn(),
  invoke: vi.fn(),
  home: vi.fn(),
}));

vi.mock("./lib/storage", async (original) => ({
  ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true,
  loadSnapshot: runtime.load,
  loadVaultRevision: async () => runtime.disk?.updatedAt ?? null,
  saveSnapshot: runtime.save,
}));
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme");
  const { defaultSettings } = await import("./data/defaults");
  const palette = resolveThemePalette(defaultSettings, "dark");
  return { useResolvedTheme: () => ({ palette, glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <aside aria-label="Library sidebar" /> }));
vi.mock("./components/HomeView", () => ({ HomeView: ({ snapshot }: { snapshot: AppSnapshot }) => {
  runtime.home(snapshot.workspace.name); return null;
} }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: (props: {
  open: boolean; onOpenCollection: () => Promise<boolean>; onClose: () => void;
}) => props.open ? <button onClick={async () => { if (await props.onOpenCollection()) props.onClose(); }}>Open an .orion file</button> : null }));
vi.mock("./components/NoteView", () => ({ NoteView: (props: {
  note: Note; initialEditing: boolean; onUpdateNote: (note: Note) => void; onOpenNote: (id: string) => void;
}) => <section data-testid="document" data-editing={props.initialEditing}>
  <h1>{props.note.title}</h1>
  <textarea aria-label="Draft body" value={props.note.body} onChange={(event) => props.onUpdateNote({
    ...props.note, body: event.target.value, updatedAt: new Date().toISOString(),
  })} />
  <button onClick={() => props.onOpenNote(props.note.id === "note-one" ? "note-two" : "note-one")}>Open linked note</button>
</section> }));

import App from "./App";

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  runtime.load.mockReset();
  runtime.save.mockReset();
  runtime.invoke.mockReset().mockResolvedValue(undefined);
  runtime.home.mockClear();
  mockIPC((command, payload) => runtime.invoke(command, payload), { shouldMockEvents: true });
  mockWindows("main");
  const vault = createEmptyVault("Window test");
  vault.spaces[0].notes = ["one", "two"].map((name): Note => ({
    id: `note-${name}`, title: `Document ${name}`, slug: `document-${name}`, body: `Body ${name}`, summary: "",
    kind: "article", status: "ready", tags: [], aliases: [], conceptIds: [], sourceIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt,
  }));
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault) => { runtime.disk = structuredClone(next); });
});

function finderFiles(entries: string[]) {
  const ids = ["first", "second"];
  const queued = [...entries];
  runtime.invoke.mockImplementation(async (command, payload) => {
    if (command === "pending_orion_files") return [...queued];
    if (command === "open_orion_file") {
      const index = queued.indexOf(payload.token);
      if (index < 0) throw new Error("Expired file token");
      const [entryNoteId] = queued.splice(index, 1);
      return { file: { exportId: "fixture_collection_123", entryNoteId,
        collection: { title: "Portable project", notes: ids.map(id => ({ id, title: "Portable " + id, body: "Original " + id,
          summary: "", tags: [], sourceIds: [] })), sources: [] } }, collectionHash: "a".repeat(64), imageUrls: {} };
    }
  });
  return queued;
}

describe("Finder collection navigation", () => {
  it("launches on the designated note before the first save and bypasses the old Home", async () => {
    finderFiles(["second"]);
    const write = pending<void>();
    runtime.save.mockImplementationOnce(async (vault: OrionVault) => { await write.promise; runtime.disk = vault; });
    render(<App />);
    try {
      await screen.findByRole("heading", { name: "Portable second" });
      expect(runtime.home).not.toHaveBeenCalled();
      expect(runtime.disk!.spaces).toHaveLength(1);
    } finally { await act(async () => write.resolve()); }
    await waitFor(() => expect(runtime.disk!.spaces.find(s => s.workspace.name === "Portable project")?.activeNoteId).toBe("second"));
  });

  it("continues to the next queued document when the first file is invalid", async () => {
    finderFiles(["missing", "second"]);
    render(<App />);
    await screen.findByRole("heading", { name: "Portable second" });
    expect(runtime.home).not.toHaveBeenCalled();
    await waitFor(() => expect(runtime.disk!.spaces).toHaveLength(2));
  });

  it("keeps a new note open after a save failure and retries with the latest edits", async () => {
    finderFiles(["second"]);
    runtime.save.mockRejectedValueOnce(new Error("Disk is full"));
    render(<App />);
    await screen.findByRole("heading", { name: "Portable second" });
    const retry = await screen.findByRole("button", { name: "Retry save" });
    expect(screen.queryByText("Collection imported")).not.toBeInTheDocument();
    expect(runtime.disk!.spaces).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), { target: { value: "Draft before retry" } });
    fireEvent.click(retry);
    await waitFor(() => expect(runtime.disk!.spaces[1]?.notes[1].body).toBe("Draft before retry"));
    expect(screen.getByRole("heading", { name: "Portable second" })).toBeInTheDocument();
  });

  it("opens successive files in a running window while a save is pending, preserving edits", async () => {
    const queued = finderFiles([]);
    await launch(false);
    const write = pending<void>();
    runtime.save.mockImplementationOnce(async (vault: OrionVault) => { await write.promise; runtime.disk = vault; });
    fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), { target: { value: "Edited before opening" } });
    queued.push("first", "second");
    await act(async () => { await emit("orion-portable-files", {}); });
    try {
      await screen.findByRole("heading", { name: "Portable second" });
      fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), { target: { value: "Edit inside the collection" } });
      queued.push("first", "second");
      await act(async () => { await emit("orion-portable-files", {}); });
      await waitFor(() => expect(runtime.invoke.mock.calls.filter(call => call[0] === "open_orion_file")).toHaveLength(4));
      expect(screen.getByRole("textbox", { name: "Draft body" })).toHaveValue("Edit inside the collection");
    } finally { await act(async () => write.resolve()); }
    await waitFor(() => {
      expect(runtime.disk!.spaces).toHaveLength(2);
      expect(runtime.disk!.spaces[0].notes[0].body).toBe("Edited before opening");
      expect(runtime.disk!.spaces[1].notes.find(n => n.id === "second")?.body).toBe("Edit inside the collection");
    });
  });

  it("respects edits and deletions saved by another window before reopening a known file", async () => {
    const queued = finderFiles(["first"]);
    render(<App />);
    await screen.findByRole("heading", { name: "Portable first" });
    await waitFor(() => expect(runtime.disk!.spaces).toHaveLength(2));
    const externalSave = (change: (space: AppSnapshot) => void) => {
      const next = structuredClone(runtime.disk!);
      const space = next.spaces.find(s => s.workspace.name === "Portable project")!;
      change(space);
      next.updatedAt = space.updatedAt = new Date(Date.parse(next.updatedAt) + 2000).toISOString();
      runtime.disk = next;
    };
    externalSave(space => { space.notes.find(n => n.id === "second")!.body = "Revised in another window"; });
    queued.push("second");
    await act(async () => { await emit("orion-portable-files", {}); });
    await screen.findByRole("heading", { name: "Portable second" });
    expect(screen.getByRole("textbox", { name: "Draft body" })).toHaveValue("Revised in another window");
    await waitFor(() => expect(runtime.disk!.spaces[1].activeNoteId).toBe("second"));
    externalSave(space => {
      space.notes = space.notes.filter(n => n.id !== "second");
      space.activeNoteId = "first";
    });
    queued.push("second");
    await act(async () => { await emit("orion-portable-files", {}); });
    await screen.findByText("This note was deleted locally. Your collection and edits were kept.");
    expect(screen.queryByTestId("document")).not.toBeInTheDocument();
    expect(runtime.disk!.spaces[1].notes.map(n => n.id)).toEqual(["first"]);
  });
});

afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks();
  window.history.replaceState(null, "", "/");
});

async function launch(writing: boolean) {
  const spaceId = runtime.disk!.activeSpaceId;
  window.history.replaceState(null, "", `/?space=${spaceId}&note=note-one${writing ? "&view=writing" : ""}`);
  render(<App />);
  await screen.findByRole("heading", { name: "Document one" });
  await waitFor(() => expect(runtime.save).toHaveBeenCalled());
  return spaceId;
}

describe("writing window integration", () => {
  it("sends a collection selected in a writing window to the library and keeps the draft open", async () => {
    runtime.invoke.mockImplementation(async (command) => command === "pick_orion_file_for_library" ? true : undefined);
    await launch(true);
    fireEvent.click(screen.getByRole("button", { name: "Share or export" }));
    fireEvent.click(screen.getByRole("button", { name: "Open an .orion file" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Open an .orion file" })).not.toBeInTheDocument());
    expect(runtime.invoke.mock.calls.some(call => call[0] === "pick_orion_file_for_library")).toBe(true);
    expect(screen.getByRole("heading", { name: "Document one" })).toBeInTheDocument();
    expect(runtime.disk!.spaces).toHaveLength(1);
  });

  it("launches the bound draft and saves before opening a linked note in the library", async () => {
    const spaceId = await launch(true);
    expect(screen.getByTestId("document")).toHaveAttribute("data-editing", "true");
    expect(screen.queryByRole("complementary", { name: "Library sidebar" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), { target: { value: "My new draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Open linked note" }));
    await waitFor(() => expect(runtime.invoke).toHaveBeenCalledWith("show_note_in_library", {
      spaceId, noteId: "note-two", passages: undefined,
    }));
    expect(runtime.disk!.spaces[0].notes[0].body).toBe("My new draft");
    expect(screen.getByRole("heading", { name: "Document one" })).toBeInTheDocument();
  });

  it.each([false, true])("retains typing during incoming navigation even when autosave finishes: %s", async (autosaveFinishes) => {
    const spaceId = await launch(false);
    await waitFor(() => expect(runtime.invoke).toHaveBeenCalledWith("set_library_navigation_ready", { ready: true }));
    const stale = structuredClone(runtime.disk!);
    const read = pending<OrionVault>();
    const delayedRead = vi.fn(() => read.promise);
    runtime.load.mockImplementationOnce(async () => structuredClone(runtime.disk));
    runtime.load.mockImplementationOnce(delayedRead);
    await act(async () => { await emit("orion-open-note", { spaceId, noteId: "note-two" }); });
    await waitFor(() => expect(delayedRead).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), { target: { value: "Typed while navigation reads disk" } });
    if (autosaveFinishes) {
      await waitFor(() => expect(runtime.disk!.spaces[0].notes[0].body).toBe("Typed while navigation reads disk"));
    }
    await act(async () => read.resolve(stale));
    await screen.findByRole("heading", { name: "Document two" });
    fireEvent.click(screen.getByRole("button", { name: "Open linked note" }));
    expect(screen.getByRole("textbox", { name: "Draft body" })).toHaveValue("Typed while navigation reads disk");
    await waitFor(() => expect(runtime.disk!.spaces[0].notes[0].body).toBe("Typed while navigation reads disk"));
  });
});
