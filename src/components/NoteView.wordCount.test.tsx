import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Note } from "../types";
import { NoteView } from "./NoteView";

const note: Note = { id: "word-count", title: "Test title", summary: "A subtitle", body: "One **two** three.\n\nFour five.",
  slug: "word-count", kind: "article", status: "ready", aliases: [], tags: [], conceptIds: [], sourceIds: [],
  createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z" };
const props = { notes: [note], concepts: [], onOpenNote: vi.fn(), onOpenConcept: vi.fn(), onUpdateNote: vi.fn(),
  onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn(), onThreadAction: vi.fn().mockResolvedValue(undefined) };
const count = () => screen.getByLabelText("Word count");

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) },
  });
});

describe("note word-count pill", () => {
  it("shows only while editing, hides on Done, and follows each note's edit mode", async () => {
    const view = render(<NoteView {...props} note={note} />);
    expect(screen.queryByLabelText("Word count")).not.toBeInTheDocument();
    const range = document.createRange(); range.selectNodeContents(screen.getByText("two"));
    act(() => { document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range); fireEvent(document, new Event("selectionchange")); });
    expect(screen.queryByLabelText("Word count")).not.toBeInTheDocument();
    act(() => { document.getSelection()!.removeAllRanges(); fireEvent(document, new Event("selectionchange")); });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => expect(count()).toHaveTextContent("9 words"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByLabelText("Word count")).not.toBeInTheDocument());
    view.rerender(<NoteView {...props} note={{ ...note, id: "empty", title: "", summary: "", body: "" }} />);
    await waitFor(() => expect(count()).toHaveTextContent("0 words"));
    view.rerender(<NoteView {...props} note={note} />);
    await waitFor(() => expect(screen.queryByLabelText("Word count")).not.toBeInTheDocument());
  });

  it("tracks typing, editor and heading selections and Undo without saving counts", async () => {
    function Harness() { const [current, setCurrent] = useState(note); return <NoteView {...props} note={current} onUpdateNote={setCurrent} initialEditing />; }
    render(<Harness />);
    const textbox = await screen.findByRole("textbox", { name: "Note body" });
    const editor = (textbox as HTMLElement & { editor: Editor }).editor;
    await waitFor(() => expect(count()).toHaveTextContent("9 words"));
    await waitFor(() => expect(textbox).toHaveFocus());
    act(() => { editor.commands.setTextSelection({ from: 1, to: 8 }); });
    await waitFor(() => expect(count()).toHaveTextContent("2 of 9 words"));
    act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, " six seven"); editor.commands.setTextSelection(editor.state.doc.content.size - 1); });
    await waitFor(() => expect(count()).toHaveTextContent("11 words"));
    act(() => { editor.commands.undo(); });
    await waitFor(() => expect(count()).toHaveTextContent("9 words"));
    const title = screen.getByRole("textbox", { name: "Note title" }) as HTMLTextAreaElement;
    act(() => { title.focus(); title.setSelectionRange(0, 4); fireEvent.select(title); });
    await waitFor(() => expect(count()).toHaveTextContent("1 of 9 words"));
  });
});
