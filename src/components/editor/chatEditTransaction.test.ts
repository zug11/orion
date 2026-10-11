// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { afterEach, expect, it, vi } from "vitest";
import { applyChatEditorChange } from "./chatEditTransaction";
let editor: Editor;
afterEach(() => editor?.destroy());
function create(markdown: string) {
  const onUpdate = vi.fn();
  editor = new Editor({ extensions: [StarterKit, Markdown, TableKit, TaskList, TaskItem], content: markdown, contentType: "markdown", onUpdate });
  return onUpdate;
}
it("applies multiple changes in one undoable rich transaction and preserves formatting", () => {
  const base = "Old opening.\n\nKeep **bold** and [a link](https://example.com).\n\n- [x] Keep this task\n\n| A | B |\n| --- | --- |\n| one | two |\n\nOld ending.";
  const update = create(base), original = editor.getJSON();
  applyChatEditorChange(editor, base, base.replace("Old opening", "New opening").replace("Old ending", "New ending"));
  expect(editor.getText()).toContain("New opening");
  expect(editor.getMarkdown()).toContain("**bold**");
  expect(update).toHaveBeenCalledOnce();
  editor.commands.undo();
  expect(editor.getJSON()).toEqual(original);
  editor.commands.redo();
  expect(editor.getText()).toContain("New ending");
});
it("refuses late changes without losing typing or adding a history entry", () => {
  create("Original text.");
  editor.commands.insertContent("New typing. ");
  const typed = editor.getJSON();
  expect(() => applyChatEditorChange(editor, "Original text.", "Replacement.")).toThrow(/changed/);
  expect(editor.getJSON()).toEqual(typed);
  editor.commands.undo();
  expect(editor.getText()).toBe("Original text.");
});
it("keeps preceding typing separate from the applied change's Undo", () => {
  create("Original text.");
  editor.commands.insertContent("Typed. ");
  const typed = editor.getJSON(), base = editor.getMarkdown();
  applyChatEditorChange(editor, base, base.replace("Original", "Edited"));
  editor.commands.undo(); expect(editor.getJSON()).toEqual(typed);
  editor.commands.undo(); expect(editor.getText()).toBe("Original text.");
});
