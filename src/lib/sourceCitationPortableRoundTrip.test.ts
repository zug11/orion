// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
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
import type { Source } from "../types";
import { parseTextImport } from "./files";
import fixture from "./fixtures/mcpPortableImport.json";
import { restoreMarkdownFrontmatter, splitMarkdownFrontmatter } from "./markdown";
import { canonicalizeSourceCitations } from "./sourceCitations";

// Exact output captured by test_mcp_library.mjs from the independent executable.
// No renderer-produced citation overlay is added to these command results.
const sources = fixture.citationSources as Source[];
const editors: Editor[] = [];
function createEditor(content: string) {
  const editor = new Editor({
    extensions: [
      NoteStarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: { autolink: true, openOnClick: false, enableClickSelection: false,
          protocols: ["orion-note", "orion-concept", "orion-source"],
          HTMLAttributes: { target: null, rel: null, class: "editor-explicit-link" } } }),
      TableKit.configure({ table: false }), NoteTable, NoteBlock, NoteExcerpt,
      TaskList, NoteTaskItem.configure({ nested: true }), NoteTextAlignment, NoteMargins,
      NoteImage.configure({ allowBase64: true }),
      NoteMarkdown.configure({ markedOptions: { gfm: true } }),
    ], content, contentType: "markdown", editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  return editor;
}
afterEach(() => editors.splice(0).forEach(editor => editor.destroy()));
const expectedReferences: Record<string, string[]> = {
  "one citation": ["citation-source"], "repeated source": ["citation-source"],
  "first appearance renumber": ["citation-second", "citation-source"],
  "remove one marker": ["citation-second", "citation-source"],
  "remove first source and renumber": ["citation-source"],
  "remove final marker retains provenance": [], "authored numeric label and References": [],
  "protected CRLF and frontmatter": ["citation-source"], "remove authored formatted label": [], "exact Unicode ID and title whitespace": ["citation-証拠"],
};
describe("actual MCP source-citation output", () => {
  for (const state of fixture.citationStates) {
    it(`imports and survives three editor save/reopen cycles: ${state.name}`, () => {
      const initial = canonicalizeSourceCitations(state.markdown, sources);
      expect(initial.markdown).toBe(state.markdown);
      expect(initial.references.map(reference => reference.sourceId)).toEqual(expectedReferences[state.name]);
      expect(initial.references.map(reference => reference.number)).toEqual(initial.references.map((_, i) => i + 1));
      for (const ref of initial.references) expect(ref.title).toBe(sources.find(source => source.id === ref.sourceId)?.title.trim());
      const parsed = parseTextImport(`${state.name}.md`, "text/markdown", state.markdown);
      const payload = buildImportPayload([{ item: { id: "citation-import", fileName: parsed.fileName, mimeType: parsed.mimeType, byteSize: parsed.byteSize, status: "ready", included: true, parsed } }], createEmptySnapshot());
      expect(payload.sources[0].text).toBe(parsed.text);
      let markdown = payload.notes[0].body;
      let initialDocument: unknown;
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const document = splitMarkdownFrontmatter(markdown);
        const citations = canonicalizeSourceCitations(document.content, sources);
        expect(citations.references).toEqual(initial.references);
        const editor = createEditor(citations.body);
        const json = editor.getJSON();
        if (cycle === 0) initialDocument = json;
        else expect(json).toEqual(initialDocument);
        const markers: { text: string; href: string }[] = [];
        editor.state.doc.descendants(node => {
          for (const mark of node.marks) if (mark.type.name === "link" && String(mark.attrs.href).startsWith("orion-source://")) {
            markers.push({ text: node.textContent, href: mark.attrs.href });
          }
        });
        expect(markers.length).toBeGreaterThanOrEqual(initial.references.length);
        for (const marker of markers) {
          const ref = initial.references.find(ref => marker.href === `orion-source://${ref.sourceId}`);
          expect(ref).toBeDefined();
          expect(marker.text).toBe(String(ref?.number));
        }
        const saved = canonicalizeSourceCitations(editor.getMarkdown(), sources);
        expect(saved.references).toEqual(initial.references);
        markdown = restoreMarkdownFrontmatter(document.prefix, saved.markdown);
        expect(splitMarkdownFrontmatter(markdown).prefix).toBe(splitMarkdownFrontmatter(state.markdown).prefix);
      }
      if (state.name === "remove final marker retains provenance") {
        expect(state.sourceIds).toEqual(["citation-source", "citation-second"]);
        expect(markdown).not.toContain("orion-source://");
      }
      if (state.name === "authored numeric label and References") {
        expect(markdown).toContain("Year 2024.");
        expect(markdown).toContain("## References\n\nAn authored essay section.");
      }
      if (state.name === "protected CRLF and frontmatter") {
        expect(markdown).toContain("private: '[literal](orion-source://hidden)'");
        expect(markdown).toContain("[code](orion-source://citation-source)");
        expect(markdown).toContain("[example](orion-source://citation-source)");
      }
    });
  }
});
