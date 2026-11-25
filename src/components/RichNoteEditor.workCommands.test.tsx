// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { makeContactNote } from "../lib/contacts";
import type { Note } from "../types";
import { LeadContactsContext, type LeadChoice } from "./LeadContactsContext";
import { RichNoteEditor } from "./RichNoteEditor";
import * as navigation from "./TicketNavigation";

beforeAll(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ left: 0, right: 0, top: 0, bottom: 0 }) },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function fixture(markdown: string, contacts: Note[] = []) {
  const onChange = vi.fn();
  const save = vi.fn((choice: LeadChoice, _noteId: string, insert: (contact: Note) => boolean) => {
    const note = "name" in choice ? makeContactNote(choice.name, choice.organization) : contacts.find(note => note.id === choice.existingId);
    return Boolean(note && insert(note));
  });
  function tree(spaceId: string) {
    return <LeadContactsContext.Provider value={{ spaceId, contacts, save }}>
      <RichNoteEditor noteId="source" markdown={markdown} notes={contacts} concepts={[]} sources={[]} attachedSourceIds={[]}
        onChange={onChange} onAttachSource={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()}/>
    </LeadContactsContext.Provider>;
  }
  const view = render(tree("original"));
  const element = view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor };
  return { editor: element.editor, element, save, onChange, changeSpace: () => view.rerender(tree("another")) };
}

async function openLead(editor: Editor, markdown: string) {
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
  // Let the mount-time caret restoration finish before opening the picker.
  await act(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  act(() => { editor.view.focus(); });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  act(() => { editor.commands.setTextSelection(markdown.indexOf("/lead") + 6); });
  expect(await screen.findByRole("option", { name: "Lead" })).toHaveAttribute("aria-selected", "true");
  fireEvent.keyDown(editor.view.dom, { key: "Enter" });
  return screen.findByRole("dialog");
}

it("creates a contact and replaces only the slash token with a literal linked name in one Undo", async () => {
  const base = "Meet /lead for lunch.";
  const { editor, save } = fixture(base);
  const dialog = await openLead(editor, base);
  const name = within(dialog).getByLabelText("Name");
  expect(name).toHaveFocus();
  fireEvent.change(name, { target: { value: "Ada *Research*" } });
  fireEvent.change(within(dialog).getByLabelText(/Organization/), { target: { value: "North" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create and link" }));
  expect(save).toHaveBeenCalledWith({ name: "Ada *Research*", organization: "North" }, "source", expect.any(Function));
  expect(editor.getText()).toBe("Meet Ada *Research* for lunch.");
  const link = editor.view.dom.querySelector("a");
  expect(link?.textContent).toBe("Ada *Research*");
  expect(link?.getAttribute("href")).toMatch(/^orion-note:\/\/note-/);
  expect(link?.children.length).toBe(0);
  const reopened = fixture(editor.getMarkdown()).editor;
  expect(reopened.state.doc.toJSON()).toEqual(editor.state.doc.toJSON());
  expect(editor.state.storedMarks?.some(mark => mark.type.name === "link")).toBeFalsy();
  act(() => { editor.commands.undo(); });
  expect(editor.getText()).toBe(base);
});

it("links a selected existing contact by identity and distinguishes namesakes", async () => {
  const ada = makeContactNote("Ada", "North")!, other = makeContactNote("Ada", "South")!;
  const base = "Meet /lead today.";
  const { editor, save } = fixture(base, [ada, other]);
  const dialog = await openLead(editor, base);
  const search = within(dialog).getByRole("searchbox");
  fireEvent.change(search, { target: { value: "south" } });
  expect(within(dialog).queryByRole("button", { name: /North/ })).toBeNull();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  const result = within(dialog).getByRole("button", { name: /Ada, South/ });
  expect(result).toHaveFocus();
  fireEvent.click(result);
  expect(save).toHaveBeenCalledWith({ existingId: other.id }, "source", expect.any(Function));
  expect(editor.view.dom.querySelector("a")).toHaveAttribute("href", `orion-note://${other.id}`);
  expect(editor.getText()).toBe("Meet Ada today.");
});

it.each(["cancel", "edited", "space"])("preserves prose and creates no contact after %s", async reason => {
  const base = "Meet /lead today.";
  const { editor, save, changeSpace } = fixture(base);
  const dialog = await openLead(editor, base);
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Ada" } });
  if (reason === "cancel") {
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(editor.view.dom).toHaveFocus();
  } else if (reason === "space") {
    changeSpace();
  } else {
    act(() => { editor.commands.insertContentAt(1, "Later. "); });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create and link" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("changed");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  }
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(editor.getText()).toBe(reason === "edited" ? "Later. " + base : base);
});

it("applies a guarded voice reschedule in the mounted editor with one Undo", async () => {
  type Handle = Parameters<NonNullable<ReturnType<typeof navigation.useTicketNavigation>["registerEditor"]>>[0];
  let handle: Handle | undefined;
  const registerEditor = (next: Handle) => { handle = next; return () => { handle = undefined; }; };
  vi.spyOn(navigation, "useTicketNavigation").mockReturnValue({ index: new Map(), registerEditor });
  const body = "Keep **this**. Meet [1 Dec](orion-date://2026-12-01).";
  const base = "---\npriority: important\n---\n\n" + body;
  const next = base.replace("[1 Dec](orion-date://2026-12-01)", "[8 Dec](orion-date://2026-12-08)");
  const { editor, onChange } = fixture(base);
  await waitFor(() => expect(handle).toBeDefined());
  act(() => { expect(handle!.applyVoiceBody(base, next)).toBe(true); });
  expect(onChange.mock.lastCall?.[0]).toContain("priority: important");
  expect(editor.getMarkdown()).toContain("[8 Dec](orion-date://2026-12-08)");
  expect(editor.getMarkdown()).toContain("**this**");
  expect(handle!.applyVoiceBody(base, next)).toBe(false);
  act(() => { editor.commands.undo(); });
  expect(editor.getMarkdown()).toBe(body);
});
