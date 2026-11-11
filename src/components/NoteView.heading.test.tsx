// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import type { Editor } from "@tiptap/core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NoteView } from "./NoteView";
import type { Note } from "../types";

const blank: Note = {
  id: "blank-page", title: "", summary: "", body: "", slug: "blank-page",
  aliases: [], tags: [], kind: "article", status: "ready", sourceIds: [], conceptIds: [],
  createdAt: "2026-11-03T00:00:00.000Z", updatedAt: "2026-11-03T00:00:00.000Z",
};

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ bottom: 0, height: 0, left: 0,
      right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) }) },
  });
});

function mount(note = blank, strict = false) {
  const onUpdate = vi.fn();
  function Harness() {
    const [current, setCurrent] = useState(note);
    return <NoteView note={current} notes={[current]} concepts={[]} initialEditing
      onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onDeleteNote={vi.fn()}
      onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()}
      onUpdateNote={(next) => { onUpdate(next); setCurrent(next); }} />;
  }
  const view = render(strict ? <StrictMode><Harness /></StrictMode> : <Harness />);
  return { ...view, onUpdate };
}

const bodyEditor = () => (screen.getByRole("textbox", { name: "Note body" }) as HTMLElement & { editor: Editor }).editor;

describe("first lines of the document", () => {
  it("places empty placeholders below the toolbar and lets Enter skip both without saving filler", async () => {
    const { container, onUpdate } = mount();
    const title = await screen.findByPlaceholderText("Title");
    const subtitle = screen.getByPlaceholderText("Subtitle");
    const toolbar = screen.getByRole("toolbar", { name: /formatting/i });
    expect(toolbar.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector(".note-header textarea")).toBeNull();
    expect(title).toHaveValue("");
    expect(subtitle).toHaveValue("");
    expect(title).toHaveFocus();
    fireEvent.keyDown(title, { key: "Enter" });
    expect(subtitle).toHaveFocus();
    fireEvent.keyDown(subtitle, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note body" })).toHaveFocus());
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => { bodyEditor().commands.insertContent("I can work out where this is going as I write."); });
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "", summary: "", body: "I can work out where this is going as I write.",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByText("Untitled note")).not.toBeInTheDocument();
    expect(screen.queryByText("A new thread in your atlas.")).not.toBeInTheDocument();
    expect(screen.getByText("I can work out where this is going as I write.")).toBeInTheDocument();
  });

  it("saves named lines separately from prose and restores them when editing again", async () => {
    const { onUpdate } = mount();
    fireEvent.change(await screen.findByPlaceholderText("Title"), { target: { value: "Finding the thought" } });
    fireEvent.change(screen.getByPlaceholderText("Subtitle"), { target: { value: "A beginning, not an outline." } });
    act(() => { bodyEditor().commands.insertContent("The actual prose."); });
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      title: "Finding the thought", summary: "A beginning, not an outline.", body: "The actual prose.",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.getByRole("heading", { name: "Finding the thought" })).toBeInTheDocument();
    expect(screen.getByText("A beginning, not an outline.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByPlaceholderText("Title")).toHaveValue("Finding the thought");
    expect(screen.getByPlaceholderText("Subtitle")).toHaveValue("A beginning, not an outline.");
    expect(bodyEditor().getMarkdown()).toBe("The actual prose.");
  });

  it("navigates back from the body while preserving composition and modified Enter", async () => {
    mount();
    const title = await screen.findByPlaceholderText("Title");
    const subtitle = screen.getByPlaceholderText("Subtitle");
    fireEvent.keyDown(title, { key: "Enter", isComposing: true });
    expect(title).toHaveFocus();
    expect(fireEvent.keyDown(title, { key: "Enter", shiftKey: true })).toBe(true);
    fireEvent.keyDown(title, { key: "Enter" });
    fireEvent.keyDown(subtitle, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Note body" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Note body" }), { key: "ArrowUp" });
    expect(subtitle).toHaveFocus();
    fireEvent.keyDown(subtitle, { key: "Backspace" });
    expect(title).toHaveFocus();
  });

  it("presents legacy blank notes as empty without a migration or an initial write", async () => {
    const { onUpdate } = mount({ ...blank, title: "Untitled note", summary: "A new thread in your atlas." });
    expect(await screen.findByPlaceholderText("Title")).toHaveValue("");
    expect(screen.getByPlaceholderText("Subtitle")).toHaveValue("");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("removes both empty rows from the body, remembers the layout on reopen, and restores them with Enter", async () => {
    const prose = "This writing can stay at the top of the page.";
    const view = mount({ ...blank, body: prose });
    const body = await screen.findByRole("textbox", { name: "Note body" });
    const editor = bodyEditor();
    act(() => { editor.commands.focus("start"); });
    await waitFor(() => expect(body).toHaveFocus());
    fireEvent.keyDown(body, { key: "Backspace" });
    expect(screen.queryByRole("textbox", { name: "Note summary" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note title" })).toBeInTheDocument();
    await waitFor(() => expect(body).toHaveFocus());
    fireEvent.keyDown(body, { key: "Backspace" });
    expect(view.container.querySelector(".note-document-heading")).toBeNull();
    expect(bodyEditor()).toBe(editor);
    const saved = view.onUpdate.mock.calls[view.onUpdate.mock.calls.length - 1][0] as Note;
    expect(saved).toMatchObject({ headingLayout: "none", title: "", summary: "", body: prose });

    view.unmount();
    const reopened = mount(saved);
    const reopenedBody = await screen.findByRole("textbox", { name: "Note body" });
    await waitFor(() => expect(reopenedBody).toHaveFocus());
    expect(reopened.container.querySelector(".note-document-heading")).toBeNull();
    fireEvent.keyDown(reopenedBody, { key: "Enter" });
    const title = screen.getByRole("textbox", { name: "Note title" });
    expect(title).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Note summary" })).not.toBeInTheDocument();
    expect(bodyEditor().getMarkdown()).toBe(prose);
    fireEvent.keyDown(title, { key: "Enter" });
    expect(screen.getByRole("textbox", { name: "Note summary" })).toHaveFocus();
    expect(reopened.onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ headingLayout: "both", body: prose }));
  });

  it("removes empty rows from their own cursor while protecting authored headings at a body boundary", async () => {
    const { onUpdate } = mount({ ...blank, title: "Keep the title", summary: "Keep the subtitle", body: "Keep the body." });
    const body = await screen.findByRole("textbox", { name: "Note body" });
    act(() => { bodyEditor().commands.focus("start"); });
    await waitFor(() => expect(body).toHaveFocus());
    fireEvent.keyDown(body, { key: "Backspace" });
    const subtitle = screen.getByRole("textbox", { name: "Note summary" });
    expect(subtitle).toHaveFocus();
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.change(subtitle, { target: { value: "" } });
    fireEvent.keyDown(subtitle, { key: "Backspace" });
    const title = screen.getByRole("textbox", { name: "Note title" });
    expect(title).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Note summary" })).not.toBeInTheDocument();
    fireEvent.change(title, { target: { value: "" } });
    fireEvent.keyDown(title, { key: "Backspace" });
    await waitFor(() => expect(body).toHaveFocus());
    expect(screen.queryByRole("textbox", { name: "Note title" })).not.toBeInTheDocument();
    expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ headingLayout: "none", body: "Keep the body." }));
  });

  it("keeps ordinary body Enter and Undo intact away from the top boundary", async () => {
    mount({ ...blank, headingLayout: "none", body: "Some ordinary prose." });
    const body = await screen.findByRole("textbox", { name: "Note body" });
    const editor = bodyEditor();
    await waitFor(() => expect(body).toHaveFocus());
    act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
    expect(editor.state.selection.$from.parentOffset).toBe("Some ordinary prose.".length);
    fireEvent.keyDown(body, { key: "Enter", keyCode: 13 });
    expect(editor.state.doc.childCount).toBe(2);
    expect(screen.queryByRole("textbox", { name: "Note title" })).not.toBeInTheDocument();
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("Some ordinary prose.");
    expect(editor.state.doc.childCount).toBe(1);
  });

  it("opens a saved body-only note safely through StrictMode editor remounts", async () => {
    const { onUpdate } = mount({ ...blank, headingLayout: "none", body: "A saved body-only note." }, true);
    const body = await screen.findByRole("textbox", { name: "Note body" });
    await waitFor(() => expect(body).toHaveFocus());
    expect(bodyEditor().getMarkdown()).toBe("A saved body-only note.");
    expect(screen.queryByRole("textbox", { name: "Note title" })).not.toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each(["```\nCode stays literal.\n```", "- A list item", "> A quoted passage"])(
    "leaves Enter inside structured body content to the rich editor: %s", async (bodyText) => {
      mount({ ...blank, headingLayout: "none", body: bodyText });
      const body = await screen.findByRole("textbox", { name: "Note body" });
      act(() => { bodyEditor().commands.focus("start"); });
      await waitFor(() => expect(body).toHaveFocus());
      fireEvent.keyDown(body, { key: "Enter", keyCode: 13 });
      expect(screen.queryByRole("textbox", { name: "Note title" })).not.toBeInTheDocument();
      expect(screen.queryByRole("textbox", { name: "Note summary" })).not.toBeInTheDocument();
    },
  );
});
