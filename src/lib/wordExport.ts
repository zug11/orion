import {
  AlignmentType, Bookmark, BorderStyle, CheckBox, Document, ExternalHyperlink,
  HeadingLevel, ImageRun, InternalHyperlink, LevelFormat, Packer, Paragraph,
  Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType,
  type INumberingOptions, type IParagraphOptions, type IRunOptions, type ParagraphChild,
} from "docx";
import type { AppSnapshot } from "../types";
import { buildWebExportDocument, notesForExportScope, type ExportScope } from "./webExport";
import { isSafeNoteImageUrl, noteImageAssetId } from "./noteImages";
import type { NoteMargins } from "./noteMargins";

const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CONTENT_WIDTH_PX = 624;
const CONTENT_WIDTH_TWIPS = 9360;

export interface WordExportDocument {
  fileName: string;
  bytes: Uint8Array<ArrayBuffer>;
  noteIds: string[];
  title: string;
}

export interface WordExportImage {
  bytes: Uint8Array<ArrayBuffer>;
  type: "png" | "jpg" | "gif";
  width: number;
  height: number;
}

export interface WordExportOptions {
  /** A narrow injectable boundary also used by generated-package tests. */
  loadImage?: (source: string) => Promise<WordExportImage>;
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Managed attachments and bounded raster data URLs only; never fetch a remote image. */
export async function loadWordExportImage(source: string): Promise<WordExportImage> {
  if (!isSafeNoteImageUrl(source)) throw new Error("This image cannot be included in a Word document.");
  let base64Data: string;
  let mimeType: string;
  const assetId = noteImageAssetId(source);
  if (assetId) {
    const { readWordExportImage } = await import("./storage");
    ({ base64Data, mimeType } = await readWordExportImage(assetId));
  } else {
    const comma = source.indexOf(",");
    mimeType = source.slice(5, source.indexOf(";"));
    base64Data = source.slice(comma + 1);
  }
  if (base64Data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error("Images in Word exports can be up to 12 MB each.");
  }
  let bytes = decodeBase64(base64Data);
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error("An image is empty or too large to export.");
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 100_000_000) {
      throw new Error("An image is damaged or too large to decode for Word.");
    }
    let width = image.naturalWidth;
    let height = image.naturalHeight;
    if (mimeType === "image/webp") {
      // Word's widely supported raster formats do not include WebP. Keep the
      // original attachment untouched, and convert only this exported copy.
      const scale = Math.min(1, 2400 / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Orion could not prepare this WebP image for Word.");
      context.drawImage(image, 0, 0, width, height);
      bytes = decodeBase64(canvas.toDataURL("image/png").split(",")[1]);
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("A converted image is too large for Word export.");
      mimeType = "image/png";
    }
    const type = mimeType === "image/png" ? "png" : mimeType === "image/jpeg" ? "jpg" : mimeType === "image/gif" ? "gif" : null;
    if (!type) throw new Error("This image format is not supported by Word export.");
    return { bytes, type, width, height };
  } catch (error) {
    throw new Error(`Orion could not include an image in the Word document: ${error instanceof Error ? error.message : "image unavailable"}`);
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Block = Paragraph | Table;
type BlockOptions = { quote?: boolean; depth?: number; paragraph?: IParagraphOptions; run?: IRunOptions; maxWidth?: number;
  bodyInset?: { left: number; right: number }; paragraphMargins?: NoteMargins;
  listMarker?: { consumed: boolean; reference: string; depth: number; task: boolean } };
const BLOCK_TAGS = /^(?:P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|DIV|SECTION|HR)$/;

function elementMargins(element: Element): NoteMargins {
  const left = Number(element.getAttribute("data-orion-margin-left"));
  const right = Number(element.getAttribute("data-orion-margin-right"));
  return [left, right].every((value) => Number.isInteger(value) && value >= 0 && value <= 25)
    ? { left, right } : { left: 0, right: 0 };
}

class WordContentBuilder {
  readonly numbering: Array<INumberingOptions["config"][number]> = [];
  readonly anchors = new Map<string, string>();
  private readonly placedAnchors = new Set<string>();
  private readonly images = new Map<string, WordExportImage>();
  private imageBytes = 0;

  constructor(private readonly loadImage: (source: string) => Promise<WordExportImage>, articles: Element[]) {
    for (const article of articles) {
      for (const element of [article, ...article.querySelectorAll("[id]")]) {
        if (element.id && !this.anchors.has(element.id)) this.anchors.set(element.id, `orion_${this.anchors.size + 1}`);
      }
    }
  }

  bookmark(element: Element): ParagraphChild[] {
    const id = this.anchors.get(element.id);
    if (!id || this.placedAnchors.has(id)) return [];
    this.placedAnchors.add(id);
    return [new Bookmark({ id, children: [] })];
  }

  inline(node: Node, style: IRunOptions = {}): ParagraphChild[] {
    if (node.nodeType === 3) return [new TextRun({ ...style, text: cleanText(node.textContent ?? "") })];
    if (!(node instanceof Element)) return [];
    const tag = node.tagName;
    if (["SCRIPT", "STYLE", "IMG"].includes(tag)) return [];
    if (tag === "BR") return [new TextRun({ ...style, break: 1 })];
    if (tag === "INPUT" && node.getAttribute("type") === "checkbox") {
      return [new CheckBox({ checked: node.hasAttribute("checked"), checkedState: { value: "2611", font: "DejaVu Sans" }, uncheckedState: { value: "2610", font: "DejaVu Sans" } })];
    }
    const next: IRunOptions = {
      ...style,
      ...(["B", "STRONG"].includes(tag) ? { bold: true } : {}),
      ...(["I", "EM"].includes(tag) ? { italics: true } : {}),
      ...(["S", "DEL"].includes(tag) ? { strike: true } : {}),
      ...(tag === "CODE" ? { style: "InlineCode", font: "Courier New", size: 20 } : {}),
      ...(tag === "SUP" ? { superScript: true } : {}),
      ...(tag === "SUB" ? { subScript: true } : {}),
      ...(tag === "A" ? { style: "Hyperlink", color: "315C91", underline: {} } : {}),
      ...(node.classList.contains("source-citation") ? { superScript: true, size: 18 } : {}),
    };
    const children = [...node.childNodes].flatMap((child) => this.inline(child, next));
    if (node.classList.contains("export-reference-meta")) children.unshift(new TextRun({ text: " — ", ...style }));
    if (tag === "A") {
      const href = node.getAttribute("href") ?? "";
      if (href.startsWith("#")) {
        const anchor = this.anchors.get(href.slice(1));
        if (anchor) return [...this.bookmark(node), new InternalHyperlink({ anchor, children })];
      } else {
        try {
          const url = new URL(href);
          if (["http:", "https:", "mailto:"].includes(url.protocol) && !url.username && !url.password) {
            return [...this.bookmark(node), new ExternalHyperlink({ link: url.href, children })];
          }
        } catch { /* A malformed or excluded link remains readable text. */ }
      }
    }
    return [...this.bookmark(node), ...children];
  }

  paragraph(children: ParagraphChild[], options: BlockOptions = {}): Paragraph {
    const marker = options.listMarker;
    const markerOptions: IParagraphOptions = marker
      ? marker.consumed || marker.task ? { indent: { left: 360 * (marker.depth + (marker.task ? 0 : 1)) } }
        : { numbering: { reference: marker.reference, level: marker.depth } }
      : {};
    // Percentage paragraph margins sit inside this note's body width. Keep
    // list hanging indents and quote/code padding in addition to those insets.
    const margins = options.paragraphMargins;
    const inset = options.bodyInset;
    let marginIndent: IParagraphOptions["indent"];
    if (inset?.left || inset?.right || margins?.left || margins?.right) {
      const styleInset = options.paragraph?.style === "OrionCode" ? 160 : 0;
      const existing = options.paragraph?.indent;
      const left = (typeof existing?.left === "number" ? existing.left : styleInset || (options.quote ? 360 : 0))
        + (marker ? 360 * (marker.depth + (marker.task ? 0 : 1)) : 0);
      const right = typeof existing?.right === "number" ? existing.right : styleInset || (options.quote ? 180 : 0);
      const width = Math.max(0, (options.maxWidth ?? CONTENT_WIDTH_PX) * 15 - left - right);
      marginIndent = {
        ...existing,
        ...(!marker?.consumed && marker && !marker.task ? { hanging: 240 } : {}),
        left: left + (inset?.left ?? 0) + Math.round(width * (margins?.left ?? 0) / 100),
        right: right + (inset?.right ?? 0) + Math.round(width * (margins?.right ?? 0) / 100),
      };
    }
    if (marker) marker.consumed = true;
    return new Paragraph({
      spacing: { after: 160, line: 276 },
      widowControl: true,
      ...(options.quote ? { style: "Quote", indent: { left: 360, right: 180 }, border: { left: { style: BorderStyle.SINGLE, color: "B9BDC8", size: 10, space: 12 } } } : {}),
      ...options.paragraph,
      ...markerOptions,
      ...(marginIndent ? { indent: marginIndent } : {}),
      children,
    });
  }

  async children(element: Element, options: BlockOptions = {}, prefix: ParagraphChild[] = []): Promise<Block[]> {
    const output: Block[] = [];
    let inline: ParagraphChild[] = prefix;
    const flush = () => { if (inline.length) { output.push(this.paragraph(inline, options)); inline = []; } };
    for (const child of element.childNodes) {
      if (child instanceof Element && (BLOCK_TAGS.test(child.tagName) || child.classList.contains("note-image-reading"))) {
        flush();
        output.push(...await this.block(child, options));
      } else if (child.nodeType !== 3 || child.textContent?.trim() || inline.length) {
        inline.push(...this.inline(child, options.run));
      }
    }
    flush();
    return output;
  }

  async image(element: Element, options: BlockOptions): Promise<Block[]> {
    const imageElement = element.querySelector("img");
    const source = imageElement?.getAttribute("src");
    if (!source || !isSafeNoteImageUrl(source)) return [];
    let image = this.images.get(source);
    if (!image) {
      image = await this.loadImage(source);
      if (!image.bytes.length || image.bytes.length > MAX_IMAGE_BYTES || !Number.isFinite(image.width) || !Number.isFinite(image.height) || image.width <= 0 || image.height <= 0) {
        throw new Error("An image is damaged or too large to include in Word.");
      }
      this.imageBytes += image.bytes.length;
      if (this.imageBytes > MAX_DOCUMENT_BYTES - MAX_TEXT_BYTES) throw new Error("This selection contains too many images for one Word document.");
      this.images.set(source, image);
    }
    const wrapper = (element.querySelector(".note-image-free-content") ?? element) as HTMLElement;
    const percentage = Number.parseFloat(wrapper.style.width) || 100;
    const paragraphWidth = (options.maxWidth ?? CONTENT_WIDTH_PX)
      * (100 - (options.paragraphMargins?.left ?? 0) - (options.paragraphMargins?.right ?? 0)) / 100;
    const maxWidth = paragraphWidth * Math.min(100, Math.max(15, percentage)) / 100;
    const scale = Math.min(1, maxWidth / image.width, 650 / image.height);
    const alignment = wrapper.style.float === "left" || wrapper.style.marginLeft === "0px" ? AlignmentType.LEFT
      : wrapper.style.float === "right" || wrapper.style.marginRight === "0px" ? AlignmentType.RIGHT : AlignmentType.CENTER;
    const caption = [...wrapper.children].filter((child) => child !== imageElement).map((child) => child.textContent?.trim()).filter(Boolean).join(" ");
    const result: Block[] = [this.paragraph([
      new ImageRun({ type: image.type, data: image.bytes, transformation: { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) }, altText: { name: "Image", title: imageElement?.getAttribute("alt") || "Image", description: imageElement?.getAttribute("alt") || "" } }),
    ], { ...options, listMarker: undefined, paragraph: { alignment, spacing: { before: 160, after: caption ? 60 : 180 }, keepNext: Boolean(caption) } })];
    if (caption) result.push(this.paragraph([new TextRun(cleanText(caption))], { ...options, listMarker: undefined, paragraph: { style: "Caption", alignment, spacing: { after: 180 } } }));
    return result;
  }

  async block(element: Element, options: BlockOptions = {}): Promise<Block[]> {
    const tag = element.tagName;
    if (element.classList.contains("note-image-reading")) return this.image(element, options);
    if (tag === "UL" || tag === "OL") return this.list(element, options);
    if (tag === "TABLE") return [await this.table(element, options)];
    if (tag === "BLOCKQUOTE") return this.children(element, { ...options, quote: true, run: { ...options.run, italics: true } });
    if (tag === "PRE") {
      const lines = cleanText(element.textContent ?? "").replace(/\n$/, "").split("\n");
      return [this.paragraph(lines.flatMap((text, index) => [
        ...(index ? [new TextRun({ break: 1 })] : []), new TextRun({ text: text || " ", font: "Courier New", size: 19 }),
      ]), { ...options, paragraph: { style: "OrionCode", spacing: { after: 160, line: 240 } } })];
    }
    if (tag === "HR") return [this.paragraph([], { ...options, paragraph: { border: { bottom: { color: "C8CDD7", style: BorderStyle.SINGLE, size: 6 } }, spacing: { before: 200, after: 200 } } })];
    if (tag === "P" || /^H[1-6]$/.test(tag)) {
      const heading = /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0;
      const headingLevel = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6][heading - 1];
      const blocks = await this.children(element, {
        ...options,
        paragraphMargins: elementMargins(element),
        paragraph: { ...options.paragraph, ...(heading ? { heading: headingLevel, keepNext: true, spacing: { before: 280, after: 120 } } : {}), ...(element.getAttribute("data-orion-justify") === "true" ? { alignment: AlignmentType.JUSTIFIED } : {}) },
      }, this.bookmark(element));
      return blocks.length ? blocks : [this.paragraph([], options)];
    }
    return this.children(element, options);
  }

