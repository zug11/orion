import type { Source } from "../types";
import {
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
} from "./markdown";

const SOURCE_LINK_PATTERN =
  /\[((?:\\.|[^\]\\])*)\]\(orion-source:\/\/([^) \t\r\n]+)\)/g;
const REFERENCE_HEADING_PATTERN = /^ {0,3}##[ \t]+References[ \t]*\r?$/gm;
const REFERENCE_ITEM_PATTERN =
  /^\s*\d+\.\s+\[((?:\\.|[^\]\\])*)\]\(orion-source:\/\/([^) \t\r\n]+)\)\s*$/;
const REMOVED_CITATION = "\uE000";

interface MarkdownRange {
  start: number;
  end: number;
}

interface TrailingReferences {
  body: string;
  titlesBySourceId: Map<string, string>;
}

export interface SourceCitationReference {
  available: boolean;
  number: number;
  sourceId: string;
  title: string;
}

export interface SourceCitationDocument {
  /** Markdown shown in the word processor, without the generated footer. */
  body: string;
  /** Portable Markdown persisted to the vault and used by exports. */
  markdown: string;
  references: SourceCitationReference[];
}

function unescapeMarkdownLabel(value: string): string {
  return value.replace(/\\([\\\[\]])/g, "$1");
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1").replace(/[\r\n]+/g, " ");
}

function markdownCodeRanges(markdown: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  const patterns = [
    /(^|\n)(?: {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[ \t]*(?=\n|$)|$)/g,
    /(`+)([^`\n]|`(?!\1))*?\1/g,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(markdown)) !== null) {
      ranges.push({
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }

  return ranges.sort((left, right) => left.start - right.start);
}

function isProtectedByCode(
  start: number,
  end: number,
  ranges: readonly MarkdownRange[],
): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

function isProtectedSourceLink(
  markdown: string,
  start: number,
  end: number,
  ranges: readonly MarkdownRange[],
): boolean {
  return (
    markdown[start - 1] === "!" ||
    markdown[start - 1] === "\\" ||
    isProtectedByCode(start, end, ranges)
  );
}

function splitTrailingReferences(markdown: string): TrailingReferences {
  const headings = [...markdown.matchAll(REFERENCE_HEADING_PATTERN)];
  const codeRanges = markdownCodeRanges(markdown);

  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    const headingStart = heading.index ?? 0;
    if (
      isProtectedByCode(
        headingStart,
        headingStart + heading[0].length,
        codeRanges,
      )
    ) {
      continue;
    }
    const afterHeading = markdown.slice(headingStart + heading[0].length);
    const lines = afterHeading
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;

    const parsed = lines.map((line) => line.match(REFERENCE_ITEM_PATTERN));
    if (parsed.some((match) => !match)) continue;

    const titlesBySourceId = new Map<string, string>();
    for (const match of parsed) {
      if (!match) continue;
      titlesBySourceId.set(match[2], unescapeMarkdownLabel(match[1]));
    }

    // The canonical footer is separated from the authored body by exactly two
    // newlines. Remove only that separator so Tiptap's significant table
    // spacing remains byte-for-byte intact.
    const separator = markdown
      .slice(0, headingStart)
      .match(/(?:\r?\n){2}$/)?.[0];
    const separatorStart = separator
      ? headingStart - separator.length
      : headingStart;
    return {
      body: markdown.slice(0, separatorStart),
      titlesBySourceId,
    };
  }

  return { body: markdown, titlesBySourceId: new Map() };
}

function sourceReferenceFooter(
  references: readonly SourceCitationReference[],
): string {
  if (references.length === 0) return "";
  const items = references
    .map(
      (reference) =>
        `${reference.number}. [${escapeMarkdownLabel(reference.title)}](orion-source://${reference.sourceId})`,
    )
    .join("\n");
  return `## References\n\n${items}`;
}

/**
 * Canonicalizes all prose source links to compact first-occurrence numbers and
 * rebuilds a portable References section at the document boundary. The footer
 * is returned separately so the visual editor can keep it read-only.
 */
export function canonicalizeSourceCitations(
  markdown: string,
  sources: readonly Source[],
): SourceCitationDocument {
  const document = splitMarkdownFrontmatter(markdown);
  const trailing = splitTrailingReferences(document.content);
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const codeRanges = markdownCodeRanges(trailing.body);
  const referenceBySourceId = new Map<string, SourceCitationReference>();
  const references: SourceCitationReference[] = [];
  let body = "";
  let cursor = 0;

  SOURCE_LINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_LINK_PATTERN.exec(trailing.body)) !== null) {
    const matchEnd = SOURCE_LINK_PATTERN.lastIndex;
    if (
      isProtectedSourceLink(trailing.body, match.index, matchEnd, codeRanges)
    ) {
      continue;
    }

    const sourceId = match[2];
    let reference = referenceBySourceId.get(sourceId);
    if (!reference) {
      const source = sourceById.get(sourceId);
      const legacyLabel = unescapeMarkdownLabel(match[1]).trim();
      const storedTitle = trailing.titlesBySourceId.get(sourceId)?.trim();
      reference = {
        available: Boolean(source),
        number: references.length + 1,
        sourceId,
        title:
          source?.title.trim() ||
          storedTitle ||
          (/^\d+$/.test(legacyLabel) ? "Unavailable source" : legacyLabel) ||
          "Unavailable source",
      };
      referenceBySourceId.set(sourceId, reference);
      references.push(reference);
    }

    body += trailing.body.slice(cursor, match.index);
    body += `[${reference.number}](orion-source://${sourceId})`;
    cursor = matchEnd;
  }
  body += trailing.body.slice(cursor);

  const footer = sourceReferenceFooter(references);
  const editableBody = restoreMarkdownFrontmatter(document.prefix, body);
  return {
    body: editableBody,
    markdown: restoreMarkdownFrontmatter(
      document.prefix,
      footer ? `${body}\n\n${footer}` : body,
    ),
    references,
  };
}

