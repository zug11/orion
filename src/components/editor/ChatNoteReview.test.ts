// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { afterEach, expect, it, vi } from "vitest";
import { ChatNoteReview, diffChatDocument, showChatNoteReview, clearChatNoteReview } from "./ChatNoteReview";
import { prepareChatEditorChange, applyPreparedChatChange } from "./chatEditTransaction";
let editor: Editor;
afterEach(() => editor?.destroy());
it.each([
  ["Keep this old word.\n\nUntouched paragraph.", "Keep this new word.\n\nUntouched paragraph.", "old", "new"],
  ["Keep this.", "Keep this.\n\nNew paragraph.", "", "New paragraph."],
  ["- Keep\n- Old item", "- Keep\n- New item", "Old", "New"],
  ["| A | B |\n| --- | --- |\n| one | two |", "| A | B |\n| --- | --- |\n| one | three |", "two", "three"],
  ["Plain **bold**.", "Plain *italic*.", "bold", "italic"],
  ["A 😀 old thought.", "A 😀 new thought.", "old", "new"],
])("decorates actual positions without mutating content/history: %s", async (base, next, removed, added) => {
  const save = vi.fn();
  editor = new Editor({ extensions: [StarterKit, Markdown, TableKit, ChatNoteReview], content: base, contentType: "markdown", onUpdate: save });
  await new Promise(resolve => setTimeout(resolve, 0));
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  save.mockClear();
  const prepared = prepareChatEditorChange(editor, base, next);
  const changes = diffChatDocument(prepared.original, prepared.replacement);
  expect(changes.map(change => prepared.original.textBetween(change.from, change.to)).join("")).toBe(removed);
  expect(changes.map(change => change.addition.textBetween(0, change.addition.size)).join("")).toBe(added);
  showChatNoteReview(editor, "review", prepared);
  expect(editor.state.doc.eq(prepared.original)).toBe(true);
  expect(editor.getMarkdown()).not.toContain('chat-note');
  expect(save).not.toHaveBeenCalled(); expect(editor.can().undo()).toBe(false);
  expect(editor.view.dom.querySelector("[data-chat-addition]")).toHaveTextContent(added);
  editor.commands.insertContent("Unaccepted typing");
  expect(editor.state.doc.eq(prepared.original)).toBe(true);
  expect(save).not.toHaveBeenCalled();
  clearChatNoteReview(editor);
  applyPreparedChatChange(editor, prepared);
  expect(save).toHaveBeenCalledOnce();
  editor.commands.undo(); expect(editor.state.doc.eq(prepared.original)).toBe(true);
});
