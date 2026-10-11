// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { CellSelection, TableMap } from "@tiptap/pm/tables";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { RichNoteEditor } from "./RichNoteEditor";

const target: Note = {
  id: "target-note", title: "Research notes", slug: "research-notes", summary: "The supporting research.",
  body: "Supporting text.", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [],
  createdAt: "2026-10-09T00:00:00Z", updatedAt: "2026-10-09T00:00:00Z",
};
const href = `orion-note://${target.id}`;

beforeEach(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-content")) return new DOMRect(0, 0, 1200, 760);
    if (this.classList.contains("rich-note-editor")) return new DOMRect(200, 80, 840, 620);
    if (this.classList.contains("editor-prose")) return new DOMRect(280, 130, 680, 500);
    return new DOMRect(280, 200, 80, 20);
  });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(280, 200, 80, 20) },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function fixture(markdown: string) {
  const onChange = vi.fn();
  const onRegisterConcept = vi.fn();
  const onGenerateLinkTitle = vi.fn();
  const props = { noteId: "draft", markdown, notes: [target], concepts: [], sources: [], attachedSourceIds: [],
    onChange, onAttachSource: vi.fn(), onRegisterConcept, onGenerateLinkTitle, onDisableConceptAutoLink: vi.fn() };
  const view = render(<div className="workspace-content"><RichNoteEditor {...props} /></div>);
  const editor = (view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  await waitFor(() => expect(editor.isInitialized).toBe(true));
  return { ...view, props, editor, onChange, onRegisterConcept, onGenerateLinkTitle };
}

function selectText(editor: Editor, text: string) {
  let from = -1;
  editor.state.doc.descendants((node, position) => {
    if (from < 0 && node.isText && node.text?.includes(text)) from = position + node.text.indexOf(text);
  });
  if (from < 0) throw new Error(`Fixture text missing: ${text}`);
  act(() => { editor.commands.setTextSelection({ from, to: from + text.length }); });
}

function openLink() {
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Note body" }), { key: "k", metaKey: true });
}

function chooseTarget() {
  fireEvent.click(screen.getByRole("button", { name: "Link to Research notes" }));
}

function withoutAddedLinks(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAddedLinks);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (key === "marks" && Array.isArray(item)) {
      const remaining = item.filter(mark => mark.type !== "link" || mark.attrs?.href !== href);
      return remaining.length ? [[key, remaining.map(withoutAddedLinks)]] : [];
    }
    return [[key, withoutAddedLinks(item)]];
  }));
}

describe("direct note links from editor selection", () => {
  it("links a short bold phrase without creating a canonical article, preserving wording and one Undo", async () => {
    const { editor, onRegisterConcept, onGenerateLinkTitle, unmount } = await fixture("Keep **it** here.");
    selectText(editor, "it");
    const before = editor.getJSON();
    openLink();
    chooseTarget();
    expect(editor.state.doc.textContent).toBe("Keep it here.");
    expect(withoutAddedLinks(editor.getJSON())).toEqual(before);
    expect(editor.view.dom.querySelector(`a[href="${href}"]`)).toHaveTextContent("it");
    expect(onRegisterConcept).not.toHaveBeenCalled();
    expect(onGenerateLinkTitle).not.toHaveBeenCalled();
    const saved = editor.getMarkdown();
    act(() => { editor.commands.undo(); });
    expect(editor.getJSON()).toEqual(before);
    unmount();
    const reopened = await fixture(saved);
    expect(reopened.editor.view.dom.querySelector(`a[href="${href}"]`)).toHaveTextContent("it");
  });

  it("preserves headings, task state and inline formatting when a multi-block passage becomes a note link", async () => {
    const { editor } = await fixture("## Heading\n\nFirst **paragraph**.\n\n- [x] Completed task\n- [ ] Open task\n\nLast *paragraph*.");
    const before = editor.getJSON();
    act(() => { editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 }); });
    openLink();
    chooseTarget();
    expect(withoutAddedLinks(editor.getJSON())).toEqual(before);
    expect(editor.view.dom.querySelectorAll(`a[href="${href}"]`).length).toBeGreaterThan(3);
    act(() => { editor.commands.undo(); });
    expect(editor.getJSON()).toEqual(before);
  });

  it("inserts the destination title at an empty cursor instead of creating or replacing prose", async () => {
    const { editor, onRegisterConcept } = await fixture("Before.\n\nAfter.");
    act(() => { editor.commands.setTextSelection(8); });
    openLink();
    chooseTarget();
    expect(editor.state.doc.textContent).toBe("Before.Research notesAfter.");
    expect(editor.view.dom.querySelector(`a[href="${href}"]`)).toHaveTextContent("Research notes");
    expect(onRegisterConcept).not.toHaveBeenCalled();
  });

  it("removes a deleted destination from an open picker and cannot link to it", async () => {
    const view = await fixture("The evidence matters.");
    selectText(view.editor, "evidence");
    openLink();
    expect(screen.getByRole("button", { name: "Link to Research notes" })).toBeInTheDocument();
    view.rerender(<div className="workspace-content"><RichNoteEditor {...view.props} notes={[]} /></div>);
    expect(screen.queryByRole("button", { name: "Link to Research notes" })).not.toBeInTheDocument();
    expect(screen.getByText("No matching notes in this Space.")).toBeInTheDocument();
    expect(view.editor.getMarkdown()).toBe("The evidence matters.");
  });

  it("links only the selected table column while preserving cells and their formatting", async () => {
    const { editor } = await fixture("| Left | Right |\n| --- | --- |\n| **One** | Two |\n| Three | Four |");
    const before = editor.getJSON();
    const table = editor.state.doc.firstChild!;
    const map = TableMap.get(table);
    act(() => { editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, 1 + map.map[0], 1 + map.map[4]))); });
    const selection = editor.state.selection.toJSON();
    openLink();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(editor.state.selection).toBeInstanceOf(CellSelection);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    openLink();
    chooseTarget();
    expect(withoutAddedLinks(editor.getJSON())).toEqual(before);
    const linkedWords = [...editor.view.dom.querySelectorAll(`a[href="${href}"]`)].map(anchor => anchor.textContent);
    expect(linkedWords).toEqual(["Left", "One", "Three"]);
    act(() => { editor.commands.undo(); });
    expect(editor.getJSON()).toEqual(before);
  });
});
