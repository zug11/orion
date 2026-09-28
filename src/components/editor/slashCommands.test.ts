import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { getSlashMatch, matchingSlashItems } from "./slashCommands";

describe("slash command discovery", () => {
  it("offers all six direct headings and only relevant table deletion choices", () => {
    for (let level = 1; level <= 6; level++) {
      expect(matchingSlashItems({ from: 1, to: 4, query: `h${level}`, inTable: false }).map(item => item.id)).toEqual([`h${level}`]);
    }
    expect(matchingSlashItems({ from: 1, to: 8, query: "delete", inTable: true }).map(item => item.id)).toEqual(["delete-row", "delete-column", "delete-table"]);
    expect(matchingSlashItems({ from: 1, to: 8, query: "delete", inTable: false })).toEqual([]);
    expect(matchingSlashItems({ from: 1, to: 8, query: "table", inTable: true })).toEqual([]);
  });

  it("leaves slash characters inside URLs, paths and code untouched", () => {
    for (const content of ["<p>folder/file</p>", "<p>https://example.com</p>", "<pre><code>/todo</code></pre>", "<p><code>Code /todo</code></p>"]) {
      const editor = new Editor({ extensions: [StarterKit], content });
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      expect(getSlashMatch(editor.state)).toBeNull();
      editor.destroy();
    }
    const editor = new Editor({ extensions: [StarterKit], content: "<p>/todo</p>" });
    editor.commands.setTextSelection(6);
    expect(getSlashMatch(editor.state)).toMatchObject({ from: 1, to: 6, query: "todo", inTable: false });
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(getSlashMatch(editor.state)).toBeNull();
    editor.destroy();
  });

  it("captures only the command at the cursor inside an existing paragraph", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>Text before /table and after.</p>" });
    editor.commands.setTextSelection(19);
    expect(getSlashMatch(editor.state)).toEqual({ from: 13, to: 19, query: "table", inTable: false });
    editor.commands.setTextSelection(14);
    expect(getSlashMatch(editor.state)).toMatchObject({ from: 13, to: 14, query: "" });
    editor.destroy();
  });

  it("opens after a soft line break within the same paragraph", () => {
    const editor = new Editor({ extensions: [StarterKit], content: "<p>Before<br>/todo after</p>" });
    editor.commands.setTextSelection(13);
    expect(getSlashMatch(editor.state)).toMatchObject({ from: 8, to: 13, query: "todo" });
    editor.destroy();
  });
});
