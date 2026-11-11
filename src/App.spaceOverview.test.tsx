// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createEmptyVault } from "./data/defaults";
import type { AppSnapshot, Note, OrganizeContentResult, OrionVault } from "./types";

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null,
  load: vi.fn(), save: vi.fn(), organize: vi.fn(), prepare: vi.fn(), current: vi.fn(),
  claim: vi.fn(), release: vi.fn(),
}));
vi.mock("./lib/storage", async original => ({
  ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true,
  loadSnapshot: runtime.load, saveSnapshot: runtime.save, organizeWithAI: runtime.organize,
}));
vi.mock("./lib/spaceKnowledge", async original => {
  const actual = await original<typeof import("./lib/spaceKnowledge")>();
  return { ...actual,
    prepareSpaceKnowledgeIndex: (...args: Parameters<typeof actual.prepareSpaceKnowledgeIndex>) => {
      runtime.prepare(); return actual.prepareSpaceKnowledgeIndex(...args);
    },
    spaceKnowledgeIsCurrent: (...args: Parameters<typeof actual.spaceKnowledgeIsCurrent>) => {
      runtime.current(); return actual.spaceKnowledgeIsCurrent(...args);
    },
  };
});
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme");
  const { defaultSettings } = await import("./data/defaults");
  const palette = resolveThemePalette(defaultSettings, "dark");
  return { useResolvedTheme: () => ({ palette, glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/ChatDock", () => ({ ChatDock: () => null }));
vi.mock("./components/HomeView", () => ({ HomeView: ({ snapshot, onRefreshOverview }: {
  snapshot: AppSnapshot; onRefreshOverview: () => void;
}) => <section><h1>Home fixture</h1><p>{snapshot.spaceOverview?.body}</p>
  <button onClick={onRefreshOverview}>Refresh summary</button></section> }));
vi.mock("./components/NoteView", () => ({ NoteView: ({ note, onUpdateNote, onFinishEditing }: {
  note: Note; onUpdateNote: (note: Note) => void; onFinishEditing: (id: string) => void;
}) => <section><h1>{note.title}</h1><textarea aria-label="Draft body" value={note.body}
  onChange={event => onUpdateNote({ ...note, body: event.target.value, updatedAt: new Date().toISOString() })} />
  <button onClick={() => onFinishEditing(note.id)}>Done</button></section> }));

import App from "./App";

function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function result(body = "The current Space orientation."): OrganizeContentResult {
  return { notes: [{ title: "A current summary", body, summary: "", tags: [], aliases: [], links: [] }],
    concepts: [], wikiArticles: [], suggestedConnections: [] };
}

beforeEach(() => {
  for (const mock of [runtime.load, runtime.save, runtime.organize, runtime.prepare, runtime.current,
    runtime.claim, runtime.release]) mock.mockReset();
  runtime.claim.mockResolvedValue(true);
  mockIPC((command, payload) => command === "claim_space_overview" ? runtime.claim(payload)
    : command === "release_space_overview" ? runtime.release(payload) : undefined, { shouldMockEvents: true });
  mockWindows("main");
  const vault = createEmptyVault("Summary fixture");
  vault.spaces[0].settings.apiKeyConfigured = true;
  vault.spaces[0].settings.includeExistingNotesInAIContext = true;
  vault.spaces[0].notes = [{ id: "draft", title: "Writing fixture", slug: "draft", body: "A first observation.",
    summary: "", kind: "wiki", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt }];
  runtime.disk = vault;
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk));
  runtime.save.mockImplementation(async (next: OrionVault, expected: string | null) => {
    if (expected !== runtime.disk?.updatedAt) throw new Error("ORION_VAULT_CONFLICT");
    runtime.disk = structuredClone(next);
  });
  runtime.organize.mockResolvedValue(result());
});

afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  vi.useRealTimers(); clearMocks(); window.history.replaceState(null, "", "/");
});

async function launch(home = false) {
  window.history.replaceState(null, "", home ? "/" : `/?space=${runtime.disk!.activeSpaceId}&note=draft`);
  render(<App />);
  await screen.findByRole("heading", { name: home ? "Home fixture" : "Writing fixture" });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  // Remount after switching clocks so every maintenance/autosave timer is controlled.
  await act(async () => { cleanup(); });
  await act(async () => { render(<App />); await vi.dynamicImportSettled(); });
}
async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function type(body: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Draft body" }), { target: { value: body } });
}

