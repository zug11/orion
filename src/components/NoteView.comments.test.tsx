// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Note } from "../types";
import { createEmptySnapshot } from "../data/defaults";
import { addHumanPassageComment } from "../lib/passageThreads";
import { createVoiceSelectionStore } from "../lib/voiceSelection";
import { NoteView } from "./NoteView";
const now = "2026-10-13T00:00:00Z";
const note: Note = { id: "draft", title: "Draft", slug: "draft", body: "Before **warm light** after.", summary: "", aliases: [], tags: [], kind: "article", status: "ready", sourceIds: [], conceptIds: [], createdAt: now, updatedAt: now };
afterEach(() => { vi.restoreAllMocks(); cleanup(); window.getSelection()?.removeAllRanges(); });
beforeAll(() => Object.defineProperties(Range.prototype, {
  getClientRects: { configurable: true, value: () => [] },
  getBoundingClientRect: { configurable: true, value: () => new DOMRect(40, 120, 140, 24) },
}));
it.each([false, true])("saves a selected human comment locally, preserves its draft and only calls Orion explicitly, editing=%s", async editing => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("passage-thread__icon") ? new DOMRect(280, 200, 25, 25) : new DOMRect(0, 0, 1100, 800);
  });
  const store = createVoiceSelectionStore("space"), create = vi.fn(), action = vi.fn().mockResolvedValue(undefined);
  let latest = note;
  function Harness() {
    const [current, setCurrent] = useState(note); latest = current;
    return <NoteView note={current} notes={[current]} concepts={[]} initialEditing={editing} voiceSelection={store}
      onCreateComment={async (selection, content, id) => {
        create(selection, content, id);
        const snapshot = createEmptySnapshot("QA", now, "space"); snapshot.notes = [current];
        setCurrent(addHumanPassageComment(snapshot, selection, content, id, now).notes[0]);
      }} onThreadAction={action} onUpdateNote={setCurrent}
      onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />;
  }
  const view = render(<div className="workspace-content"><Harness /></div>);
  if (editing) await screen.findByRole("textbox", { name: "Note body" });
  const root = view.container.querySelector<HTMLElement>(editing ? ".tiptap" : '[data-voice-note-body="reading"]')!;
  if (editing) await waitFor(() => expect(document.activeElement).toBe(root));
  if (editing) vi.spyOn((root as HTMLElement & { editor: Editor }).editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  const selected = root.querySelector("strong")!.firstChild!;
  fireEvent.pointerDown(root);
  act(() => {
    if (editing) { const editor = (root as HTMLElement & { editor: Editor }).editor; editor.commands.setTextSelection({ from: editor.view.posAtDOM(selected, 0), to: editor.view.posAtDOM(selected, 10) }); }
    const range = document.createRange(); range.selectNodeContents(selected);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
  });
  fireEvent(document, new Event("selectionchange")); fireEvent.pointerUp(root);
  await waitFor(() => expect(store.getSnapshot()?.text).toBe("warm light"));
  const button = await screen.findByRole("button", { name: "Comment on selected text" });
  fireEvent.mouseDown(button); fireEvent.click(button);
  const input = await screen.findByRole("textbox", { name: "Your comment" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Make this image more concrete." } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(create).not.toHaveBeenCalled(); expect(action).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Comment on selected text" }));
  expect(await screen.findByRole("textbox", { name: "Your comment" })).toHaveValue("Make this image more concrete.");
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  expect(await screen.findByRole("article", { name: "Your comment" })).toHaveTextContent("Make this image more concrete.");
  expect(create).toHaveBeenCalledTimes(1); expect(action).not.toHaveBeenCalled();
  expect(latest.body).toBe(note.body);
  expect(latest.discussionThreads![0].anchor.quote).toBe("warm light");
  fireEvent.click(screen.getByRole("button", { name: "Close discussion" }));
  fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
  expect(screen.getByRole("article", { name: "Your comment" })).toBeVisible();
  expect(action).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Discuss this passage" }), { target: { value: "What do you think of my comment?" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask Orion about this passage" }));
  await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
});

