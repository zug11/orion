// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { buildImportPayload } from "../components/ImportStudio";
import { NoteBlock } from "../components/editor/NoteBlock";
import { isNoteExcerptNode, NoteExcerpt } from "../components/editor/NoteExcerpt";
import { NoteImage } from "../components/editor/NoteImage";
import { NoteMarkdown, NoteMargins } from "../components/editor/NoteMargins";
import { NoteStarterKit, NoteTaskItem } from "../components/editor/NoteStarterKit";
import { NoteTable } from "../components/editor/NoteTable";
import { NoteTextAlignment } from "../components/editor/NoteTextAlignment";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { parseTextImport } from "./files";
import mcpFixture from "./fixtures/mcpPortableImport.json";
import { parseNoteExcerptTitle } from "./noteExcerpts";

// Captured from the real MCP library contract harness on 2026-10-11. This
// maintained test consumes that output; it does not launch a fresh MCP binary.
// Paragraph/document margins, image and table layout were all authored by the
// structured MCP commands. The table also passed row/column/cell edits and header
// toggling through the real executable; no renderer metadata overlay is added.
const NOW = "2026-10-11T00:00:00Z";
const IMAGE_URL = "orion-image://localhost/image_Abc-123456789";
const imageLayout = {
  placement: "wrap", alignment: "left", widthPercent: 37,
  xPercent: 24.5, offsetY: 97, gap: 18,
  caption: "A preserved café 🪐 caption", showCaption: true, title: "Existing diagram",
};
const image = `![Existing diagram](${IMAGE_URL} "orion-image-layout:v1:${encodeURIComponent(JSON.stringify(imageLayout))}")`;
const markdown = mcpFixture.note.body;

