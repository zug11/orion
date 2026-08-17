import type { ExistingNoteContext, OrganizeContentResult } from "../types";
import { truncateUnicode } from "./text";

export const LONG_DOCUMENT_MIN_CHARS = 60_000;
export const LONG_DOCUMENT_TARGET_SECTION_CHARS = 45_000;
// Twelve logical readings fit in two six-wide waves for the ordinary case,
// leaving the fixed exploration window useful for Space routing and synthesis.
export const LONG_DOCUMENT_MAX_SECTIONS = 12;
export const LONG_DOCUMENT_CONCURRENCY = 6;
export const PARALLEL_READING_MIN_PAGES = 4;
export const PARALLEL_READING_TARGET_PAGES = 2;

const PAGE_HEADING_PATTERN = /^## Page (\d+)\s*$/gm;
const MAX_SECTION_DOSSIER_CHARS = 8_000;
const MAX_SYNTHESIS_CHARS = 96_000;

export interface LongDocumentSection {
  index: number;
  total: number;
  content: string;
  pageStart?: number;
  pageEnd?: number;
}

export interface LongDocumentSectionOutcome<T> {
  section: LongDocumentSection;
  value?: T;
  error?: unknown;
}

interface TextBlock {
  content: string;
  pageNumber?: number;
}

export function isLongDocument(text: string): boolean {
  return text.length > LONG_DOCUMENT_MIN_CHARS;
}

export function splitLongDocument(
  text: string,
  maximumSections = LONG_DOCUMENT_MAX_SECTIONS,
): LongDocumentSection[] {
  if (!isLongDocument(text)) return [];
  const requestedCount = longDocumentSectionCount(text.length, maximumSections);
  return splitDocumentIntoReadingSections(text, requestedCount);
}

/**
 * Splits a document into an exact number of complete, ordered reading ranges.
 * The orchestration planner uses this after calculating payload-safe minimums;
 * keeping the exact splitter here preserves PDF page metadata and the same
 * Unicode-safe hard-boundary behavior used by ordinary long-document imports.
 */
export function splitDocumentIntoReadingSections(
  text: string,
  requestedCount: number,
): LongDocumentSection[] {
  if (!text) return [];
  const boundedCount = Math.max(
    1,
    Math.min(LONG_DOCUMENT_MAX_SECTIONS, Math.floor(requestedCount), text.length),
  );
  const pages = pageBlocks(text);
  if (pages) {
    return splitIntoSections(
      text,
      pageAwareBlocksForCount(pages, boundedCount),
      boundedCount,
    );
  }
  return splitUnpagedTextWithFullCoverage(text, boundedCount);
}

/**
 * Installed knowledge imports may parallelize a modest page-aware document
 * before it reaches the legacy 60k-character long-document threshold. Text
 * without stable page boundaries keeps the direct one-call fast path.
 */
export function splitDocumentForParallelReading(
  text: string,
  maximumSections = LONG_DOCUMENT_MAX_SECTIONS,
): LongDocumentSection[] {
  const boundedMaximum = Math.max(
    1,
    Math.min(LONG_DOCUMENT_MAX_SECTIONS, Math.floor(maximumSections)),
  );
  if (isLongDocument(text)) return splitLongDocument(text, boundedMaximum);
  const pages = pageBlocks(text);
  if (!pages || pages.length < PARALLEL_READING_MIN_PAGES) return [];
  const requestedCount = Math.min(
    boundedMaximum,
    pages.length,
    Math.ceil(pages.length / PARALLEL_READING_TARGET_PAGES),
  );
  return splitDocumentIntoReadingSections(text, requestedCount);
}

