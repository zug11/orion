import type { Concept, Note } from "../types";

export interface MarkdownFrontmatter {
  content: string;
  prefix: string;
}

export function splitMarkdownFrontmatter(
  markdown: string,
): MarkdownFrontmatter {
  const match = markdown.match(
    /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)+/,
  );
  if (!match) {
    return { content: markdown, prefix: "" };
  }
  return {
    content: markdown.slice(match[0].length),
    prefix: match[0],
  };
}

export function restoreMarkdownFrontmatter(
  prefix: string,
  content: string,
): string {
  return prefix ? `${prefix}${content}` : content;
}

export function stripOrionNoteMarkers(markdown: string): string {
  const stripped = markdown.replace(
    /^[ \t]*(?:\\?<!--|&lt;!--)[ \t]*orion-note:[^ \t\r\n>]+:(?:start|end)[ \t]*(?:-->|--&gt;)[ \t]*(?:\r?\n)?/gim,
    "",
  );

  // Tiptap's GFM table serializer deliberately places an extra newline around
  // a table. Reformatting every marker-free note here makes the controlled
  // editor see its own update as external content, which reloads the document
  // and moves the caret out of the selected cell. Only repair blank lines when
  // a legacy marker was actually removed.
  return stripped === markdown ? markdown : stripped.replace(/\n{3,}/g, "\n\n");
}

export function stripOrionLinksToTargets(
  markdown: string,
  targets: {
    noteIds?: readonly string[];
    conceptIds?: readonly string[];
    sourceIds?: readonly string[];
  },
): string {
  const noteIds = new Set(targets.noteIds ?? []);
  const conceptIds = new Set(targets.conceptIds ?? []);
  const sourceIds = new Set(targets.sourceIds ?? []);
  if (noteIds.size === 0 && conceptIds.size === 0 && sourceIds.size === 0) {
    return markdown;
  }

  return markdown.replace(
    /\[((?:\\.|[^\]\\])*)\]\(orion-(note|concept|source):\/\/([^) \t\r\n]+)\)/g,
    (link, label: string, kind: string, id: string) => {
      const remove =
        kind === "note"
          ? noteIds.has(id)
          : kind === "concept"
            ? conceptIds.has(id)
            : sourceIds.has(id);
      return remove ? label : link;
    },
  );
}

export function expandOrionWikiLinks(
  body: string,
  notes: readonly Note[],
  concepts: readonly Concept[],
): string {
  const protectedRanges = markdownCodeRanges(body);
  const pattern = /\\?\[\\?\[([^\]\n]+?)\\?\]\\?\]/g;
  let result = "";
  let cursor = 0;
  let protectedIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(body)) !== null) {
    while (
      protectedIndex < protectedRanges.length &&
      protectedRanges[protectedIndex].end <= match.index
    ) {
      protectedIndex += 1;
    }
    const protectedRange = protectedRanges[protectedIndex];
    if (
      protectedRange &&
      match.index < protectedRange.end &&
      pattern.lastIndex > protectedRange.start
    ) {
      continue;
    }

    const parsed = parseWikiLink(match[1]);
    result += body.slice(cursor, match.index);
    result += markdownLinkForWikiTarget(parsed, notes, concepts);
    cursor = pattern.lastIndex;
  }

  return result + body.slice(cursor);
}

export function stripDuplicateTitleHeading(
  body: string,
  title: string,
): string {
  const heading = body.match(/^\s*#\s+([^\n]+)\n*/);
  if (!heading) {
    return body;
  }
  if (normalizeHeading(heading[1]) !== normalizeHeading(title)) {
    return body;
  }
  return body.slice(heading[0].length).replace(/^\n+/, "");
}

function normalizeHeading(value: string): string {
  return value
    .replace(/[*_`~]/g, "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

interface ParsedWikiLink {
  namespace: "note" | "concept" | null;
  query: string;
  label: string;
}

interface MarkdownRange {
  start: number;
  end: number;
}

function parseWikiLink(inner: string): ParsedWikiLink {
  const separator = inner.indexOf("|");
  const rawQuery = (separator >= 0 ? inner.slice(0, separator) : inner).trim();
  const explicitLabel =
    separator >= 0 ? inner.slice(separator + 1).trim() : "";
  const namespaceSeparator = rawQuery.indexOf(":");
  const possibleNamespace =
    namespaceSeparator >= 0
      ? rawQuery.slice(0, namespaceSeparator).trim().toLocaleLowerCase()
      : "";
  const namespace =
    possibleNamespace === "note" || possibleNamespace === "concept"
      ? possibleNamespace
      : null;
  const query = (
    namespace ? rawQuery.slice(namespaceSeparator + 1) : rawQuery
  ).trim();

  return {
    namespace,
    query,
    label: explicitLabel || query,
  };
}

function markdownLinkForWikiTarget(
  link: ParsedWikiLink,
  notes: readonly Note[],
  concepts: readonly Concept[],
): string {
  const label = escapeMarkdownLabel(link.label || link.query);
  const normalizedQuery = normalizeWikiQuery(link.query);

  if (!normalizedQuery) {
    return label;
  }

  if (link.namespace !== "note") {
    const conceptMatches = concepts.filter(
      (concept) =>
        concept.id === link.query ||
        normalizeWikiQuery(concept.label) === normalizedQuery ||
        concept.aliases.some(
          (alias) => normalizeWikiQuery(alias) === normalizedQuery,
        ),
    );
    if (conceptMatches.length === 1) {
      return `[${label}](orion-concept://${conceptMatches[0].id})`;
    }
  }

  if (link.namespace !== "concept") {
    const noteMatches = notes.filter(
      (note) =>
        note.id === link.query ||
        normalizeWikiQuery(note.slug) === normalizedQuery ||
        normalizeWikiQuery(note.title) === normalizedQuery ||
        note.aliases.some(
          (alias) => normalizeWikiQuery(alias) === normalizedQuery,
        ),
    );
    if (noteMatches.length === 1) {
      return `[${label}](orion-note://${noteMatches[0].id})`;
    }
  }

  // Never expose storage syntax in the word-processor surface. Keeping the
  // original note body untouched means this can still become a live link when
  // a matching article or concept is added later.
  return label;
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

function normalizeWikiQuery(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}
