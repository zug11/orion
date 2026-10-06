// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Note, OrionVault } from "./types";
import { createEmptyVault } from "./data/defaults";

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null,
  load: vi.fn(),
  save: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("./lib/storage", async (original) => ({
  ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true,
  loadSnapshot: runtime.load,
  saveSnapshot: runtime.save,
}));
vi.mock("./lib/useResolvedTheme", () => ({ useResolvedTheme: () => ({ palette: {}, glassStatus: null }) }));
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <aside aria-label="Library sidebar" /> }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
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
