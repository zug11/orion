// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import TaskList from "@tiptap/extension-task-list";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Document, ExternalHyperlink, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildImportPayload } from "../components/ImportStudio";
import { NoteBlock } from "../components/editor/NoteBlock";
import { NoteImage } from "../components/editor/NoteImage";
import { NoteMarkdown, NoteMargins } from "../components/editor/NoteMargins";
import { NoteStarterKit, NoteTaskItem } from "../components/editor/NoteStarterKit";
import { NoteTable } from "../components/editor/NoteTable";
import { NoteTextAlignment } from "../components/editor/NoteTextAlignment";
import { createEmptySnapshot } from "../data/defaults";
import { parseImportFile } from "./files";
import { IMPORT_NOTE_TRUNCATION_NOTICE } from "./importNoteExcerpt";
import { buildWordExportDocument } from "./wordExport";

const probe = vi.hoisted(() => ({ html: [] as string[], options: [] as unknown[], imageReads: vi.fn(), images: 0 }));
// Exercise the real browser Mammoth entry used by the renderer, not a mocked
// conversion. Spies observe options/HTML and reject any request for image bytes.
vi.mock("mammoth", async () => {
  const module = await vi.importActual<{ default: typeof import("mammoth") }>("mammoth/mammoth.browser.js");
  const actual = module.default;
  return { default: { ...actual,
    convertToHtml: async (...args: Parameters<typeof actual.convertToHtml>) => {
      probe.options.push(args[1]);
      const result = await actual.convertToHtml(...args);
      probe.html.push(result.value);
      return result;
    },
    images: { ...actual.images, imgElement: (handler: Parameters<typeof actual.images.imgElement>[0]) => actual.images.imgElement(async (image) => {
      probe.images += 1;
      const forbidden = () => { probe.imageReads(); throw new Error("Embedded image bytes must not be read."); };
      return handler({ ...image, read: forbidden, readAsArrayBuffer: forbidden, readAsBase64String: forbidden, readAsBuffer: forbidden });
    }) },
  } };
});

