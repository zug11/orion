import type {
  AppSnapshot,
  AutoLinkSegment,
  Backlink,
  Concept,
  ConceptReference,
  Note,
  Relationship,
  SearchResult,
  WikiLinkResolution,
} from "../types";
import { splitMarkdownFrontmatter } from "./markdown";
import { visibleNoteTags } from "./noteMetadata";

export interface AutoLinkOptions {
  excludeConceptIds?: ReadonlySet<string>;
  excludeNoteIdFromTargets?: string;
}

export interface RelatedNote {
  note: Note;
  relationship: Relationship;
  direction: "incoming" | "outgoing";
}

export type ConceptDestination =
  | { kind: "note"; noteId: string }
  | { kind: "connections"; noteIds: string[] }
  | { kind: "missing"; noteIds: [] };

interface ProtectedRange {
  start: number;
  end: number;
}

interface LinkCandidate {
  phrase: string;
  normalizedPhrase: string;
  concept: Concept;
  isLabel: boolean;
}

interface CompiledLinkMatcher {
  byNormalizedPhrase: Map<string, LinkCandidate[]>;
  pattern: RegExp | null;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const compiledMatcherCache = new WeakMap<
  readonly Concept[],
  Map<string, CompiledLinkMatcher>
>();
const MARKDOWN_PROTECTED_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /!?\[[^\]\n]*\]\([^)\n]+\)/g,
  /\[\[[^\]\n]+\]\]/g,
  /\b(?:https?:\/\/|mailto:)[^\s<]+/gi,
];

export function decorateAutoLinks(
  text: string,
  concepts: readonly Concept[],
  options: AutoLinkOptions = {},
): AutoLinkSegment[] {
  if (!text) {
    return [];
  }

  const protectedRanges = collectProtectedRanges(text);
  const matcher = getCompiledLinkMatcher(
    concepts,
    options.excludeConceptIds,
    options.excludeNoteIdFromTargets,
  );
  if (!matcher.pattern) {
    return [{ type: "text", text, start: 0, end: text.length }];
  }
  const segments: AutoLinkSegment[] = [];
  let textStart = 0;
  let protectedIndex = 0;
  matcher.pattern.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.pattern.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    while (
      protectedIndex < protectedRanges.length &&
      protectedRanges[protectedIndex].end <= start
    ) {
      protectedIndex += 1;
    }

    const protectedRange = protectedRanges[protectedIndex];
    if (
      protectedRange &&
      start < protectedRange.end &&
      end > protectedRange.start
    ) {
      continue;
    }

    const phraseCandidates =
      matcher.byNormalizedPhrase.get(normalize(match[0])) ?? [];
    const candidate = phraseCandidates.find(
      (item) =>
        candidateMatchesValue(text, start, end, item) &&
        (!options.excludeNoteIdFromTargets ||
          item.concept.noteIds.some(
            (noteId) => noteId !== options.excludeNoteIdFromTargets,
          )),
    );

    if (!candidate) {
      continue;
    }

    if (textStart < start) {
      segments.push({
        type: "text",
        text: text.slice(textStart, start),
        start: textStart,
        end: start,
      });
    }

    const targets = options.excludeNoteIdFromTargets
      ? candidate.concept.noteIds.filter(
          (noteId) => noteId !== options.excludeNoteIdFromTargets,
        )
      : [...candidate.concept.noteIds];

    segments.push({
      type: "concept",
      text: text.slice(start, end),
      start,
      end,
      conceptId: candidate.concept.id,
      targetNoteIds: targets,
      ambiguous:
        targets.length > 1 &&
        (!candidate.concept.canonicalNoteId ||
          !targets.includes(candidate.concept.canonicalNoteId)),
    });

    textStart = end;
  }

  if (textStart < text.length) {
    segments.push({
      type: "text",
      text: text.slice(textStart),
      start: textStart,
      end: text.length,
    });
  }

  return mergeAdjacentTextSegments(segments);
}

