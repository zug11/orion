import type { OrganizeContentResult, OrganizedNote } from "../../types";
import type { KnowledgeImportSourceInput } from "./context";
import type { CompletedSourceReading } from "./blueprintImport";
import type { KnowledgeResultProvenance } from "./protocol";

/**
 * Deterministic landing assembly: when a knowledge run cannot finish, Orion
 * still delivers bounded notes without any provider call. Tier 1 composes
 * idea-first notes only from validated synthesis seeds and their exact source
 * claims; tier 2 preserves parsed source text structurally. Neither tier
 * fabricates prose.
 */

const LANDED_SUMMARY_LIMIT = 300;
const LANDED_STRUCTURAL_BODY_LIMIT = 60_000;
const LANDED_NOTE_LIMIT = 30;

export interface KnowledgeLandingAssembly {
  result: OrganizeContentResult;
  provenance: KnowledgeResultProvenance[];
  warnings: string[];
}

export function assembleDeterministicLanding(
  sources: readonly KnowledgeImportSourceInput[],
  readings: readonly CompletedSourceReading[],
): KnowledgeLandingAssembly {
  const readingsBySource = new Map<string, CompletedSourceReading[]>();
  for (const completed of readings) {
    const bucket = readingsBySource.get(completed.reading.sourceId) ?? [];
    bucket.push(completed);
    readingsBySource.set(completed.reading.sourceId, bucket);
  }
  const allocateTitle = createLandingTitleAllocator();
  const notes: OrganizedNote[] = [];
  const provenance: KnowledgeResultProvenance[] = [];
  const warnings: string[] = [];
  const semanticCandidates: Array<{
    sourceId: string;
    sourceIndex: number;
    order: number;
    importance: number;
    title: string;
    thesis: string;
    claims: string[];
    artifactIds: string[];
  }> = [];
  const structuralSources: Array<{
    source: KnowledgeImportSourceInput;
    sourceIndex: number;
  }> = [];

  sources.forEach((source, sourceIndex) => {
    const completed = [...(readingsBySource.get(source.sourceId) ?? [])].sort(
      (left, right) =>
        rangeOrdinal(left.reading.rangeId) - rangeOrdinal(right.reading.rangeId),
    );
    if (completed.length === 0) {
      structuralSources.push({ source, sourceIndex });
      return;
    }
    const groups = new Map<string, (typeof semanticCandidates)[number]>();
    let order = 0;
    for (const { artifact, reading } of completed) {
      const claims = new Map(
        reading.sourceClaims.map((claim) => [claim.claimId, claim.text] as const),
      );
      for (const seed of reading.synthesisSeeds) {
        // A repeated title does not prove that two ideas are interchangeable.
        // Only an identical thesis permits local coalescing without a writer.
        const key = JSON.stringify([
          normalizedTitle(seed.proposedTitle),
          normalizedParagraph(seed.thesis),
        ]);
        const selectedClaims = seed.claimIds.flatMap((claimId) => {
          const claim = claims.get(claimId);
          return claim ? [claim] : [];
        });
        const existing = groups.get(key);
        if (existing) {
          existing.claims = uniqueStrings([...existing.claims, ...selectedClaims]);
          existing.artifactIds = uniqueStrings([
            ...existing.artifactIds,
            artifact.artifactId,
          ]);
          existing.importance = Math.max(
            existing.importance,
            landingImportance(seed.importance),
          );
          continue;
        }
        groups.set(key, {
          sourceId: source.sourceId,
          sourceIndex,
          order,
          importance: landingImportance(seed.importance),
          title: seed.proposedTitle,
          thesis: seed.thesis,
          claims: uniqueStrings(selectedClaims),
          artifactIds: [artifact.artifactId],
        });
        order += 1;
      }
    }
    if (groups.size === 0) structuralSources.push({ source, sourceIndex });
    else semanticCandidates.push(...groups.values());
  });

  const selectedStructuralSources = structuralSources.slice(0, LANDED_NOTE_LIMIT);
  const semanticCapacity = Math.max(
    0,
    LANDED_NOTE_LIMIT - selectedStructuralSources.length,
  );
  const selectedCandidates = [...semanticCandidates]
    .sort(
      (left, right) =>
        right.importance - left.importance ||
        left.sourceIndex - right.sourceIndex ||
        left.order - right.order,
    )
    .slice(0, semanticCapacity)
    .sort(
      (left, right) =>
        left.sourceIndex - right.sourceIndex || left.order - right.order,
    );
  if (semanticCandidates.length > selectedCandidates.length) {
    warnings.push(
      `Orion landed the ${selectedCandidates.length} strongest validated knowledge objects; ${semanticCandidates.length - selectedCandidates.length} additional candidates remain available in the source readings for regeneration.`,
    );
  }
  if (structuralSources.length > selectedStructuralSources.length) {
    warnings.push(structuralOverflowWarning(structuralSources.length));
  }

  for (const candidate of selectedCandidates) {
    const title = allocateTitle(candidate.title);
    const body = composeSemanticLandingBody(
      title,
      candidate.thesis,
      candidate.claims,
    );
    notes.push({
      title,
      summary: boundedLandingSummary(candidate.thesis),
      body,
      tags: [],
      aliases: [],
      links: [],
    });
    provenance.push({
      kind: "note",
      title,
      sourceIds: [candidate.sourceId],
      evidenceReferences: candidate.artifactIds.map((artifactId) => ({
        kind: "artifact" as const,
        artifactId,
      })),
    });
  }

  for (const { source } of selectedStructuralSources) {
    const title = allocateTitle(source.parsed.title);
    warnings.push(
      `Orion completed no semantic readings for “${source.parsed.title}”, so its landed note preserves the source text directly.`,
    );
    const structural = structuralLandingNote(source, title);
    notes.push(structural.note);
    provenance.push(structural.provenance);
    warnings.push(...structural.warnings);
  }
  return {
    result: { notes, wikiArticles: [], concepts: [], suggestedConnections: [] },
    provenance,
    warnings,
  };
}

