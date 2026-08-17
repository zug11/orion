import type {
  AppSnapshot,
  EntityId,
  ExistingNoteContext,
  Note,
  OrganizedWikiArticle,
} from "../types";
import { noteVersion } from "./knowledgeOrchestration/context";
import { truncateUnicode } from "./text";

/**
 * The legacy organizer receives a compact directory, never an arbitrary run
 * of full note bodies. A byte budget is the primary provider-context boundary;
 * the 71-note threshold merely mirrors the one-range small-Space contract used
 * by typed routing.
 */
export const MAX_COMPACT_ORGANIZER_CONTEXT_BYTES = 56 * 1024;
const SMALL_SPACE_DIRECTORY_LIMIT = 71;
const MAX_MATCH_TEXT_CHARS = 96_000;
const MAX_SUMMARY_CHARS = 560;
const MAX_SKETCH_CHARS = 720;

export interface CompactOrganizerContextOptions {
  /** Text that determines relevance without ever leaving the local process. */
  matchText?: string;
  /** Notes whose graph neighbours should be treated as high-confidence anchors. */
  focusNoteIds?: readonly EntityId[];
  /** Additional notes that must be considered before lexical candidates. */
  anchorNoteIds?: readonly EntityId[];
  excludeNoteIds?: readonly EntityId[];
}

interface ContextCandidate {
  context: ExistingNoteContext;
  score: number;
  anchored: boolean;
}

interface CompactDigestIndexes {
  conceptLabelsByNoteId: ReadonlyMap<EntityId, readonly string[]>;
  relationshipHintsByNoteId: ReadonlyMap<EntityId, readonly string[]>;
}

/**
 * Builds deterministic, metadata-first context for organizer fallbacks.
 * Small Spaces can send their complete compact directory. Larger Spaces first
 * contract locally to graph anchors and positive semantic matches, then fit the
 * resulting manifests into a strict serialized-byte budget.
 */
export function buildCompactOrganizerContext(
  snapshot: AppSnapshot,
  options: CompactOrganizerContextOptions = {},
): ExistingNoteContext[] | undefined {
  if (!snapshot.settings.includeExistingNotesInAIContext) return undefined;

  const excluded = new Set(options.excludeNoteIds ?? []);
  const focusNoteIds = new Set(options.focusNoteIds ?? []);
  const anchors = collectAnchorNoteIds(snapshot, focusNoteIds);
  for (const noteId of options.anchorNoteIds ?? []) anchors.add(noteId);
  for (const noteId of snapshot.spaceOverview?.relatedNoteIds ?? []) {
    anchors.add(noteId);
  }
  for (const noteId of focusNoteIds) anchors.delete(noteId);
  for (const noteId of excluded) anchors.delete(noteId);

  const eligibleNotes = snapshot.notes.filter(
    (note) => !excluded.has(note.id) && isContextEligible(note),
  );
  if (eligibleNotes.length === 0) return undefined;

  const noteById = new Map(snapshot.notes.map((note) => [note.id, note]));
  const indexes = buildDigestIndexes(snapshot, noteById);
  const match = buildMatchIndex(options.matchText ?? "");
  const includeCompleteDirectory = eligibleNotes.length <= SMALL_SPACE_DIRECTORY_LIMIT;
  const candidates = eligibleNotes
    .map((note): ContextCandidate => {
      const context = compactNoteContext(note, indexes);
      const anchored = anchors.has(note.id);
      return {
        context,
        anchored,
        score: (anchored ? 10_000 : 0) + scoreContext(context, match),
      };
    })
    .filter(({ anchored, score }) => includeCompleteDirectory || anchored || score > 0)
    .sort(compareCandidates);

  return fitCompactOrganizerContext(candidates.map(({ context }) => context));
}

/**
 * Keeps canonical articles produced earlier in the same import batch visible
 * to later sources, but only as compact records. New records take priority over
 * older directory entries when the byte budget is full.
 */