  async list(element: Element, options: BlockOptions): Promise<Block[]> {
    const depth = Math.min(options.depth ?? 0, 8);
    const reference = `list_${this.numbering.length + 1}`;
    const ordered = element.tagName === "OL";
    this.numbering.push({ reference, levels: Array.from({ length: 9 }, (_, level) => ({
      level, format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: ordered ? `%${level + 1}.` : "•", start: Math.max(1, Number.parseInt(element.getAttribute("start") ?? "1") || 1),
      alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 360 * (level + 1), hanging: 240 } } },
    })) });
    const output: Block[] = [];
    for (const item of [...element.children].filter((child) => child.tagName === "LI")) {
      const nested = [...item.children].filter((child) => child.tagName === "UL" || child.tagName === "OL");
      const content = item.cloneNode(true) as Element;
      [...content.children].filter((child) => child.tagName === "UL" || child.tagName === "OL").forEach((child) => child.remove());
      const task = content.querySelector('input[type="checkbox"]');
      // Keep complete rich children. Only the first actual paragraph receives
      // the list marker; continuation paragraphs, code, tables and images stay.
      const firstParagraph = content.querySelector("p");
      const itemOptions = { ...options, paragraph: { spacing: { after: 100, line: 276 } }, listMarker: { reference, depth, task: Boolean(task), consumed: false } };
      if (item.id) {
        const anchor = content.ownerDocument.createElement("span");
        anchor.id = item.id;
        (firstParagraph ?? content.querySelector("div") ?? content).prepend(anchor);
      }
      output.push(...await this.children(content, itemOptions));
      for (const child of nested) output.push(...await this.list(child, { ...options, depth: depth + 1 }));
    }
    return output;
  }

  async table(element: Element, options: BlockOptions): Promise<Table> {
    const rows = [...element.querySelectorAll("tr")].filter((row) => row.closest("table") === element);
    const columnCount = Math.max(1, ...rows.map((row) => row.children.length));
    const wrapper = element.parentElement as HTMLElement;
    const percentage = Math.min(100, Math.max(35, Number.parseFloat(wrapper?.style.width) || 100));
    const width = Math.round((options.maxWidth ?? CONTENT_WIDTH_PX) * 15 * percentage / 100);
    const rawWidths = [...element.querySelectorAll("col")].map((col) => Number.parseFloat((col as HTMLElement).style.width) || 96);
    const sum = rawWidths.reduce((total, value) => total + value, 0);
    const columnWidths = Array.from({ length: columnCount }, (_, index) => Math.round(width * (rawWidths.length === columnCount && sum ? rawWidths[index] / sum : 1 / columnCount)));
    const tableRows: TableRow[] = [];
    for (const [index, row] of rows.entries()) {
      const header = row.parentElement?.tagName === "THEAD";
      const cells: TableCell[] = [];
      for (const [column, cell] of [...row.children].entries()) {
        const alignment = (cell as HTMLElement).style.textAlign;
        const children = await this.children(cell, { ...options, bodyInset: undefined, paragraphMargins: undefined, listMarker: undefined, maxWidth: columnWidths[column] / 15, run: { ...options.run, size: 20, bold: header }, paragraph: { spacing: { after: 60, line: 240 }, alignment: alignment === "right" ? AlignmentType.RIGHT : alignment === "center" ? AlignmentType.CENTER : AlignmentType.LEFT } });
        if (!(children[children.length - 1] instanceof Paragraph)) children.push(new Paragraph(""));
        cells.push(new TableCell({
          children, width: { size: columnWidths[column], type: WidthType.DXA }, margins: { top: 90, bottom: 90, left: 110, right: 110 },
          ...(header || (wrapper?.getAttribute("data-banded") !== "false" && index % 2 === 1) ? { shading: { fill: header ? "E9EDF3" : "F6F7F9" } } : {}),
        }));
      }
      tableRows.push(new TableRow({ children: cells, tableHeader: header }));
    }
    return new Table({ rows: tableRows, width: { size: width, type: WidthType.DXA }, ...(options.bodyInset?.left ? { indent: { size: options.bodyInset.left, type: WidthType.DXA } } : {}), columnWidths, layout: TableLayoutType.FIXED, borders: { top: { style: BorderStyle.SINGLE, size: 4, color: "CBD1DB" }, bottom: { style: BorderStyle.SINGLE, size: 4, color: "CBD1DB" }, left: { style: BorderStyle.SINGLE, size: 4, color: "CBD1DB" }, right: { style: BorderStyle.SINGLE, size: 4, color: "CBD1DB" }, insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "CBD1DB" }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "CBD1DB" } } });
  }
}