export function canonicalConceptNoteId(
  concept: Concept,
  notes: readonly Note[],
): string | null {
  if (!concept.canonicalNoteId) {
    return null;
  }
  const note = notes.find((candidate) => candidate.id === concept.canonicalNoteId);
  if (
    !note ||
    !concept.noteIds.includes(note.id) ||
    normalize(note.title) !== normalize(concept.label)
  ) {
    return null;
  }
  return note.id;
}

export function resolveConceptDestination(
  concept: Concept,
  notes: readonly Note[],
): ConceptDestination {
  const canonicalNoteId = canonicalConceptNoteId(concept, notes);
  if (canonicalNoteId) {
    return { kind: "note", noteId: canonicalNoteId };
  }
  const validNoteIds = unique(concept.noteIds).filter((noteId) =>
    notes.some((note) => note.id === noteId),
  );
  if (validNoteIds.length === 1) {
    return { kind: "note", noteId: validNoteIds[0] };
  }
  if (validNoteIds.length > 1) {
    return { kind: "connections", noteIds: validNoteIds };
  }
  return { kind: "missing", noteIds: [] };
}

export function resolveWikiLink(
  rawLink: string,
  notes: readonly Note[],
  concepts: readonly Concept[],
  start = 0,
): WikiLinkResolution {
  const raw = rawLink.startsWith("[[") && rawLink.endsWith("]]")
    ? rawLink
    : `[[${rawLink}]]`;
  const inner = raw.slice(2, -2);
  const separator = inner.indexOf("|");
  const rawQuery = (separator >= 0 ? inner.slice(0, separator) : inner).trim();
  const label = (separator >= 0 ? inner.slice(separator + 1) : rawQuery).trim();
  const namespaceSeparator = rawQuery.indexOf(":");
  const namespace =
    namespaceSeparator >= 0
      ? rawQuery.slice(0, namespaceSeparator).trim().toLocaleLowerCase()
      : "";
  const query =
    namespace === "note" || namespace === "concept"
      ? rawQuery.slice(namespaceSeparator + 1).trim()
      : rawQuery;

  if (namespace !== "note") {
    const conceptMatches = concepts.filter((concept) =>
      conceptMatchesQuery(concept, query),
    );
    if (conceptMatches.length > 0) {
      const canonicalIds = unique(
        conceptMatches.flatMap((concept) => {
          const canonical = canonicalConceptNoteId(concept, notes);
          return canonical ? [canonical] : [];
        }),
      );
      const noteIds = unique([
        ...canonicalIds,
        ...conceptMatches.flatMap((concept) => concept.noteIds),
      ]).filter((noteId) => notes.some((note) => note.id === noteId));
      return {
        raw,
        query,
        label: label || query,
        start,
        end: start + raw.length,
        kind: "concept",
        conceptId:
          conceptMatches.length === 1 ? conceptMatches[0].id : undefined,
        noteIds,
        ambiguous:
          canonicalIds.length !== 1 &&
          (noteIds.length > 1 || conceptMatches.length > 1),
      };
    }
  }

  if (namespace !== "concept") {
    const noteMatches = notes.filter((note) => noteMatchesQuery(note, query));
    if (noteMatches.length > 0) {
      return {
        raw,
        query,
        label: label || query,
        start,
        end: start + raw.length,
        kind: "note",
        noteIds: noteMatches.map((note) => note.id),
        ambiguous: noteMatches.length > 1,
      };
    }
  }

  return {
    raw,
    query,
    label: label || query,
    start,
    end: start + raw.length,
    kind: "missing",
    noteIds: [],
    ambiguous: false,
  };
}

