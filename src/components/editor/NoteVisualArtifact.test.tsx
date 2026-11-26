// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import TaskList from "@tiptap/extension-task-list";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { afterEach, describe, expect, it } from "vitest";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { NoteMarkdown } from "./NoteMargins";
import { captureVisualArtifact, captureVisualArtifactAfterBlock, insertArtifactTasks, insertVisualArtifact, NoteVisualArtifact } from "./NoteVisualArtifact";
import { readVisualArtifactMarker, remarkVisualArtifacts, visualArtifactMarker } from "../../lib/visualArtifactMarkdown";
import { ExportVisualArtifact } from "../../lib/visualArtifactExport";
import { type VisualArtifact } from "../../lib/visualArtifacts";
import { buildPortableCollection } from "../../lib/portableOrion";
import { createEmptySnapshot } from "../../data/defaults";
import type { Note } from "../../types";

const editors: Editor[] = [];
const artifact: VisualArtifact = { version: 1, format: "explainer", title: "Énergie ☀️",
  blocks: [{ kind: "text", heading: "Charge", text: "Excess power → storage. <!-- example -->" }] };
const marker = visualArtifactMarker(artifact);
function editorFor(body: string) {
  const editor = new Editor({ extensions: [NoteStarterKit, TaskList, NoteTaskItem, NoteVisualArtifact, NoteMarkdown], content: body, contentType: "markdown" });
  editors.push(editor);
  return editor;
}
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));

describe("note visual artifacts", () => {
  it("inserts the recipe list after the chosen artifact in a single Undo", () => {
    const editor = editorFor([marker, "Middle", marker, "After"].join("\n\n"));
    const before = editor.getMarkdown();
    const positions: number[] = [];
    editor.state.doc.forEach((node, pos) => {
      if (node.type.name === "noteVisualArtifact") positions.push(pos);
    });
    expect(insertArtifactTasks(editor, positions[1], "stale marker", ["2 pears"])).toBe(false);
    expect(insertArtifactTasks(editor, positions[1], marker, ["2 pears", "100 g flour"])).toBe(true);
    expect(editor.state.doc.child(3).type.name).toBe("taskList");
    expect(editor.state.doc.child(3).lastChild?.attrs.checked).toBe(false);
    expect(editor.getMarkdown()).toContain("- [ ] 2 pears\n- [ ] 100 g flour");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(before);
  });
  it("inserts after the selected passage, keeps the original prose and one Undo survives adjacent edits", () => {
    const editor = editorFor("A line with **repeated** text.\n\nA line with repeated text.\n\nLast.");
    const before = editor.getMarkdown();
    const firstSize = editor.state.doc.firstChild!.nodeSize;
    const from = firstSize + 1;
    editor.commands.setTextSelection({ from, to: from + 11 });
    const result = captureVisualArtifact(editor)!;
    expect(result.source).toBe("A line with");
    expect(insertVisualArtifact(editor, result.capture, artifact)).toBe(true);
    expect(editor.getMarkdown()).toBe(before.replace("\n\nLast.", "\n\n" + marker + "\n\nLast."));
    const reopened = editorFor(editor.getMarkdown());
    expect(reopened.state.doc.child(2).type.name).toBe("noteVisualArtifact");
    expect(readVisualArtifactMarker(reopened.state.doc.child(2).attrs.marker)).toEqual(artifact);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(before);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.getMarkdown()).toContain(marker);
  });

  it("places the artifact after the selected paragraph when selection includes its final line break", () => {
    const editor = editorFor("First.\n\nSecond.");
    editor.commands.setTextSelection({ from: 1, to: editor.state.doc.firstChild!.nodeSize + 1 });
    const result = captureVisualArtifact(editor)!;
    expect(result.source).toBe("First.");
    expect(insertVisualArtifact(editor, result.capture, artifact)).toBe(true);
    expect(editor.getMarkdown()).toBe("First.\n\n" + marker + "\n\nSecond.");
  });

  it("does not apply to a changed document, a different editor, or an invalid insertion boundary", () => {
    const editor = editorFor("Two words.");
    const capture = captureVisualArtifactAfterBlock(editor, editor.state.doc.firstChild!.nodeSize)!;
    const other = editorFor("Two words.");
    expect(insertVisualArtifact(other, capture, artifact)).toBe(false);
    expect(captureVisualArtifactAfterBlock(editor, 3)).toBeNull();
    editor.commands.insertContent("New ");
    expect(insertVisualArtifact(editor, capture, artifact)).toBe(false);
    expect(editor.getMarkdown()).not.toContain(marker);
  });

  it.each(["The idea /vis", "/vis"])("keeps a slash command until successful insertion and restores it on Undo (%s)", text => {
    const editor = editorFor("Earlier secret.\n\n" + text);
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    const before = editor.getMarkdown();
    const result = captureVisualArtifact(editor, { from: end - 4, to: end })!;
    expect(result.source).toBe(text.replace("/vis", "").trim());
    expect(editor.getMarkdown()).toBe(before);
    expect(insertVisualArtifact(editor, result.capture, artifact)).toBe(true);
    expect(editor.getMarkdown()).not.toContain("/vis");
    expect(editor.getMarkdown()).toContain(marker);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(before);
  });

  it("keeps broken or future standalone records on edit, and leaves fenced examples alone", () => {
    for (const record of ["<!-- orion-artifact:v1 %%% -->", "<!-- orion-artifact:v2 future -->"]) {
      const editor = editorFor("Before.\n\n" + record + "\n\nAfter.");
      expect(readVisualArtifactMarker(record)).toBeNull();
      expect(editor.getMarkdown()).toContain(record);
      expect(editor.state.doc.child(1).type.name).toBe("noteVisualArtifact");
    }
    const editor = editorFor("```text\n" + marker + "\n```");
    expect(editor.state.doc.firstChild?.type.name).toBe("codeBlock");
  });

  it("produces readable exports and preserves only valid visible artifacts in portable notes", () => {
    const body = "Source words.\n\n" + marker;
    const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkVisualArtifacts]}
      components={{ aside: ({ node }) => <ExportVisualArtifact marker={node?.properties["data-orion-artifact"]}/> }}>{body}</ReactMarkdown>);
    expect(html).toContain("Énergie ☀️");
    expect(html).toContain("Excess power");
    expect(html).not.toContain("orion-artifact");
    const snapshot = createEmptySnapshot();
    const note: Note = { id: "n", title: "Test", slug: "test", aliases: [], kind: "article", status: "ready", conceptIds: [], summary: "", body: body + "\n\n<!-- orion-artifact:v1 invalid -->", sourceIds: [], tags: [], createdAt: "", updatedAt: "" };
    const file = buildPortableCollection({ ...snapshot, notes: [note] }, ["n"]);
    expect(file.collection.notes[0].body).toContain(marker);
    expect(file.collection.notes[0].body).not.toContain("invalid");
  });
});
