import { describe, expect, it } from "vitest";
import {
  delimitedRowsToMarkdown,
  detectSourceKind,
  parseDelimitedText,
  parseTextImport,
} from "./files";

describe("import file helpers", () => {
  it("detects supported formats from extensions and MIME types", () => {
    expect(detectSourceKind("notes.md", "")).toBe("markdown");
    expect(detectSourceKind("scan", "application/pdf")).toBe("pdf");
    expect(
      detectSourceKind(
        "brief.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(detectSourceKind("photo.png", "image/png")).toBeNull();
  });

  it("parses quoted CSV values and converts them to Markdown", () => {
    const rows = parseDelimitedText(
      'Name,Notes\nOrion,"hunter, constellation"\nM42,"line one\nline two"',
    );

    expect(rows).toEqual([
      ["Name", "Notes"],
      ["Orion", "hunter, constellation"],
      ["M42", "line one\nline two"],
    ]);
    expect(delimitedRowsToMarkdown(rows)).toContain(
      "| Orion | hunter, constellation |",
    );
    expect(delimitedRowsToMarkdown(rows)).toContain("line one<br>line two");
  });

  it("uses a JSON title and preserves structured content", () => {
    const parsed = parseTextImport(
      "export.json",
      "application/json",
      '{"title":"Field Atlas","items":["Orion","Artemis"]}',
    );

    expect(parsed.title).toBe("Field Atlas");
    expect(parsed.format).toBe("json");
    expect(parsed.text).toContain('"items": [');
  });

  it("extracts readable HTML and ignores scripts", () => {
    const parsed = parseTextImport(
      "page.html",
      "text/html",
      "<html><head><title>Night Atlas</title><script>bad()</script></head><body><h1>Orion</h1><p>A winter landmark.</p></body></html>",
    );

    expect(parsed.title).toBe("Night Atlas");
    expect(parsed.text).toContain("# Orion");
    expect(parsed.text).toContain("A winter landmark.");
    expect(parsed.text).not.toContain("bad()");
  });
});
