import type { JSONContent } from "@tiptap/core";
import { Lexer } from "marked";
import type { Note } from "../types";
import { splitMarkdownFrontmatter, stripDuplicateTitleHeading } from "./markdown";

export const NOTE_EXCERPT_PREFIX = "orion-excerpt:v1:";
export const NOTE_EXCERPT_TEXT_PREFIX = "orion-excerpt:v2:";
export const MAX_EXCERPT_CHARACTERS = 12_000;
export const MAX_EXCERPT_PASSAGES = 12;
const MAX_EXCERPT_METADATA = 80_000;

export interface ExcerptRange { from: number; to: number }
export interface ExcerptPassage extends ExcerptRange { text: string }
/** MCP can preserve exact words without claiming offsets in the renderer's text. */
export interface ExcerptTextPassage { text: string; locator: "unique-text" }
export type ExcerptLocator = ExcerptPassage | ExcerptTextPassage;
export interface NoteExcerptReference { noteId: string; passages: ExcerptLocator[] }
export interface NoteExcerptSelection {
  noteId: string;
  title: string;
  text: string;
  passages: ExcerptPassage[];
}
export interface ExcerptBlock {
  kind: "paragraph" | "heading" | "code" | "quote" | "list";
  level?: number;
  text: string;
  from: number;
  to: number;
}
export interface ExcerptDocument { text: string; blocks: ExcerptBlock[] }

interface Token {
  type: string;
  text?: string;
  depth?: number;
  tokens?: Token[];
  items?: Token[];
  header?: { tokens: Token[] }[];
  rows?: { tokens: Token[] }[][];
}

function decodeEntities(text: string): string {
  return text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity) => {
    if (entity.startsWith("&#")) {
      const numeric = entity.slice(2, -1);
      const value = /^x/i.test(numeric) ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value) : "�";
    }
    if (typeof document !== "undefined") {
      const decoder = document.createElement("textarea");
      // Only one character reference is interpreted in an inert element.
      decoder.innerHTML = entity;
      return decoder.value;
    }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " } as Record<string, string>)[entity] ?? entity;
  });
}

function inlineText(token: Token): string {
  if (token.type === "br") return "\n";
  if (token.type === "code" || token.type === "codespan") return token.text ?? "";
  if (token.type === "def") return "";
  if (token.tokens) return token.tokens.map(inlineText).join("");
  if (token.type === "html") return decodeEntities((token.text ?? "").replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, ""));
  return decodeEntities(token.text ?? "").replace(/\r?\n/g, " ");
}

const documentCache = new WeakMap<Note, { body: string; title: string; document: ExcerptDocument }>();

/** The reader and selection offsets share this exact, inert text representation. */
export function getNoteExcerptDocument(note: Note): ExcerptDocument {
  const cached = documentCache.get(note);
  if (cached?.body === note.body && cached.title === note.title) return cached.document;
  const body = stripDuplicateTitleHeading(splitMarkdownFrontmatter(note.body).content, note.title);
  const rawBlocks: Omit<ExcerptBlock, "from" | "to">[] = [];
  function visit(tokens: Token[], inherited?: "quote" | "list") {
    for (const token of tokens) {
      if (token.type === "space" || token.type === "def" || token.type === "hr") continue;
      if (token.type === "blockquote") { visit(token.tokens ?? [], "quote"); continue; }
      if (token.type === "list") {
        for (const item of token.items ?? []) visit(item.tokens ?? [item], "list");
        continue;
      }
      if (token.type === "table") {
        for (const row of [token.header ?? [], ...(token.rows ?? [])]) {
          const text = row.map((cell) => cell.tokens.map(inlineText).join("")).join("\t");
          if (text.trim()) rawBlocks.push({ kind: "paragraph", text });
        }
        continue;
      }
      const text = inlineText(token).trim();
      if (text) rawBlocks.push({
        kind: token.type === "heading" ? "heading" : token.type === "code" ? "code" : inherited ?? "paragraph",
        ...(token.type === "heading" ? { level: token.depth } : {}), text,
      });
    }
  }
  visit(Lexer.lex(body, { gfm: true }) as Token[]);
  let cursor = 0;
  const blocks = rawBlocks.map((block) => {
    const result = { ...block, from: cursor, to: cursor + block.text.length };
    cursor = result.to + 2;
    return result;
  });
  const result = { text: blocks.map((block) => block.text).join("\n\n"), blocks };
  documentCache.set(note, { body: note.body, title: note.title, document: result });
  return result;
}

