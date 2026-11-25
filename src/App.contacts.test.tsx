// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createEmptySnapshot, createEmptyVault } from "./data/defaults";
import { isContactNote } from "./lib/contacts";
import type { OrionVault } from "./types";
import App from "./App";

const storage = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock("./lib/storage", async original => ({
  ...await original<typeof import("./lib/storage")>(),
  loadSnapshot: storage.load, saveSnapshot: storage.save,
}));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/ChatDock", () => ({ ChatDock: () => null }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }) },
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } },
  });
});
afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

it("saves contacts from /lead, shows the directory per Space, follows backlinks and reuses a saved contact after reopening", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  let disk = createEmptyVault("Client work");
  const space = disk.spaces[0];
  disk.spaces.push(createEmptySnapshot("Personal", disk.updatedAt, "space-personal"));
  const sourceId = "meeting-notes";
  space.notes.push({ id: sourceId, title: "Meeting notes", summary: "", body: "Call /lead today.\n\nEmail /lead tomorrow.", slug: "meeting-notes",
    kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: disk.updatedAt, updatedAt: disk.updatedAt });
  let release!: () => void, contactSaveStarted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  storage.load.mockImplementation(async () => structuredClone(disk));
  storage.save.mockImplementation(async (next: OrionVault) => {
    if (next.spaces[0].notes.some(isContactNote)) { contactSaveStarted = true; await gate; }
    disk = structuredClone(next);
  });

  async function openPicker() {
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dom = await screen.findByRole("textbox", { name: "Note body" }) as HTMLElement & { editor: Editor };
    const editor = dom.editor;
    await waitFor(() => expect(editor.isInitialized).toBe(true));
    await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 12, right: 13, top: 20, bottom: 40 });
    let pos = 0;
    editor.state.doc.descendants((node, at) => {
      if (!pos && node.isText && node.text!.includes("/lead")) pos = at + node.text!.indexOf("/lead") + 5;
    });
    expect(pos).toBeGreaterThan(0);
    act(() => { editor.view.focus(); editor.commands.setTextSelection(pos); });
    await screen.findByRole("option", { name: "Lead" });
    fireEvent.keyDown(dom, { key: "Enter" });
    return screen.findByRole("dialog", { name: /contact/i });
  }

  const launch = () => {
    window.history.replaceState(null, "", `/?space=${space.workspace.id}&note=${sourceId}`);
    return render(<App />);
  };
  const first = launch();
  await screen.findByRole("heading", { name: "Meeting notes" });
  expect(screen.queryByRole("button", { name: "Contacts" })).toBeNull();
  const create = await openPicker();
  fireEvent.change(within(create).getByLabelText("Name"), { target: { value: "Avery Lane" } });
  fireEvent.change(within(create).getByLabelText(/Organization/), { target: { value: "North" } });
  fireEvent.click(within(create).getByRole("button", { name: "Create and link" }));
  await waitFor(() => expect(contactSaveStarted).toBe(true), { timeout: 3500 });
  expect(screen.queryByRole("button", { name: "Contacts" })).toBeNull();
  await act(async () => { release(); await gate; });
  fireEvent.click(await screen.findByRole("button", { name: "Contacts" }));
  const directory = await screen.findByRole("list", { name: "Space contacts" });
  fireEvent.click(within(directory).getByRole("button", { name: /Avery Lane/ }));
  const details = await screen.findByRole("region", { name: "Contact details" });
  expect(details).toHaveTextContent("North");
  fireEvent.click(within(details).getByRole("button", { name: "Meeting notes" }));
  await screen.findByRole("textbox", { name: "Note body" });
  fireEvent.click(screen.getByRole("button", { name: /Client work space/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Personal, 0 notes/ }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Contacts" })).toBeNull());
  first.unmount();

  launch();
  await screen.findByRole("button", { name: "Contacts" });
  const choose = await openPicker();
  const query = within(choose).getByRole("searchbox");
  fireEvent.change(query, { target: { value: "avery" } });
  fireEvent.keyDown(query, { key: "Enter" });
  await waitFor(() => {
    const people = disk.spaces[0].notes.filter(isContactNote);
    expect(people).toHaveLength(1);
    expect(disk.spaces[0].notes.find(note => note.id === sourceId)?.body)
      .toBe(`Call [Avery Lane](orion-note://${people[0].id}) today.\n\nEmail [Avery Lane](orion-note://${people[0].id}) tomorrow.`);
    expect(disk.spaces[1].notes).toHaveLength(0);
  }, { timeout: 3500 });
}, 10_000);
