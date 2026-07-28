import type {
  ImportDraft,
  ParsedImport,
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
] as const;

export const IMPORT_ACCEPT =
  ".txt,.md,.markdown,.json,.csv,.tsv,.html,.htm,.pdf,.docx,text/plain,text/markdown,text/csv,text/html,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export class UnsupportedImportError extends Error {
  constructor(
    public readonly fileName: string,
    public readonly mimeType: string,
  ) {
    super(`Orion cannot import “${fileName}” yet (${mimeType || "unknown type"}).`);
    this.name = "UnsupportedImportError";
  }
}

export async function parseImportFile(file: File): Promise<ParsedImport> {
  const format = detectSourceKind(file.name, file.type);
  if (!format) {
    throw new UnsupportedImportError(file.name, file.type);
  }

  if (format === "pdf") {
    return parsePdf(file);
  }
  if (format === "docx") {
    return parseDocx(file);
  }

  const rawText = stripByteOrderMark(await file.text());
  return parseTextImport(file.name, file.type, rawText, file.size, format);
}

export async function parseImportFiles(
  files: Iterable<File> | ArrayLike<File>,
): Promise<ParsedImport[]> {
  return Promise.all(Array.from(files).map(parseImportFile));
}

export function parseTextImport(
  fileName: string,
  mimeType: string,
  rawText: string,
  byteSize = new TextEncoder().encode(rawText).byteLength,
  knownFormat?: SourceKind,
): ParsedImport {
  const format = knownFormat ?? detectSourceKind(fileName, mimeType);
  if (!format || format === "pdf" || format === "docx") {
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

async function parsePdf(file: File): Promise<ParsedImport> {
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
  const pages: string[] = [];

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (!("str" in item)) {
          continue;
        }
        pageText += item.str;
        pageText += item.hasEOL ? "\n" : " ";
      }
      const normalized = pageText
        .replace(/[ \t]+\n/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
      if (normalized) {
        pages.push(normalized);
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  const warnings: string[] = [];
  if (pages.length === 0) {
    warnings.push(
      "No selectable text was found. This PDF may contain scanned images.",
    );
  }

  return {
    title: titleFromFileName(file.name),
    fileName: file.name,
    mimeType: file.type || "application/pdf",
    format: "pdf",
    byteSize: file.size,
    text: pages
      .map((page, index) => `## Page ${index + 1}\n\n${page}`)
      .join("\n\n"),
    warnings,
  };
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
