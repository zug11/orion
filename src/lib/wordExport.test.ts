// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { serializeNoteImageTitle } from "./noteImageLayout";
import { buildWordExportDocument } from "./wordExport";
import { docxHtmlToMarkdown } from "./docxImport";

const NOW = "2026-10-01T10:00:00Z";
const PIXEL = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const note = (id: string, title: string, body: string): Note => ({ id, title, body, slug: id, summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: NOW, updatedAt: NOW });

function fixture() {
  const snapshot = createEmptySnapshot("Research room", NOW);
  snapshot.workspace.description = "A selected collection.";
  snapshot.notes = [
    note("origin", "Origin & evidence", [
      "## Important heading",
      "A **bold** claim with *emphasis*, ~~revised~~ words and `code`.",
      "",
      "Justified text. <!-- orion-text:v1 justify -->",
      "",
      "- [ ] Read the source",
      "- [x] Record the result",
      "",
      "3. Third item",
      "4. Fourth item",
      "",
      "> A preserved quotation.",
      "",
      "```js",
      "const answer = 42;",
      "console.log(answer);",
      "```",
      "",
      "| Concept | Value |",
      "| :--- | ---: |",
      "| First | 42 |",
      "",
      "[Linked article](orion-note://linked), [Other Space](orion-note://foreign), [public](https://example.com/public).",
      "",
      "Claim [Source](orion-source://source).",
      "",
      '<script>private_script_secret()</script>',
    ].join("\n")),
    note("linked", "Linked article", "Linked body. [One more hop](orion-note://second-hop)."),
    note("second-hop", "Second hop", "DO_NOT_INCLUDE_SECOND_HOP"),
    note("unrelated", "Unrelated", "DO_NOT_INCLUDE_UNRELATED"),
  ];
  snapshot.sources = [{ id: "source", title: "Public source title", kind: "pdf", importedAt: NOW, sourceUrl: "https://example.com/source", fileName: "private-source-filename.pdf", text: "PRIVATE_RAW_SOURCE_BODY", noteIds: ["origin"] }];
  return snapshot;
}

async function unpack(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")!.async("string");
  return { zip, xml, document: new DOMParser().parseFromString(xml, "application/xml"), rels: await zip.file("word/_rels/document.xml.rels")!.async("string") };
}