export function mergeGeneratedOrganizerArticles(
  existing: readonly ExistingNoteContext[] | undefined,
  articles: readonly OrganizedWikiArticle[],
): ExistingNoteContext[] | undefined {
  if (!existing || articles.length === 0) return existing ? [...existing] : undefined;

  const generated: ExistingNoteContext[] = [];
  const replacedKeys = new Set<string>();
  const byKey = new Map(
    existing.flatMap((context) =>
      [context.title, ...context.aliases].map((value) => [normalize(value), context] as const),
    ),
  );

  for (const article of articles) {
    const title = truncateUnicode(article.title.trim(), 240);
    if (!title) continue;
    const key = normalize(title);
    const prior = byKey.get(key);
    const aliases = uniqueBoundedStrings(
      [...article.aliases, ...(prior?.aliases ?? [])],
      12,
      180,
    );
    const body = markdownPlainText(article.body);
    const semanticSketch = wholeBodySketch(body);
    const summary = truncateUnicode(
      article.summary.trim() || semanticSketch || prior?.summary || "",
      MAX_SUMMARY_CHARS,
    );
    const context: ExistingNoteContext = {
      id: prior?.id ?? `pending-wiki:${key}`,
      title,
      aliases,
      summary,
      reference: true,
      tags: uniqueBoundedStrings(article.tags, 12, 100),
      headings: markdownHeadings(article.body),
      conceptLabels: prior?.conceptLabels ? [...prior.conceptLabels] : [],
      relationshipHints: prior?.relationshipHints
        ? [...prior.relationshipHints]
        : [],
      semanticSketch,
      bodyCharacters: article.body.length,
      digestQuality:
        summary.length >= 40 && semanticSketch.length >= 80 ? "strong" : "weak",
    };
    generated.push(context);
    for (const value of [prior?.title ?? "", ...(prior?.aliases ?? []), title, ...aliases]) {
      if (value) replacedKeys.add(normalize(value));
    }
  }

  const untouched = existing.filter(
    (context) =>
      ![context.title, ...context.aliases].some((value) =>
        replacedKeys.has(normalize(value)),
      ),
  );
  return fitCompactOrganizerContext([...generated, ...untouched]);
}

export function compactOrganizerContextBytes(
  contexts: readonly ExistingNoteContext[],
): number {
  return new TextEncoder().encode(JSON.stringify(contexts)).byteLength;
}

function fitCompactOrganizerContext(
  contexts: readonly ExistingNoteContext[],
): ExistingNoteContext[] | undefined {
  const selected: ExistingNoteContext[] = [];
  for (const context of contexts) {
    const next = [...selected, context];
    if (compactOrganizerContextBytes(next) <= MAX_COMPACT_ORGANIZER_CONTEXT_BYTES) {
      selected.push(context);
    }
  }
  return selected.length > 0 ? selected : undefined;
}

function compactNoteContext(
  note: Note,
  indexes: CompactDigestIndexes,
): ExistingNoteContext {
  const plainBody = markdownPlainText(note.body);
  const semanticSketch = wholeBodySketch(plainBody);
  const summary = truncateUnicode(
    note.summary.trim() || semanticSketch,
    MAX_SUMMARY_CHARS,
  );
  return {
    id: note.id,
    version: noteVersion(note),
    title: truncateUnicode(note.title.trim(), 240),
    aliases: uniqueBoundedStrings(note.aliases, 12, 180),
    summary,
    reference: note.kind === "wiki",
    tags: uniqueBoundedStrings(note.tags, 12, 100),
    headings: markdownHeadings(note.body),
    conceptLabels: [
      ...(indexes.conceptLabelsByNoteId.get(note.id) ?? []),
    ],
    relationshipHints: [
      ...(indexes.relationshipHintsByNoteId.get(note.id) ?? []),
    ],
    semanticSketch,
    bodyCharacters: note.body.length,
    digestQuality:
      summary.length >= 40 && semanticSketch.length >= 80 ? "strong" : "weak",
  };
}

function buildDigestIndexes(
  snapshot: AppSnapshot,
  noteById: ReadonlyMap<EntityId, Note>,
): CompactDigestIndexes {
  const conceptLabels = new Map<EntityId, string[]>();
  const relationships = new Map<EntityId, string[]>();
  const conceptById = new Map(
    snapshot.concepts.map((concept) => [concept.id, concept] as const),
  );
  const append = (
    index: Map<EntityId, string[]>,
    noteId: EntityId,
    value: string,
    maximum: number,
  ) => {
    if (!noteById.has(noteId)) return;
    const values = index.get(noteId) ?? [];
    const bounded = truncateUnicode(value.trim(), 220);
    if (!bounded || values.includes(bounded) || values.length >= maximum) return;
    values.push(bounded);
    index.set(noteId, values);
  };

  for (const concept of snapshot.concepts) {
    const noteIds = new Set(concept.noteIds);
    if (concept.canonicalNoteId) noteIds.add(concept.canonicalNoteId);
    for (const noteId of noteIds) append(conceptLabels, noteId, concept.label, 20);
  }
  for (const note of snapshot.notes) {
    for (const conceptId of note.conceptIds) {
      const concept = conceptById.get(conceptId);
      if (concept) append(conceptLabels, note.id, concept.label, 20);
    }
  }
  for (const relationship of snapshot.relationships) {
    const source = noteById.get(relationship.fromNoteId);
    const target = noteById.get(relationship.toNoteId);
    if (!source || !target) continue;
    const label = relationship.label.trim() ? ` (${relationship.label.trim()})` : "";
    append(
      relationships,
      source.id,
      `${relationship.kind}: ${target.title}${label}`,
      16,
    );
    append(
      relationships,
      target.id,
      `${relationship.kind} from ${source.title}${label}`,
      16,
    );
  }
  return {
    conceptLabelsByNoteId: conceptLabels,
    relationshipHintsByNoteId: relationships,
  };
}