/**
 * Removes citations to deleted sources. Numeric citation markers disappear;
 * descriptive links created by older Orion builds keep their readable words.
 */
export function removeSourceCitations(
  markdown: string,
  sourceIds: readonly string[],
  remainingSources: readonly Source[],
): string {
  const removedIds = new Set(sourceIds);
  if (removedIds.size === 0) return markdown;

  const document = splitMarkdownFrontmatter(markdown);
  const trailing = splitTrailingReferences(document.content);
  const codeRanges = markdownCodeRanges(trailing.body);
  let foundRemovedSource = sourceIds.some((sourceId) =>
    trailing.titlesBySourceId.has(sourceId),
  );
  let body = "";
  let cursor = 0;

  SOURCE_LINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SOURCE_LINK_PATTERN.exec(trailing.body)) !== null) {
    const matchEnd = SOURCE_LINK_PATTERN.lastIndex;
    if (
      isProtectedSourceLink(trailing.body, match.index, matchEnd, codeRanges) ||
      !removedIds.has(match[2])
    ) {
      continue;
    }

    foundRemovedSource = true;
    body += trailing.body.slice(cursor, match.index);
    const label = unescapeMarkdownLabel(match[1]);
    const isGeneratedNumber =
      /^\s*\d+\s*$/.test(label) &&
      trailing.titlesBySourceId.has(match[2]);
    body += isGeneratedNumber ? REMOVED_CITATION : label;
    cursor = matchEnd;
  }
  if (!foundRemovedSource) return markdown;
  body += trailing.body.slice(cursor);

  body = body
    .replace(new RegExp(`[ \\t]+${REMOVED_CITATION}(?=[ \\t\\n.,;:!?)}\\]])`, "g"), "")
    .replace(new RegExp(REMOVED_CITATION, "g"), "");

  return canonicalizeSourceCitations(
    restoreMarkdownFrontmatter(document.prefix, body),
    remainingSources,
  ).markdown;
}