export function resolveWikiLinks(
  markdown: string,
  notes: readonly Note[],
  concepts: readonly Concept[],
): WikiLinkResolution[] {
  const links: WikiLinkResolution[] = [];
  const pattern = /\[\[[^\]\n]+\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    links.push(resolveWikiLink(match[0], notes, concepts, match.index));
  }

  const markdownLinkPattern =
    /\[([^\]\n]+)\]\(orion-(note|concept):\/\/([^)]+)\)/g;
  while ((match = markdownLinkPattern.exec(markdown)) !== null) {
    const [, label, kind, id] = match;
    if (kind === "note") {
      const target = notes.find((note) => note.id === id);
      links.push({
        raw: match[0],
        query: id,
        label,
        start: match.index,
        end: match.index + match[0].length,
        kind: target ? "note" : "missing",
        noteIds: target ? [target.id] : [],
        ambiguous: false,
      });
      continue;
    }
    const concept = concepts.find((candidate) => candidate.id === id);
    const canonicalId = concept
      ? canonicalConceptNoteId(concept, notes)
      : null;
    const noteIds = concept
      ? unique([
          ...(canonicalId ? [canonicalId] : []),
          ...concept.noteIds.filter((noteId) =>
            notes.some((note) => note.id === noteId),
          ),
        ])
      : [];
    links.push({
      raw: match[0],
      query: id,
      label,
      start: match.index,
      end: match.index + match[0].length,
      kind: concept ? "concept" : "missing",
      conceptId: concept?.id,
      noteIds,
      ambiguous: Boolean(concept && !canonicalId && noteIds.length > 1),
    });
  }
  return links.sort((left, right) => left.start - right.start);
}

export function getBacklinks(
  targetNoteId: string,
  snapshot: Pick<
    AppSnapshot,
    "notes" | "concepts" | "relationships"
  >,
): Backlink[] {
  const targetConceptIds = new Set(
    snapshot.concepts
      .filter((concept) => concept.noteIds.includes(targetNoteId))
      .map((concept) => concept.id),
  );
  const backlinks = new Map<string, Backlink>();

  for (const note of snapshot.notes) {
    if (note.id === targetNoteId) {
      continue;
    }
    const body = splitMarkdownFrontmatter(note.body).content;

    const explicitLink = resolveWikiLinks(
      body,
      snapshot.notes,
      snapshot.concepts,
    ).find((link) => link.noteIds.includes(targetNoteId));

    if (explicitLink) {
      backlinks.set(note.id, {
        noteId: note.id,
        title: note.title,
        excerpt: makeExcerpt(body, explicitLink.label),
        matchedText: explicitLink.label,
        conceptId: explicitLink.conceptId,
        kind: "explicit",
      });
      continue;
    }

    const mention = decorateAutoLinks(body, snapshot.concepts).find(
      (segment) =>
        segment.type === "concept" &&
        targetConceptIds.has(segment.conceptId) &&
        segment.targetNoteIds.includes(targetNoteId),
    );

    if (mention?.type === "concept") {
      backlinks.set(note.id, {
        noteId: note.id,
        title: note.title,
        excerpt: makeExcerpt(body, mention.text),
        matchedText: mention.text,
        conceptId: mention.conceptId,
        kind: "mention",
      });
    }
  }

  for (const relationship of snapshot.relationships) {
    const otherNoteId =
      relationship.toNoteId === targetNoteId
        ? relationship.fromNoteId
        : relationship.fromNoteId === targetNoteId
          ? relationship.toNoteId
          : null;

    if (!otherNoteId || backlinks.has(otherNoteId)) {
      continue;
    }
    const note = snapshot.notes.find((candidate) => candidate.id === otherNoteId);
    if (!note) {
      continue;
    }
    backlinks.set(otherNoteId, {
      noteId: note.id,
      title: note.title,
      excerpt:
        relationship.context ??
        `${note.title} ${relationship.label} this note.`,
      matchedText: relationship.label,
      conceptId: relationship.conceptId,
      kind: "relationship",
    });
  }

  return [...backlinks.values()].sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}

