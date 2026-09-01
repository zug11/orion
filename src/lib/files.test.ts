import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  delimitedRowsToMarkdown,
  detectSourceKind,
  pdfVisionOcrReason,
  parseImportFile,
  parseDelimitedText,
  normalizePdfPages,
  parseTextImport,
  shouldUsePdfVisionText,
} from "./files";

const pdfState = vi.hoisted(() => ({
  pages: [] as string[],
  beforeRead: undefined as ((pageNumber: number) => Promise<void>) | undefined,
}));
const destroyPdf = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: { workerSrc: "test-pdf-worker" },
  getDocument: () => {
    const { pages, beforeRead } = pdfState;
    return {
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (pageNumber: number) => ({
          getTextContent: async () => {
            await beforeRead?.(pageNumber);
            return {
              items: pages[pageNumber - 1]
                ? [{ str: pages[pageNumber - 1], hasEOL: true }]
                : [],
            };
          },
        }),
      }),
      destroy: destroyPdf,
    };
  },
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("import file helpers", () => {
  beforeEach(() => {
    pdfState.pages = [];
    pdfState.beforeRead = undefined;
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

  it("reads four PDF pages concurrently while retaining physical order and exact OCR selection", async () => {
    pdfState.pages = Array.from({ length: 7 }, (_, index) =>
      index === 1 || index === 5
        ? ""
        : `Physical page ${index + 1} supplies enough readable embedded source text.`,
    );
    const pending = new Map<number, ReturnType<typeof deferred>>();
    pdfState.beforeRead = (pageNumber) => {
      const gate = deferred();
      pending.set(pageNumber, gate);
      return gate.promise;
    };
    const recognize = vi.fn().mockResolvedValue({
      text: "Recognized text",
      pageCount: 7,
      pages: [
        {
          pageNumber: 2,
          text: "The second physical page was recovered by local recognition.",
        },
        {
          pageNumber: 6,
          text: "The sixth physical page was recovered by local recognition.",
        },
      ],
      warnings: [],
    });
    const file = new File(["pdf"], "parallel.pdf", { type: "application/pdf" });
    const parsing = parseImportFile(file, recognize);

    await vi.waitFor(() => expect([...pending.keys()]).toEqual([1, 2, 3, 4]));
    pending.get(4)!.resolve();
    await vi.waitFor(() => expect(pending.has(5)).toBe(true));
    pending.get(3)!.resolve();
    await vi.waitFor(() => expect(pending.has(6)).toBe(true));
    pending.get(2)!.resolve();
    await vi.waitFor(() => expect(pending.has(7)).toBe(true));
    expect(recognize).not.toHaveBeenCalled();
    for (const gate of pending.values()) gate.resolve();

    const parsed = await parsing;
    expect(parsed.text.match(/^## Page \d+/gm)).toEqual(
      Array.from({ length: 7 }, (_, index) => `## Page ${index + 1}`),
    );
    expect(parsed.text).toContain("## Page 2\n\nThe second physical page");
    expect(parsed.text).toContain("## Page 6\n\nThe sixth physical page");
    expect(recognize).toHaveBeenCalledWith(file, { pageNumbers: [2, 6] });
    expect(destroyPdf).toHaveBeenCalledOnce();
  });

  it("shares four PDF extraction slots across documents without blocking plain text", async () => {
    pdfState.pages = Array.from({ length: 8 }, (_, index) =>
      `Page ${index + 1} has a complete sentence of useful selectable document text.`,
    );
    const release = deferred();
    let active = 0;
    let maximum = 0;
    let started = 0;
    pdfState.beforeRead = async () => {
      started += 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await release.promise;
      active -= 1;
    };
    const first = parseImportFile(
      new File(["pdf"], "first.pdf", { type: "application/pdf" }),
    );
    await vi.waitFor(() => expect(started).toBe(4));
    const second = parseImportFile(
      new File(["pdf"], "second.pdf", { type: "application/pdf" }),
    );
    const text = await parseImportFile(
      new File(["Plain text is ready independently."], "notes.txt", {
        type: "text/plain",
      }),
    );
    expect(text.text).toBe("Plain text is ready independently.");
    expect(started).toBe(4);
    release.resolve();

    const documents = await Promise.all([first, second]);
    expect(maximum).toBe(4);
    expect(started).toBe(16);
    expect(
      documents.every((document) => document.text.includes("## Page 8")),
    ).toBe(true);
    expect(destroyPdf).toHaveBeenCalledTimes(2);
  });

  it("drains live PDF reads after a page failure before destroying the document", async () => {
    pdfState.pages = Array.from(
      { length: 8 },
      () => "A complete page of selectable source text.",
    );
    const pending = new Map<number, ReturnType<typeof deferred>>();
    pdfState.beforeRead = (pageNumber) => {
      const gate = deferred();
      pending.set(pageNumber, gate);
      return gate.promise;
    };
    const parsing = parseImportFile(
      new File(["pdf"], "broken.pdf", { type: "application/pdf" }),
    );
    await vi.waitFor(() => expect(pending.size).toBe(4));
    pending.get(2)!.reject(new Error("Page stream is damaged"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(destroyPdf).not.toHaveBeenCalled();
    expect([...pending.keys()]).toEqual([1, 2, 3, 4]);
    for (const [pageNumber, gate] of pending) {
      if (pageNumber !== 2) gate.resolve();
    }
    await expect(parsing).rejects.toThrow("Page stream is damaged");
    expect(destroyPdf).toHaveBeenCalledOnce();

    pdfState.beforeRead = undefined;
    await expect(
      parseImportFile(
        new File(["pdf"], "next.pdf", { type: "application/pdf" }),
      ),
    ).resolves.toMatchObject({ format: "pdf" });
    expect(destroyPdf).toHaveBeenCalledTimes(2);
  });

  it("surfaces a damaged selectable OCR layer when page OCR is unavailable without inventing text", async () => {
    pdfState.pages = [
      `A readable scanned paragraph ${"�".repeat(30)} remains source text.`,
    ];
    const parsed = await parseImportFile(
      new File(["pdf"], "damaged.pdf", { type: "application/pdf" }),
    );

    expect(parsed.text).toContain("�".repeat(30));
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/page recognition is available in the installed Orion desktop app/i),
      expect.stringMatching(/embedded selectable-text layer contains 30 damaged glyphs/i),
    ]));
  });

  it("selects only textless or materially damaged PDF pages for Vision", () => {
    expect(pdfVisionOcrReason("")).toBe("textless");
    expect(pdfVisionOcrReason("Cover title")).toBeNull();
    expect(
      pdfVisionOcrReason(
        "This ordinary page has enough readable selectable words for Orion.",
      ),
    ).toBeNull();
    expect(
      pdfVisionOcrReason(
        `This page remains mostly readable despite one uncertain glyph � in its text.`,
      ),
    ).toBeNull();
    expect(
      pdfVisionOcrReason(
        `This damaged page still has readable words ${"�".repeat(5)} around its broken glyphs.`,
      ),
    ).toBe("damaged");
    expect(pdfVisionOcrReason(`${"Readable source words. ".repeat(140)}${"�".repeat(5)}`)).toBeNull();
  });

  it("accepts Vision text only when it materially improves the selected page", () => {
    const damaged = `A philosophical paragraph ${"�".repeat(16)} develops contradiction and mediation in a sustained argument.`;

    expect(
      shouldUsePdfVisionText(
        damaged,
        "A philosophical paragraph develops contradiction and mediation in a sustained argument.",
      ),
    ).toBe(true);
    expect(shouldUsePdfVisionText(damaged, "Tiny fragment")).toBe(false);
    expect(
      shouldUsePdfVisionText(
        damaged,
        "An unrelated candidate of roughly similar size describes astronomy, winter stars, telescopes, and constellations instead.",
      ),
    ).toBe(false);
    expect(
      shouldUsePdfVisionText(
        "An already readable page has enough selectable words for direct import.",
        "Different recognized words should never replace an undamaged page.",
      ),
    ).toBe(false);
  });

  it("removes repeated PDF running heads and dehyphenates line wraps while retaining pages", () => {
    const pages = normalizePdfPages([
      {
        pageNumber: 10,
        text: "8\nAspects of Hegel's Philosophy\nThe dialectical rela-\ntionship remains.",
      },
      {
        pageNumber: 11,
        text: "9\nAspects of Hegel's Philosophy\nIts critical force contin-\nues here.",
      },
      {
        pageNumber: 12,
        text: "10\nAspects of Hegel's Philosophy\nA third page develops it.",
      },
    ]);

    expect(pages).toEqual([
      {
        pageNumber: 10,
        text: "Aspects of Hegel's Philosophy\nThe dialectical relationship remains.",
      },
      {
        pageNumber: 11,
        text: "Its critical force continues here.",
      },
      {
        pageNumber: 12,
        text: "A third page develops it.",
      },
    ]);
  });

  it("falls back to local text recognition for scanned PDFs", async () => {
    pdfState.pages = [""];
    const recognize = vi.fn().mockResolvedValue({
      text: "Scanned page text now contains enough recognized words to import.",
      pageCount: 1,
      pages: [
        {
          pageNumber: 1,
          text: "Scanned page text now contains enough recognized words to import.",
        },
      ],
      warnings: [],
    });
    const file = new File(["pdf"], "scan.pdf", {
      type: "application/pdf",
    });

    const parsed = await parseImportFile(file, recognize);

    expect(recognize).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledWith(file, { pageNumbers: [1] });
    expect(parsed.format).toBe("pdf");
    expect(parsed.text).toBe(
      "## Page 1\n\nScanned page text now contains enough recognized words to import.",
    );
    expect(parsed.warnings[0]).toMatch(/page-selective on-device text recognition/i);
  });

  it("OCRs all selected physical pages in one native call, maps exact page numbers, and preserves good pages", async () => {
    const damaged = `Damaged source ${"�".repeat(12)} still contains a substantial philosophical argument about mediation.`;
    pdfState.pages = [
      "A complete first page has enough selectable text to remain untouched.",
      "",
      damaged,
      "A complete fourth page also remains on the selectable-text fast path.",
    ];
    const recognize = vi.fn().mockResolvedValue({
      text: "",
      pageCount: 4,
      pages: [
        {
          pageNumber: 2,
          text: "The scanned second page now has enough locally recognized words.",
        },
        {
          pageNumber: 3,
          text: "Damaged source still contains a substantial philosophical argument about mediation.",
        },
      ],
      warnings: [],
    });
    const file = new File(["pdf"], "mixed.pdf", {
      type: "application/pdf",
    });

    const parsed = await parseImportFile(file, recognize);

    expect(recognize).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledWith(file, { pageNumbers: [2, 3] });
    expect(parsed.text).toContain(
      "## Page 1\n\nA complete first page has enough selectable text to remain untouched.",
    );
    expect(parsed.text).toContain(
      "## Page 2\n\nThe scanned second page now has enough locally recognized words.",
    );
    expect(parsed.text).toContain(
      "## Page 3\n\nDamaged source still contains a substantial philosophical argument about mediation.",
    );
    expect(parsed.text).toContain(
      "## Page 4\n\nA complete fourth page also remains on the selectable-text fast path.",
    );
    expect(parsed.text).not.toContain("�");
  });

  it("keeps original page text and exact blank-page headings when selected OCR fails or is incomplete", async () => {
    const damaged = `A readable damaged paragraph ${"�".repeat(12)} still preserves its original source argument.`;
    pdfState.pages = [
      "A good opening page has enough words to stay on the fast path.",
      damaged,
      "",
      "A good closing page also has enough words to stay unchanged.",
    ];
    const recognize = vi.fn().mockResolvedValue({
      text: "Tiny fragment",
      pageCount: 4,
      pages: [{ pageNumber: 2, text: "Tiny fragment" }],
      warnings: ["Recognition was low confidence."],
    });

    const parsed = await parseImportFile(
      new File(["pdf"], "partial.pdf", { type: "application/pdf" }),
      recognize,
    );

    expect(parsed.text).toContain(`## Page 2\n\n${damaged}`);
    expect(parsed.text).toContain("## Page 3\n\n## Page 4");
    expect(parsed.text).not.toContain("Tiny fragment");
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/did not materially improve PDF pages 2–3/i),
      "Recognition was low confidence.",
    ]));
  });

  it("uses one selective native call for fully scanned PDFs larger than the old whole-PDF limit", async () => {
    pdfState.pages = Array.from({ length: 51 }, () => "");
    const recognizedPages = Array.from({ length: 51 }, (_, index) => ({
      pageNumber: index + 1,
      text: `Recognized physical page ${index + 1} contains enough words for a faithful local import.`,
    }));
    const recognize = vi.fn().mockResolvedValue({
      text: recognizedPages.map(({ text }) => text).join("\n"),
      pageCount: 51,
      pages: recognizedPages,
      warnings: [],
    });
    const file = new File(["pdf"], "book.pdf", {
      type: "application/pdf",
    });

    const parsed = await parseImportFile(file, recognize);

    expect(recognize).toHaveBeenCalledOnce();
    expect(recognize).toHaveBeenCalledWith(file, {
      pageNumbers: Array.from({ length: 51 }, (_, index) => index + 1),
    });
    expect(parsed.text).toContain("## Page 1\n\nRecognized physical page 1");
    expect(parsed.text).toContain("## Page 51\n\nRecognized physical page 51");
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/pages 1–51/i),
    ]));
  });

  it("keeps mixed selectable pages when the selective native batch fails", async () => {
    pdfState.pages = [
      "A healthy selectable page contains enough source words to preserve.",
      "",
    ];
    const recognize = vi.fn().mockRejectedValue(new Error("Vision batch failed"));

    const parsed = await parseImportFile(
      new File(["pdf"], "mixed-failure.pdf", { type: "application/pdf" }),
      recognize,
    );

    expect(parsed.text).toBe(
      "## Page 1\n\nA healthy selectable page contains enough source words to preserve.\n\n## Page 2",
    );
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/failed for PDF page 2/i),
      expect.stringMatching(/Vision batch failed/i),
    ]));
  });

  it("rejects a fully textless PDF when selective recognition is unavailable or fails", async () => {
    pdfState.pages = ["", ""];
    const file = new File(["pdf"], "unreadable.pdf", {
      type: "application/pdf",
    });

    await expect(parseImportFile(file)).rejects.toThrow(/installed Orion desktop app/i);
    await expect(
      parseImportFile(
        file,
        vi.fn().mockRejectedValue(new Error("Vision could not read the scan")),
      ),
    ).rejects.toThrow(/Vision could not read the scan/i);
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