describe("Space summary maintenance while writing", () => {
  it("checks an existing index only after writing becomes quiet", async () => {
    const { prepareSpaceKnowledgeIndex } = await import("./lib/spaceKnowledge");
    const workspace = runtime.disk!.spaces[0];
    workspace.spaceKnowledge = { ...prepareSpaceKnowledgeIndex(workspace), stale: false };
    runtime.prepare.mockClear();
    await launch();
    expect(runtime.current).not.toHaveBeenCalled();
    for (let index = 0; index < 10; index++) {
      type(`Existing knowledge, edited ${index}.`);
      await advance(500);
    }
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.current).not.toHaveBeenCalled();
    await advance(3_000);
    expect(runtime.current).toHaveBeenCalled();
    expect(runtime.organize).toHaveBeenCalledOnce();
  });

  it("keeps the ordinary autosave deadline while postponing summary work during typing", async () => {
    await launch();
    runtime.prepare.mockClear(); runtime.current.mockClear(); runtime.save.mockClear();
    for (let index = 0; index < 10; index++) {
      type(`A first observation, continued ${index}.`);
      await advance(500);
    }
    expect(runtime.save).toHaveBeenCalled();
    expect(runtime.disk!.spaces[0].notes[0].body).toBe("A first observation, continued 9.");
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.current).not.toHaveBeenCalled();
    expect(runtime.organize).not.toHaveBeenCalled();
    await advance(3_000);
    expect(runtime.organize).toHaveBeenCalledOnce();
    await advance(2_000);
    expect(runtime.disk!.spaces[0].spaceOverview?.body).toBe("The current Space orientation.");
  });

  it("does not rerun a completed manual refresh when the earlier automatic timer fires", async () => {
    await launch(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh summary" }));
    await advance(100);
    expect(runtime.organize).toHaveBeenCalledOnce();
    await advance(5_000);
    expect(runtime.organize).toHaveBeenCalledOnce();
  });

  it("reserves a manual request before waiting for the native owner", async () => {
    await launch(true);
    const lease = pending<boolean>();
    runtime.claim.mockReturnValue(lease.promise);
    const refresh = screen.getByRole("button", { name: "Refresh summary" });
    fireEvent.click(refresh);
    fireEvent.click(refresh);
    await advance(2_000);
    expect(runtime.claim).toHaveBeenCalledOnce();
    expect(runtime.prepare).not.toHaveBeenCalled();
    await act(async () => { lease.resolve(true); await vi.dynamicImportSettled(); });
    await advance(100);
    expect(runtime.organize).toHaveBeenCalledOnce();
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it("does no summary preparation when another window owns the native refresh", async () => {
    runtime.claim.mockResolvedValue(false);
    await launch();
    await advance(2_000);
    expect(runtime.claim).toHaveBeenCalledOnce();
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.organize).not.toHaveBeenCalled();
    expect(runtime.release).not.toHaveBeenCalled();
  });

  it("maintains a local index once with context disabled and never sends notes to a provider", async () => {
    runtime.disk!.spaces[0].settings.includeExistingNotesInAIContext = false;
    await launch();
    for (let index = 0; index < 10; index++) {
      type(`Local thought ${index}.`);
      await advance(500);
    }
    expect(runtime.prepare).not.toHaveBeenCalled();
    expect(runtime.disk!.spaces[0].notes[0].body).toBe("Local thought 9.");
    await advance(3_000);
    expect(runtime.prepare).toHaveBeenCalledOnce();
    await advance(5_000);
    expect(runtime.prepare).toHaveBeenCalledOnce();
    expect(runtime.disk!.spaces[0].spaceKnowledge?.stale).toBe(false);
    expect(runtime.organize).not.toHaveBeenCalled();
    expect(runtime.claim).not.toHaveBeenCalled();
  });

  it("coalesces a stale in-flight result while typing continues and keeps autosaving", async () => {
    const first = pending<OrganizeContentResult>();
    runtime.organize.mockImplementationOnce(() => first.promise);
    await launch();
    await advance(1_800);
    expect(runtime.organize).toHaveBeenCalledOnce();
    type("The user is still developing a new thought.");
    await act(async () => { first.resolve(result("Obsolete orientation.")); });
    for (let index = 0; index < 10; index++) {
      type(`The user is still developing a new thought ${index}.`);
      await advance(500);
    }
    expect(runtime.organize).toHaveBeenCalledOnce();
    expect(runtime.disk!.spaces[0].spaceOverview?.body).not.toBe("Obsolete orientation.");
    expect(runtime.disk!.spaces[0].notes[0].body).toBe("The user is still developing a new thought 9.");
    await advance(4_000);
    expect(runtime.organize).toHaveBeenCalledTimes(2);
    expect(runtime.organize.mock.calls[1][0].content).toContain("The user is still developing a new thought 9.");
  });
});
