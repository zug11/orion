import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  delimitedRowsToMarkdown,
  detectSourceKind,
  parseImportFile,
  parseDelimitedText,
  parseTextImport,
} from "./files";

const pdfState = vi.hoisted(() => ({ pages: [] as string[] }));
const destroyPdf = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "test-pdf-worker" },
  getDocument: () => ({
    promise: Promise.resolve({
      get numPages() {
        return pdfState.pages.length;
      },
      getPage: async (pageNumber: number) => ({
        getTextContent: async () => ({
          items: pdfState.pages[pageNumber - 1]
            ? [
                {
                  str: pdfState.pages[pageNumber - 1],
                  hasEOL: true,
                },
              ]
            : [],
        }),
      }),
    }),
    destroy: destroyPdf,
  }),
}));

describe("import file helpers", () => {
  beforeEach(() => {
    pdfState.pages = [];
    destroyPdf.mockClear();
  });

  it("detects supported formats from extensions and MIME types", () => {
    expect(detectSourceKind("notes.md", "")).toBe("markdown");
    expect(detectSourceKind("scan", "application/pdf")).toBe("pdf");
    expect(
      detectSourceKind(
        "brief.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
    expect(detectSourceKind("photo.png", "image/png")).toBe("image");
    expect(detectSourceKind("photo.JPG", "")).toBe("image");
    expect(detectSourceKind("whiteboard.heic", "")).toBe("image");
  });

  it("uses local text recognition for image imports", async () => {
    const recognize = vi.fn().mockResolvedValue({
      text: "A photographed whiteboard plan",
      pageCount: 1,
      pages: [{ pageNumber: 1, text: "A photographed whiteboard plan" }],
      warnings: ["One line was faint."],
    });
    const file = new File([new Uint8Array([1, 2, 3])], "board.heic", {
      type: "image/heic",
    });

    await expect(parseImportFile(file, recognize)).resolves.toMatchObject({
      title: "Board",
      format: "image",
      text: "A photographed whiteboard plan",
      warnings: ["One line was faint."],
    });
    expect(recognize).toHaveBeenCalledWith(file);
  });

  it("preserves an image MIME type when WebKit omits it", async () => {
    const recognize = vi.fn().mockResolvedValue({
      text: "Recognized HEIC text",
      pageCount: 1,
      pages: [{ pageNumber: 1, text: "Recognized HEIC text" }],
      warnings: [],
    });
    const file = new File([new Uint8Array([1])], "board.heic");

    const parsed = await parseImportFile(file, recognize);

    expect(parsed.mimeType).toBe("image/heic");
  });

  it("keeps selectable-text PDFs on the pdf.js fast path", async () => {
    pdfState.pages = [
      "This ordinary PDF contains enough selectable words to import directly.",
    ];
    const recognize = vi.fn();
    const file = new File(["pdf"], "paper.pdf", {
      type: "application/pdf",
    });

    const parsed = await parseImportFile(file, recognize);

    expect(parsed.text).toContain("This ordinary PDF contains");
    expect(recognize).not.toHaveBeenCalled();
  });

  it("falls back to local text recognition for scanned PDFs", async () => {
    pdfState.pages = [""];
    const recognize = vi.fn().mockResolvedValue({
      text: "Scanned page text",
      pageCount: 1,
      pages: [{ pageNumber: 1, text: "Scanned page text" }],
      warnings: [],
    });
    const file = new File(["pdf"], "scan.pdf", {
      type: "application/pdf",
    });

    const parsed = await parseImportFile(file, recognize);

    expect(recognize).toHaveBeenCalledOnce();
    expect(parsed.format).toBe("pdf");
    expect(parsed.text).toBe("## Page 1\n\nScanned page text");
    expect(parsed.warnings[0]).toMatch(/on-device text recognition/i);
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
