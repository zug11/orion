import type { AppSnapshot, Concept, Note, Source } from "../types";
import { Lexer } from "marked";
import { splitMarkdownFrontmatter } from "./markdown";

const SNIPPET_LENGTH = 200;
const noteTextCache = new WeakMap<Note, { body: string; text: string }>();

interface SearchToken {
  type: string;
  text?: string;
  tokens?: SearchToken[];
  items?: SearchToken[];
  header?: { tokens: SearchToken[] }[];
  rows?: { tokens: SearchToken[] }[][];
}

function decodeEntities(text: string): string {
  let decoder: HTMLTextAreaElement | undefined;
  return text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity) => {
    if (entity.startsWith("&#")) {
      const numeric = entity.slice(2, -1);
      const value = /^x/i.test(numeric) ? parseInt(numeric.slice(1), 16) : Number(numeric);
      return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
        ? String.fromCodePoint(value) : "�";
    }
    // Only a single character reference reaches this inert text element; never
    // parse note HTML or put user markup into a live document to extract text.
    if (typeof document !== "undefined") {
      decoder ??= document.createElement("textarea");
      decoder.innerHTML = entity;
      return decoder.value;
    }
    return ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " } as Record<string, string>)[entity] ?? entity;
  });
}

function tokenText(token: SearchToken): string {
  if (token.type === "code" || token.type === "codespan") return token.text ?? "";
  if (token.type === "def") return "";
  if (token.type === "table") {
    return [...(token.header ?? []), ...(token.rows ?? []).flat()]
      .map((cell) => cell.tokens.map(tokenText).join("")).join(" ") + " ";
  }
  if (token.type === "list") return (token.items ?? []).map(tokenText).join(" ") + " ";
  if (token.tokens) {
    const text = token.tokens.map(tokenText).join("");
    return ["heading", "paragraph", "blockquote", "list_item"].includes(token.type) ? `${text} ` : text;
  }
  if (token.type === "html") return decodeEntities((token.text ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]*>/g, " "));
  return typeof token.text === "string" ? decodeEntities(token.text) : " ";
}

function readableNoteBody(note: Note): string {
  const cached = noteTextCache.get(note);
  if (cached?.body === note.body) return cached.text;
  // Interpret formatting before choosing an excerpt. Link destinations/titles
  // (including saved citation payloads) never become searchable visible text.
  const tokens = Lexer.lex(splitMarkdownFrontmatter(note.body).content, { gfm: true });
  const text = tokens.map(tokenText).join(" ").replace(/\s+/gu, " ").trim();
  noteTextCache.set(note, { body: note.body, text });
  return text;
}

export interface LocalSearchMatch<T> {
  item: T;
  score: number;
  snippet: string;
}

export type SpaceSearchMatch =
  | (LocalSearchMatch<Note> & { type: "note" })
  | (LocalSearchMatch<Concept> & { type: "concept" })
  | (LocalSearchMatch<Source> & { type: "source" });

interface SearchField {
  text: string;
  score: number;
  preview?: string;
}

function queryPattern(query: string): RegExp | null {
  const words = query.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return null;
  // Treat input literally while allowing phrases to span line breaks in a
  // preserved PDF/transcript. Search the complete text before bounding excerpts.
  return new RegExp(
    words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"),
    "iu",
  );
}

function excerpt(text: string, offset = 0): string {
  let start = Math.max(0, offset - 64);
  // Avoid cutting an emoji or other supplementary character in half.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) start -= 1;
  const prefix = start > 0 ? "…" : "";
  const raw = text.slice(start, start + SNIPPET_LENGTH * 2);
  const characters = Array.from(raw.replace(/\s+/gu, " ").trim());
  const truncated = start + raw.length < text.length || characters.length + prefix.length > SNIPPET_LENGTH;
  const available = SNIPPET_LENGTH - prefix.length - (truncated ? 1 : 0);
  return prefix + characters.slice(0, available).join("") + (truncated ? "…" : "");
}

function matchFields<T>(
  item: T,
  fields: SearchField[],
  pattern: RegExp | null,
  defaultPreview: string,
): LocalSearchMatch<T> | null {
  if (!pattern) return { item, score: 0, snippet: excerpt(defaultPreview) };
  for (const field of fields) {
    const match = pattern.exec(field.text);
    if (!match) continue;
    return {
      item,
      score: field.score + (match[0].length === field.text.length ? 10 : 0),
      snippet: field.preview ? excerpt(field.preview) : excerpt(field.text, match.index),
    };
  }
  return null;
}

function noteMatch(note: Note, pattern: RegExp | null): LocalSearchMatch<Note> | null {
  const metadata = matchFields(note, [
    { text: note.title, score: 100, preview: note.summary },
    ...note.aliases.map((text) => ({ text, score: 90 })),
    ...note.tags.map((text) => ({ text, score: 80 })),
    { text: note.summary, score: 60 },
  ], pattern, note.summary);
  return metadata ?? matchFields(note, [{ text: readableNoteBody(note), score: 40 }], pattern, "");
}

function sourceMatch(source: Source, pattern: RegExp | null): LocalSearchMatch<Source> | null {
  return matchFields(source, [
    { text: source.title, score: 100, preview: source.fileName ?? source.text },
    { text: source.fileName ?? "", score: 90 },
    { text: source.sourceUrl ?? "", score: 70 },
    { text: source.text, score: 40 },
  ], pattern, source.fileName ?? "Written in Orion");
}

function byScore<T>(left: LocalSearchMatch<T>, right: LocalSearchMatch<T>): number {
  return right.score - left.score;
}

/** Only the supplied Space's notes are searched; no vault or provider access. */
export function searchLocalNotes(notes: readonly Note[], query: string): LocalSearchMatch<Note>[] {
  const pattern = queryPattern(query);
  return notes.flatMap((note) => {
    const match = noteMatch(note, pattern);
    return match ? [match] : [];
  }).sort(byScore);
}

export function searchLocalSources(sources: readonly Source[], query: string): LocalSearchMatch<Source>[] {
  const pattern = queryPattern(query);
  return sources.flatMap((source) => {
    const match = sourceMatch(source, pattern);
    return match ? [match] : [];
  }).sort(byScore);
}

/** Rank across entity kinds before limiting so body hits cannot bury an exact title. */
export function searchLocalSpace(
  snapshot: Pick<AppSnapshot, "notes" | "concepts" | "sources">,
  query: string,
  limit = 12,
): SpaceSearchMatch[] {
  const pattern = queryPattern(query);
  if (!pattern) return [];
  const matches: SpaceSearchMatch[] = [];
  for (const note of snapshot.notes) {
    const match = noteMatch(note, pattern);
    if (match) matches.push({ ...match, type: "note" });
  }
  for (const concept of snapshot.concepts) {
    const match = matchFields(concept, [
      { text: concept.label, score: 100, preview: concept.description },
      ...concept.aliases.map((text) => ({ text, score: 90 })),
      { text: concept.description, score: 60 },
    ], pattern, concept.description);
    if (match) matches.push({ ...match, type: "concept" });
  }
  for (const source of snapshot.sources) {
    const match = sourceMatch(source, pattern);
    if (match) matches.push({ ...match, type: "source" });
  }
  return matches.sort((left, right) => right.score - left.score).slice(0, Math.max(0, limit));
}