const editors: Editor[] = [];
function createEditor(content: string): Editor {
  const editor = new Editor({
    // The content-bearing extensions/configuration used by RichNoteEditor.
    extensions: [
      NoteStarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { autolink: true, openOnClick: false, enableClickSelection: false,
          protocols: ["orion-note", "orion-concept", "orion-source"],
          HTMLAttributes: { target: null, rel: null, class: "editor-explicit-link" } },
      }),
      TableKit.configure({ table: false }), NoteTable, NoteBlock, NoteExcerpt,
      TaskList, NoteTaskItem.configure({ nested: true }), NoteTextAlignment, NoteMargins,
      NoteImage.configure({ allowBase64: true, HTMLAttributes: { class: "note-embedded-image" } }),
      NoteMarkdown.configure({ markedOptions: { gfm: true } }),
    ],
    content, contentType: "markdown",
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  return editor;
}
function note(id: string, title: string, body: string): Note {
  return { id, title, body, slug: id, summary: "", aliases: [], tags: [], kind: "article",
    status: "ready", conceptIds: [], sourceIds: [], createdAt: NOW, updatedAt: NOW };
}
function nodes(root: ProseMirrorNode, type: string): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = [];
  root.descendants((child) => { if (child.type.name === type) result.push(child); });
  return result;
}
function verifyPortableSemantics(editor: Editor) {
  const doc = editor.state.doc;
  expect(doc.attrs).toMatchObject({ marginLeft: 8, marginRight: 11 });
  const frames = nodes(doc, "noteBlock");
  expect(frames).toHaveLength(1);
  const frame = frames[0];
  expect(nodes(frame, "noteBlock")).toHaveLength(0);
  expect(nodes(frame, "heading")[0].textContent).toBe("Search review");
  const paragraph = nodes(frame, "paragraph").find((entry) => entry.textContent === "Keep the reading surface calm.");
  expect(paragraph?.attrs).toMatchObject({ marginLeft: 4, marginRight: 6, textAlign: "justify" });
  expect(nodes(frame, "taskItem").map((entry) => ({ text: entry.textContent, checked: entry.attrs.checked })))
    .toEqual([{ text: "Check keyboard navigation", checked: false }, { text: "Keep citations close", checked: true }]);

  const tables = nodes(frame, "table");
  expect(tables).toHaveLength(1);
  expect(tables[0].attrs).toMatchObject({ tableWidth: 74, banded: false });
  expect(tables[0].childCount).toBe(3);
  expect(tables[0].firstChild?.firstChild?.type.name).toBe("tableHeader");
  expect(tables[0].firstChild?.child(0).attrs.colwidth).toEqual([127]);
  expect(tables[0].firstChild?.child(1).attrs.colwidth).toEqual([220]);
  expect(tables[0].textContent).toBe("AreaDecisionSearchAsk AI on the rightAnswersA clear reading view");
  const search = tables[0].child(1).child(0).firstChild?.firstChild;
  expect(search?.text).toBe("Search");
  expect(search?.marks.some((mark) => mark.type.name === "bold")).toBe(true);

  const images = nodes(frame, "image");
  expect(images).toHaveLength(1);
  expect(images[0].attrs).toMatchObject({ ...imageLayout, src: IMAGE_URL, alt: "Existing diagram" });
  const references: { text: string; href: string; title: unknown }[] = [];
  doc.descendants((child) => {
    for (const mark of child.marks) if (mark.type.name === "link") {
      references.push({ text: child.textContent, href: mark.attrs.href, title: mark.attrs.title });
    }
  });
  expect(references).toEqual(expect.arrayContaining([
    expect.objectContaining({ text: "Supporting note", href: "orion-note://knowledge-b" }),
    expect.objectContaining({ text: "One append.", href: "https://example.com/reference%29a?first=1&second=2#source" }),
    expect.objectContaining({ text: "Read [more] *now*", href: "https://xn--r8jz45g.jp/%E6%96%87" }),
  ]));
  const excerpt = nodes(doc, "blockquote").find(isNoteExcerptNode);
  expect(excerpt?.firstChild?.textContent).toBe("A focused search view keeps the answer readable and the evidence close.");
  const citation = references.find((entry) => entry.text === "Contract Beta")!;
  expect(parseNoteExcerptTitle(citation.title, citation.href)).toEqual({
    noteId: "knowledge-b", passages: [{ text: "A focused search view keeps the answer readable and the evidence close.", locator: "unique-text" }],
  });
  expect(editor.view.dom.querySelector("a[data-note-excerpt-source]")?.hasAttribute("title")).toBe(false);
  expect(editor.view.dom.textContent).not.toMatch(/orion-(?:block|table|excerpt|document-margins|paragraph-margins|text):/);
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

describe("combined portable MCP-content import and editor round trip", () => {
  it.each(mcpFixture.tableStates)("preserves the executable's $name table through import and reopen", (scenario) => {
    const parsed = parseTextImport("table-state.md", "text/markdown", scenario.markdown);
    const payload = buildImportPayload([{ item: {
      id: "table-state", fileName: parsed.fileName, mimeType: parsed.mimeType,
      byteSize: parsed.byteSize, status: "ready", included: true, parsed,
    } }], createEmptySnapshot(mcpFixture.spaceId, NOW));
    expect(payload.sources[0].text).toBe(scenario.markdown);
    let saved = payload.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const editor = createEditor(saved);
      const table = nodes(editor.state.doc, "table")[0];
      expect(table).toBeDefined();
      expect(table.childCount).toBe(scenario.rows);
      expect(table.firstChild?.childCount).toBe(scenario.columns);
      expect(table.firstChild?.firstChild?.type.name).toBe(scenario.header ? "tableHeader" : "tableCell");
      expect(table.attrs).toMatchObject({ tableWidth: 74, banded: false });
      expect(table.firstChild?.child(0).attrs.colwidth).toEqual([127]);
      expect(table.firstChild?.child(1).attrs.colwidth).toEqual([220]);
      expect(table.textContent).toContain(scenario.text);
      if ("firstRowEmpty" in scenario && scenario.firstRowEmpty) expect(table.firstChild?.textContent).toBe("");
      let preservedBold = false;
      table.descendants((child) => {
        if (child.text === "Search" && child.marks.some((mark) => mark.type.name === "bold")) preservedBold = true;
      });
      expect(preservedBold).toBe(true);
      expect(editor.view.dom.textContent).not.toContain("orion-table:v1");
      saved = editor.getMarkdown();
    }
    expect(payload.sources[0].text).toBe(scenario.markdown);
  });

  it("preserves one combined document through parsing, source creation, editor serialization and repeated reopen", () => {
    const snapshot = createEmptySnapshot(mcpFixture.spaceId, NOW);
    snapshot.notes = [note(mcpFixture.sourceNote.id, mcpFixture.sourceNote.title, mcpFixture.sourceNote.body),
      note("image-owner", "Existing managed image", image)];
    const before = structuredClone(snapshot);
    const parsed = parseTextImport("portable-content.md", "text/markdown", markdown);
    expect(parsed.text).toBe(markdown);
    const payload = buildImportPayload([{ item: {
      id: "combined-import", fileName: parsed.fileName, mimeType: parsed.mimeType,
      byteSize: parsed.byteSize, status: "ready", included: true, parsed,
    } }], snapshot);
    expect(payload.notes).toHaveLength(1);
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0].text).toBe(markdown);
    expect(payload.notes[0].sourceIds).toEqual([payload.sources[0].id]);
    expect(payload.sources[0].noteIds).toEqual([payload.notes[0].id]);
    expect(snapshot).toEqual(before);

    let saved = payload.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const editor = createEditor(saved);
      verifyPortableSemantics(editor);
      saved = editor.getMarkdown();
      expect(saved.match(/<!-- orion-block:v1 -->/g)).toHaveLength(1);
      expect(saved.match(/<!-- \/orion-block -->/g)).toHaveLength(1);
      expect(saved).toContain("orion-excerpt:v2:");
      expect(saved).toContain("orion-image-layout:v1:");
    }
    // Saving the editable representation never rewrites the preserved source.
    expect(payload.sources[0].text).toBe(markdown);
  });
});

