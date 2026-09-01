import { describe, expect, it } from "vitest";
import type { CompletedSourceReading } from "./blueprintImport";
import type { KnowledgeImportSourceInput } from "./context";
import type { KnowledgeSourceReading } from "./protocol";
import {
  assembleDeterministicLanding,
  assembleStructuralLanding,
} from "./deterministicLanding";
import { assignment } from "./testFixtures";

function source(sourceId = "source-trial"): KnowledgeImportSourceInput {
  return {
    sourceId,
    parsed: {
      title: `Mechanical trials ${sourceId}`,
      text: "Synthetic bench observations for import tests.",
      fileName: "trials.txt",
      mimeType: "text/plain",
      format: "text",
      byteSize: 48,
      warnings: [],
    },
  };
}

function reading(
  ideas: Array<{ title: string; thesis: string; claims?: string[] }>,
  rangeId = "range-1",
): CompletedSourceReading {
  const sourceId = "source-trial";
  const sourceClaims = ideas.flatMap((idea, index) =>
    (idea.claims ?? [idea.thesis]).map((text, claimIndex) => ({
      claimId: `${rangeId}-idea-${index}-claim-${claimIndex}`,
      text,
      support: [{ sourceId, rangeId }],
    })),
  );
  const value: KnowledgeSourceReading = {
    sourceId,
    rangeId,
    summary: "Private reading summary that must not become note prose.",
    coverage: { complete: true, limitations: [] },
    sourceAssessment: { importance: "high", rationale: "Independent trials." },
    spaceAssessment: {
      relevance: "medium",
      novelty: "high",
      focusConcepts: [],
      deprioritizedConcepts: [],
      reviewedNoteIds: [],
      rationale: "Potential design implications.",
    },
    sourceClaims,
    synthesisSeeds: ideas.map((idea, index) => ({
      seedId: `${rangeId}-idea-${index}`,
      proposedTitle: idea.title,
      thesis: idea.thesis,
      claimIds: sourceClaims
        .filter(({ claimId }) => claimId.startsWith(`${rangeId}-idea-${index}-claim-`))
        .map(({ claimId }) => claimId),
      importance: "high",
      contribution: "new",
      relatedNoteIds: [],
      rationale: "One independently reusable finding.",
    })),
    spaceInterpretations: [{
      interpretationId: `${rangeId}-interpretation`,
      text: "A private Space comparison must not masquerade as source evidence.",
      sourceClaimIds: sourceClaims.slice(0, 1).map(({ claimId }) => claimId),
      relatedNoteIds: [],
      rationale: "An interpretation, not a source assertion.",
    }],
    mustPreserve: [],
  };
  const assignmentId = `read-${rangeId}`;
  return {
    assignment: assignment(assignmentId, "root"),
    artifact: {
      artifactId: `artifact:${rangeId}`,
      assignmentId,
      purpose: "evidence",
      summary: value.summary,
      body: value.summary,
      assessment: {
        spaceRelevance: "medium",
        sourceImportance: "high",
        novelty: "high",
        focusConcepts: [],
        deprioritizedConcepts: [],
        reviewedNoteIds: [],
        rationale: "Synthetic source evidence.",
      },
      claims: sourceClaims.map(({ text, support }) => ({
        text,
        references: support.map((range) => ({ kind: "source-range", ...range })),
      })),
      references: [{ kind: "source-range", sourceId, rangeId }],
      mustPreserve: [],
      ownerProposals: [],
    },
    reading: value,
  };
}

const independentIdeas = (count: number) => Array.from({ length: count }, (_, index) => ({
  title: `Trial ${index + 1} has an independent constraint`,
  thesis: `The source proposes a provisional constraint for trial ${index + 1}.`,
}));

