// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { afterEach, describe, expect, it } from "vitest";
import { insertCleanedVoiceTranscriptAt, insertVoiceTranscriptAt } from "./voiceDictation";

const editors: Editor[] = [];

function createEditor(content: string) {
  const editor = new Editor({
    extensions: [
      NoteStarterKit,
      TaskList,
      NoteTaskItem.configure({ nested: true }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("voice dictation insertion", () => {
  it("inserts normalized speech at the chosen text cursor", () => {
    const editor = createEditor("Alpha beta");

    expect(
      insertVoiceTranscriptAt(editor, 6, "  A spoken thought.  "),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe("Alpha A spoken thought. beta");
  });

  it("does not create an editor transaction for an empty transcript", () => {
    const editor = createEditor("Keep this.");

    expect(insertVoiceTranscriptAt(editor, 1, "   ")).toBe(false);
    expect(editor.getMarkdown()).toBe("Keep this.");
  });

  it("inserts a cleaned sentence inline without replacing the current selection", () => {
    const editor = createEditor("Alpha beta");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(insertCleanedVoiceTranscriptAt(editor, 6, [
      { kind: "paragraph", text: "A spoken thought." },
    ])).toBe(true);
    expect(editor.getMarkdown()).toBe("Alpha A spoken thought. beta");
  });

  it("groups bullets and unchecked tasks as ordinary editable list nodes", () => {
    const editor = createEditor("");

    expect(insertCleanedVoiceTranscriptAt(editor, 1, [
      { kind: "paragraph", text: "For Thursday:" },
      { kind: "bullet", text: "Budget" },
      { kind: "bullet", text: "Timeline" },
      { kind: "todo", text: "Send the agenda" },
      { kind: "todo", text: "Book the room" },
      { kind: "paragraph", text: "I think that should work." },
    ])).toBe(true);
    expect(editor.state.doc.content.content.map(node => node.type.name)).toEqual([
      "paragraph", "bulletList", "taskList", "paragraph",
    ]);
    expect(editor.state.doc.child(1).childCount).toBe(2);
    expect(editor.state.doc.child(2).childCount).toBe(2);
    expect(editor.state.doc.child(2).child(0).attrs.checked).toBe(false);
    expect(editor.getMarkdown()).toBe(
      "For Thursday:\n\n- Budget\n- Timeline\n\n- [ ] Send the agenda\n- [ ] Book the room\n\nI think that should work.",
    );
  });

  it("preserves prose on both sides when inserting blocks in a paragraph", () => {
    const editor = createEditor("BeforeAfter");
    expect(insertCleanedVoiceTranscriptAt(editor, 7, [
      { kind: "bullet", text: "First" },
      { kind: "bullet", text: "Second" },
    ])).toBe(true);
    expect(editor.getMarkdown()).toBe("Before\n\n- First\n- Second\n\nAfter");
  });

  it.each([1, 6])("preserves surrounding prose at paragraph boundary %i", position => {
    const editor = createEditor("Words");
    expect(insertCleanedVoiceTranscriptAt(editor, position, [
      { kind: "paragraph", text: "First thought." },
      { kind: "paragraph", text: "Perhaps another." },
    ])).toBe(true);
    expect(editor.state.doc.textContent).toBe(position === 1
      ? "First thought.Perhaps another.Words"
      : "WordsFirst thought.Perhaps another.");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("Words");
  });

  it("treats HTML, Markdown, links, and multilingual speech as literal text", () => {
    const editor = createEditor("");
    const literal = "<script>alert(1)</script> **bold** [link](https://example.com) 你好 — peut-être";
    expect(insertCleanedVoiceTranscriptAt(editor, 1, [
      { kind: "bullet", text: literal },
      { kind: "todo", text: "- [x] quoted task" },
    ])).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe(literal);
    expect(editor.state.doc.child(1).textContent).toBe("- [x] quoted task");
    editor.state.doc.descendants(node => {
      expect(node.marks).toEqual([]);
      expect(["paragraph", "bulletList", "listItem", "taskList", "taskItem", "text"]).toContain(node.type.name);
    });
    expect(editor.view.dom.querySelector("script,a,strong")).toBeNull();
    const reloaded = createEditor(editor.getMarkdown());
    expect(reloaded.state.doc.textContent).toBe(editor.state.doc.textContent);
    expect(reloaded.view.dom.querySelector("script,strong")).toBeNull();
    // Ordinary URL autolinking may recognize a visible address on reload;
    // the provider's bracket syntax must never become a labelled link.
    expect(reloaded.view.dom.querySelector("a")?.textContent).toBe("https://example.com");
  });

  it.each(["plain", "structured"])("undoes %s dictation independently of preceding and subsequent typing", mode => {
    const editor = createEditor("Start");
    editor.commands.insertContentAt(6, " typed");
    const before = editor.state.doc;
    if (mode === "plain") expect(insertVoiceTranscriptAt(editor, 12, "Dictation.")).toBe(true);
    else expect(insertCleanedVoiceTranscriptAt(editor, 12, [
      { kind: "bullet", text: "First" },
      { kind: "todo", text: "Second" },
    ])).toBe(true);
    const dictated = editor.state.doc;
    editor.commands.insertContent(" afterward");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(dictated)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("Start");
  });

  it("rejects malformed blocks without changing text or selection", () => {
    const editor = createEditor("Keep this.");
    editor.commands.setTextSelection(3);
    const before = editor.state;
    expect(insertCleanedVoiceTranscriptAt(editor, 1, [])).toBe(false);
    expect(insertCleanedVoiceTranscriptAt(editor, 1, [{ kind: "paragraph", text: " " }])).toBe(false);
    expect(insertCleanedVoiceTranscriptAt(editor, Number.NaN, [{ kind: "paragraph", text: "Hi" }])).toBe(false);
    expect(editor.state).toBe(before);
  });
});