export function getConceptReferences(
  conceptId: string,
  snapshot: Pick<AppSnapshot, "notes" | "concepts">,
): ConceptReference[] {
  const concept = snapshot.concepts.find((item) => item.id === conceptId);
  if (!concept) {
    return [];
  }

  const references: ConceptReference[] = [];
  for (const note of snapshot.notes) {
    const body = splitMarkdownFrontmatter(note.body).content;
    const seen = new Set<string>();
    const explicit = resolveWikiLinks(
      body,
      snapshot.notes,
      snapshot.concepts,
    ).filter((link) => link.conceptId === conceptId);

    for (const link of explicit) {
      const key = `${link.start}:${link.end}`;
      seen.add(key);
      references.push({
        noteId: note.id,
        noteTitle: note.title,
        excerpt: makeExcerpt(body, link.label),
        matchedText: link.label,
        isTarget: concept.noteIds.includes(note.id),
      });
    }

    const mentions = decorateAutoLinks(body, [concept]).filter(
      (segment) => segment.type === "concept",
    );
    for (const mention of mentions) {
      const key = `${mention.start}:${mention.end}`;
      if (seen.has(key)) {
        continue;
      }
      references.push({
        noteId: note.id,
        noteTitle: note.title,
        excerpt: makeExcerpt(body, mention.text),
        matchedText: mention.text,
        isTarget: concept.noteIds.includes(note.id),
      });
    }
  }

  return references;
}

export function getRelatedNotes(
  noteId: string,
  snapshot: Pick<AppSnapshot, "notes" | "relationships">,
): RelatedNote[] {
  const related: RelatedNote[] = [];
  for (const relationship of snapshot.relationships) {
    const direction =
      relationship.fromNoteId === noteId
        ? "outgoing"
        : relationship.toNoteId === noteId
          ? "incoming"
          : null;
    if (!direction) {
      continue;
    }
    const relatedId =
      direction === "outgoing"
        ? relationship.toNoteId
        : relationship.fromNoteId;
    const note = snapshot.notes.find((candidate) => candidate.id === relatedId);
    if (note) {
      related.push({ note, relationship, direction });
    }
  }
  return related.sort(
    (a, b) => b.relationship.strength - a.relationship.strength,
  );
}

export function makeExcerpt(
  markdown: string,
  query = "",
  radius = 92,
): string {
  const text = markdownToPlainText(markdown);
  if (!text) {
    return "";
  }

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchIndex = normalizedQuery
    ? text.toLocaleLowerCase().indexOf(normalizedQuery)
    : 0;
  const center = matchIndex >= 0 ? matchIndex : 0;
  const start = Math.max(0, center - radius);
  const end = Math.min(
    text.length,
    center + Math.max(normalizedQuery.length, 1) + radius,
  );
  const slice = text.slice(start, end);
  const beginning =
    start > 0 ? trimToWordBoundary(slice, "start") : slice.trimStart();
  const ending =
    end < text.length
      ? trimToWordBoundary(beginning, "end")
      : beginning.trimEnd();

  return `${start > 0 ? "…" : ""}${ending}${end < text.length ? "…" : ""}`;
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(
      /\\?\[\\?\[(?:[^|\]\n]+\|)?([^\]\n]+?)\\?\]\\?\]/g,
      "$1",
    )
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function searchWiki(
  query: string,
  snapshot: Pick<AppSnapshot, "notes" | "concepts" | "sources">,
  limit = 12,
): SearchResult[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) {
    return [];
  }
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const results: SearchResult[] = [];

  for (const note of snapshot.notes) {
    const body = splitMarkdownFrontmatter(note.body).content;
    const tags = visibleNoteTags(note);
    const score = scoreFields(normalizedQuery, tokens, {
      title: note.title,
      aliases: note.aliases,
      tags,
      summary: note.summary,
      body,
    });
    if (score > 0) {
      results.push({
        id: note.id,
        kind: "note",
        title: note.title,
        subtitle: tags.slice(0, 2).join(" · ") || "Note",
        excerpt: makeExcerpt(
          body,
          bestExcerptQuery({ ...note, body }, tokens),
        ),
        score,
        noteIds: [note.id],
      });
    }
  }

  for (const concept of snapshot.concepts) {
    if (canonicalConceptNoteId(concept, snapshot.notes)) {
      continue;
    }
    const score = scoreFields(normalizedQuery, tokens, {
      title: concept.label,
      aliases: concept.aliases,
      tags: [],
      summary: concept.description,
      body: "",
    });
    if (score > 0) {
      results.push({
        id: concept.id,
        kind: "concept",
        title: concept.label,
        subtitle: `${concept.noteIds.length} ${
          concept.noteIds.length === 1 ? "destination" : "destinations"
        }`,
        excerpt: concept.description,
        score: score + (concept.noteIds.length > 1 ? 2 : 0),
        noteIds: [...concept.noteIds],
      });
    }
  }

  for (const source of snapshot.sources) {
    const score = scoreFields(normalizedQuery, tokens, {
      title: source.title,
      aliases: source.fileName ? [source.fileName] : [],
      tags: [source.kind],
      summary: "",
      body: source.text,
    });
    if (score > 0) {
      results.push({
        id: source.id,
        kind: "source",
        title: source.title,
        subtitle: source.fileName ?? source.kind,
        excerpt: makeExcerpt(source.text, tokens[0]),
        score: score * 0.85,
        noteIds: [...source.noteIds],
      });
    }
  }

  return results
    .sort(
      (a, b) =>
        b.score - a.score ||
        kindRank(a.kind) - kindRank(b.kind) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, Math.max(0, limit));
}

