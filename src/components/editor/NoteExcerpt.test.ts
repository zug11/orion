import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { buildNoteExcerptContent, createNoteExcerptSelection, getNoteExcerptText, parseNoteExcerptTitle } from "../../lib/noteExcerpts";
import type { Note } from "../../types";
import { NoteStarterKit } from "./NoteStarterKit";
import { deleteNoteExcerptBeforeCaret, isNoteExcerptNode, NoteExcerpt } from "./NoteExcerpt";

const editors: Editor[] = [];
function excerptNote(id: string, title: string, body: string): Note {
  return { id, title, body, slug: id, summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
}
function create(markdown = "") {
  const editor = new Editor({
    extensions: [NoteStarterKit.configure({ link: { protocols: ["orion-note"] } }), NoteExcerpt, Markdown.configure({ markedOptions: { gfm: true } })],
    content: markdown, contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); });

describe("portable excerpt editor behaviour", () => {
  it("roundtrips a quoted sentence and source as ordinary Markdown and retains passage navigation", () => {
    const source = excerptNote("source", "Notes on attention", 'A **careful** sentence with café and 🪶.\n\nAnother paragraph.');
    const selection = createNoteExcerptSelection(source, [{ from: 2, to: getNoteExcerptText(source).indexOf("\n\n") }]);
    const editor = create("Before.");
    editor.commands.insertContentAt(editor.state.doc.content.size, buildNoteExcerptContent(selection));
    const markdown = editor.getMarkdown();
    expect(markdown).toContain("> careful sentence with café and 🪶.");
    expect(markdown).toContain("[Notes on attention](orion-note://source");
    expect(markdown).not.toContain("<blockquote");
    const reopened = create(markdown);
    const quote = reopened.state.doc.child(1);
    expect(isNoteExcerptNode(quote)).toBe(true);
    expect(quote.child(0).textContent).toBe(selection.text);
    const link = quote.lastChild!.firstChild!.marks.find((mark) => mark.type.name === "link")!;
    expect(parseNoteExcerptTitle(link.attrs.title, link.attrs.href)?.passages).toEqual(selection.passages);
    expect(reopened.view.dom.querySelector(".note-excerpt-source")?.textContent).toBe("Notes on attention");
  });

  it("Backspace after an excerpt removes it in one edit and Undo restores it exactly", () => {
    const source = excerptNote("source", "Original", "Selected sentence.");
    const editor = create("Before.");
    editor.commands.insertContentAt(editor.state.doc.content.size, buildNoteExcerptContent(createNoteExcerptSelection(source, [{ from: 0, to: 18 }])));
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const before = editor.getMarkdown();
    expect(deleteNoteExcerptBeforeCaret(editor)).toBe(true);
    expect(editor.getMarkdown().trim()).toBe("Before.");
    editor.commands.undo();
    expect(editor.getMarkdown()).toBe(before);
  });

  it("preserves regular blockquotes and normal text deletion", () => {
    const editor = create("> Ordinary quotation.\n\nFollowing words.");
    editor.commands.setTextSelection(editor.state.doc.content.size - "Following words.".length - 1);
    expect(deleteNoteExcerptBeforeCaret(editor)).toBe(false);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(deleteNoteExcerptBeforeCaret(editor)).toBe(false);
  });
});