function isContextEligible(note: Note): boolean {
  return (
    note.status !== "archived" &&
    !note.tags.includes("orion-link-pending") &&
    !note.tags.includes("orion-link-draft") &&
    !/<!--\s*orion-link-(?:pending|draft)\s*-->/i.test(note.body)
  );
}

function collectAnchorNoteIds(
  snapshot: AppSnapshot,
  focusNoteIds: ReadonlySet<EntityId>,
): Set<EntityId> {
  const anchors = new Set<EntityId>();
  if (focusNoteIds.size === 0) return anchors;
  for (const relationship of snapshot.relationships) {
    if (focusNoteIds.has(relationship.fromNoteId)) anchors.add(relationship.toNoteId);
    if (focusNoteIds.has(relationship.toNoteId)) anchors.add(relationship.fromNoteId);
  }
  for (const concept of snapshot.concepts) {
    const noteIds = new Set(concept.noteIds);
    if (concept.canonicalNoteId) noteIds.add(concept.canonicalNoteId);
    if ([...noteIds].some((noteId) => focusNoteIds.has(noteId))) {
      for (const noteId of noteIds) anchors.add(noteId);
    }
  }
  return anchors;
}

function markdownHeadings(markdown: string): string[] {
  return uniqueBoundedStrings(
    [...markdown.matchAll(/^#{1,3}\s+(.+)$/gm)].map((match) => match[1]),
    16,
    180,
  );
}

function markdownPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Samples the beginning, middle, and end instead of treating a prefix as a summary. */
function wholeBodySketch(plainBody: string): string {
  if (plainBody.length <= MAX_SKETCH_CHARS) return plainBody;
  const sampleLength = 170;
  const starts = [
    0,
    Math.floor(plainBody.length / 3),
    Math.floor((plainBody.length * 2) / 3),
    Math.max(0, plainBody.length - sampleLength),
  ];
  return truncateUnicode(
    starts
      .map((start) => plainBody.slice(start, start + sampleLength).trim())
      .filter(Boolean)
      .join(" … "),
    MAX_SKETCH_CHARS,
  );
}

function buildMatchIndex(raw: string): {
  padded: string;
  tokens: ReadonlySet<string>;
} {
  const sampled = wholeTextMatchSample(raw);
  const normalized = normalize(sampled);
  return {
    padded: ` ${normalized} `,
    tokens: new Set(
      normalized.split(" ").filter((token) => token.length >= 5),
    ),
  };
}

function wholeTextMatchSample(value: string): string {
  if (value.length <= MAX_MATCH_TEXT_CHARS) return value;
  const quarter = Math.floor(MAX_MATCH_TEXT_CHARS / 4);
  return [
    value.slice(0, quarter),
    value.slice(Math.floor(value.length / 3), Math.floor(value.length / 3) + quarter),
    value.slice(
      Math.floor((value.length * 2) / 3),
      Math.floor((value.length * 2) / 3) + quarter,
    ),
    value.slice(-quarter),
  ].join(" ");
}

function scoreContext(
  context: ExistingNoteContext,
  match: { padded: string; tokens: ReadonlySet<string> },
): number {
  const phraseScore = (value: string, weight: number) => {
    const phrase = normalize(value);
    return phrase && match.padded.includes(` ${phrase} `) ? weight : 0;
  };
  const semanticTokens = new Set(
    normalize(
      [context.summary, context.semanticSketch ?? "", ...(context.headings ?? [])].join(" "),
    )
      .split(" ")
      .filter((token) => token.length >= 5),
  );
  const overlap = [...semanticTokens].reduce(
    (total, token) => total + (match.tokens.has(token) ? 2 : 0),
    0,
  );
  return (
    phraseScore(context.title, 100) +
    context.aliases.reduce((total, alias) => total + phraseScore(alias, 64), 0) +
    (context.conceptLabels ?? []).reduce(
      (total, label) => total + phraseScore(label, 36),
      0,
    ) +
    (context.tags ?? []).reduce(
      (total, tag) => total + phraseScore(tag, 18),
      0,
    ) +
    Math.min(overlap, 48)
  );
}

function compareCandidates(left: ContextCandidate, right: ContextCandidate): number {
  return (
    Number(right.anchored) - Number(left.anchored) ||
    right.score - left.score ||
    Number(right.context.reference) - Number(left.context.reference) ||
    left.context.title.localeCompare(right.context.title) ||
    left.context.id.localeCompare(right.context.id)
  );
}

function uniqueBoundedStrings(
  values: readonly string[],
  maximum: number,
  maximumCharacters: number,
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = truncateUnicode(raw.trim(), maximumCharacters);
    const key = normalize(value);
    if (!value || seen.has(key)) continue;
    selected.push(value);
    seen.add(key);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