/** Compare actual editor marks, rather than relying on Markdown spellings. */
function inlineCharacters(editor: Editor) {
  const characters: { text: string; marks: string[]; href?: string }[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return;
    const marks = node.marks.map(mark => mark.type.name).sort();
    const href = node.marks.find(mark => mark.type.name === "link")?.attrs.href as string | undefined;
    for (const text of Array.from(node.text ?? "")) characters.push({ text, marks, ...(href ? { href } : {}) });
  });
  return characters;
}

describe("executable inline formatting through Markdown import and editor reopen", () => {
  it.each(mcpFixture.inlineStates)("preserves $name without changing other marks", (scenario) => {
    const parsed = parseTextImport("inline-state.md", "text/markdown", scenario.markdown);
    const payload = buildImportPayload([{ item: {
      id: "inline-state", fileName: parsed.fileName, mimeType: parsed.mimeType,
      byteSize: parsed.byteSize, status: "ready", included: true, parsed,
    } }], createEmptySnapshot(mcpFixture.spaceId, NOW));
    expect(payload.sources[0].text).toBe(scenario.markdown);
    let saved = payload.notes[0].body;
    let baseline: ReturnType<typeof inlineCharacters> | undefined;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const editor = createEditor(saved);
      const characters = inlineCharacters(editor);
      const allText = characters.map(character => character.text).join("");
      const from = Array.from(allText.slice(0, allText.indexOf(scenario.text))).length;
      expect(allText).toContain(scenario.text);
      const selected = characters.slice(from, from + Array.from(scenario.text).length);
      expect(selected.length).toBe(Array.from(scenario.text).length);
      for (const character of selected) {
        expect(character.marks).toEqual([...scenario.marks].sort());
        expect(character.href).toBe("href" in scenario ? scenario.href : undefined);
      }
      if (baseline) expect(characters).toEqual(baseline);
      baseline = characters;
      saved = editor.getMarkdown();
    }
  });
});
