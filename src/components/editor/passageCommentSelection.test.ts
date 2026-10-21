import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { getSlashMatch, matchingSlashItems } from "./slashCommands";
import { selectSlashCommentPassage } from "./passageCommentSelection";

describe("slash comment passage selection", () => {
  it("discovers the local comment command", () => {
    expect(matchingSlashItems({ from: 1, to: 9, query: "comment", inTable: false }).map(item => item.id)).toEqual(["comment"]);
  });
  it("removes only the command, selects the whole paragraph, and preserves one-step undo", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>Before /comment after.</p><p>Another paragraph.</p>" });
    editor.commands.setTextSelection(16);
    const before = editor.state.doc.toJSON();
    expect(selectSlashCommentPassage(editor, getSlashMatch(editor.state)!)).toBe(true);
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe("Before  after.");
    expect(editor.state.doc.lastChild!.textContent).toBe("Another paragraph.");
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.destroy();
  });
  it("uses preceding prose on an empty line without swallowing it or following text", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>Earlier.</p><p>/comment</p><p>Later.</p>" });
    editor.commands.setTextSelection(19);
    expect(selectSlashCommentPassage(editor, getSlashMatch(editor.state)!)).toBe(true);
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(9);
    expect(editor.state.doc.lastChild!.textContent).toBe("Later.");
    expect(editor.state.doc.child(1).textContent).toBe("");
    editor.destroy();
  });
  it("opens an empty note comment without consuming stale commands", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>/comment</p>" });
    editor.commands.setTextSelection(9);
    expect(selectSlashCommentPassage(editor, getSlashMatch(editor.state)!)).toBe("note");
    expect(editor.state.doc.textContent).toBe("");
    editor.commands.undo();
    expect(editor.state.doc.textContent).toBe("/comment");
    const original = editor.state.doc.toJSON();
    editor.commands.setTextSelection(1);
    expect(selectSlashCommentPassage(editor, { from: 1, to: 9 })).toBe(false);
    expect(editor.state.doc.toJSON()).toEqual(original);
    editor.commands.setContent("<p>Before /heading</p>");
    editor.commands.setTextSelection(16);
    expect(selectSlashCommentPassage(editor, { from: 8, to: 16 })).toBe(false);
    expect(editor.state.doc.textContent).toBe("Before /heading");
    editor.destroy();
  });
});

it("leaves a comment independent when a blank paragraph separates it from prose", () => {
  const editor = new Editor({ extensions: [StarterKit], content: "<p>Earlier.</p><p></p><p>/comment</p>" });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  expect(selectSlashCommentPassage(editor, getSlashMatch(editor.state)!)).toBe("note");
  expect(editor.state.doc.firstChild!.textContent).toBe("Earlier.");
  expect(editor.state.selection.empty).toBe(true);
  editor.destroy();
});
