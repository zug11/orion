import type {
  ImportDraft,
  ParsedImport,
  RecognizedDocumentText,
  SourceKind,
} from "../types";

export const SUPPORTED_IMPORT_EXTENSIONS = [
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".pdf",
  ".docx",
  ".png",
  ".jpg",
  ".jpeg",
  ".heic",
  ".heif",
] as const;

export const IMPORT_ACCEPT =
  ".txt,.md,.markdown,.json,.csv,.tsv,.html,.htm,.pdf,.docx,.png,.jpg,.jpeg,.heic,.heif,text/plain,text/markdown,text/csv,text/html,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/heic,image/heif";

export interface DocumentTextRecognitionOptions {
  pageNumbers?: number[];
}

export type DocumentTextRecognizer = (
  file: File,
  options?: DocumentTextRecognitionOptions,
) => Promise<RecognizedDocumentText>;

export type PdfVisionOcrReason = "textless" | "damaged";

// PDF text extraction shares a small local pool across documents. It never
// consumes an AI-provider slot or waits for OCR/media transcription.
const PDF_TEXT_EXTRACTION_WIDTH = 4;
let activePdfTextExtractions = 0;
const waitingPdfTextExtractions: Array<() => void> = [];

async function withPdfTextExtractionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activePdfTextExtractions >= PDF_TEXT_EXTRACTION_WIDTH) {
    await new Promise<void>((resolve) => waitingPdfTextExtractions.push(resolve));
  } else {
    activePdfTextExtractions += 1;
  }
  try {
    return await work();
  } finally {
    const next = waitingPdfTextExtractions.shift();
    if (next) next();
    else activePdfTextExtractions -= 1;
  }
}

export class UnsupportedImportError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly mimeType: string,
  ) {
    super(`Orion cannot import “${fileName}” yet (${mimeType || "unknown type"}).`);
    this.name = "UnsupportedImportError";
  }
}

export async function parseImportFile(
  file: File,
  recognizeDocumentText?: DocumentTextRecognizer,
): Promise<ParsedImport> {
  const format = detectSourceKind(file.name, file.type);
  if (!format) {
    throw new UnsupportedImportError(file.name, file.type);
  }

  if (format === "pdf") {
    return parsePdf(file, recognizeDocumentText);
  }
  if (format === "docx") {
    return parseDocx(file);
  }
  if (format === "image") {
    return parseImage(file, recognizeDocumentText);
  }

  const rawText = stripByteOrderMark(await file.text());
  return parseTextImport(file.name, file.type, rawText, file.size, format);
}

export async function parseImportFiles(
  files: Iterable<File> | ArrayLike<File>,
  recognizeDocumentText?: DocumentTextRecognizer,
): Promise<ParsedImport[]> {
  return Promise.all(
    Array.from(files).map((file) =>
      parseImportFile(file, recognizeDocumentText),
    ),
  );
}

export function parseTextImport(
  fileName: string,
  mimeType: string,
  rawText: string,
  byteSize = new TextEncoder().encode(rawText).byteLength,
  knownFormat?: SourceKind,
): ParsedImport {
  const format = knownFormat ?? detectSourceKind(fileName, mimeType);
  if (
    !format ||
    format === "pdf" ||
    format === "docx" ||
    format === "image"
  ) {
    throw new UnsupportedImportError(fileName, mimeType);
  }

  const warnings: string[] = [];
  let title = titleFromFileName(fileName);
  let text = stripByteOrderMark(rawText).trim();

  if (format === "json") {
    try {
      const value: unknown = JSON.parse(text);
      text = JSON.stringify(value, null, 2);
      title = titleFromJson(value) ?? title;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      throw new Error(`Could not parse ${fileName}: ${message}`);
    }
  } else if (format === "csv") {
    const rows = parseDelimitedText(text);
    if (rows.length === 0) {
      warnings.push("The table did not contain any rows.");
    } else {
      text = delimitedRowsToMarkdown(rows);
    }
  } else if (format === "html") {
    const parsed = htmlToText(text);
    text = parsed.text;
    title = parsed.title || title;
    if (!text) {
      warnings.push("No readable text was found in the HTML document.");
    }
  } else if (format === "markdown") {
    title = markdownTitle(text) ?? title;
  }

  if (!text) {
    warnings.push("This file is empty.");
  }

  return {
    title,
    fileName,
    mimeType: mimeType || fallbackMimeType(format),
    format,
    byteSize,
    text,
    warnings,
  };
}