export function getNoteExcerptText(note: Note): string { return getNoteExcerptDocument(note).text; }

export function excerptSearchMatches(text: string, query: string, limit = 500): ExcerptRange[] {
  const parts = query.trim().slice(0, 256).split(/\s+/u).filter(Boolean);
  if (!parts.length) return [];
  const pattern = new RegExp(parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"), "giu");
  const matches: ExcerptRange[] = [];
  for (const match of text.matchAll(pattern)) {
    matches.push({ from: match.index, to: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

export interface ExcerptSearchResult { note: Note; snippet: string; bodyMatch?: ExcerptRange; score: number }

/** Searches complete visible bodies, only in the explicit active-Space array. */
export function searchExcerptNotes(notes: readonly Note[], query: string, excludeNoteId?: string): ExcerptSearchResult[] {
  return notes.filter((note) => note.id !== excludeNoteId).flatMap((note) => {
    const text = getNoteExcerptText(note);
    const titleMatch = excerptSearchMatches(note.title, query, 1)[0];
    const bodyMatch = excerptSearchMatches(text, query, 1)[0];
    if (query.trim() && !titleMatch && !bodyMatch) return [];
    let from = Math.max(0, (bodyMatch?.from ?? 0) - 72);
    if (from && /[\uDC00-\uDFFF]/u.test(text[from])) from -= 1;
    const snippet = `${from ? "…" : ""}${text.slice(from, from + 220).replace(/\s+/gu, " ")}${from + 220 < text.length ? "…" : ""}`;
    return [{ note, snippet, bodyMatch, score: titleMatch ? 2 : bodyMatch ? 1 : 0 }];
  }).sort((left, right) => right.score - left.score);
}

export function normalizeExcerptRanges(text: string, ranges: readonly ExcerptRange[]): ExcerptRange[] {
  const sorted = ranges.filter((range) => Number.isSafeInteger(range.from) && Number.isSafeInteger(range.to))
    .map((range) => {
      let from = Math.max(0, Math.min(text.length, range.from));
      let to = Math.max(from, Math.min(text.length, range.to));
      while (from < to && /\s/u.test(text[from])) from += 1;
      while (to > from && /\s/u.test(text[to - 1])) to -= 1;
      // Selection endpoints must not bisect a supplementary character.
      if (from && /[\uDC00-\uDFFF]/u.test(text[from])) from -= 1;
      if (to < text.length && /[\uDC00-\uDFFF]/u.test(text[to])) to += 1;
      return { from, to };
    }).filter(({ from, to }) => to > from).sort((a, b) => a.from - b.from);
  const merged: ExcerptRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

export function createNoteExcerptSelection(note: Note, ranges: readonly ExcerptRange[]): NoteExcerptSelection {
  const text = getNoteExcerptText(note);
  const normalized = normalizeExcerptRanges(text, ranges);
  if (!normalized.length) throw new Error("Select a passage from the note first.");
  if (normalized.length > MAX_EXCERPT_PASSAGES) throw new Error(`Choose at most ${MAX_EXCERPT_PASSAGES} passages.`);
  const passages = normalized.map((range) => ({ ...range, text: text.slice(range.from, range.to) }));
  const quote = passages.map((passage) => passage.text).join(" … ");
  if (quote.length > MAX_EXCERPT_CHARACTERS) throw new Error("Choose a shorter excerpt (up to 12,000 characters).");
  return { noteId: note.id, title: note.title, text: quote, passages };
}

export function encodeNoteExcerptTitle(selection: NoteExcerptSelection): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ noteId: selection.noteId, passages: selection.passages }));
  const encoded = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (encoded.length > MAX_EXCERPT_METADATA) throw new Error("This excerpt is too large to preserve.");
  return NOTE_EXCERPT_PREFIX + encoded;
}

export function parseNoteExcerptTitle(title: unknown, href?: string): NoteExcerptReference | undefined {
  if (typeof title !== "string") return;
  if (title.startsWith(NOTE_EXCERPT_TEXT_PREFIX)) return parseTextExcerptTitle(title, href);
  if (!title.startsWith(NOTE_EXCERPT_PREFIX)) return;
  const encoded = title.slice(NOTE_EXCERPT_PREFIX.length);
  if (!encoded || encoded.length > MAX_EXCERPT_METADATA || !/^[A-Za-z0-9_-]+$/.test(encoded)) return;
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value.noteId !== "string" || !/^[^\s"<>()[\]\\?#]{1,256}$/u.test(value.noteId) ||
      (href !== undefined && href !== `orion-note://${value.noteId}`) || !Array.isArray(value.passages) ||
      !value.passages.length || value.passages.length > MAX_EXCERPT_PASSAGES) return;
    let length = 0;
    let previousEnd = -1;
    for (const passage of value.passages) {
      if (!passage || !Number.isSafeInteger(passage.from) || !Number.isSafeInteger(passage.to) ||
        passage.from < 0 || passage.to <= passage.from || passage.from < previousEnd ||
        typeof passage.text !== "string" || passage.text.length !== passage.to - passage.from) return;
      length += passage.text.length;
      previousEnd = passage.to;
    }
    if (length > MAX_EXCERPT_CHARACTERS) return;
    return { noteId: value.noteId, passages: value.passages.map(({ from, to, text }: ExcerptPassage) => ({ from, to, text })) };
  } catch { return; }
}

/** Version 2 is percent-encoded JSON containing text only, never guessed ranges. */
function parseTextExcerptTitle(title: string, href?: string): NoteExcerptReference | undefined {
  const encoded = title.slice(NOTE_EXCERPT_TEXT_PREFIX.length);
  if (!encoded || encoded.length > MAX_EXCERPT_METADATA || !/^(?:[A-Za-z0-9_.!~*'()-]|%[0-9a-f]{2})+$/i.test(encoded)) return;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(encoded));
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 2 || typeof record.noteId !== "string"
      || !/^[^\s"<>()[\]\\?#]{1,256}$/u.test(record.noteId)
      || (href !== undefined && href !== `orion-note://${record.noteId}`)
      || !Array.isArray(record.passages) || !record.passages.length || record.passages.length > MAX_EXCERPT_PASSAGES) return;
    const passages: ExcerptTextPassage[] = [];
    let length = (record.passages.length - 1) * 3;
    for (const passage of record.passages) {
      if (!passage || typeof passage !== "object" || Array.isArray(passage) || Object.keys(passage).length !== 1
        || typeof passage.text !== "string" || !passage.text.trim()
        || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(passage.text)) return;
      length += passage.text.length;
      if (length > MAX_EXCERPT_CHARACTERS) return;
      passages.push({ text: passage.text, locator: "unique-text" });
    }
    return { noteId: record.noteId, passages };
  } catch { return; }
}

/** Ordinary Markdown structures keep the quoted words readable in every export. */
export function buildNoteExcerptContent(selection: NoteExcerptSelection): JSONContent[] {
  const title = encodeNoteExcerptTitle(selection);
  if (!parseNoteExcerptTitle(title, `orion-note://${selection.noteId}`)) throw new Error("The source note is not valid.");
  const quote = selection.passages.map((passage) => passage.text).join(" … ");
  const paragraphs = quote.split(/\n\n+/).map((text) => ({
    type: "paragraph", content: text.split("\n").flatMap((line, index) => [
      ...(index ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : []),
    ]),
  }));
  return [{ type: "blockquote", content: [
    ...paragraphs,
    { type: "paragraph", content: [{ type: "text", text: selection.title || "Untitled note", marks: [{
      type: "link", attrs: { href: `orion-note://${selection.noteId}`, title, target: null, rel: null },
    }] }] },
  ] }, { type: "paragraph" }];
}

/** Offsets use the canonical article text. Both ends must belong to this reader. */
export function excerptRangeFromSelection(root: HTMLElement, selection: Selection | null): ExcerptRange | null {
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  const selected = selection.getRangeAt(0);
  if (!root.contains(selected.startContainer) || !root.contains(selected.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(root);
  before.setEnd(selected.startContainer, selected.startOffset);
  const from = before.toString().length;
  return { from, to: from + selected.toString().length };
}