function splitIntoSections(
  text: string,
  blocks: TextBlock[],
  requestedCount = Math.max(
    2,
    Math.min(
      LONG_DOCUMENT_MAX_SECTIONS,
      Math.ceil(text.length / LONG_DOCUMENT_TARGET_SECTION_CHARS),
      blocks.length,
    ),
  ),
): LongDocumentSection[] {
  if (blocks.length === 0 || requestedCount < 1) return [];
  requestedCount = Math.min(requestedCount, blocks.length);
  const groups: TextBlock[][] = [];
  let cursor = 0;
  let remainingCharacters = blocks.reduce(
    (total, block) => total + block.content.length,
    0,
  );

  for (let groupIndex = 0; groupIndex < requestedCount; groupIndex += 1) {
    const sectionsRemaining = requestedCount - groupIndex;
    const blocksRemaining = blocks.length - cursor;
    const target = remainingCharacters / sectionsRemaining;
    const maximumBlocks = blocksRemaining - (sectionsRemaining - 1);
    const group: TextBlock[] = [];
    let characters = 0;
    while (group.length < maximumBlocks) {
      const block = blocks[cursor + group.length];
      if (!block) break;
      group.push(block);
      characters += block.content.length;
      if (characters >= target) break;
    }
    cursor += group.length;
    remainingCharacters -= characters;
    groups.push(group);
  }

  return groups.map((group, index) => {
    const pageNumbers = group.flatMap(({ pageNumber }) =>
      pageNumber === undefined ? [] : [pageNumber],
    );
    return {
      index,
      total: groups.length,
      content: group.map(({ content }) => content).join(""),
      ...(pageNumbers.length > 0
        ? {
            pageStart: pageNumbers[0],
            pageEnd: pageNumbers[pageNumbers.length - 1],
          }
        : {}),
    };
  });
}

function longDocumentSectionCount(
  textLength: number,
  maximumSections: number,
): number {
  const boundedMaximum = Math.max(
    1,
    Math.min(LONG_DOCUMENT_MAX_SECTIONS, Math.floor(maximumSections)),
  );
  return Math.min(
    boundedMaximum,
    Math.max(2, Math.ceil(textLength / LONG_DOCUMENT_TARGET_SECTION_CHARS)),
  );
}

function pageAwareBlocksForCount(
  pages: TextBlock[],
  requestedCount: number,
): TextBlock[] {
  if (pages.length >= requestedCount) return pages;
  const counts = pages.map(() => 1);
  for (let allocated = pages.length; allocated < requestedCount; allocated += 1) {
    let selected = 0;
    for (let index = 1; index < pages.length; index += 1) {
      if (
        pages[index].content.length / counts[index] >
        pages[selected].content.length / counts[selected]
      ) {
        selected = index;
      }
    }
    counts[selected] += 1;
  }
  return pages.flatMap((page, index) =>
    splitUnpagedTextWithFullCoverage(page.content, counts[index]).map(
      ({ content }) => ({ content, pageNumber: page.pageNumber }),
    ),
  );
}

/**
 * Produces exact, ordered coverage even when extracted text has no page or
 * paragraph structure (for example CSV, minified JSON, OCR, or transcripts).
 * Preferred prose boundaries are used near each balanced target; a Unicode-
 * safe hard boundary is the deterministic last resort.
 */
function splitUnpagedTextWithFullCoverage(
  text: string,
  requestedCount: number,
): LongDocumentSection[] {
  const sectionCount = Math.min(
    Math.max(1, requestedCount),
    text.length,
  );
  const boundaries = [0];
  const averageSectionLength = text.length / sectionCount;
  const searchRadius = Math.min(
    24_000,
    Math.max(1_024, Math.floor(averageSectionLength / 3)),
  );

  for (let index = 1; index < sectionCount; index += 1) {
    const previous = boundaries[boundaries.length - 1];
    const sectionsAfterBoundary = sectionCount - index;
    const minimum = previous + 1;
    const maximum = text.length - sectionsAfterBoundary;
    const balancedTarget = Math.round((text.length * index) / sectionCount);
    const target = Math.max(minimum, Math.min(maximum, balancedTarget));
    const preferred = findPreferredTextBoundary(
      text,
      target,
      minimum,
      maximum,
      searchRadius,
    );
    boundaries.push(
      avoidSplittingSurrogatePair(
        text,
        preferred ?? target,
        minimum,
        maximum,
      ),
    );
  }
  boundaries.push(text.length);

  return boundaries.slice(0, -1).map((start, index) => ({
    index,
    total: sectionCount,
    content: text.slice(start, boundaries[index + 1]),
  }));
}

