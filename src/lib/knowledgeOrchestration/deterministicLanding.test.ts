import { describe, expect, it } from "vitest";
import type { ParsedImport } from "../../types";
import type { CompletedSourceReading } from "./blueprintImport";
import type { KnowledgeSourceReading } from "./protocol";
import {
  assembleDeterministicLanding,
  assembleStructuralLanding,
} from "./deterministicLanding";
import { assignment } from "./testFixtures";

function parsed(title: string, text: string): ParsedImport {
  return {
    title,
    fileName: `${title}.txt`,
    mimeType: "text/plain",
    format: "text",
    byteSize: text.length,
    text,
    warnings: [],
  };
}

function reading(
  sourceId: string,
  rangeId: string,
  summary: string,
  claims: string[],
  interpretations: string[] = [],
): CompletedSourceReading {
  const value: KnowledgeSourceReading = {
    sourceId,
    rangeId,
    summary,
    coverage: { complete: true, limitations: [] },
    sourceAssessment: {
      importance: "high",
      rationale: "The range grounds the source argument.",
    },
    spaceAssessment: {
      relevance: "medium",
      novelty: "medium",
      focusConcepts: [],
      deprioritizedConcepts: [],
      reviewedNoteIds: [],
      rationale: "It bears on the active Space.",
    },
    sourceClaims: claims.map((text, index) => ({
      claimId: `${rangeId}-claim-${index + 1}`,
      text,
      support: [{ sourceId, rangeId }],
    })),
    synthesisSeeds: claims.map((text, index) => ({
      seedId: `${rangeId}-seed-${index + 1}`,
      proposedTitle: `Durable idea ${index + 1}`,
      thesis: text,
      claimIds: [`${rangeId}-claim-${index + 1}`],
      importance: "high",
      contribution: "new",
      relatedNoteIds: [],
      rationale: "The claim establishes an independently reusable idea.",
    })),
    spaceInterpretations: interpretations.map((text, index) => ({
      interpretationId: `${rangeId}-lens-${index + 1}`,
      text,
      sourceClaimIds: [`${rangeId}-claim-1`],
      relatedNoteIds: [],
      rationale: "A Space-lens projection.",
    })),
    mustPreserve: [`Source range ${sourceId}/${rangeId}`],
  };
  return {
    assignment: assignment(`read-${sourceId}-${rangeId}`, "root"),
    artifact: {
      artifactId: `artifact:test:source-reading:${sourceId}:${rangeId}`,
      assignmentId: `read-${sourceId}-${rangeId}`,
      purpose: "evidence",
      summary,
      body: summary,
      assessment: {
        spaceRelevance: "medium",
        sourceImportance: "high",
        novelty: "medium",
        focusConcepts: [],
        deprioritizedConcepts: [],
        reviewedNoteIds: [],
        rationale: "It bears on the active Space.",
      },
      claims: value.sourceClaims.map(({ text, support }) => ({
        text,
        references: support.map((range) => ({
          kind: "source-range" as const,
          ...range,
        })),
      })),
      references: [{ kind: "source-range", sourceId, rangeId }],
      mustPreserve: [...value.mustPreserve],
      ownerProposals: [],
    },
    reading: value,
  };
}

