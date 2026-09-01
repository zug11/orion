import { describe, expect, it } from "vitest";
import { planLocalImportConnections } from "./importConnections";
import { parseKnowledgeModelResponse, type KnowledgeSourceReading, type KnowledgeWritingBlueprintOutput } from "./protocol";
import { runResult } from "./testFixtures";
import { createEmptySnapshot } from "../../data/defaults";
import type { AppSnapshot } from "../../types";

function seed(seedId: string, overrides: Partial<KnowledgeSourceReading["synthesisSeeds"][number]> = {}): KnowledgeSourceReading["synthesisSeeds"][number] {
  return {
    seedId, proposedTitle: `Argument ${seedId}`, thesis: "Structural inheritance of trauma shapes later experience.",
    claimIds: [seedId], importance: "high", contribution: "new", relatedNoteIds: [],
    rationale: "The argument specifies a causal mechanism.", linkPhrases: ["structural inheritance of trauma"], ...overrides,
  };
}

function reading(seeds: KnowledgeSourceReading["synthesisSeeds"]): KnowledgeSourceReading {
  return {
    sourceId: "source-1", rangeId: "range-1", summary: "An argument with explicit qualifications.",
    coverage: { complete: true, limitations: [] },
    sourceAssessment: { importance: "high", rationale: "Distinct claims." },
    spaceAssessment: { relevance: "high", novelty: "high", focusConcepts: [], deprioritizedConcepts: [], reviewedNoteIds: [], rationale: "Distinct arguments." },
    sourceClaims: seeds.map((entry) => ({ claimId: entry.seedId, text: entry.thesis, support: [{ sourceId: "source-1", rangeId: "range-1" }] })),
    synthesisSeeds: seeds, spaceInterpretations: [], mustPreserve: [],
  };
}

function plan(seeds: KnowledgeSourceReading["synthesisSeeds"], notes: { id: string; title: string }[] = [], existingVocabulary?: Pick<AppSnapshot, "notes" | "concepts">) {
  return planLocalImportConnections({
    outputs: seeds.map((entry): KnowledgeWritingBlueprintOutput => ({
      outputId: entry.seedId, title: entry.proposedTitle, editorialBrief: entry.thesis,
      operation: "create", kind: "note", sourceIds: ["source-1"], claimSelections: [{ artifactId: "reading-1", claimIds: entry.claimIds }],
      lensSelections: [], mustPreserve: [], estimatedTokens: 700, writerSlotId: "writer-1", existingDestination: null,
    })),
    seedDispositions: seeds.map((entry) => ({ artifactId: "reading-1", seedId: entry.seedId, disposition: "output", outputId: entry.seedId, rationale: "Distinct argument." })),
    readings: [{ artifact: { artifactId: "reading-1" }, reading: reading(seeds) }], notes, existingVocabulary,
  });
}

describe("local connection planning", () => {
  it("preserves deliberate grounded phrases without inventing vocabulary from repeated keywords", () => {
    const planned = plan([seed("a", { linkPhrases: ["structural inheritance of trauma", "unmentioned phrase", "structure"] })]);
    expect(planned.concepts.map(({ label }) => label)).toEqual(["structural inheritance of trauma"]);
    expect(planned.concepts[0].canonicalTitle).toBe("Argument a");
    expect(planned.suggestedConnections).toEqual([]);
  });

  it("does not choose an ambiguous phrase owner or connect siblings just because they share a source", () => {
    expect(plan([seed("a"), seed("b")])).toEqual({ concepts: [], suggestedConnections: [] });
  });

  it("omits only conflicting local phrase plans while retaining source objects and private existing vocabulary", () => {
    const snapshot = createEmptySnapshot("Arguments", "2026-08-31T00:00:00.000Z");
    snapshot.notes = [{
      id: "existing", title: "Private established recognition account", body: "Private existing prose.",
      summary: "An existing account.", slug: "existing", aliases: ["recognition"], tags: [],
      sourceIds: [], conceptIds: ["canonical"], kind: "article", status: "ready",
      createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
    }];
    snapshot.concepts = [{
      id: "canonical", label: snapshot.notes[0].title, aliases: ["recognition"], description: "An existing account.",
      noteIds: ["existing"], canonicalNoteId: "existing", autoLink: true, color: "#8ea4ff",
    }];
    const seeds = [seed("a", {
      thesis: "Recognition may interrupt projection.", linkPhrases: ["recognition", "projection"],
    })];
    const before = structuredClone(seeds);
    const planned = plan(seeds, [], snapshot);
    expect(planned.concepts.map(({ label }) => label)).toEqual(["projection"]);
    expect(seeds).toEqual(before);
    expect(JSON.stringify(planned)).not.toContain("Private");
    expect(planned.suggestedConnections).toEqual([]);
  });

  it("does not map a local phrase to another argument when a sibling owns its exact title", () => {
    const planned = plan([
      seed("a", { proposedTitle: "Recognition", thesis: "Recognition is relational.", linkPhrases: [] }),
      seed("b", { thesis: "Recognition may interrupt projection.", linkPhrases: ["recognition", "projection"] }),
    ]);
    expect(planned.concepts.map(({ label, canonicalTitle }) => ({ label, canonicalTitle }))).toEqual([
      { label: "projection", canonicalTitle: "Argument b" },
    ]);
  });

  it("retains only declared typed, same-Space seed relationships", () => {
    const seeds = [
      seed("a", { contribution: "extends", relatedNoteIds: ["existing"] }),
      seed("b", { contribution: "qualifies", relatedNoteIds: ["existing"] }),
      seed("c", { contribution: "contradicts", relatedNoteIds: ["outside"] }),
    ];
    const planned = plan(seeds, [{ id: "existing", title: "Existing argument" }]);
    expect(planned.suggestedConnections.map(({ kind }) => kind)).toEqual(["related", "qualifies"]);
    expect(JSON.stringify(planned)).not.toContain("outside");
  });

  it("validates new phrase metadata and remains compatible with prior readings", () => {
    const sourceReading = reading([seed("a")]);
    const contract = { kind: "source-reading" as const, sourceId: "source-1", rangeId: "range-1" };
    const parse = () => parseKnowledgeModelResponse({ kind: "complete", payload: sourceReading }, contract);
    expect(parse()).toMatchObject({ payload: { synthesisSeeds: [{ linkPhrases: ["structural inheritance of trauma"] }] } });
    sourceReading.synthesisSeeds[0].linkPhrases = ["recognition", "Recognition"];
    expect(parse).toThrow(/duplicates/);
    delete sourceReading.synthesisSeeds[0].linkPhrases;
    expect(parse()).toMatchObject({ kind: "complete" });
  });

  it("retains connection kinds while accepting legacy untyped results and rejecting unknown kinds", () => {
    const payload = runResult();
    payload.result.suggestedConnections = [{ fromTitle: "A", toTitle: "B", kind: "qualifies", reason: "A narrows B's scope." }];
    const parse = () => parseKnowledgeModelResponse({ kind: "complete", payload }, { kind: "root-result" });
    expect(parse()).toMatchObject({ payload: { result: { suggestedConnections: [{ kind: "qualifies" }] } } });
    delete payload.result.suggestedConnections[0].kind;
    expect(parse()).toMatchObject({ payload: { result: { suggestedConnections: [{ kind: "related" }] } } });
    Object.assign(payload.result.suggestedConnections[0], { kind: "shares-source" });
    expect(parse).toThrow(/connection kind/);
  });
});
