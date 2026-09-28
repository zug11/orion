import { render } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { createNoteExcerptSelection, encodeNoteExcerptTitle } from "../lib/noteExcerpts";
import { consumeNoteExcerptNavigation } from "../lib/noteExcerptNavigation";
import { RichNoteEditor } from "./RichNoteEditor";

describe("editor excerpt source navigation", () => {
  it("uses current notes and the current navigation callback without recreating the editor", () => {
    const source: Note = { id: "excerpt-source", title: "Source article", body: "The selected sentence.", slug: "source", summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
    const selection = createNoteExcerptSelection(source, [{ from: 0, to: source.body.length }]);
    const markdown = `> ${selection.text}\n>\n> [Source article](orion-note://${source.id} "${encodeNoteExcerptTitle(selection)}")`;
    const oldOpen = vi.fn();
    const currentOpen = vi.fn();
    const props = { noteId: "origin", markdown, concepts: [], sources: [], attachedSourceIds: [], onChange: vi.fn(), onAttachSource: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
    const { container, rerender } = render(<RichNoteEditor {...props} notes={[]} onOpenNote={oldOpen}/>);
    const element = container.querySelector(".tiptap") as HTMLElement & { editor: Editor };
    const editor = element.editor;
    rerender(<RichNoteEditor {...props} notes={[source]} onOpenNote={currentOpen}/>);
    expect((container.querySelector(".tiptap") as typeof element).editor).toBe(editor);
    const anchor = container.querySelector("a[data-note-excerpt-source]")!;
    const event = new MouseEvent("click", { bubbles: true });
    Object.defineProperty(event, "target", { value: anchor });
    editor.view.props.handleClick?.(editor.view, 0, event);
    expect(currentOpen).toHaveBeenCalledWith(source.id);
    expect(oldOpen).not.toHaveBeenCalled();
    expect(consumeNoteExcerptNavigation(source.id)?.passages).toEqual(selection.passages);

    rerender(<RichNoteEditor {...props} notes={[]} onOpenNote={currentOpen}/>);
    editor.view.props.handleClick?.(editor.view, 0, event);
    expect(currentOpen).toHaveBeenCalledTimes(1);
  });
});