describe("deterministic landing semantic integrity", () => {
  it("preserves more than twelve distinct ideas without merging or dropping them", () => {
    const ideas = independentIdeas(18);
    const { result, provenance, warnings } = assembleDeterministicLanding(
      [source()],
      [reading(ideas)],
    );

    expect(result.notes.map(({ title }) => title)).toEqual(ideas.map(({ title }) => title));
    expect(result.notes.map(({ body }) => body)).toEqual(
      ideas.map(({ title, thesis }) => `# ${title}\n\n${thesis}`),
    );
    expect(provenance).toHaveLength(18);
    expect(provenance.every(({ sourceIds }) => sourceIds.join() === "source-trial")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("retains the aggregate thirty-output boundary and reports every omitted candidate", () => {
    const { result, warnings } = assembleDeterministicLanding(
      [source()],
      [reading(independentIdeas(31))],
    );

    expect(result.notes).toHaveLength(30);
    expect(warnings).toEqual([
      "Orion landed the 30 strongest validated knowledge objects; 1 additional candidates remain available in the source readings for regeneration.",
    ]);
  });

  it("reserves aggregate capacity for sources with no semantic reading", () => {
    const { result, provenance, warnings } = assembleDeterministicLanding(
      [source(), source("source-unread-one"), source("source-unread-two")],
      [reading(independentIdeas(29))],
    );

    expect(result.notes).toHaveLength(30);
    expect(provenance.slice(-2).map(({ sourceIds }) => sourceIds)).toEqual([
      ["source-unread-one"],
      ["source-unread-two"],
    ]);
    expect(warnings[0]).toContain("1 additional candidates");
  });

  it("deduplicates thesis and claim paragraphs while retaining source qualifications exactly", () => {
    const claim = "The author speculates that the coating may reduce wear; this is not an established mechanism.";
    const qualification = "The observations do not demonstrate causation.";
    const completed = reading([{
      title: "A provisional coating hypothesis",
      thesis: `${claim}\n\n${claim}`,
      claims: [claim, `${qualification}\n\n${claim}`],
    }]);
    const { result } = assembleDeterministicLanding([source()], [completed]);

    expect(result.notes[0].body).toBe([
      "# A provisional coating hypothesis",
      claim,
      qualification,
    ].join("\n\n"));
    expect(result.notes[0].body).not.toContain("Private reading summary");
    expect(result.notes[0].body).not.toContain("private Space comparison");
  });

  it("does not delete a differently qualified source claim as a near duplicate", () => {
    const thesis = "The coating reduces wear.";
    const qualifiedClaim = "The coating may reduce wear in this trial, but the author leaves the question open.";
    const { result } = assembleDeterministicLanding([source()], [reading([{
      title: "The limits of a coating trial",
      thesis,
      claims: [qualifiedClaim],
    }])]);

    expect(result.notes[0].body).toContain(qualifiedClaim);
  });

  it("does not merge unrelated ideas solely because their proposed titles match", () => {
    const { result, provenance } = assembleDeterministicLanding([source()], [
      reading([{ title: "Trial constraints", thesis: "Temperature limits the seal." }]),
      reading([{ title: "Trial constraints", thesis: "Vibration limits the bracket." }], "range-2"),
    ]);

    expect(result.notes.map(({ title }) => title)).toEqual(["Trial constraints", "Trial constraints (2)"]);
    expect(result.notes[0].body).not.toContain("Vibration");
    expect(result.notes[1].body).not.toContain("Temperature");
    expect(provenance.map(({ evidenceReferences }) => evidenceReferences)).toEqual([
      [{ kind: "artifact", artifactId: "artifact:range-1" }],
      [{ kind: "artifact", artifactId: "artifact:range-2" }],
    ]);
  });

  it("bounds structural-only recovery with an explicit overflow warning", () => {
    const sources = Array.from({ length: 31 }, (_, index) => source(`source-${index}`));
    for (const assemble of [assembleStructuralLanding, (inputs: KnowledgeImportSourceInput[]) =>
      assembleDeterministicLanding(inputs, [])]) {
      const { result, provenance, warnings } = assemble(sources);
      expect(result.notes).toHaveLength(30);
      expect(provenance).toHaveLength(30);
      expect(warnings).toContain(
        "Orion landed 30 source notes within the import output limit; 1 additional sources remain preserved for regeneration.",
      );
    }
  });
});