export function assembleStructuralLanding(
  sources: readonly KnowledgeImportSourceInput[],
): KnowledgeLandingAssembly {
  const allocateTitle = createLandingTitleAllocator();
  const notes: OrganizedNote[] = [];
  const provenance: KnowledgeResultProvenance[] = [];
  const warnings: string[] = [];
  for (const source of sources.slice(0, LANDED_NOTE_LIMIT)) {
    const structural = structuralLandingNote(
      source,
      allocateTitle(source.parsed.title),
    );
    notes.push(structural.note);
    provenance.push(structural.provenance);
    warnings.push(...structural.warnings);
  }
  if (sources.length > LANDED_NOTE_LIMIT) {
    warnings.push(structuralOverflowWarning(sources.length));
  }
  return {
    result: { notes, wikiArticles: [], concepts: [], suggestedConnections: [] },
    provenance,
    warnings,
  };
}

function structuralLandingNote(
  source: KnowledgeImportSourceInput,
  title: string,
): {
  note: OrganizedNote;
  provenance: KnowledgeResultProvenance;
  warnings: string[];
} {
  const text = source.parsed.text;
  const truncated = text.length > LANDED_STRUCTURAL_BODY_LIMIT;
  return {
    note: {
      title,
      summary: boundedLandingSummary(text),
      body: truncated ? text.slice(0, LANDED_STRUCTURAL_BODY_LIMIT) : text,
      tags: [],
      aliases: [],
      links: [],
    },
    provenance: {
      kind: "note",
      title,
      sourceIds: [source.sourceId],
      evidenceReferences: [{ kind: "source", sourceId: source.sourceId }],
    },
    warnings: truncated
      ? [
          `Orion preserved the first 60,000 characters of “${source.parsed.title}” in its landed note; the complete text remains on the source record.`,
        ]
      : [],
  };
}

// Duplicate output titles are rejected by the orchestrated pipeline and would
// collide during payload application, so landed notes keep the same
// uniqueness invariant with a deterministic ordinal suffix.
function createLandingTitleAllocator(): (rawTitle: string) => string {
  const used = new Set<string>();
  return (rawTitle) => {
    const base = rawTitle.trim() || "Imported source";
    let candidate = base;
    for (let ordinal = 2; used.has(normalizedTitle(candidate)); ordinal += 1) {
      candidate = `${base} (${ordinal})`;
    }
    used.add(normalizedTitle(candidate));
    return candidate;
  };
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizedParagraph(value: string): string {
  // Keep case, punctuation, and qualifiers meaningful. A fuzzy match could
  // discard a source's uncertainty or conflate two different assertions.
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
}

function uniqueParagraphs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return values
    .flatMap((value) => value.split(/\n\s*\n/u))
    .flatMap((value) => {
      const paragraph = value.trim();
      const key = normalizedParagraph(paragraph);
      if (!key || seen.has(key)) return [];
      seen.add(key);
      return [paragraph];
    });
}

function composeSemanticLandingBody(
  title: string,
  thesis: string,
  claims: readonly string[],
): string {
  const claimParagraphs = uniqueParagraphs(claims);
  const sourceWording = new Map(
    claimParagraphs.map((paragraph) => [normalizedParagraph(paragraph), paragraph]),
  );
  const thesisParagraphs = uniqueParagraphs([thesis]).map(
    (paragraph) => sourceWording.get(normalizedParagraph(paragraph)) ?? paragraph,
  );
  // The seed supplies one lead, while exact selected source claims supply the
  // rest. Never append private reading summaries or Space interpretations.
  return [
    `# ${title}`,
    ...uniqueParagraphs([...thesisParagraphs, ...claimParagraphs]),
  ].join("\n\n");
}

function structuralOverflowWarning(sourceCount: number): string {
  return `Orion landed ${LANDED_NOTE_LIMIT} source notes within the import output limit; ${sourceCount - LANDED_NOTE_LIMIT} additional sources remain preserved for regeneration.`;
}

function parsedRangeOrdinal(rangeId: string): number | undefined {
  const match = /^range-(\d+)$/.exec(rangeId);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function landingImportance(value: "low" | "medium" | "high"): number {
  return value === "high" ? 2 : value === "medium" ? 1 : 0;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function rangeOrdinal(rangeId: string): number {
  return parsedRangeOrdinal(rangeId) ?? 0;
}

function boundedLandingSummary(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  if (flattened.length <= LANDED_SUMMARY_LIMIT) return flattened;
  return `${flattened.slice(0, LANDED_SUMMARY_LIMIT - 1).trimEnd()}…`;
}