it.each(["Before /comment after.", "Before **warm light** after.\n\n/comment", "/comment", "Before **warm light** after.\n\n&nbsp;\n\n/comment", "\n\n&nbsp;\n\n/comment\n\ndsads\n\n&nbsp;"])("opens the same local comment modal from slash in %s", async body => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("passage-thread__icon") ? new DOMRect(280, 200, 25, 25) : new DOMRect(0, 0, 1100, 800);
  });
  const store = createVoiceSelectionStore("space"), action = vi.fn();
  let latest = { ...note, body };
  function Harness() {
    const [current, setCurrent] = useState({ ...note, body }); latest = current;
    return <NoteView note={current} notes={[current]} concepts={[]} initialEditing voiceSelection={store}
      onCreateComment={async (selection, content, id) => {
        const snapshot = createEmptySnapshot("QA", now, "space"); snapshot.notes = [current];
        setCurrent(addHumanPassageComment(snapshot, selection, content, id, now).notes[0]);
      }} onThreadAction={action} onUpdateNote={setCurrent}
      onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />;
  }
  render(<div className="workspace-content"><Harness /></div>);
  const root = await screen.findByRole("textbox", { name: "Note body" }) as HTMLElement & { editor: Editor };
  await waitFor(() => expect(document.activeElement).toBe(root));
  vi.spyOn(root.editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  let end = 0;
  root.editor.state.doc.descendants((node, position) => {
    if (node.isText && node.text!.includes("/comment")) end = position + node.text!.indexOf("/comment") + 8;
  });
  act(() => { root.editor.commands.setTextSelection(end); });
  await screen.findByRole("option", { name: "Comment" });
  fireEvent.keyDown(root, { key: "Enter" });
  expect(await screen.findByRole("dialog", { name: "Add comment" })).toBeVisible();
  const createPanel = screen.getByRole("dialog", { name: "Add comment" });
  expect(createPanel).toHaveStyle({ left: "280px", top: "233px" });
  expect(latest.discussionThreads).toBeUndefined();
  expect(latest.body).not.toContain("/comment");
  if (body !== "/comment" && !body.includes("dsads")) expect(latest.body).toContain(body.startsWith("Before /comment") ? "Before  after." : "Before **warm light** after.");
  expect(action).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Your comment" }), { target: { value: "Keep the paragraph's cadence." } });
  fireEvent.click(screen.getByRole("button", { name: "Save comment" }));
  expect(await screen.findByRole("article", { name: "Your comment" })).toHaveTextContent("Keep the paragraph's cadence.");
  expect(screen.getByRole("dialog", { name: "Comment" })).toHaveStyle({ left: "280px", top: "233px" });
  expect(latest.discussionThreads![0].anchor.quote).not.toContain("/comment");
  if (body === "/comment" || body.includes("&nbsp;")) {
    expect(latest.discussionThreads![0].anchor).toMatchObject({ scope: "note", quote: "", text: "", cursor: expect.any(Object) });
    expect(screen.queryByText("Passage changed or unavailable")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close discussion" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open passage discussion" }));
    expect(screen.getByRole("article", { name: "Your comment" })).toBeVisible();
  }
  if (screen.queryByRole("button", {name:"Close discussion"})) fireEvent.click(screen.getByRole("button", {name:"Close discussion"}));
  fireEvent.click(screen.getByRole("button", {name:"Done"}));
  await waitFor(() => expect(screen.queryByRole("textbox",{name:"Note body"})).toBeNull());
  const reading = document.querySelector('[data-voice-note-body="reading"]')!;
  const marker = await screen.findByRole("button",{name:"Open passage discussion"});
  expect(reading.contains(marker)).toBe(true);
  expect(screen.queryByText("Passage changed or unavailable")).toBeNull();
  fireEvent.click(marker);
  expect(await screen.findByRole("article",{name:"Your comment"})).toHaveTextContent("Keep the paragraph's cadence.");
  expect(action).not.toHaveBeenCalled();
});