export function noteHref(note: Pick<Note, "slug">): string {
  return `#/note/${encodeURIComponent(note.slug)}`;
}

function getCompiledLinkMatcher(
  concepts: readonly Concept[],
  excluded: ReadonlySet<string> | undefined,
  excludedTargetNoteId: string | undefined,
): CompiledLinkMatcher {
  if (!excluded) {
    const cacheKey = excludedTargetNoteId ?? "";
    const cached = compiledMatcherCache.get(concepts)?.get(cacheKey);
    if (cached) {
      return cached;
    }
  }
  const candidates: LinkCandidate[] = [];
  for (const concept of concepts) {
    if (
      !concept.autoLink ||
      excluded?.has(concept.id) ||
      (excludedTargetNoteId &&
        concept.canonicalNoteId === excludedTargetNoteId) ||
      (excludedTargetNoteId &&
        !concept.noteIds.some((noteId) => noteId !== excludedTargetNoteId))
    ) {
      continue;
    }
    const phrases = [concept.label, ...concept.aliases];
    const seen = new Set<string>();
    for (const [index, rawPhrase] of phrases.entries()) {
      const phrase = rawPhrase.trim();
      const normalizedPhrase = normalize(phrase);
      if (!phrase || seen.has(normalizedPhrase)) {
        continue;
      }
      seen.add(normalizedPhrase);
      candidates.push({
        phrase,
        normalizedPhrase,
        concept,
        isLabel: index === 0,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      b.phrase.length - a.phrase.length ||
      Number(b.isLabel) - Number(a.isLabel) ||
      a.phrase.localeCompare(b.phrase),
  );
  const byNormalizedPhrase = new Map<string, LinkCandidate[]>();
  const patterns = new Set<string>();
  for (const candidate of candidates) {
    const matching = byNormalizedPhrase.get(candidate.normalizedPhrase) ?? [];
    matching.push(candidate);
    byNormalizedPhrase.set(candidate.normalizedPhrase, matching);
    patterns.add(linkPhrasePattern(candidate.phrase));
  }
  const compiled: CompiledLinkMatcher = {
    byNormalizedPhrase,
    pattern:
      patterns.size > 0
        ? new RegExp(`(?:${[...patterns].join("|")})`, "giu")
        : null,
  };
  if (!excluded) {
    const cacheKey = excludedTargetNoteId ?? "";
    const cache = compiledMatcherCache.get(concepts) ?? new Map();
    cache.set(cacheKey, compiled);
    compiledMatcherCache.set(concepts, cache);
  }
  return compiled;
}

function candidateMatchesValue(
  text: string,
  start: number,
  end: number,
  candidate: LinkCandidate,
): boolean {
  const value = text.slice(start, end);
  if (
    candidate.concept.matchCase
      ? value !== candidate.phrase
      : normalize(value) !== candidate.normalizedPhrase
  ) {
    return false;
  }

  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  const beginsWithWord = WORD_CHARACTER.test(candidate.phrase[0]);
  const endsWithWord = WORD_CHARACTER.test(
    candidate.phrase[candidate.phrase.length - 1],
  );

  return !(
    (beginsWithWord && before && WORD_CHARACTER.test(before)) ||
    (endsWithWord && after && WORD_CHARACTER.test(after))
  );
}

function linkPhrasePattern(phrase: string): string {
  let pattern = "";
  const characters = [...phrase.trim()];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (/\s/u.test(character)) {
      while (
        index + 1 < characters.length &&
        /\s/u.test(characters[index + 1])
      ) {
        index += 1;
      }
      pattern += "\\s+";
      continue;
    }
    if (/[‐‑‒–—−-]/u.test(character)) {
      pattern += "[‐‑‒–—−-]";
      continue;
    }
    if (/['‘’]/u.test(character)) {
      pattern += "['‘’]";
      continue;
    }
    pattern += character.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
  }
  return pattern;
}

function collectProtectedRanges(text: string): ProtectedRange[] {
  const ranges: ProtectedRange[] = [];
  for (const pattern of MARKDOWN_PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);

  const merged: ProtectedRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function mergeAdjacentTextSegments(
  segments: AutoLinkSegment[],
): AutoLinkSegment[] {
  const merged: AutoLinkSegment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (segment.type === "text" && previous?.type === "text") {
      previous.text += segment.text;
      previous.end = segment.end;
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

function conceptMatchesQuery(concept: Concept, query: string): boolean {
  const normalized = normalize(query);
  return (
    normalize(concept.id) === normalized ||
    normalize(concept.id.replace(/^concept-/, "")) === normalized ||
    normalize(concept.label) === normalized ||
    concept.aliases.some((alias) => normalize(alias) === normalized)
  );
}

function noteMatchesQuery(note: Note, query: string): boolean {
  const normalized = normalize(query);
  return (
    normalize(note.id) === normalized ||
    normalize(note.id.replace(/^note-/, "")) === normalized ||
    normalize(note.slug) === normalized ||
    normalize(note.title) === normalized ||
    note.aliases.some((alias) => normalize(alias) === normalized)
  );
}

function scoreFields(
  normalizedQuery: string,
  tokens: readonly string[],
  fields: {
    title: string;
    aliases: readonly string[];
    tags: readonly string[];
    summary: string;
    body: string;
  },
): number {
  const title = normalize(fields.title);
  const aliases = fields.aliases.map(normalize);
  const tags = fields.tags.map(normalize);
  const summary = normalize(fields.summary);
  const body = normalize(markdownToPlainText(fields.body));
  let score = 0;

  if (title === normalizedQuery) {
    score += 140;
  } else if (title.startsWith(normalizedQuery)) {
    score += 90;
  } else if (title.includes(normalizedQuery)) {
    score += 65;
  }
  if (aliases.some((alias) => alias === normalizedQuery)) {
    score += 100;
  } else if (aliases.some((alias) => alias.includes(normalizedQuery))) {
    score += 52;
  }
  if (tags.some((tag) => tag === normalizedQuery)) {
    score += 40;
  }
  if (summary.includes(normalizedQuery)) {
    score += 28;
  }
  if (body.includes(normalizedQuery)) {
    score += 14;
  }

  const searchable = [title, ...aliases, ...tags, summary, body].join(" ");
  const matchedTokens = tokens.filter((token) => searchable.includes(token));
  if (matchedTokens.length !== tokens.length) {
    return 0;
  }
  score += matchedTokens.length * 5;
  return score;
}

function bestExcerptQuery(
  note: Pick<Note, "title" | "aliases" | "body">,
  tokens: readonly string[],
): string {
  const plainBody = normalize(markdownToPlainText(note.body));
  return (
    tokens.find((token) => plainBody.includes(token)) ??
    note.aliases.find((alias) => plainBody.includes(normalize(alias))) ??
    note.title
  );
}

function trimToWordBoundary(
  text: string,
  edge: "start" | "end",
): string {
  if (edge === "start") {
    return text.replace(/^\S+\s+/, "").trimStart();
  }
  return text.replace(/\s+\S+$/, "").trimEnd();
}

function kindRank(kind: SearchResult["kind"]): number {
  if (kind === "note") {
    return 0;
  }
  if (kind === "concept") {
    return 1;
  }
  return 2;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[‘’]/g, "'")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
