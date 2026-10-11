// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";
import { buildImportPayload } from "../components/ImportStudio";
import { NoteBlock } from "../components/editor/NoteBlock";
import { NoteExcerpt } from "../components/editor/NoteExcerpt";
import { NoteImage } from "../components/editor/NoteImage";
import { NoteMarkdown, NoteMargins } from "../components/editor/NoteMargins";
import { NoteStarterKit, NoteTaskItem } from "../components/editor/NoteStarterKit";
import { NoteTable } from "../components/editor/NoteTable";
import { NoteTextAlignment } from "../components/editor/NoteTextAlignment";
import { createEmptySnapshot } from "../data/defaults";
import { createImportDraft, parseTextImport } from "./files";
import { IMPORT_NOTE_TRUNCATION_NOTICE } from "./importNoteExcerpt";
import fixture from "./fixtures/semanticImport.html?raw";

const editors: Editor[] = [];
function editor(content: string): Editor {
  const result = new Editor({
    extensions: [
      NoteStarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { autolink: true, openOnClick: false, enableClickSelection: false,
          protocols: ["orion-note", "orion-concept", "orion-source"],
          HTMLAttributes: { target: null, rel: null, class: "editor-explicit-link" } } }),
      TableKit.configure({ table: false }), NoteTable, NoteBlock, NoteExcerpt,
      TaskList, NoteTaskItem.configure({ nested: true }), NoteTextAlignment, NoteMargins,
      NoteImage.configure({ allowBase64: true, HTMLAttributes: { class: "note-embedded-image" } }),
      NoteMarkdown.configure({ markedOptions: { gfm: true } }),
    ], content, contentType: "markdown", editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(result); return result;
}
function nodes(root: ProseMirrorNode, type: string): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = [];
  root.descendants((node) => { if (node.type.name === type) result.push(node); });
  return result;
}
function payload(html: string) {
  const parsed = parseTextImport("semantic.html", "text/html", html);
  const snapshot = createEmptySnapshot("Local HTML", "2026-10-11T00:00:00Z");
  const before = structuredClone(snapshot);
  const result = buildImportPayload([{ item: {
    id: "html-import", fileName: parsed.fileName, mimeType: parsed.mimeType,
    byteSize: parsed.byteSize, status: "ready", included: true, parsed,
  } }], snapshot);
  expect(snapshot).toEqual(before);
  expect(result.sources[0].text).toBe(parsed.text);
  expect(createImportDraft(parsed).extractedText).toBe(parsed.text);
  expect(result.notes[0].sourceIds).toEqual([result.sources[0].id]);
  return { parsed, result };
}

afterEach(() => editors.splice(0).forEach((entry) => entry.destroy()));

describe("HTML import through source, note and production editor", () => {
  it("preserves semantic content through three serialization and reopen cycles", () => {
    const { parsed, result } = payload(fixture);
    expect(parsed.title).toBe("Semantic HTML evidence");
    expect(parsed.warnings).toHaveLength(3);
    expect(result.sources[0]).toMatchObject({ title: "Semantic HTML evidence", kind: "html", fileName: "semantic.html", mimeType: "text/html" });
    let markdown = result.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const instance = editor(markdown);
      const doc = instance.state.doc;
      expect(nodes(doc, "heading")[0].textContent).toBe("HTML field notes");
      expect(nodes(doc, "paragraph").some((node) => node.textContent === "First paragraph.")).toBe(true);
      expect(doc.textContent).toContain("Second paragraph: bold nested, italic, retired, and `exact` & code.");
      expect(doc.textContent).toContain("ab outer inner 🪐 café");
      const marks: Record<string, string[]> = {};
      const links: string[] = [];
      doc.descendants((node) => { for (const mark of node.marks) { (marks[mark.type.name] ??= []).push(node.textContent); if (mark.type.name === "link") links.push(mark.attrs.href); } });
      expect(marks.bold).toEqual(expect.arrayContaining(["bold nested", "ab", "Pipe code"]));
      expect(marks.italic).toEqual(expect.arrayContaining(["italic", "outer inner"]));
      expect(marks.strike).toContain("retired");
      expect(marks.code).toEqual(expect.arrayContaining(["a|b", "c\\|d", "`exact` & code", " paired spaces ", " leading", "trailing ", "\ttabbed"]));
      expect(links).toEqual(["https://example.com/a(b)?one=1&two=2", "https://example.com/a%7Cb"]);
      expect(nodes(doc, "orderedList")[0].attrs.start).toBe(3);
      expect(nodes(doc, "taskItem").map((node) => [node.textContent, node.attrs.checked])).toEqual([["Read the evidence", true], ["Review the caveat", false]]);
      expect(nodes(doc, "blockquote")[0].childCount).toBe(2);
      expect(doc.textContent).toContain("``` literal fence");
      expect(doc.textContent).toContain("kept as literal text");
      expect(doc.textContent).toContain("Edges:  leading|trailing |\ttabbed");
      expect(nodes(doc, "codeBlock")[0].textContent).toBe("  first line\n\nordinary code line\nlast line\n");
      expect(nodes(doc, "codeBlock")[1].textContent).toBe("``` literal fence\nkept as literal text");
      const tables = nodes(doc, "table");
      expect(tables).toHaveLength(3);
      expect(tables[0].childCount).toBe(2);
      expect(tables[0].child(1).childCount).toBe(2);
      expect(tables[0].child(1).child(1).textContent).toBe("a|b pipe link");
      expect(tables[1].childCount).toBe(2);
      expect(tables[1].child(0).textContent).toBe("");
      expect(tables[1].child(1).textContent).toBe("First real data🪐");
      expect(tables[1].firstChild?.firstChild?.type.name).toBe("tableCell");
      expect(tables[2].firstChild?.firstChild?.textContent).toBe("c\\|d");
      expect(doc.textContent).toContain("c\\|d");
      expect(doc.textContent).toContain("Literal table fallback");
      expect(nodes(doc, "image")).toHaveLength(0);
      expect(nodes(doc, "noteBlock")).toHaveLength(0);
      expect(doc.textContent).toContain("*stars*, [link](orion-note://private), &nbsp; and <!-- orion-block:v1 -->.");
      expect(doc.textContent).toContain("[Image: The diagram]");
      expect(doc.textContent).not.toMatch(/never execute|orion-document-margins/);
      markdown = instance.getMarkdown();
    }
    expect(result.sources[0].text).toBe(parsed.text);
  });

  it("preserves the entire semantic source when only the note is shortened", () => {
    const html = `<h1>Long source</h1>${'<p>Complete café 🪐 paragraph with <strong>evidence</strong>.</p>'.repeat(5_000)}<p>Final source sentinel</p>`;
    const { parsed, result } = payload(html);
    expect(parsed.text.length).toBeGreaterThan(200_000);
    expect(result.sources[0].text).toContain("Final source sentinel");
    expect(result.notes[0].body).toContain(IMPORT_NOTE_TRUNCATION_NOTICE);
    expect(result.notes[0].body).not.toContain("Final source sentinel");
    expect(result.sources[0].byteSize).toBe(new TextEncoder().encode(html).length);
  });
});
