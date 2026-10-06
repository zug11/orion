// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import { afterEach, describe, expect, it } from "vitest";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { NoteTextAlignment, toggleNoteJustification } from "./NoteTextAlignment";
import { JUSTIFY_MARKER } from "../../lib/noteTextAlignment";

const editors: Editor[] = [];
function createEditor(markdown: string) {
  const editor = new Editor({ extensions: [NoteStarterKit, NoteTextAlignment, TaskList, NoteTaskItem.configure({ nested: true }), Markdown],
    content: markdown, contentType: "markdown", editorProps: { handleScrollToSelection: () => true } });
  editors.push(editor); return editor;
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

describe("portable paragraph justification", () => {
  it("justifies selected paragraphs together, preserving links and Undo", () => {
    const editor = createEditor("First **paragraph**.\n\nSecond [note](orion-note://n1).\n\nLeave alone.");
    const end = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize - 1;
    editor.commands.setTextSelection({ from: 1, to: end });
    expect(toggleNoteJustification(editor)).toBe(true);
    expect(editor.state.doc.child(0).attrs.textAlign).toBe("justify");
    expect(editor.state.doc.child(1).attrs.textAlign).toBe("justify");
    expect(editor.state.doc.child(2).attrs.textAlign).toBe("left");
    const saved = editor.getMarkdown();
    expect(saved).toContain("**paragraph**"); expect(saved).toContain("orion-note://n1");
    expect(saved.split(JUSTIFY_MARKER)).toHaveLength(3);
    const restored = createEditor(saved);
    expect(restored.getJSON()).toEqual(editor.getJSON());
    expect(restored.getMarkdown()).toBe(saved);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).not.toContain(JUSTIFY_MARKER);
  });
  it.each(["A paragraph.", "### A heading", "> A quoted paragraph.", "- [ ] A task.", "- A list item."])("round trips formatting without displaying metadata: %s", (markdown) => {
    const editor = createEditor(markdown);
    editor.commands.selectAll(); toggleNoteJustification(editor);
    const saved = editor.getMarkdown();
    const restored = createEditor(saved);
    expect(restored.getJSON()).toEqual(editor.getJSON());
    expect(restored.getMarkdown()).toBe(saved);
    expect(restored.view.dom.textContent).not.toContain("orion-text:");
    restored.commands.selectAll(); toggleNoteJustification(restored);
    expect(restored.getMarkdown()).not.toContain(JUSTIFY_MARKER);
  });
  it("keeps marker examples literal in fenced code and rejects arbitrary style metadata", () => {
    const editor = createEditor(`\`\`\`html\n${JUSTIFY_MARKER}\n\nExample\n\`\`\`\n\n<!-- orion-text:v1 color:red -->\n\nPlain text.`);
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
    expect(editor.state.doc.firstChild?.textContent).toContain(JUSTIFY_MARKER);
    expect(editor.view.dom.querySelector('[data-orion-justify="true"]')).toBeNull();
  });
});