describe("deterministic landing assembly", () => {
  it("assembles idea-first semantic notes with exact claims and no range summaries or interpretations", () => {
    const sources = [
      { sourceId: "s1", parsed: parsed("Hegel Notebook", "Short source text.") },
    ];
    const { result, provenance, warnings } = assembleDeterministicLanding(
      sources,
      [
        reading("s1", "range-2", "Second range summary.", [
          "Second claim, quoted verbatim.",
        ]),
        reading(
          "s1",
          "range-1",
          "First range summary.",
          ["First claim — exact wording (§12)."],
          ["A Space-lens interpretation that must never land."],
        ),
      ],
    );

    expect(result.notes).toHaveLength(1);
    const note = result.notes[0];
    expect(note.title).toBe("Durable idea 1");
    expect(note.summary).toBe("First claim — exact wording (§12).");
    expect(note.body).toBe(
      [
        "# Durable idea 1",
        "First claim — exact wording (§12).",
        "Second claim, quoted verbatim.",
      ].join("\n\n"),
    );
    expect(note.body).not.toContain("range summary");
    expect(note.body).not.toMatch(/^## Range/mu);
    expect(note.body).not.toContain("must never land");
    expect(note.tags).toEqual([]);
    expect(note.aliases).toEqual([]);
    expect(note.links).toEqual([]);
    expect(result.wikiArticles).toEqual([]);
    expect(result.concepts).toEqual([]);
    expect(result.suggestedConnections).toEqual([]);
    expect(provenance).toEqual([
      {
        kind: "note",
        title: "Durable idea 1",
        sourceIds: ["s1"],
        evidenceReferences: [
          {
            kind: "artifact",
            artifactId: "artifact:test:source-reading:s1:range-1",
          },
          {
            kind: "artifact",
            artifactId: "artifact:test:source-reading:s1:range-2",
          },
        ],
      },
    ]);
    expect(warnings).toEqual([]);
  });

  it("fills an uncovered source with a structural note and deduplicates titles deterministically", () => {
    const sources = [
      { sourceId: "s1", parsed: parsed("Same Title", "Read source text.") },
      { sourceId: "s2", parsed: parsed("Same Title", "Preserved source prose.") },
    ];
    const completed = reading(
      "s1",
      "range-1",
      "Only completed summary.",
      ["Only claim."],
    );
    completed.reading.synthesisSeeds[0].proposedTitle = "Same Title";
    const { result, provenance, warnings } = assembleDeterministicLanding(
      sources,
      [completed],
    );

    expect(result.notes.map(({ title }) => title)).toEqual([
      "Same Title",
      "Same Title (2)",
    ]);
    expect(result.notes[1].body).toBe("Preserved source prose.");
    expect(provenance[1]).toEqual({
      kind: "note",
      title: "Same Title (2)",
      sourceIds: ["s2"],
      evidenceReferences: [{ kind: "source", sourceId: "s2" }],
    });
    expect(warnings).toEqual([
      "Orion completed no semantic readings for “Same Title”, so its landed note preserves the source text directly.",
    ]);
  });

  it("bounds a landed note summary near 300 characters", () => {
    const longSummary = `${"An unbroken opening sentence. ".repeat(20)}Tail.`;
    const { result } = assembleDeterministicLanding(
      [{ sourceId: "s1", parsed: parsed("Bounded", "Text.") }],
      [reading("s1", "range-1", "Private range summary.", [longSummary])],
    );

    expect(result.notes[0].summary.length).toBeLessThanOrEqual(300);
    expect(result.notes[0].summary.endsWith("…")).toBe(true);
    expect(longSummary.startsWith(result.notes[0].summary.slice(0, -1))).toBe(
      true,
    );
  });

  it("bounds a structural landing body at 60,000 characters with a truncation warning", () => {
    const exact = "a".repeat(60_000);
    const over = "b".repeat(60_001);
    const { result, provenance, warnings } = assembleStructuralLanding([
      { sourceId: "s1", parsed: parsed("Exact", exact) },
      { sourceId: "s2", parsed: parsed("Over", over) },
    ]);

    expect(result.notes[0].body).toBe(exact);
    expect(result.notes[1].body).toBe(over.slice(0, 60_000));
    expect(provenance.map(({ evidenceReferences }) => evidenceReferences)).toEqual(
      [
        [{ kind: "source", sourceId: "s1" }],
        [{ kind: "source", sourceId: "s2" }],
      ],
    );
    expect(warnings).toEqual([
      "Orion preserved the first 60,000 characters of “Over” in its landed note; the complete text remains on the source record.",
    ]);
  });
});
