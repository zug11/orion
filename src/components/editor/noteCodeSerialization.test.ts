// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, describe, expect, it } from "vitest";
import { NoteBlock } from "./NoteBlock";
import { NoteMarkdown, NoteMargins } from "./NoteMargins";
import { NoteStarterKit } from "./NoteStarterKit";
import { NoteTable } from "./NoteTable";
import { remarkNoteBlocks } from "../../lib/noteBlocks";
import { remarkNoteMargins } from "../../lib/noteMargins";
import { remarkNoteTableMetadata } from "../../lib/noteTables";
import { canSerializeInlineCode, serializeInlineCode, serializeWithLiteralCode, TABLE_CODE_JOIN } from "../../lib/noteCodeSerialization";
import { buildWebExportDocument } from "../../lib/webExport";
import { createEmptySnapshot } from "../../data/defaults";

const editors: Editor[] = [];
function create(content: JSONContent | string) {
  const editor = new Editor({
    extensions: [NoteStarterKit.configure({ link: { protocols: ["orion-note", "orion-concept", "orion-source"] } }),
      TableKit.configure({ table: false }), NoteTable, NoteBlock, NoteMargins,
      NoteMarkdown.configure({ markedOptions: { gfm: true } })],
    content, ...(typeof content === "string" ? { contentType: "markdown" as const } : {}),
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  return editor;
}
afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()));

const text = (value: string, marks?: JSONContent["marks"]): JSONContent => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
function roundTrip(content: JSONContent) {
  let editor = create(content);
  const original = editor.getJSON();
  const markdown = editor.getMarkdown();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    editor = create(editor.getMarkdown());
    expect(editor.getJSON(), `reopen ${cycle + 1}: ${markdown}`).toEqual(original);
    expect(editor.getMarkdown()).toBe(markdown);
  }
  // The read surface/export use remark rather than Tiptap's Marked parser.
  // Match every code element's exact characters, not just concatenated prose.
  const rendered = document.createElement("div");
  rendered.innerHTML = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [remarkGfm, remarkNoteBlocks, remarkNoteMargins, remarkNoteTableMetadata], children: markdown,
  }));
  const expectedCode: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "codeBlock") { expectedCode.push(node.textContent ? `${node.textContent}\n` : ""); return false; }
    if (node.isText && node.marks.some((mark) => mark.type.name === "code")) expectedCode.push(node.text!);
  });
  expect(Array.from(rendered.querySelectorAll("code"), (element) => element.textContent)).toEqual(expectedCode);
  const expectedCells: string[] = [];
  editor.state.doc.descendants((node) => {
    if (["tableHeader", "tableCell"].includes(node.type.name)) { expectedCells.push(node.textContent); return false; }
  });
  expect(Array.from(rendered.querySelectorAll("th,td"), (element) => element.textContent)).toEqual(expectedCells);
  return { editor, markdown };
}
function documentWith(content: JSONContent[]): JSONContent {
  return { type: "doc", attrs: { marginLeft: 4, marginRight: 7 }, content };
}
function tableWith(value: string, code: boolean): JSONContent {
  return { type: "table", attrs: { tableWidth: 74, banded: false }, content: [
    { type: "tableRow", content: ["Code", "Neighbour"].map((label, index) => ({ type: "tableHeader", attrs: { colwidth: [index ? 220 : 127] }, content: [paragraph([text(label)])] })) },
    { type: "tableRow", content: [
      { type: "tableCell", attrs: { colwidth: [127] }, content: [paragraph([text(value, code ? [{ type: "code" }] : undefined)])] },
      { type: "tableCell", attrs: { colwidth: [220] }, content: [paragraph([text("Unaffected", [{ type: "bold" }])])] },
    ] },
  ] };
}