/** The same semantic, privacy-filtered content as HTML, encoded as real Word structures. */
export async function buildWordExportDocument(
  snapshot: AppSnapshot,
  scope: ExportScope,
  originNoteId: string | null,
  options: WordExportOptions = {},
): Promise<WordExportDocument> {
  const notes = notesForExportScope(snapshot, scope, originNoteId);
  const inputSize = notes.reduce((bytes, note) => bytes + new TextEncoder().encode(note.body + note.title + note.summary).length, 0);
  if (inputSize > MAX_TEXT_BYTES || notes.length > 2000) throw new Error("Choose fewer notes for this Word export (up to 16 MB of text and 2,000 notes).");
  const web = buildWebExportDocument(snapshot, scope, originNoteId);
  if (new TextEncoder().encode(web.html).length > MAX_TEXT_BYTES) throw new Error("This selection contains too much text or citation metadata for one Word document.");
  const parsed = new DOMParser().parseFromString(web.html, "text/html");
  const articles = [...parsed.querySelectorAll("article.export-note")];
  const builder = new WordContentBuilder(options.loadImage ?? loadWordExportImage, articles);
  const children: Block[] = [];
  if (scope === "space") {
    children.push(new Paragraph({ text: cleanText(web.title), heading: HeadingLevel.TITLE }));
    if (snapshot.workspace.description.trim()) children.push(new Paragraph(cleanText(snapshot.workspace.description)));
    for (const article of articles) children.push(new Paragraph({ children: [new InternalHyperlink({ anchor: builder.anchors.get(article.id)!, children: [new TextRun(article.getAttribute("data-page-title") || "Untitled note")] })], spacing: { after: 100 } }));
  }
  for (const [index, article] of articles.entries()) {
    const title = article.querySelector(".export-note-header h1")?.textContent ?? "Untitled note";
    children.push(new Paragraph({ children: [...builder.bookmark(article), new TextRun(cleanText(title))], heading: HeadingLevel.TITLE, pageBreakBefore: scope === "space" || index > 0, spacing: { after: 240 } }));
    const summary = article.querySelector(".export-note-summary")?.textContent;
    if (summary) children.push(new Paragraph({ text: cleanText(summary), style: "Subtitle", spacing: { after: 200 } }));
    const tags = [...article.querySelectorAll(".export-tags span")].map((tag) => tag.textContent).join("  ");
    if (tags) children.push(new Paragraph({ children: [new TextRun({ text: tags, color: "626A77", size: 18 })], spacing: { after: 200 } }));
    const prose = article.querySelector(".export-prose");
    if (prose) {
      const margins = elementMargins(prose);
      const bodyInset = { left: Math.round(CONTENT_WIDTH_TWIPS * margins.left / 100), right: Math.round(CONTENT_WIDTH_TWIPS * margins.right / 100) };
      children.push(...await builder.children(prose, { bodyInset, maxWidth: (CONTENT_WIDTH_TWIPS - bodyInset.left - bodyInset.right) / 15 }));
    }
    const references = article.querySelector(".export-references");
    if (references) children.push(...await builder.children(references));
  }
  const doc = new Document({
    title: cleanText(web.title), creator: "", lastModifiedBy: "", description: "", keywords: "",
    styles: {
      default: { document: { run: { font: "Calibri", size: 23, color: "20242C" }, paragraph: { spacing: { after: 160, line: 276 } } } },
      paragraphStyles: [
        { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { color: "000000", size: 48, bold: true }, paragraph: { keepNext: true, spacing: { after: 240 } } },
        { id: "Subtitle", name: "Subtitle", basedOn: "Normal", next: "Normal", run: { color: "545C69", size: 25 } },
        { id: "Caption", name: "Caption", basedOn: "Normal", next: "Normal", run: { size: 19, color: "545C69", italics: true } },
        { id: "Quote", name: "Quote", basedOn: "Normal", next: "Normal", run: { italics: true }, paragraph: { indent: { left: 360, right: 180 } } },
        { id: "OrionCode", name: "Code", basedOn: "Normal", next: "Normal", run: { font: "Courier New", size: 19 }, paragraph: { shading: { fill: "F1F3F6" }, spacing: { after: 0, line: 240 }, indent: { left: 160, right: 160 } } },
        ...[32, 28, 25, 24, 23, 23].map((size, index) => ({ id: `Heading${index + 1}`, name: `Heading ${index + 1}`, basedOn: "Normal", next: "Normal", run: { size, bold: true, color: "20242C" }, paragraph: { keepNext: true, spacing: { before: 280, after: 120 } } })),
      ],
      characterStyles: [{ id: "InlineCode", name: "Inline code", basedOn: "DefaultParagraphFont", run: { font: "Courier New", size: 20 } }],
    },
    numbering: { config: builder.numbering },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1080, bottom: 1080, left: 1440, right: 1440 } } }, children }],
  });
  const bytes = new Uint8Array(await Packer.toArrayBuffer(doc));
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("This Word document is too large. Export fewer notes or images.");
  return { fileName: web.fileName.replace(/\.html$/, ".docx"), bytes, noteIds: web.noteIds, title: web.title };
}
