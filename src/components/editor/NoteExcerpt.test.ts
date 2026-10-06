import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { afterEach, describe, expect, it } from "vitest";
import { buildNoteExcerptContent, createNoteExcerptSelection, getNoteExcerptText, parseNoteExcerptTitle } from "../../lib/noteExcerpts";
import type { Note } from "../../types";
import { NoteStarterKit } from "./NoteStarterKit";
import { deleteNoteExcerptBeforeCaret, isNoteExcerptNode, NoteExcerpt } from "./NoteExcerpt";
import { parseTextImport } from "../../lib/files";

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

  it("imports and reserializes MCP v2 excerpts with native styling and one-step deletion", () => {
    // Exact percent-encoded JSON format emitted by the independent Rust MCP server.
    const title = "orion-excerpt:v2:%7B%22noteId%22%3A%22source%22%2C%22passages%22%3A%5B%7B%22text%22%3A%22Exact%20caf%C3%A9%20%F0%9F%AA%B6%20words.%22%7D%5D%7D";
    const markdown = `Before.\n\n> Exact café 🪶 words.\n>\n> [Source \\[notes\\]](orion-note://source "${title}")\n\nAfter.`;
    const imported = parseTextImport("excerpt.md", "text/markdown", markdown);
    expect(imported.text).toBe(markdown);
    const editor = create(imported.text);
    const reopened = create(editor.getMarkdown());
    const quote = reopened.state.doc.child(1);
    expect(isNoteExcerptNode(quote)).toBe(true);
    expect(quote.firstChild?.textContent).toBe("Exact café 🪶 words.");
    expect(reopened.view.dom.querySelector(".note-excerpt-source")?.textContent).toBe("Source [notes]");
    const anchor = reopened.view.dom.querySelector("a[data-note-excerpt-source]");
    expect(anchor?.getAttribute("href")).toBe("orion-note://source");
    expect(anchor?.hasAttribute("title")).toBe(false);
    expect(reopened.getMarkdown()).toContain(title);
    reopened.commands.setTextSelection(reopened.state.doc.child(0).nodeSize + quote.nodeSize + 1);
    const before = reopened.getMarkdown();
    expect(deleteNoteExcerptBeforeCaret(reopened)).toBe(true);
    expect(reopened.getMarkdown()).toBe("Before.\n\nAfter.");
    reopened.commands.undo();
    expect(reopened.getMarkdown()).toBe(before);
  });

  it("preserves regular blockquotes and normal text deletion", () => {
    const editor = create("> Ordinary quotation.\n\nFollowing words.");
    editor.commands.setTextSelection(editor.state.doc.content.size - "Following words.".length - 1);
    expect(deleteNoteExcerptBeforeCaret(editor)).toBe(false);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(deleteNoteExcerptBeforeCaret(editor)).toBe(false);
  });
});