export function createImportDraft(
  parsed: ParsedImport,
  id = createId(),
  now = new Date().toISOString(),
): ImportDraft {
  return {
    id,
    title: parsed.title,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    format: parsed.format,
    byteSize: parsed.byteSize,
    extractedText: parsed.text,
    createdAt: now,
    status: "ready",
    warnings: [...parsed.warnings],
    generatedNoteIds: [],
  };
}

export function detectSourceKind(
  fileName: string,
  mimeType = "",
): SourceKind | null {
  const extension = fileName.toLocaleLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
  const mime = mimeType.toLocaleLowerCase().split(";")[0].trim();

  if (extension === ".pdf" || mime === "application/pdf") {
    return "pdf";
  }
  if (
    [".png", ".jpg", ".jpeg", ".heic", ".heif"].includes(extension) ||
    ["image/png", "image/jpeg", "image/heic", "image/heif"].includes(mime)
  ) {
    return "image";
  }
  if (
    extension === ".docx" ||
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if ([".md", ".markdown", ".mdown"].includes(extension)) {
    return "markdown";
  }
  if (extension === ".json" || mime === "application/json") {
    return "json";
  }
  if (
    [".csv", ".tsv"].includes(extension) ||
    ["text/csv", "text/tab-separated-values"].includes(mime)
  ) {
    return "csv";
  }
  if (
    [".html", ".htm"].includes(extension) ||
    ["text/html", "application/xhtml+xml"].includes(mime)
  ) {
    return "html";
  }
  if (
    extension === ".txt" ||
    mime === "text/plain" ||
    (!extension && mime.startsWith("text/"))
  ) {
    return "text";
  }
  return null;
}

export function parseDelimitedText(
  input: string,
  delimiter = detectDelimiter(input),
): string[][] {
  if (!input.trim()) {
    return [];
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      row.push(value.trim());
      value = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(value.trim());
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
      }
      row = [];
      value = "";
    } else {
      value += character;
    }
  }

  row.push(value.trim());
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }
  return rows;
}

export function delimitedRowsToMarkdown(rows: readonly string[][]): string {
  if (rows.length === 0) {
    return "";
  }
  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) =>
      escapeMarkdownTableCell(row[index] ?? ""),
    ),
  );
  const header = normalizedRows[0];
  const divider = Array.from({ length: columnCount }, () => "---");
  const body = normalizedRows.slice(1);
  return [header, divider, ...body]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