describe("literal code serialization", () => {
  it.each(["tick ` here", "`", "``", "at `` the ` edge```", " careful", "careful ", " careful ",
    "\tcareful", "careful\t", " ", "   ", "\t", " \t ", "\u00a0careful\u00a0", "\uFEFFcareful\uFEFF", "<&nbsp;> \\ literal"])(
    "preserves inline code %j and surrounding marks through three reopens", (value) => {
      roundTrip(documentWith([{ type: "noteBlock", content: [
        paragraph([text("Before", [{ type: "italic" }]), text(" "), text(value, [{ type: "code" }]),
          text(" "), text("after", [{ type: "bold" }]), text(" "), text("note", [{ type: "link", attrs: { href: "orion-note://n1", title: "unchanged" } }])]),
      ] }]));
    });

  it.each(["tick ` here", "`", "``", " careful ", "\tcareful\t", "   ", " \t ", "\uFEFF", "a | b", "a\\\\|b",
    "a\\|b", "a\\\\\\|b", "`a\\|b` ", "\\|\\|\\\\|", TABLE_CODE_JOIN])(
    "preserves table code %j and table layout through three reopens", (value) => {
      roundTrip(documentWith([tableWith(value, true), paragraph([text("After.")])]));
    });

  it.each(["a|b", "a\\|b", "a\\\\|b", "a\\\\\\|b", "a &#124; b"])(
    "preserves literal table text %j without creating columns", (value) => {
      roundTrip(documentWith([tableWith(value, false), paragraph([text("After.")])]));
    });

  it.each(["before\n```\nafter", "````\n~~~\n`````", "first\n\nlast\n", " \t \n", "<!-- /orion-block -->\n```"])(
    "preserves fenced code %j inside a writing block", (value) => {
      roundTrip(documentWith([{ type: "noteBlock", content: [
        { type: "codeBlock", attrs: { language: "markdown" }, content: [text(value)] }, paragraph([text("After.")]),
      ] }]));
    });

  it("preserves adjacent code runs, outer marks and exact link attributes", () => {
    const link = { type: "link", attrs: { href: "https://example.com/path?q=a&second=b", title: "A `title`" } };
    roundTrip(documentWith([paragraph([
      text("literal ` "), text("first ", [{ type: "code" }]), text("second", [{ type: "code" }]),
      text("nested `code`", [link, { type: "bold" }, { type: "code" }]),
      text("other", [{ type: "italic" }, { type: "code" }]), text(" "), text("rest", [link]), text(" ` end"),
    ])]));
  });

  it("keeps all-space inline code as actual code even when alone in a paragraph", () => {
    roundTrip(documentWith([paragraph([text("   ", [{ type: "code" }])])]));
  });

  it("keeps an empty code block and adjacent ordinary formatting", () => {
    roundTrip(documentWith([{ type: "codeBlock", content: [] }, paragraph([
      text("bold", [{ type: "bold" }]), text(" and "), text("strike", [{ type: "strike" }]),
    ])]));
  });

  it("keeps authored sentinel-looking characters, including inside code and attributes", () => {
    const value = "\uE000ORION0:0\uE001 \uE000ORION1:5\uE001";
    roundTrip(documentWith([paragraph([text(value), text(value, [{ type: "code" }]),
      text("linked", [{ type: "link", attrs: { href: "https://example.com", title: "\uE000ORION2:3\uE001" } }])])]));
  });

  it("does not mutate input JSON and does not recursively substitute restored literal content", () => {
    const original = documentWith([paragraph([text("\uE000ORION0:0\uE001 ", [{ type: "code" }])])]);
    const freeze = (value: unknown) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } };
    freeze(original);
    const before = JSON.stringify(original);
    const rendered = serializeWithLiteralCode(original, (copy) => copy.content![0].content![0].text!);
    expect(rendered).toBe(serializeInlineCode("\uE000ORION0:0\uE001 "));
    expect(JSON.stringify(original)).toBe(before);
    expect(serializeWithLiteralCode({ type: "doc", content: [] }, () => "")).toBe("");
    expect(serializeInlineCode("")).toBe("");
  });

  it("fails closed if a renderer drops or duplicates its transient literal placeholder", () => {
    const original = documentWith([paragraph([text("code", [{ type: "code" }])])]);
    expect(() => serializeWithLiteralCode(original, () => "")).toThrow("serialized safely");
    expect(() => serializeWithLiteralCode(original, (copy) => copy.content![0].content![0].text!.repeat(2))).toThrow("serialized safely");
  });

  it("reports inline line endings as lossy without introducing an autosave exception", () => {
    for (const value of ["a\nb", "a\rb", "a\r\nb"]) {
      expect(canSerializeInlineCode(value)).toBe(false);
      expect(serializeInlineCode(value)).toBe("`a b`");
    }
  });

  it("uses a portable join only for an odd literal backslash run before a table-code pipe", () => {
    for (const value of ["a\\|b", "a\\\\\\|b"]) {
      expect(canSerializeInlineCode(value, true)).toBe(true);
      expect(canSerializeInlineCode(value, false)).toBe(true);
      expect(serializeInlineCode(value, true)).toContain(TABLE_CODE_JOIN);
      expect(serializeInlineCode(value)).not.toContain(TABLE_CODE_JOIN);
    }
    expect(serializeInlineCode("a\\\\|b", true)).not.toContain(TABLE_CODE_JOIN);
    expect(serializeInlineCode("a|b", true)).not.toContain(TABLE_CODE_JOIN);
  });

  it("does not consume authored comments or malformed joins outside the exact table-code triple", () => {
    type Ast = { type: string; value?: string; children?: Ast[] };
    const code = (value: string): Ast => ({ type: "inlineCode", value });
    const comment = (value = TABLE_CODE_JOIN): Ast => ({ type: "html", value });
    const original: Ast = { type: "root", children: [
      { type: "paragraph", children: [code("a"), comment(), code("b")] },
      { type: "table", children: [
        { type: "tableCell", children: [code("a"), comment(), { type: "text", value: "b" }] },
        { type: "tableCell", children: [comment(), code("a")] },
        { type: "tableCell", children: [code("a"), comment()] },
        { type: "tableCell", children: [code("a"), comment("<!-- other -->"), code("b")] },
        { type: "tableCell", children: [code(TABLE_CODE_JOIN)] },
      ] },
    ] };
    const before = JSON.stringify(original);
    remarkNoteTableMetadata()(original);
    expect(JSON.stringify(original)).toBe(before);
  });

  it("exports joined table-code text and literal code markers without exposing or duplicating metadata", () => {
    const value = " \\|first` and \\\\\\|second ";
    const { markdown } = roundTrip(documentWith([tableWith(value, true), paragraph([text(TABLE_CODE_JOIN, [{ type: "code" }])])]));
    const snapshot = createEmptySnapshot("Code export", "2026-10-11T00:00:00Z");
    snapshot.notes = [{ id: "code-note", title: "Code note", body: markdown, slug: "code-note", summary: "", aliases: [], tags: [],
      kind: "article", status: "ready", sourceIds: [], conceptIds: [], createdAt: "2026-10-11T00:00:00Z", updatedAt: "2026-10-11T00:00:00Z" }];
    const exported = buildWebExportDocument(snapshot, "note", "code-note");
    const html = new DOMParser().parseFromString(exported.html, "text/html");
    expect(Array.from(html.querySelectorAll(".export-prose code"), (node) => node.textContent)).toEqual([value, TABLE_CODE_JOIN]);
  });
});
