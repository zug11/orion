import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../../types";
import { ExcerptPicker } from "./ExcerptPicker";

function note(id: string, title: string, body: string): Note {
  return { id, title, body, slug: id, summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
}
function select(root: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let offset = 0;
  let started = false;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = node.textContent!.length;
    if (!started && offset + length >= start) { range.setStart(node, start - offset); started = true; }
    if (offset + length >= end) { range.setEnd(node, end - offset); break; }
    offset += length;
  }
  act(() => {
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  fireEvent.mouseUp(root);
}

afterEach(() => window.getSelection()?.removeAllRanges());

describe("excerpt picker", () => {
  it("opens a full note after a body match, captures exactly one sentence and inserts it", () => {
    const source = note("source", "An essay", "Opening thought.\n\nThe exact sentence. A longer paragraph follows.\n\nA final thought.");
    const onInsertExcerpt = vi.fn();
    render(<ExcerptPicker notes={[source]} currentNoteId="current" onInsertExcerpt={onInsertExcerpt} onClose={vi.fn()}/>);
    fireEvent.change(screen.getByRole("textbox", { name: "Search notes and their contents" }), { target: { value: "exact sentence" } });
    fireEvent.click(screen.getByRole("button", { name: /An essay/ }));
    const article = screen.getByLabelText("Source note: An essay");
    expect(article.textContent).toBe(source.body);
    expect(article.querySelector(".excerpt-search-highlight")?.textContent).toBe("exact sentence");
    expect(screen.getByRole("button", { name: "Insert excerpt" })).toBeDisabled();
    const from = article.textContent!.indexOf("The exact");
    select(article, from, from + "The exact sentence.".length);
    fireEvent.click(screen.getByRole("button", { name: "Insert excerpt" }));
    expect(onInsertExcerpt).toHaveBeenCalledWith(expect.objectContaining({ noteId: "source", text: "The exact sentence.", passages: [{ from, to: from + 19, text: "The exact sentence." }] }));
    expect(screen.queryByRole("button", { name: /Change excerpt/ })).toBeNull();
  });

  it("keeps separated selections in source order with ellipses and ignores selection outside the article", () => {
    const source = note("source", "Source", "First sentence. Middle sentence. Last sentence.");
    const onInsertExcerpt = vi.fn();
    render(<ExcerptPicker notes={[source]} currentNoteId="current" onInsertExcerpt={onInsertExcerpt} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    const article = screen.getByLabelText("Source note: Source");
    select(article, 33, 47);
    fireEvent.click(screen.getByRole("button", { name: "Add another passage" }));
    select(article, 0, 15);
    fireEvent.click(screen.getByRole("button", { name: "Insert excerpt" }));
    expect(onInsertExcerpt).toHaveBeenCalledWith(expect.objectContaining({ text: "First sentence. … Last sentence." }));
  });

  it("rejects changed or removed source notes while the picker is open", () => {
    const source = note("source", "Source", "Original exact sentence.");
    const onInsertExcerpt = vi.fn();
    const props = { currentNoteId: "current", onInsertExcerpt, onClose: vi.fn() };
    const { rerender } = render(<ExcerptPicker {...props} notes={[source]}/>);
    fireEvent.click(screen.getByRole("button", { name: /Source/ }));
    select(screen.getByLabelText("Source note: Source"), 0, 24);
    rerender(<ExcerptPicker {...props} notes={[{ ...source, body: "Changed exact sentence." }]}/>);
    expect(screen.getByRole("alert")).toHaveTextContent("changed");
    expect(screen.getByRole("button", { name: "Insert excerpt" })).toBeDisabled();
    rerender(<ExcerptPicker {...props} notes={[]}/>);
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
    expect(onInsertExcerpt).not.toHaveBeenCalled();
  });

  it("supports the existing-note link flow, Escape and a bounded focus loop", () => {
    const onInsertLink = vi.fn();
    const onClose = vi.fn();
    render(<ExcerptPicker notes={[note("source", "Source", "Some text."), note("current", "Current", "Some text.")]} currentNoteId="current" mode="link" onInsertLink={onInsertLink} onInsertExcerpt={vi.fn()} onClose={onClose}/>);
    const dialog = screen.getByRole("dialog", { name: "Link a note" });
    expect(within(dialog).queryByRole("button", { name: /Current/ })).toBeNull();
    const result = within(dialog).getByRole("button", { name: /Source/ });
    result.focus();
    fireEvent.keyDown(result, { key: "Tab" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close note picker" }));
    fireEvent.click(result);
    expect(onInsertLink).toHaveBeenCalledWith(expect.objectContaining({ id: "source" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