async function parsePdf(
  file: File,
  recognizeDocumentText?: DocumentTextRecognizer,
): Promise<ParsedImport> {
  const { getDocument, GlobalWorkerOptions } = await import(
    "pdfjs-dist/legacy/build/pdf.mjs"
  );
  if (!GlobalWorkerOptions.workerSrc) {
    GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }

  const loadingTask = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    useWorkerFetch: false,
  });
  const document = await loadingTask.promise;
  const rawPages: Array<{ pageNumber: number; text: string }> = new Array(
    document.numPages,
  );
  const warnings: string[] = [];

  try {
    let nextPageNumber = 1;
    let extractionFailed = false;
    let extractionError: unknown;
    // Keep only one pending page per worker. Completion order cannot change
    // physical page provenance, and every live read drains before destroy().
    await Promise.all(
      Array.from(
        { length: Math.min(PDF_TEXT_EXTRACTION_WIDTH, document.numPages) },
        async () => {
          while (!extractionFailed && nextPageNumber <= document.numPages) {
            const pageNumber = nextPageNumber++;
            try {
              await withPdfTextExtractionSlot(async () => {
                if (extractionFailed) return;
                const page = await document.getPage(pageNumber);
                const content = await page.getTextContent();
                let pageText = "";
                for (const item of content.items) {
                  if (!("str" in item)) continue;
                  pageText += item.str;
                  pageText += item.hasEOL ? "\n" : " ";
                }
                rawPages[pageNumber - 1] = {
                  pageNumber,
                  text: pageText
                    .replace(/[ \t]+\n/g, "\n")
                    .replace(/[ \t]{2,}/g, " ")
                    .trim(),
                };
              });
            } catch (error) {
              if (!extractionFailed) extractionError = error;
              extractionFailed = true;
            }
          }
        },
      ),
    );
    if (extractionFailed) throw extractionError;

    const selectedPages = rawPages.flatMap((page) => {
      const reason = pdfVisionOcrReason(page.text);
      return reason ? [{ ...page, reason }] : [];
    });
    const selectableText = rawPages.map(({ text }) => text).join("\n");
    const hadMeaningfulSelectableText = hasMeaningfulText(selectableText);

    if (selectedPages.length > 0) {
      if (!recognizeDocumentText) {
        if (!hadMeaningfulSelectableText) {
          await requireDocumentTextRecognition(file, recognizeDocumentText);
        }
        warnings.push(
          `PDF ${pluralizePages(selectedPages.map(({ pageNumber }) => pageNumber))} may benefit from on-device text recognition. Orion kept the embedded selectable text because page recognition is available in the installed Orion desktop app.`,
        );
      } else {
        const pageNumbers = selectedPages.map(({ pageNumber }) => pageNumber);
        try {
          const recognized = await recognizeDocumentText(file, { pageNumbers });
          const recognizedByPage = new Map(
            recognized.pages
              .filter(({ pageNumber }) => pageNumbers.includes(pageNumber))
              .map(({ pageNumber, text }) => [pageNumber, text.trim()]),
          );
          const improvedPages: number[] = [];
          const unimprovedPages: number[] = [];
          for (const selected of selectedPages) {
            const recognizedText = recognizedByPage.get(selected.pageNumber) ?? "";
            if (
              shouldUsePdfVisionText(
                selected.text,
                recognizedText,
                selected.reason,
              )
            ) {
              selected.text = recognizedText;
              improvedPages.push(selected.pageNumber);
            } else {
              unimprovedPages.push(selected.pageNumber);
            }
          }
          const selectedByPage = new Map(
            selectedPages.map(({ pageNumber, text }) => [pageNumber, text]),
          );
          for (const page of rawPages) {
            page.text = selectedByPage.get(page.pageNumber) ?? page.text;
          }
          warnings.push(
            ...pdfVisionBatchWarnings(
              pageNumbers,
              improvedPages,
              unimprovedPages,
              hadMeaningfulSelectableText,
              recognized.warnings,
            ),
          );
        } catch (error) {
          if (!hadMeaningfulSelectableText) {
            throw error;
          }
          warnings.push(
            `On-device text recognition failed for PDF ${pluralizePages(pageNumbers)}. Orion kept every page's embedded selectable text. ${errorMessage(error)}`,
          );
        }
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  const pages = normalizePdfPages(rawPages);
  const finalText = pages.map(({ text }) => text).join("\n");
  if (!hasMeaningfulText(finalText)) {
    throw new Error(
      `No meaningful text could be read from “${file.name}”. Try a clearer scan or a PDF with selectable text.`,
    );
  }

  return {
    title: titleFromFileName(file.name),
    fileName: file.name,
    mimeType: file.type || "application/pdf",
    format: "pdf",
    byteSize: file.size,
    text: formatPdfPages(pages),
    warnings: [...warnings, ...pdfSelectableTextWarnings(finalText)],
  };
}

/**
 * Select only physically textless pages or pages whose embedded layer has a
 * material concentration of Unicode replacement glyphs.
 */
export function pdfVisionOcrReason(text: string): PdfVisionOcrReason | null {
  if (!text.trim()) {
    return "textless";
  }
  const damage = pdfReplacementGlyphCount(text);
  const density = damage / Math.max(1, text.length);
  return damage >= 5 && density >= 0.002 ? "damaged" : null;
}

/**
 * Textless pages accept meaningful local recognition. A damaged selectable
 * layer is replaced only when the candidate reduces replacement glyphs, stays
 * close to the original signal size, and retains enough normalized vocabulary
 * to be recognizably the same physical page.
 */
export function shouldUsePdfVisionText(
  originalText: string,
  recognizedText: string,
  reason = pdfVisionOcrReason(originalText),
): boolean {
  const candidate = recognizedText.trim();
  if (!reason || !hasMeaningfulPdfOcrText(candidate)) {
    return false;
  }
  if (reason === "textless") {
    return true;
  }

  const originalDamage = pdfReplacementGlyphCount(originalText);
  const candidateDamage = pdfReplacementGlyphCount(candidate);
  const originalSignal = pdfTextSignal(originalText);
  const candidateSignal = pdfTextSignal(candidate);
  const signalRatio = candidateSignal / Math.max(1, originalSignal);
  return (
    candidateDamage < originalDamage &&
    signalRatio >= 0.6 &&
    signalRatio <= 1.6 &&
    normalizedPdfTokenOverlap(originalText, candidate) >= 0.45
  );
}

function hasMeaningfulPdfOcrText(value: string): boolean {
  return hasMeaningfulText(value);
}

function pdfReplacementGlyphCount(value: string): number {
  return value.match(/\uFFFD/g)?.length ?? 0;
}

function pdfTextSignal(value: string): number {
  return value.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

function normalizedPdfTokenOverlap(
  originalText: string,
  candidateText: string,
): number {
  const originalTokens = normalizedPdfTokens(originalText);
  if (originalTokens.length === 0) return 0;
  const candidateCounts = new Map<string, number>();
  for (const token of normalizedPdfTokens(candidateText)) {
    candidateCounts.set(token, (candidateCounts.get(token) ?? 0) + 1);
  }
  let overlap = 0;
  for (const token of originalTokens) {
    const remaining = candidateCounts.get(token) ?? 0;
    if (remaining <= 0) continue;
    overlap += 1;
    candidateCounts.set(token, remaining - 1);
  }
  return overlap / originalTokens.length;
}

function normalizedPdfTokens(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu) ?? []
  );
}

function pdfVisionBatchWarnings(
  selectedPageNumbers: readonly number[],
  improved: readonly number[],
  notImproved: readonly number[],
  hadMeaningfulSelectableText: boolean,
  recognitionWarnings: readonly string[],
): string[] {
  const warnings = [
    hadMeaningfulSelectableText
      ? `Orion used page-selective on-device text recognition only for PDF ${pluralizePages(selectedPageNumbers)}.`
      : `No meaningful selectable text was found, so Orion used page-selective on-device text recognition for PDF ${pluralizePages(selectedPageNumbers)}.`,
  ];

  if (improved.length > 0) {
    warnings.push(
      `On-device text recognition materially improved PDF ${pluralizePages(improved)}.`,
    );
  }
  if (notImproved.length > 0) {
    warnings.push(
      `On-device text recognition did not materially improve PDF ${pluralizePages(notImproved)}. Orion kept the embedded text where available and left textless pages empty rather than inventing text.`,
    );
  }
  for (const warning of new Set(recognitionWarnings.map((value) => value.trim()))) {
    if (warning) warnings.push(warning);
  }
  return warnings;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pluralizePages(pageNumbers: readonly number[]): string {
  const pages = [...new Set(pageNumbers)].sort((left, right) => left - right);
  const ranges: string[] = [];
  for (let index = 0; index < pages.length; index += 1) {
    const start = pages[index];
    let end = start;
    while (index + 1 < pages.length && pages[index + 1] === end + 1) {
      end = pages[index + 1];
      index += 1;
    }
    ranges.push(start === end ? String(start) : `${start}\u2013${end}`);
  }
  return `${pages.length === 1 ? "page" : "pages"} ${ranges.join(", ")}`;
}

function formatPdfPages(
  pages: ReadonlyArray<{ pageNumber: number; text: string }>,
): string {
  return pages
    .map(({ pageNumber, text }) => {
      const normalized = text.trim();
      return normalized
        ? `## Page ${pageNumber}\n\n${normalized}`
        : `## Page ${pageNumber}`;
    })
    .join("\n\n");
}

/**
 * Remove deterministic scan furniture without weakening page provenance.
 * ClearScan-era books often expose printed page numbers and running heads as
 * selectable text, then break a hyphenated word at every physical line. Those
 * tokens otherwise get repeated in every parallel reader packet. The first
 * occurrence of a recurring head is retained as useful structure; subsequent
 * copies and marginal page numerals are removed.
 */
export function normalizePdfPages(
  pages: ReadonlyArray<{ pageNumber: number; text: string }>,
): Array<{ pageNumber: number; text: string }> {
  const lineCounts = new Map<string, number>();
  for (const { text } of pages) {
    const lines = pdfLines(text);
    const candidates = new Set([
      ...lines.slice(0, 3),
      ...lines.slice(Math.max(0, lines.length - 2)),
    ]);
    for (const line of candidates) {
      if (!isPossibleRunningHead(line)) continue;
      const key = normalizedFurnitureLine(line);
      lineCounts.set(key, (lineCounts.get(key) ?? 0) + 1);
    }
  }
  const recurring = new Set(
    [...lineCounts]
      .filter(([, count]) => count >= 3)
      .map(([line]) => line),
  );
  const retainedHeads = new Set<string>();

  return pages.map(({ pageNumber, text }) => {
    const lines = pdfLines(text);
    const kept = lines.filter((line, index) => {
      const nearEdge = index < 3 || index >= lines.length - 2;
      if (nearEdge && isPrintedPageNumber(line)) return false;
      const key = normalizedFurnitureLine(line);
      if (!nearEdge || !recurring.has(key)) return true;
      if (retainedHeads.has(key)) return false;
      retainedHeads.add(key);
      return true;
    });
    return {
      pageNumber,
      text: dehyphenatePdfLineBreaks(kept.join("\n")).trim(),
    };
  });
}

function pdfLines(value: string): string[] {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
}

function isPrintedPageNumber(value: string): boolean {
  return /^(?:\d{1,4}|[ivxlcdm]{1,8})$/i.test(value.trim());
}

function isPossibleRunningHead(value: string): boolean {
  const normalized = value.trim();
  return (
    normalized.length >= 3 &&
    normalized.length <= 120 &&
    !isPrintedPageNumber(normalized) &&
    !/[.!?;:]$/.test(normalized)
  );
}

function normalizedFurnitureLine(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function dehyphenatePdfLineBreaks(value: string): string {
  return value
    .replace(/([\p{L}\p{N}]{2,})[-‐‑]\n([\p{Ll}][\p{L}\p{N}'’]*)/gu, "$1$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

function pdfSelectableTextWarnings(value: string): string[] {
  const replacements = value.match(/\uFFFD/g)?.length ?? 0;
  if (replacements < 24 && replacements / Math.max(1, value.length) < 0.001) {
    return [];
  }
  return [
    `The PDF's embedded selectable-text layer contains ${replacements.toLocaleString("en-US")} damaged glyphs. Orion preserved them as visible uncertainty rather than silently guessing the scanned words.`,
  ];
}

async function parseImage(
  file: File,
  recognizeDocumentText?: DocumentTextRecognizer,
): Promise<ParsedImport> {
  const recognized = await requireDocumentTextRecognition(
    file,
    recognizeDocumentText,
  );
  const text = recognized.text.trim();
  return {
    title: titleFromFileName(file.name),
    fileName: file.name,
    mimeType: file.type || imageMimeTypeFromFileName(file.name),
    format: "image",
    byteSize: file.size,
    text,
    warnings: [
      ...recognized.warnings,
      ...(!text ? ["No readable text was found in this image."] : []),
    ],
  };
}

function imageMimeTypeFromFileName(fileName: string): string {
  const extension = fileName.toLocaleLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension === ".png") return "image/png";
  if (extension === ".heic") return "image/heic";
  if (extension === ".heif") return "image/heif";
  return fallbackMimeType("image");
}

async function requireDocumentTextRecognition(
  file: File,
  recognizeDocumentText?: DocumentTextRecognizer,
): Promise<RecognizedDocumentText> {
  if (!recognizeDocumentText) {
    throw new Error(
      `Text recognition for “${file.name}” is available in the installed Orion desktop app.`,
    );
  }
  return recognizeDocumentText(file);
}

function hasMeaningfulText(value: string): boolean {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const lettersAndNumbers = normalized.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  const words = normalized.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
  return lettersAndNumbers >= 24 || words >= 5;
}

async function parseDocx(file: File): Promise<ParsedImport> {
  const { default: mammoth } = await import("mammoth");
  const result = await mammoth.extractRawText({
    arrayBuffer: await file.arrayBuffer(),
  });
  return {
    title: titleFromFileName(file.name),
    fileName: file.name,
    mimeType:
      file.type ||
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    format: "docx",
    byteSize: file.size,
    text: result.value.trim(),
    warnings: result.messages.map((message) => message.message),
  };
}

function htmlToText(html: string): { title: string; text: string } {
  if (typeof DOMParser === "undefined") {
    return {
      title: "",
      text: decodeBasicEntities(
        html
          .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
          .replace(/<\/?(?:p|div|section|article|h[1-6]|li|tr|br)\b[^>]*>/gi, "\n")
          .replace(/<[^>]+>/g, " "),
      )
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim(),
    };
  }

  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("script, style, noscript, svg, canvas, template")
    .forEach((element) => element.remove());
  const title = document.querySelector("title")?.textContent?.trim() ?? "";
  const blocks: string[] = [];
  const blockSelector =
    "h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, tr";
  const elements = Array.from(document.body.querySelectorAll(blockSelector));

  for (const element of elements) {
    if (element.parentElement?.closest(blockSelector) !== null) {
      const parentBlock = element.parentElement?.closest(blockSelector);
      if (parentBlock && parentBlock !== element) {
        continue;
      }
    }
    const value = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (!value) {
      continue;
    }
    const tag = element.tagName.toLocaleLowerCase();
    if (/^h[1-6]$/.test(tag)) {
      blocks.push(`${"#".repeat(Number(tag[1]))} ${value}`);
    } else if (tag === "li") {
      blocks.push(`- ${value}`);
    } else if (tag === "blockquote") {
      blocks.push(`> ${value}`);
    } else {
      blocks.push(value);
    }
  }

  const fallback = document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return { title, text: (blocks.length > 0 ? blocks.join("\n\n") : fallback) };
}

function detectDelimiter(input: string): string {
  const sample = input.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", "\t", ";"].map((delimiter) => ({
    delimiter,
    count: countOutsideQuotes(sample, delimiter),
  }));
  counts.sort((a, b) => b.count - a.count);
  return counts[0].count > 0 ? counts[0].delimiter : ",";
}

function countOutsideQuotes(input: string, target: string): number {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] === '"') {
      if (quoted && input[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && input[index] === target) {
      count += 1;
    }
  }
  return count;
}

function titleFromJson(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["title", "name", "subject"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  return null;
}

function markdownTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1].replace(/\s+#+$/, "").trim() || null;
}

function titleFromFileName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  const title = withoutExtension
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title
    ? title.replace(/\b\p{L}/gu, (character) => character.toLocaleUpperCase())
    : "Untitled import";
}

function fallbackMimeType(format: SourceKind): string {
  const mimeTypes: Record<SourceKind, string> = {
    manual: "text/plain",
    text: "text/plain",
    markdown: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    html: "text/html",
    pdf: "application/pdf",
    docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    image: "image/jpeg",
    audio: "audio/mpeg",
    video: "video/mp4",
    youtube: "text/uri-list",
  };
  return mimeTypes[format];
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|");
}

function stripByteOrderMark(value: string): string {
  return value.replace(/^\uFEFF/, "");
}

function decodeBasicEntities(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(
    /&(#\d+|#x[\da-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (_, entity: string) => {
      if (entity[0] === "#") {
        const hexadecimal = entity[1].toLocaleLowerCase() === "x";
        const codePoint = Number.parseInt(
          entity.slice(hexadecimal ? 2 : 1),
          hexadecimal ? 16 : 10,
        );
        return Number.isFinite(codePoint)
          ? String.fromCodePoint(codePoint)
          : _;
      }
      return entities[entity.toLocaleLowerCase()] ?? _;
    },
  );
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
