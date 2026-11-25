// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Editor } from "@tiptap/core";
import { createEmptySnapshot, createEmptyVault } from "./data/defaults";
import type { Note, OrionVault } from "./types";
import { useTicketNavigation } from "./components/TicketNavigation";
import { resolveVoiceWorkspace, voiceWorkspaceRequest } from "./lib/voiceWorkspace";

const runtime = vi.hoisted(() => ({
  disk: null as OrionVault | null,
  work: null as ReturnType<typeof useTicketNavigation> | null,
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
vi.mock("./components/Sidebar", () => ({ Sidebar: ({ spaces, onSwitchSpace, onCreateSpace }: {
  spaces: Array<{ workspace: { id: string; name: string } }>;
  onSwitchSpace: (id: string) => void;
  onCreateSpace: (name: string) => void;
}) => <nav>
  {spaces.map(space => <button key={space.workspace.id} onClick={() => onSwitchSpace(space.workspace.id)}>Switch {space.workspace.name}</button>)}
  <button onClick={() => onCreateSpace("Blank project")}>Create Space</button>
</nav> }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/ChatDock", () => ({ ChatDock: () => {
  runtime.work = useTicketNavigation();
  return null;
} }));
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe("external MCP changes with a note already open", () => {
  it("restores each Space's view and independent scroll position when returning", async () => {
    const second=createEmptySnapshot('Second',runtime.disk!.updatedAt,'second');
    runtime.disk!.spaces.push(second);
    await launch();
    const main=document.querySelector<HTMLElement>('.workspace-content')!;
    main.scrollTop=620;main.scrollLeft=25;
    fireEvent.click(screen.getByRole('button',{name:'Switch Second'}));
    expect(main.scrollTop).toBe(0);
    expect(main.scrollLeft).toBe(0);
    main.scrollTop=180;
    fireEvent.click(screen.getByRole('button',{name:'Switch External writer fixture'}));
    await screen.findByRole('textbox',{name:'Note body'});
    expect(main.scrollTop).toBe(620);
    expect(main.scrollLeft).toBe(25);
    fireEvent.click(screen.getByRole('button',{name:'Switch Second'}));
    expect(main.scrollTop).toBe(180);
    fireEvent.click(screen.getByRole('button',{name:'Create Space'}));
    expect(main.scrollTop).toBe(0);
    fireEvent.click(screen.getByRole('button',{name:'Switch Second'}));
    expect(main.scrollTop).toBe(180);
  });
  it("saves ticket description and checklist from Details while editing a note", async () => {
    runtime.disk!.spaces[0].notes[0].body = '- [ ] New <!-- orion-ticket:v1 t1 todo b1 urgency=medium -->\n\n\n\n&nbsp;';
    const editor = await launch();
    fireEvent.click(await screen.findByRole('button', {name:'Open details for New'}));
    const description = screen.getByRole('textbox', {name:'Ticket description'});
    act(() => description.focus());
    fireEvent.change(description, {target:{value:'Release context'}});
    act(() => description.blur());
    expect(screen.queryByText('This ticket changed. Check its current contents and try again.')).toBeNull();
    expect(editor.getMarkdown()).toContain('Release context');
    const input = screen.getByRole('textbox', {name:'New checklist item'});
    fireEvent.change(input, {target:{value:'Check the build'}});
    fireEvent.submit(input.closest('form')!);
    expect(editor.getMarkdown()).toContain('[ ] Check the build');
    await waitFor(() => expect(diskNote().body).toContain('[ ] Check the build'));
  });
  it.each([false, true])("ignores an overtaken refresh and retries for current remote metadata (newer typing: %s)", async newerTyping => {
    const editor = await launch();
    const stale = structuredClone(runtime.disk!);
    const refresh = deferred<OrionVault>();
    runtime.load.mockImplementationOnce(() => refresh.promise);
    fireEvent.focus(window);

    appendInEditor(editor, localAddition);
    await waitFor(() => expect(diskNote().body).toBe(originalBody + localAddition));
    // This update has no second notification. Discarding the stale result must
    // still trigger a fresh read, even if this window has finished typing.
    externalUpdate({ summary: "A subtitle from another window." });
    const body = originalBody + localAddition + (newerTyping ? " Still writing." : "");
    if (newerTyping) appendInEditor(editor, " Still writing.");
    await act(async () => { refresh.resolve(stale); });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor.getMarkdown()).toBe(body);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note summary" })).toHaveValue("A subtitle from another window."));
    await waitFor(() => expect(diskNote().body).toBe(body));
    expect(openEditor()).toBe(editor);
  });

  it("does not treat this window's in-flight save as another writer when a refresh finishes first", async () => {
    const editor = await launch();
    const refresh = deferred<OrionVault>();
    const saved = deferred<void>();
    runtime.load.mockImplementationOnce(() => refresh.promise);
    fireEvent.focus(window);
    runtime.save.mockImplementationOnce(async (next: OrionVault, expectedRevision: string | null) => {
      expect(expectedRevision).toBe(runtime.disk!.updatedAt);
      runtime.disk = structuredClone(next);
      await saved.promise;
    });

    appendInEditor(editor, localAddition);
    await waitFor(() => expect(diskNote().body).toBe(originalBody + localAddition));
    appendInEditor(editor, " Still writing.");
    await act(async () => { refresh.resolve(structuredClone(runtime.disk!)); });
    const showedConflict = screen.queryByRole("dialog") !== null;
    // Always release the pending write, including when checking the old bug.
    await act(async () => { saved.resolve(); });

    expect(showedConflict).toBe(false);
    expect(editor.getMarkdown()).toBe(originalBody + localAddition + " Still writing.");
    await waitFor(() => expect(diskNote().body).toBe(originalBody + localAddition + " Still writing."));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("creates a genuinely empty note with optional heading placeholders", async () => {
    await launch();
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText("Title")).toHaveValue(""));
    expect(screen.getByPlaceholderText("Subtitle")).toHaveValue("");
    await waitFor(() => expect(runtime.disk!.spaces[0].notes).toHaveLength(2));
    expect(runtime.disk!.spaces[0].notes[0]).toMatchObject({ title: "", summary: "", body: "" });
  });
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

it("generates a calculator from selected prose, reopens it from disk and keeps slider changes local", async ({ onTestFinished }) => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const passage = "Borrow $1,200 for one year, with twelve equal monthly payments.";
  const untouched = "Private context outside the selection.";
  diskNote().body = passage + "\n\n" + untouched;
  Object.assign(runtime.disk!.spaces[0].settings, { model: "chatgpt:gpt-6.2-astra", chatgptConfigured: true });
  const calculator = {
    version: 1, format: "calculator", title: "Loan payment",
    blocks: [{ kind: "calculator", inputs: [
      { label: "Annual rate", unit: "%", min: 0, max: 12, step: 1, initial: 0 },
    ], outputs: [{ label: "Monthly payment", unit: "$/month", expression: {
      op: "periodicPayment", principal: 1200, periods: 12, ratePerPeriod: { op: "divide", left: { input: 0 }, right: 1200 },
    } }] }],
  };
  runtime.invoke.mockImplementation(async (command: string) =>
    command === "chat" ? { reply: JSON.stringify(calculator), noteActions: [] } : undefined);
  const calls = () => runtime.invoke.mock.calls.filter(([command]) => command === "chat");
  window.history.replaceState(null, "", `/?space=${runtime.disk!.activeSpaceId}&note=open-draft`);
  const first = render(<App />);
  await waitFor(() => expect(runtime.save).toHaveBeenCalled(), { timeout: 2500 });
  const paragraph = await screen.findByText(passage);
  fireEvent.pointerDown(paragraph);
  act(() => {
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  fireEvent(document, new Event("selectionchange"));
  fireEvent.pointerUp(paragraph);
  fireEvent.click(await screen.findByRole("button", { name: "Visualise" }));
  fireEvent.change(await screen.findByLabelText("Format"), { target: { value: "calculator" } });
  expect(calls()).toHaveLength(0);
  fireEvent.keyDown(screen.getByLabelText(/Guidance/), { key: "Enter" });
  await screen.findByRole("slider", { name: "Annual rate" });
  expect(calls()).toHaveLength(1);
  const { request } = calls()[0][1];
  expect(request).toMatchObject({ mode: "visual-artifact", model: "chatgpt:gpt-6.2-astra",
    notes: [], sources: [], concepts: [], history: [], allowNoteActions: false });
  expect(JSON.parse(request.prompt)).toEqual({ source: passage, format: "calculator", guidance: "" });
  fireEvent.click(screen.getByRole("button", { name: "Done" }));
  await waitFor(() => {
    expect(diskNote().body).toContain("<!-- orion-artifact:v1");
    expect(diskNote().writingOrigins).toContain("orion-ai");
  }, { timeout: 2500 });
  const saved = structuredClone(diskNote());
  expect(saved.body).toContain(passage);
  expect(saved.body).toContain(untouched);
  first.unmount();
  render(<App />);
  const slider = await screen.findByRole("slider", { name: "Annual rate" });
  const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" });
  expect(screen.getByText(dollars.format(100) + "/month")).toBeVisible();
  expect(screen.getByTitle("Writing contributions")).toHaveTextContent("Orion AI");
  expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
  const previousSaves = runtime.save.mock.calls.length;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    fireEvent.change(slider, { target: { value: "12" } });
    expect(screen.getByText(dollars.format(106.62) + "/month")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(runtime.save).toHaveBeenCalledTimes(previousSaves);
    expect(diskNote()).toEqual(saved);
    expect(calls()).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});


it("persists a spoken reschedule through the mounted editor and lets Undo restore the original date", async () => {
  const original = "Before **the meeting**.\n\nDesign review — [Thursday, 26 November 2026](orion-date://2026-11-26)\n\nBring the sketches.";
  diskNote().body = original;
  const editor = await launch();
  const context = runtime.work!;
  const space = context.snapshot!;
  const request = voiceWorkspaceRequest("Move the design review to Friday", space)!;
  const result = await resolveVoiceWorkspace(space, request, { focusNoteId: diskNote().id }, new Date(2026, 10, 25, 12), () => true);
  expect(result.write).toMatchObject({ kind: "moveDate", oldDate: "2026-11-26", newDate: "2026-11-27" });

  const persisted = deferred<void>();
  const saving = deferred<void>();
  const write = runtime.save.getMockImplementation()!;
  runtime.save.mockImplementationOnce(async (...args: unknown[]) => {
    saving.resolve(); await persisted.promise; return write(...args);
  });
  let receipt = false;
  let done!: Promise<void>;
  act(() => {
    done = context.writeVoiceWork!(result.write!).then(() => { receipt = true; });
  });
  await saving.promise;
  expect(openEditor()).toBe(editor);
  expect(editor.getMarkdown()).toContain("orion-date://2026-11-27");
  expect(editor.getMarkdown()).toContain("Before **the meeting**.");
  expect(editor.getMarkdown()).toContain("Bring the sketches.");
  expect(diskNote().body).toBe(original);
  expect(receipt).toBe(false);
  await act(async () => { persisted.resolve(); await done; });
  expect(receipt).toBe(true);
  expect(diskNote().body).toBe(editor.getMarkdown());
  act(() => { editor.commands.undo(); });
  expect(editor.getMarkdown()).toBe(original);
  await waitFor(() => expect(diskNote().body).toBe(original), { timeout: 3500 });
}, 10_000);