const editors: Editor[] = [];
function editor(content: string): Editor {
  const result = new Editor({ extensions: [
    NoteStarterKit.configure({ link: { autolink: false, protocols: ["orion-note", "orion-source", "orion-concept"] } }),
    TableKit.configure({ table: false }), NoteTable, NoteBlock, TaskList, NoteTaskItem.configure({ nested: true }),
    NoteTextAlignment, NoteMargins, NoteImage.configure({ allowBase64: true }),
    NoteMarkdown.configure({ markedOptions: { gfm: true } }),
  ], content, contentType: "markdown", editorProps: { handleScrollToSelection: () => true } });
  editors.push(result); return result;
}
function nodes(root: ProseMirrorNode, type: string): ProseMirrorNode[] {
  const result: ProseMirrorNode[] = [];
  root.descendants((node) => { if (node.type.name === type) result.push(node); });
  return result;
}
const code = (text: string) => new TextRun({ text, style: "InlineCode" });
const cell = (content: Paragraph[], options = {}) => new TableCell({ children: content, ...options });
const row = (...values: string[]) => new TableRow({ children: values.map((value) => cell([new Paragraph(value)])) });
const picture = () => new ImageRun({ type: "png", data: Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII="), (value) => value.charCodeAt(0)), transformation: { width: 24, height: 24 }, altText: { name: "Figure", title: "Chart", description: "Actual source figure" } });
async function payload(children: Array<Paragraph | Table>) {
  const document = new Document({ styles: { characterStyles: [{ id: "InlineCode", name: "Inline code" }], paragraphStyles: [{ id: "Code", name: "Code" }] }, sections: [{ children }] });
  const bytes = await Packer.toArrayBuffer(document);
  return importBytes(bytes);
}
async function importBytes(bytes: ArrayBuffer) {
  const file = new File([bytes], "semantic-word.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => bytes });
  const parsed = await parseImportFile(file);
  const snapshot = createEmptySnapshot("Word import", "2026-10-11T00:00:00Z");
  const original = structuredClone(snapshot);
  const result = buildImportPayload([{ item: { id: "word", fileName: file.name, mimeType: file.type, byteSize: file.size, status: "ready", included: true, parsed } }], snapshot);
  expect(snapshot).toEqual(original);
  expect(result.sources[0].text).toBe(parsed.text);
  expect(result.sources[0].byteSize).toBe(bytes.byteLength);
  expect(result.notes[0].sourceIds).toEqual([result.sources[0].id]);
  return { parsed, result };
}
afterEach(() => { editors.splice(0).forEach((value) => value.destroy()); probe.html = []; probe.options = []; probe.images = 0; probe.imageReads.mockClear(); });

describe("Word bytes through import, source retention and the production editor", () => {
  it("preserves headerless rows, literal text and code, and reports omitted pictures through three reopens", async () => {
    const { parsed, result } = await payload([
      new Paragraph({ text: "Word evidence", heading: HeadingLevel.HEADING_1 }),
      new Paragraph("Literal &nbsp; and ~~not deleted~~ café 🪐"),
      new Paragraph({ children: [new TextRun("Exact code: "), code(" "), new TextRun(" / "), code(" `tick` "), new TextRun(" / "), code("\tindented ")] }),
      new Table({ rows: [row("", ""), row("First real data", "A"), new TableRow({ children: [cell([new Paragraph({ children: [code("a\\|b")] })]), cell([new Paragraph("☑ A literal table glyph")])] })] }),
      new Paragraph({ children: [picture(), picture()] }),
    ]);
    expect(probe.html[0]).toContain("<code> </code>");
    expect(probe.html[0]).toContain("<td><p>First real data</p></td>");
    expect(probe.options[0]).toMatchObject({ externalFileAccess: false, includeEmbeddedStyleMap: false });
    expect(probe.images).toBe(2);
    expect(probe.imageReads).not.toHaveBeenCalled();
    expect(parsed.warnings).toEqual(["Images and embedded media were not imported; available descriptions and fallback text were kept."]);
    let markdown = result.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const instance = editor(markdown), doc = instance.state.doc;
      expect(doc.textContent).toContain("Literal &nbsp; and ~~not deleted~~ café 🪐");
      const codeText: string[] = [], strike: string[] = [];
      doc.descendants((node) => { if (node.isText) for (const mark of node.marks) { if (mark.type.name === "code") codeText.push(node.text!); if (mark.type.name === "strike") strike.push(node.text!); } });
      expect(codeText).toEqual([" ", " `tick` ", "\tindented ", "a\\|b"]);
      expect(strike).toEqual([]);
      const table = nodes(doc, "table")[0];
      expect(table.childCount).toBe(3);
      expect(table.child(0).textContent).toBe("");
      expect(table.child(1).textContent).toBe("First real dataA");
      expect(table.child(0).child(0).type.name).toBe("tableCell");
      expect(table.child(2).child(1).textContent).toBe("☑ A literal table glyph");
      expect(nodes(doc, "taskItem")).toHaveLength(0);
      expect(nodes(doc, "image")).toHaveLength(0);
      expect(doc.textContent.match(/\[Image: Actual source figure\]/g)).toHaveLength(2);
      markdown = instance.getMarkdown();
    }
    expect(result.sources[0].text).toBe(parsed.text);
  });

  it("retains Word glyph tasks, nested lists, safe mailto links and code glyphs without duplicate tasks", async () => {
    const { parsed, result } = await payload([
      new Paragraph("☐ Pending paragraph"), new Paragraph("☑ Finished paragraph"),
      new Paragraph({ text: "☑ Parent task", bullet: { level: 0 } }),
      new Paragraph({ text: "☐ Nested task", bullet: { level: 1 } }),
      new Paragraph({ text: "Ordinary sibling", bullet: { level: 0 } }),
      new Paragraph({ children: [code("☑ code, not a task")] }),
      new Paragraph({ style: "Code", children: [new TextRun("☐ fenced, not a task")] }),
      new Paragraph({ children: [new ExternalHyperlink({ link: "mailto:writer@example.com?subject=Evidence", children: [new TextRun("Email author")] }), new TextRun(" / "), new ExternalHyperlink({ link: "file:///private/source.docx", children: [new TextRun("Local label")] })] }),
    ]);
    expect(parsed.warnings).toContain("Only explicit HTTP(S) and mailto links were kept. Other link labels remain as text.");
    let markdown = result.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const instance = editor(markdown), doc = instance.state.doc;
      const tasks = nodes(doc, "taskItem");
      expect(tasks).toHaveLength(4);
      expect(tasks.map((item) => [item.firstChild?.textContent, item.attrs.checked])).toEqual([
        ["Pending paragraph", false], ["Finished paragraph", true], ["Parent task", true], ["Nested task", false],
      ]);
      expect(tasks[2].childCount).toBe(2);
      expect(nodes(doc, "codeBlock")[0].textContent).toBe("☐ fenced, not a task");
      const links: string[] = [];
      doc.descendants((node) => { for (const mark of node.marks) if (mark.type.name === "link") links.push(mark.attrs.href); });
      expect(links).toEqual(["mailto:writer@example.com?subject=Evidence"]);
      expect(doc.textContent).toContain("☑ code, not a task");
      expect(doc.textContent).toContain("Local label");
      markdown = instance.getMarkdown();
    }
  });

  it("keeps all merged-table text with an explicit simplification warning", async () => {
    const { parsed, result } = await payload([new Table({ rows: [
      new TableRow({ children: [cell([new Paragraph("Merged evidence")], { columnSpan: 2 })] }), row("Left detail", "Right detail"),
    ] })]);
    expect(probe.html[0]).toContain('colspan="2"');
    expect(parsed.warnings).toContain("Complex tables were simplified to readable text; merged cells and table layout were not retained.");
    const doc = editor(result.notes[0].body).state.doc;
    expect(nodes(doc, "table")).toHaveLength(0);
    for (const value of ["Merged evidence", "Left detail", "Right detail"]) expect(doc.textContent).toContain(value);
  });

  it("warns once for genuine multiple Word header rows and preserves every row through three reopens", async () => {
    const header = (...values: string[]) => new TableRow({ tableHeader: true, children: values.map((value) => cell([new Paragraph(value)])) });
    const { parsed, result } = await payload([new Table({ rows: [
      header("Primary heading", "Category"), header("Secondary heading", "Subcategory"), row("Actual evidence", "Preserved detail"),
    ] })]);
    const html = new DOMParser().parseFromString(probe.html[0], "text/html");
    expect(html.querySelectorAll("th")).toHaveLength(4);
    expect(html.querySelectorAll("td")).toHaveLength(2);
    expect(parsed.warnings).toEqual(["Multiple Word table header rows were reduced to one; all row content was kept."]);
    let markdown = result.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const instance = editor(markdown), table = nodes(instance.state.doc, "table")[0];
      expect(table.childCount).toBe(3);
      expect(table.child(0).child(0).type.name).toBe("tableHeader");
      expect(table.child(1).child(0).type.name).toBe("tableCell");
      expect(table.child(2).child(0).type.name).toBe("tableCell");
      expect([table.child(0).textContent, table.child(1).textContent, table.child(2).textContent]).toEqual([
        "Primary headingCategory", "Secondary headingSubcategory", "Actual evidencePreserved detail",
      ]);
      markdown = instance.getMarkdown();
    }
    expect(result.sources[0].text).toBe(parsed.text);
  });

  it("retains the complete extracted Word source when its editable note is shortened", async () => {
    const { parsed, result } = await payload([new Paragraph("Complete original Word paragraph. ".repeat(6_500)), new Paragraph("Final source sentinel")]);
    expect(parsed.text.length).toBeGreaterThan(200_000);
    expect(result.sources[0].text).toContain("Final source sentinel");
    expect(result.notes[0].body).toContain(IMPORT_NOTE_TRUNCATION_NOTICE);
    expect(result.notes[0].body).not.toContain("Final source sentinel");
  });

  it.each([false, true])("exports and reimports a table with header=%s without false Word header flags", async (header) => {
    const snapshot = createEmptySnapshot("Word table roundtrip", "2026-10-11T00:00:00Z");
    const body = header ? "| Heading | Other |\n| --- | --- |\n| First | A |\n| Second | B |"
      : '<!-- orion-table:v1 {"header":false} -->\n| | |\n| --- | --- |\n| First | A |\n| Second | B |';
    snapshot.notes = [{ id: "table-note", title: "Table note", slug: "table-note", body, summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: snapshot.updatedAt, updatedAt: snapshot.updatedAt }];
    const exported = await buildWordExportDocument(snapshot, "note", "table-note");
    const { parsed, result } = await importBytes(Uint8Array.from(exported.bytes).buffer);
    const html = new DOMParser().parseFromString(probe.html[0], "text/html");
    expect(html.querySelectorAll("th")).toHaveLength(header ? 2 : 0);
    expect(html.querySelectorAll("td")).toHaveLength(4);
    expect(parsed.warnings).not.toContain("Multiple Word table header rows were reduced to one; all row content was kept.");
    let markdown = result.notes[0].body;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const instance = editor(markdown), table = nodes(instance.state.doc, "table")[0];
      expect(table.childCount).toBe(header ? 3 : 2);
      expect(table.firstChild?.firstChild?.type.name).toBe(header ? "tableHeader" : "tableCell");
      expect(table.child(header ? 1 : 0).textContent).toBe("FirstA");
      expect(table.child(header ? 2 : 1).textContent).toBe("SecondB");
      markdown = instance.getMarkdown();
    }
  });
});