describe("Word export", () => {
  it("writes body and paragraph margins as scoped Word indents while preserving lists and quotes", async () => {
    const snapshot = fixture();
    const margins = "<!-- orion-paragraph-margins:v1 10 5 -->";
    snapshot.notes[0].body = `<!-- orion-document-margins:v1 10 20 -->\n\nOrdinary paragraph.\n\nSelected paragraph. ${margins}\n\n### Selected heading ${margins}\n\n- Selected bullet. ${margins}\n\n- [ ] Selected task. ${margins}\n\n> Selected quotation. ${margins}\n\n| Column |\n| --- |\n| Cell |\n\n[Linked](orion-note://linked)`;
    const { document, xml } = await unpack((await buildWordExportDocument(snapshot, "linked", "origin")).bytes);
    const paragraphs = [...document.getElementsByTagNameNS(W, "p")];
    const paragraph = (text: string) => paragraphs.find((p) => p.textContent === text)!;
    const indent = (text: string) => {
      const value = paragraph(text).getElementsByTagNameNS(W, "ind")[0];
      return value ? { left: value.getAttributeNS(W, "left"), right: value.getAttributeNS(W, "right"), hanging: value.getAttributeNS(W, "hanging") } : null;
    };
    expect(indent("Ordinary paragraph.")).toEqual({ left: "936", right: "1872", hanging: null });
    expect(indent("Selected paragraph.")).toEqual({ left: "1591", right: "2200", hanging: null });
    expect(indent("Selected heading")).toEqual({ left: "1591", right: "2200", hanging: null });
    expect(indent("Selected bullet.")).toEqual({ left: "1915", right: "2182", hanging: "240" });
    expect(paragraph("Selected bullet.").getElementsByTagNameNS(W, "numPr")).toHaveLength(1);
    const task = paragraphs.find((p) => p.textContent?.endsWith("Selected task."))!;
    expect(task.getElementsByTagNameNS(W, "ind")[0].getAttributeNS(W, "left")).toBe("1591");
    expect(task.getElementsByTagNameNS(W, "ind")[0].getAttributeNS(W, "right")).toBe("2200");
    expect(task.getElementsByTagNameNS(W, "numPr")).toHaveLength(0);
    expect(indent("Selected quotation.")).toEqual({ left: "1897", right: "2353", hanging: null });
    expect(indent("Origin & evidence")).toBeNull();
    expect(indent("Linked body. One more hop.")).toBeNull();
    expect(indent("Cell")).toBeNull();
    const table = document.getElementsByTagNameNS(W, "tbl")[0];
    expect(table.getElementsByTagNameNS(W, "tblW")[0].getAttributeNS(W, "w")).toBe("6552");
    expect(table.getElementsByTagNameNS(W, "tblInd")[0].getAttributeNS(W, "w")).toBe("936");
    expect(xml).not.toContain("orion-paragraph-margins");
    expect(xml).not.toContain("orion-document-margins");
  });

  it("writes editable structures, live scoped links and public citations without leaking excluded data", async () => {
    const output = await buildWordExportDocument(fixture(), "linked", "origin");
    expect(output.noteIds).toEqual(["origin", "linked"]);
    expect(output.fileName).toBe("origin-evidence.docx");
    const { zip, xml, document, rels } = await unpack(output.bytes);
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.getElementsByTagNameNS(W, "tbl")).toHaveLength(1);
    expect(document.getElementsByTagNameNS(W, "tc")).toHaveLength(4);
    expect(xml).toContain('w:val="Heading2"');
    expect(xml).toContain('w:val="both"');
    expect(xml).toContain('w14:checkbox');
    expect(xml).toContain('w14:checked w14:val="1"');
    expect(xml).toContain('w14:checked w14:val="0"');
    expect(xml).toContain('w:numPr');
    expect(xml).toContain('w:b');
    expect(xml).toContain('w:i');
    expect(xml).toContain('w:strike');
    expect(xml).toContain('w:anchor="orion_');
    expect(xml).toContain("Public source title");
    expect(xml).toContain("const answer = 42;");
    expect(rels).toContain("https://example.com/public");
    expect(rels).toContain("https://example.com/source");
    const allXml = (await Promise.all(Object.values(zip.files).filter((entry) => /\.(xml|rels)$/.test(entry.name)).map((entry) => entry.async("string")))).join("\n");
    for (const excluded of ["PRIVATE_RAW_SOURCE_BODY", "private-source-filename.pdf", "DO_NOT_INCLUDE_SECOND_HOP", "DO_NOT_INCLUDE_UNRELATED", "private_script_secret", "orion-note://", "orion-source://", "apiKey", "windowGlass"]) expect(allXml).not.toContain(excluded);
    expect(xml).toContain("Other Space");
    expect(rels).not.toContain("foreign");
  });

  it("embeds managed images, bounded free layouts and captions without retaining attachment URLs", async () => {
    const snapshot = fixture();
    const title = serializeNoteImageTitle({ placement: "wrap", xPercent: 12, offsetY: 2000, widthPercent: 55, caption: "Figure one with <literal> characters", showCaption: true });
    snapshot.notes[0].body = `<!-- orion-document-margins:v1 20 10 -->\n\nText before.\n\n![Meaningful description](orion-image://localhost/image_123456789 "${title}")\n\nText after.`;
    const loadImage = vi.fn().mockResolvedValue({ type: "png", bytes: PIXEL, width: 900, height: 600 });
    const output = await buildWordExportDocument(snapshot, "note", "origin", { loadImage });
    const { zip, xml, document } = await unpack(output.bytes);
    expect(loadImage).toHaveBeenCalledWith("orion-image://localhost/image_123456789");
    const images = Object.keys(zip.files).filter((name) => name.startsWith("word/media/") && !zip.files[name].dir);
    expect(images).toHaveLength(1);
    expect(await zip.file(images[0])!.async("uint8array")).toEqual(PIXEL);
    expect(xml).toContain("Figure one with &lt;literal&gt; characters");
    expect(xml).toContain("Meaningful description");
    expect(xml).toContain("wp:inline");
    expect(xml).not.toContain("wp:anchor");
    expect(xml).not.toContain("orion-image://");
    expect(xml).not.toContain("orion-image-layout");
    expect(xml.indexOf("Text before")).toBeLessThan(xml.indexOf("wp:inline"));
    expect(xml.indexOf("wp:inline")).toBeLessThan(xml.indexOf("Text after"));
    const drawing = document.getElementsByTagNameNS(W, "drawing")[0];
    const imageParagraph = drawing.parentElement!.parentElement!;
    expect(imageParagraph.getElementsByTagNameNS(W, "ind")[0].getAttributeNS(W, "left")).toBe("1872");
    expect(imageParagraph.getElementsByTagNameNS(W, "ind")[0].getAttributeNS(W, "right")).toBe("936");
    const extent = drawing.getElementsByTagNameNS("http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "extent")[0];
    expect(Number(extent.getAttribute("cx"))).toBe(240 * 9525);
  });

  it("rejects missing managed images and never asks an image loader to access the network", async () => {
    const snapshot = fixture();
    snapshot.notes[0].body = "![Remote alternative](https://example.com/tracking.png)";
    const loadImage = vi.fn().mockRejectedValue(new Error("The managed image is missing."));
    const output = await buildWordExportDocument(snapshot, "note", "origin", { loadImage });
    expect(loadImage).not.toHaveBeenCalled();
    expect((await unpack(output.bytes)).xml).toContain("Image: Remote alternative");
    snapshot.notes[0].body = "![Missing](orion-image://localhost/image_123456789)";
    await expect(buildWordExportDocument(snapshot, "note", "origin", { loadImage })).rejects.toThrow("missing");
  });

  it("builds a Space cover, page boundaries and all selected notes, and rejects an empty scope", async () => {
    const snapshot = fixture();
    const output = await buildWordExportDocument(snapshot, "space", null);
    expect(output.noteIds).toHaveLength(4);
    const { xml, document } = await unpack(output.bytes);
    expect(xml).toContain("Research room");
    expect(document.getElementsByTagNameNS(W, "pageBreakBefore")).toHaveLength(4);
    await expect(buildWordExportDocument(snapshot, "note", "foreign")).rejects.toThrow("Open a note");
  });

  it("round-trips authored headings, lists, task state and tables through the real DOCX importer", async () => {
    const output = await buildWordExportDocument(fixture(), "note", "origin");
    const { default: mammoth } = await import("mammoth");
    const html = await mammoth.convertToHtml({ buffer: Buffer.from(output.bytes) }, { includeEmbeddedStyleMap: false, styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Code'] => pre:fresh", "p[style-name='Quote'] => blockquote > p:fresh", "r[style-name='Inline code'] => code"] });
    const markdown = docxHtmlToMarkdown(html.value);
    expect(markdown).toContain("# Origin & evidence");
    expect(markdown).toContain("## Important heading");
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("- [ ] Read the source");
    expect(markdown).toContain("- [x] Record the result");
    expect(markdown).toContain("| **Concept** | **Value** |");
    expect(markdown).toContain("> *A preserved quotation.*");
    expect(markdown).toContain("```\nconst answer = 42;\nconsole.log(answer);\n```");
    expect(markdown).toContain("https://example.com/public");
  });
});