const TEXT_BOUNDARY_PATTERNS = [
  /\r?\n(?:[ \t]*\r?\n)+/g,
  /\r?\n/g,
  /[.!?…](?:["'’”)\]}]*)[ \t]+/g,
  /[ \t\f\v]+/g,
  /[,;}\]](?=[\[{("'A-Za-z0-9_-])/g,
] as const;

function findPreferredTextBoundary(
  text: string,
  target: number,
  minimum: number,
  maximum: number,
  radius: number,
): number | undefined {
  const searchStart = Math.max(minimum, target - radius);
  const searchEnd = Math.min(maximum, target + radius);
  const window = text.slice(searchStart, searchEnd);

  for (const pattern of TEXT_BOUNDARY_PATTERNS) {
    const matches = window.matchAll(pattern);
    let best: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const match of matches) {
      const candidate =
        searchStart + (match.index ?? 0) + match[0].length;
      if (candidate < minimum || candidate > maximum) continue;
      const distance = Math.abs(candidate - target);
      if (
        distance < bestDistance ||
        (distance === bestDistance && (best === undefined || candidate < best))
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

function avoidSplittingSurrogatePair(
  text: string,
  boundary: number,
  minimum: number,
  maximum: number,
): number {
  const previous = text.charCodeAt(boundary - 1);
  const next = text.charCodeAt(boundary);
  const splitsPair =
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff;
  if (!splitsPair) return boundary;
  if (boundary + 1 <= maximum) return boundary + 1;
  if (boundary - 1 >= minimum) return boundary - 1;
  return boundary;
}

export async function mapLongDocumentSections<T>(
  sections: readonly LongDocumentSection[],
  worker: (section: LongDocumentSection) => Promise<T>,
  onProgress?: (completed: number, total: number) => void,
  concurrency = LONG_DOCUMENT_CONCURRENCY,
): Promise<LongDocumentSectionOutcome<T>[]> {
  const outcomes = new Array<LongDocumentSectionOutcome<T>>(sections.length);
  let cursor = 0;
  let completed = 0;
  const workerCount = Math.min(
    sections.length,
    Math.max(1, Math.floor(concurrency)),
  );
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < sections.length) {
        const position = cursor;
        cursor += 1;
        const section = sections[position];
        try {
          outcomes[position] = { section, value: await worker(section) };
        } catch (error) {
          outcomes[position] = { section, error };
        } finally {
          completed += 1;
          onProgress?.(completed, sections.length);
        }
      }
    }),
  );
  return outcomes;
}

export function longDocumentSectionInstructions(
  documentTitle: string,
  section: LongDocumentSection,
  importInstructions: string,
): string {
  const pageRange = sectionPageRange(section);
  return [
    `Long-document reading pass ${section.index + 1} of ${section.total}${pageRange ? ` (${pageRange})` : ""} for “${documentTitle}”.`,
    "This is an evidence-gathering pass, not the final note-writing pass. Read this section closely and return one to three compact analytical notes that preserve its arguments, distinctions, examples, named concepts, and uncertainties. Keep visible PDF page references when the supplied text provides them. Do not repeat generic background, invent missing context, or attempt to summarize sections you have not received. The later Orion editor will reconcile this packet with every other section.",
    importInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildLongDocumentSynthesis(
  documentTitle: string,
  sections: readonly LongDocumentSectionOutcome<OrganizeContentResult>[],
): string {
  const successful = sections.filter(
    (
      outcome,
    ): outcome is LongDocumentSectionOutcome<OrganizeContentResult> & {
      value: OrganizeContentResult;
    } => Boolean(outcome.value),
  );
  const packets = successful.map(({ section, value }) => {
    const packet = JSON.stringify({
      section: section.index + 1,
      totalSections: section.total,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      analyticalNotes: value.notes.map(({ title, summary, body }) => ({
        title,
        summary,
        body,
      })),
      articleCandidates: value.wikiArticles.map(
        ({ title, summary, overview, spaceRelevance }) => ({
          title,
          summary,
          overview,
          spaceRelevance,
        }),
      ),
      concepts: value.concepts.map(
        ({ label, aliases, description, canonicalTitle, relatedTitles }) => ({
          label,
          aliases,
          description,
          canonicalTitle,
          relatedTitles,
        }),
      ),
    });
    return truncateUnicode(packet, MAX_SECTION_DOSSIER_CHARS);
  });
  return truncateUnicode(
    [
      `# Reading map for ${documentTitle}`,
      "The following ordered evidence packets were produced independently from sections of one long source. They are intermediate reading records, not final notes. Reconcile repetition and preserve disagreements or changes across sections.",
      ...packets.map(
        (packet, index) =>
          `## Evidence packet ${index + 1} of ${packets.length}\n\n${packet}`,
      ),
    ].join("\n\n"),
    MAX_SYNTHESIS_CHARS,
  );
}

export function longDocumentSynthesisInstructions(
  documentTitle: string,
  successfulSections: number,
  totalSections: number,
  importInstructions: string,
): string {
  return [
    `Final editorial synthesis for the long document “${documentTitle}”. Orion successfully read ${successfulSections} of ${totalSections} sections in independent passes.`,
    "Turn the ordered evidence packets into a small, coherent set of durable notes for the complete source. Prefer the document's real chapter or argument structure over one note per packet. Merge repeated claims, preserve meaningful tensions and development across sections, and create canonical wiki articles only for genuinely reusable concepts. Do not mention workers, packets, chunking, or this synthesis process in the finished prose. Do not copy the evidence packets verbatim. If a section is missing, state uncertainty only where it materially affects a note and never fabricate its contents.",
    importInstructions,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function relevantExistingNotesForSynthesis(
  notes: readonly ExistingNoteContext[] | undefined,
  synthesis: string,
  maximum = 16,
): ExistingNoteContext[] | undefined {
  if (!notes?.length) return undefined;
  const haystack = ` ${normalizeForMatch(synthesis)} `;
  const scored = notes
    .map((note, order) => {
      const phrases = [note.title, ...note.aliases]
        .map(normalizeForMatch)
        .filter((phrase) => phrase.length >= 3);
      const phraseScore = phrases.reduce(
        (score, phrase, index) =>
          score + (haystack.includes(` ${phrase} `) ? (index === 0 ? 20 : 14) : 0),
        0,
      );
      const summaryTokens = new Set(
        normalizeForMatch(note.summary)
          .split(" ")
          .filter((token) => token.length >= 5),
      );
      const overlap = [...summaryTokens].filter((token) =>
        haystack.includes(` ${token} `),
      ).length;
      return { note, order, score: phraseScore + Math.min(overlap, 8) };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, maximum)
    .map(({ note }) => note);
  return scored.length > 0 ? scored : undefined;
}

export function sectionPageRange(section: LongDocumentSection): string {
  if (section.pageStart === undefined) return "";
  return section.pageEnd === section.pageStart || section.pageEnd === undefined
    ? `page ${section.pageStart}`
    : `pages ${section.pageStart}–${section.pageEnd}`;
}

function pageBlocks(text: string): TextBlock[] | null {
  const matches = [...text.matchAll(PAGE_HEADING_PATTERN)];
  if (matches.length < 2) return null;
  return matches.map((match, index) => {
    const start = index === 0 ? 0 : (match.index ?? 0);
    const end = matches[index + 1]?.index ?? text.length;
    return {
      content: text.slice(start, end),
      pageNumber: Number(match[1]),
    };
  });
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
