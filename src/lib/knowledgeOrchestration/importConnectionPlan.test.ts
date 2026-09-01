import { describe, expect, it } from "vitest";
import { scopedImportConnectionPlan, validateImportConnectionPlan } from "./importConnectionPlan";
import type { KnowledgeWritingBlueprint } from "./protocol";

const concept = (label: string, canonicalTitle: string, relatedTitles: string[] = []) => ({
  label, canonicalTitle, relatedTitles, aliases: [], description: "A deliberate phrase.",
});

describe("planned import connections", () => {
  it("rejects ambiguous canonical phrase ownership, including aliases", () => {
    expect(() => validateImportConnectionPlan({
      concepts: [concept("recognition", "Recognition may interrupt projection"),
        { ...concept("acknowledgement", "Recognition may reinforce projection"), aliases: ["Recognition"] }],
      suggestedConnections: [],
    })).toThrow("multiple canonical destinations");
  });

  it("rejects self edges and shared-source-only rationales", () => {
    expect(() => validateImportConnectionPlan({ concepts: [], suggestedConnections: [
      { fromTitle: "Argument", toTitle: "argument", kind: "supports", reason: "It supports itself." },
    ] })).toThrow("itself");
    expect(() => validateImportConnectionPlan({ concepts: [], suggestedConnections: [
      { fromTitle: "One", toTitle: "Two", kind: "related", reason: "Both notes share the same source." },
    ] })).toThrow("Shared source");
  });

  it("retains a specific qualification without requiring or inventing support", () => {
    expect(() => validateImportConnectionPlan({ concepts: [], suggestedConnections: [
      { fromTitle: "Recognition may reinforce projection", toTitle: "Recognition may interrupt projection",
        kind: "qualifies", reason: "Recognition interrupts projection only when the other remains distinct." },
    ] })).not.toThrow();
  });

  it("scopes a writer to its own phrases and connected title endpoints, without sibling prose", () => {
    const outputs: KnowledgeWritingBlueprint["outputs"] = ["A", "B", "C", "D"].map((title) => ({
      outputId: title, title, operation: "create", kind: "note", editorialBrief: `Private brief ${title}`,
      sourceIds: ["source"], claimSelections: [], lensSelections: [], mustPreserve: [],
      estimatedTokens: 700, writerSlotId: title, existingDestination: null,
    }));
    const plan: KnowledgeWritingBlueprint = {
      spaceThesis: "Test", outputs, seedDispositions: [], writerSlots: [], warnings: [],
      concepts: [concept("abject middle", "B", ["A", "D"]), concept("other phrase", "C", ["D"])],
      suggestedConnections: [
        { fromTitle: "A", toTitle: "B", kind: "qualifies", reason: "The limit narrows the claim." },
        { fromTitle: "C", toTitle: "D", kind: "supports", reason: "Independent evidence supports the claim." },
      ],
    };
    const scoped = scopedImportConnectionPlan(plan, ["A"]);
    expect(scoped.concepts).toEqual([concept("abject middle", "B", ["A"])]);
    expect(scoped.suggestedConnections).toHaveLength(1);
    expect(scoped.outputDirectory.map(({ title }) => title)).toEqual(["A", "B"]);
    expect(JSON.stringify(scoped)).not.toContain("Private brief");
    expect(() => validateImportConnectionPlan({
      ...plan, concepts: [concept("A", "B")],
    })).toThrow("another output's exact title");
  });
});
