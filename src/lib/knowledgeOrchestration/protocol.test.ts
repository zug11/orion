import { describe, expect, it } from "vitest";
import {
  parseCoordinationCall,
  parseKnowledgeModelResponse,
  type CoordinationCall,
} from "./protocol";
import {
  artifactPayload,
  assignment,
  fanOut,
  ownerAssignment,
  runResult,
} from "./testFixtures";

describe("knowledge orchestration protocol", () => {
  it("allows a root to complete directly without a planning call", () => {
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload: runResult() },
        { kind: "root-result" },
      ),
    ).toMatchObject({ kind: "complete" });
  });

  it.each<CoordinationCall>([
    fanOut("call-fan", "root", ["a", "b"]),
    {
      primitive: "reconcile",
      callId: "call-reconcile",
      assignment: assignment("r", "root", "reconciler", {
        kind: "reconciliation",
      }),
      inputArtifactIds: ["artifact-a", "artifact-b"],
    },
    {
      primitive: "compress",
      callId: "call-compress",
      assignment: assignment("c", "root", "compressor", {
        kind: "compression",
      }),
      inputArtifactIds: ["artifact-a"],
      mustPreserve: ["page 12"],
    },
    {
      primitive: "assign_owner",
      callId: "call-owner",
      assignment: ownerAssignment("o", "root", "note-a"),
    },
    {
      primitive: "re_expand",
      callId: "call-expand",
      assignments: [assignment("e", "root")],
      fromArtifactIds: ["artifact-a"],
    },
    {
      primitive: "validate",
      callId: "call-validate",
      assignment: assignment("v", "root", "validator", {
        kind: "validation",
        proposalArtifactIds: ["artifact-a"],
      }),
      proposalArtifactIds: ["artifact-a"],
    },
    {
      primitive: "re_evaluate",
      callId: "call-reevaluate",
      assignment: assignment("re", "root"),
      priorArtifactIds: ["artifact-a"],
      observationIds: ["observation-1"],
    },
  ])("strictly validates $primitive", (call) => {
    expect(parseCoordinationCall(call)).toEqual(call);
  });

  it("rejects unknown fields and duplicate call identities", () => {
    expect(() =>
      parseCoordinationCall({
        ...fanOut("call", "root", ["a"]),
        desiredWidth: 12,
      }),
    ).toThrow(/Unexpected field/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "coordinate",
          calls: [fanOut("same", "root", ["a"]), fanOut("same", "root", ["b"])],
        },
        { kind: "root-result" },
      ),
    ).toThrow(/Duplicate coordination callId/);
  });

  it("validates child output according to its contract", () => {
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload: artifactPayload() },
        { kind: "evidence" },
      ),
    ).toMatchObject({ kind: "complete" });
    expect(() =>
      parseKnowledgeModelResponse(
        { kind: "complete", payload: artifactPayload() },
        { kind: "owner-proposal", destinationNoteIds: ["note-a"] },
      ),
    ).toThrow(/owner completion/);
  });

  it("requires a strict relevance assessment on every worker summary", () => {
    const payload = artifactPayload();
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload },
        { kind: "evidence" },
      ),
    ).toMatchObject({
      kind: "complete",
      payload: {
        assessment: {
          spaceRelevance: "medium",
          sourceImportance: "medium",
          novelty: "medium",
        },
      },
    });

    const { assessment: _assessment, ...withoutAssessment } = payload;
    expect(() =>
      parseKnowledgeModelResponse(
        { kind: "complete", payload: withoutAssessment },
        { kind: "evidence" },
      ),
    ).toThrow(/assessment/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            assessment: { ...payload.assessment, novelty: "irrelevant" },
          },
        },
        { kind: "evidence" },
      ),
    ).toThrow(/novelty/);
  });

  it("accepts bounded note-digest references and rejects extra fields", () => {
    const call = fanOut("digest-call", "root", ["digest-reader"]);
    if (call.primitive !== "fan_out") throw new Error("Expected fan_out fixture.");
    call.assignments[0].references = [
      { kind: "note-digest-range", rangeId: "note-digests-1" },
    ];
    expect(parseCoordinationCall(call)).toEqual(call);

    call.assignments[0].references = [
      {
        kind: "note-digest-range",
        rangeId: "note-digests-1",
        noteId: "outside-contract",
      } as never,
    ];
    expect(() => parseCoordinationCall(call)).toThrow(/Unexpected field/);
  });

  it("requires a reading blueprint to cover every deterministic range exactly once", () => {
    const payload = {
      spaceExplanation: "This Space studies social theory.",
      spaceFocusConcepts: ["positivism"],
      spaceQuestions: ["How does the argument develop?"],
      readers: [
        {
          readerId: "reader-1",
          sourceId: "source-1",
          rangeId: "range-1",
          focusQuestions: ["What is claimed?"],
          focusConcepts: ["method"],
          comparisons: [{ noteId: "note-1", reason: "Compare the account." }],
          mustPreserve: ["source-1:range-1"],
        },
      ],
      warnings: [],
    };
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload },
        {
          kind: "reading-blueprint",
          sourceRanges: [{ sourceId: "source-1", rangeId: "range-1" }],
        },
      ),
    ).toMatchObject({ kind: "complete", payload: { readers: [{ readerId: "reader-1" }] } });
    expect(() =>
      parseKnowledgeModelResponse(
        { kind: "complete", payload },
        {
          kind: "reading-blueprint",
          sourceRanges: [
            { sourceId: "source-1", rangeId: "range-1" },
            { sourceId: "source-1", rangeId: "range-2" },
          ],
        },
      ),
    ).toThrow(/exact output contract/);
  });

  it("keeps source claims separate from Space interpretations", () => {
    const payload = sourceReadingPayload();
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toMatchObject({
      kind: "complete",
      payload: {
        sourceClaims: [{ claimId: "claim-1" }],
        synthesisSeeds: [{ seedId: "seed-1", importance: "high" }],
        spaceInterpretations: [{ interpretationId: "lens-1" }],
      },
    });
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            sourceClaims: [
              {
                ...payload.sourceClaims[0],
                support: [{ sourceId: "source-1", rangeId: "range-other" }],
              },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/only the source range assigned/);

    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            synthesisSeeds: [
              { ...payload.synthesisSeeds[0], claimIds: ["claim-unknown"] },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/unknown source claim/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            synthesisSeeds: [
              payload.synthesisSeeds[0],
              { ...payload.synthesisSeeds[0], proposedTitle: "Another title" },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/synthesis seed IDs.*duplicates/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            synthesisSeeds: [
              { ...payload.synthesisSeeds[0], importance: "urgent" },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/Invalid synthesis seeds\[0\]\.importance/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            synthesisSeeds: [
              { ...payload.synthesisSeeds[0], sourceOrder: 1 },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/Unexpected field.*sourceOrder/);

    const secondClaim = {
      claimId: "claim-2",
      text: "A second atomic claim remains independently useful.",
      support: [{ sourceId: "source-1", rangeId: "range-1" }],
    } as const;
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            sourceClaims: [...payload.sourceClaims, secondClaim],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/partition every source claim exactly once/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            sourceClaims: [...payload.sourceClaims, secondClaim],
            synthesisSeeds: [
              payload.synthesisSeeds[0],
              {
                ...payload.synthesisSeeds[0],
                seedId: "seed-2",
                claimIds: ["claim-2"],
                thesis: "A distinct thesis for the second claim.",
              },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/synthesis seed titles.*duplicates/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            sourceClaims: [...payload.sourceClaims, secondClaim],
            synthesisSeeds: [
              payload.synthesisSeeds[0],
              {
                ...payload.synthesisSeeds[0],
                seedId: "seed-2",
                proposedTitle: "A distinct second title",
                claimIds: ["claim-2"],
              },
            ],
          },
        },
        { kind: "source-reading", sourceId: "source-1", rangeId: "range-1" },
      ),
    ).toThrow(/synthesis seed theses.*duplicates/);
  });

  it("requires a one-to-six-slot exact writing partition", () => {
    const payload = writingBlueprintPayload();
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload },
        { kind: "writing-blueprint", readingArtifactIds: ["artifact-reading-1"] },
      ),
    ).toMatchObject({ kind: "complete", payload: { outputs: [{ outputId: "output-1" }] } });
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            writerSlots: [{ ...payload.writerSlots[0], outputIds: ["other-output"] }],
          },
        },
        { kind: "writing-blueprint", readingArtifactIds: ["artifact-reading-1"] },
      ),
    ).toThrow(/exact output contract/);

    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            seedDispositions: [
              { ...payload.seedDispositions[0], outputId: null },
            ],
          },
        },
        { kind: "writing-blueprint", readingArtifactIds: ["artifact-reading-1"] },
      ),
    ).toThrow(/requires a non-null outputId/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            seedDispositions: [
              {
                ...payload.seedDispositions[0],
                disposition: "omitted",
                outputId: "output-1",
              },
            ],
          },
        },
        { kind: "writing-blueprint", readingArtifactIds: ["artifact-reading-1"] },
      ),
    ).toThrow(/omitted synthesis seed.*null outputId/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            seedDispositions: [
              payload.seedDispositions[0],
              { ...payload.seedDispositions[0], disposition: "merged" },
            ],
          },
        },
        { kind: "writing-blueprint", readingArtifactIds: ["artifact-reading-1"] },
      ),
    ).toThrow(/synthesis seed dispositions.*duplicates/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            seedDispositions: [
              { ...payload.seedDispositions[0], outputId: "output-missing" },
            ],
          },
        },
        { kind: "writing-blueprint", readingArtifactIds: ["artifact-reading-1"] },
      ),
    ).toThrow(/reference a declared blueprint output/);
  });

  it("requires each writer to return its exact slot and output IDs", () => {
    const blueprint = writingBlueprintPayload();
    const output = blueprint.outputs[0];
    const draft = {
      outputId: output.outputId,
      operation: output.operation,
      kind: output.kind,
      title: output.title,
      summary: "A grounded summary.",
      body: "# Project note\n\nGrounded prose.",
      tags: [],
      aliases: [],
      links: [],
      overview: "",
      spaceRelevance: "",
      sourceGroundedDetails: [],
      uncertainties: [],
      sourceIds: output.sourceIds,
      claimSelections: output.claimSelections,
      lensSelections: output.lensSelections,
      mustPreserve: output.mustPreserve,
      existingDestination: null,
    };
    expect(
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: { writerSlotId: "writer-1", drafts: [draft], warnings: [] },
        },
        { kind: "writer-result", writerSlotId: "writer-1", outputIds: ["output-1"] },
      ),
    ).toMatchObject({ kind: "complete", payload: { drafts: [{ outputId: "output-1" }] } });
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: { writerSlotId: "writer-other", drafts: [draft], warnings: [] },
        },
        { kind: "writer-result", writerSlotId: "writer-1", outputIds: ["output-1"] },
      ),
    ).toThrow(/exact writer slot/);

    const { mustPreserve: _mustPreserve, ...withoutPreservationEcho } = draft;
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            writerSlotId: "writer-1",
            drafts: [withoutPreservationEcho],
            warnings: [],
          },
        },
        { kind: "writer-result", writerSlotId: "writer-1", outputIds: ["output-1"] },
      ),
    ).toThrow(/mustPreserve/);
  });

  it("requires note routing to cover every exact digest identity once", () => {
    const expectedOutput = {
      kind: "note-routing" as const,
      rangeId: "note-digests-1",
      expectedNotes: [
        { noteId: "note-a", noteVersion: "version-a" },
        { noteId: "note-b", noteVersion: "version-b" },
      ],
    };
    const payload = noteRoutingPayload();
    expect(
      parseKnowledgeModelResponse(
        { kind: "complete", payload },
        expectedOutput,
      ),
    ).toEqual({ kind: "complete", payload });

    expect(() =>
      parseKnowledgeModelResponse(
        { kind: "complete", payload: { ...payload, routes: payload.routes.slice(0, 1) } },
        expectedOutput,
      ),
    ).toThrow(/every contracted note ID and version exactly once/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: { ...payload, routes: [payload.routes[0], payload.routes[0]] },
        },
        expectedOutput,
      ),
    ).toThrow(/route IDs cannot contain duplicates/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            routes: [
              payload.routes[0],
              { ...payload.routes[1], noteId: "note-extra" },
            ],
          },
        },
        expectedOutput,
      ),
    ).toThrow(/every contracted note ID and version exactly once/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            routes: [
              payload.routes[0],
              { ...payload.routes[1], noteVersion: "stale-version" },
            ],
          },
        },
        expectedOutput,
      ),
    ).toThrow(/every contracted note ID and version exactly once/);
  });

  it("strictly validates note-routing relations, range, keys, and candidates", () => {
    const expectedOutput = {
      kind: "note-routing" as const,
      rangeId: "note-digests-1",
      expectedNotes: [
        { noteId: "note-a", noteVersion: "version-a" },
        { noteId: "note-b", noteVersion: "version-b" },
      ],
    };
    const payload = noteRoutingPayload();
    expect(() =>
      parseKnowledgeModelResponse(
        { kind: "complete", payload: { ...payload, rangeId: "note-digests-2" } },
        expectedOutput,
      ),
    ).toThrow(/exact digest range contract/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            routes: [
              { ...payload.routes[0], relation: "related" },
              payload.routes[1],
            ],
          },
        },
        expectedOutput,
      ),
    ).toThrow(/relation/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            routes: [
              { ...payload.routes[0], confidence: 0.9 },
              payload.routes[1],
            ],
          },
        },
        expectedOutput,
      ),
    ).toThrow(/Unexpected field/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            routes: [
              {
                ...payload.routes[0],
                relation: "unrelated",
                candidateNoteIds: ["note-b"],
              },
              payload.routes[1],
            ],
          },
        },
        expectedOutput,
      ),
    ).toThrow(/unrelated.*cannot name candidates/);
    expect(() =>
      parseKnowledgeModelResponse(
        {
          kind: "complete",
          payload: {
            ...payload,
            routes: [
              { ...payload.routes[0], candidateNoteIds: ["note-a"] },
              payload.routes[1],
            ],
          },
        },
        expectedOutput,
      ),
    ).toThrow(/cannot select itself/);
  });

  it("does not let model coordination invent host-owned router assignments", () => {
    const call = fanOut("router-call", "root", ["router"]);
    if (call.primitive !== "fan_out") throw new Error("Expected fan_out fixture.");
    call.assignments[0] = {
      ...call.assignments[0],
      purpose: "router",
      output: {
        kind: "note-routing",
        rangeId: "note-digests-1",
        expectedNotes: [{ noteId: "note-a", noteVersion: "version-a" }],
      },
    };
    expect(() => parseCoordinationCall(call)).toThrow(/Invalid assignment purpose: router/);
    expect(() =>
      parseKnowledgeModelResponse(
        { kind: "coordinate", calls: [fanOut("other", "root", ["reader"])] },
        {
          kind: "note-routing",
          rangeId: "note-digests-1",
          expectedNotes: [{ noteId: "note-a", noteVersion: "version-a" }],
        },
      ),
    ).toThrow(/note-routing.*must complete directly/);
  });
});

function noteRoutingPayload() {
  return {
    rangeId: "note-digests-1",
    routes: [
      {
        noteId: "note-a",
        noteVersion: "version-a",
        relation: "extends",
        rationale: "The imported argument develops this note's central claim.",
        candidateNoteIds: ["note-b"],
      },
      {
        noteId: "note-b",
        noteVersion: "version-b",
        relation: "unrelated",
        rationale: "The note addresses a different problem.",
        candidateNoteIds: [],
      },
    ],
    warnings: [],
  } as const;
}

function sourceReadingPayload() {
  return {
    sourceId: "source-1",
    rangeId: "range-1",
    summary: "The range develops an argument.",
    coverage: { complete: true, limitations: [] },
    sourceAssessment: { importance: "high", rationale: "Central argument." },
    spaceAssessment: {
      relevance: "high",
      novelty: "medium",
      focusConcepts: ["method"],
      deprioritizedConcepts: [],
      reviewedNoteIds: ["note-1"],
      rationale: "It extends an existing concern.",
    },
    sourceClaims: [
      {
        claimId: "claim-1",
        text: "The author distinguishes two methods.",
        support: [{ sourceId: "source-1", rangeId: "range-1" }],
      },
    ],
    synthesisSeeds: [
      {
        seedId: "seed-1",
        proposedTitle: "Method as a Social Relation",
        thesis: "Method is shaped by the social relations it claims to describe.",
        claimIds: ["claim-1"],
        importance: "high",
        contribution: "connects",
        relatedNoteIds: ["note-1"],
        rationale: "This claim can become a durable bridge across the Space.",
      },
    ],
    spaceInterpretations: [
      {
        interpretationId: "lens-1",
        text: "The distinction bears on the Space's account of method.",
        sourceClaimIds: ["claim-1"],
        relatedNoteIds: ["note-1"],
        rationale: "The supplied note discusses the same methodological problem.",
      },
    ],
    mustPreserve: ["source-1:range-1"],
  } as const;
}

function writingBlueprintPayload() {
  return {
    spaceThesis: "The Space connects method and social theory.",
    outputs: [
      {
        outputId: "output-1",
        operation: "create",
        kind: "note",
        title: "Method and Social Theory",
        editorialBrief: "Explain the source argument in the Space's context.",
        sourceIds: ["source-1"],
        claimSelections: [
          { artifactId: "artifact-reading-1", claimIds: ["claim-1"] },
        ],
        lensSelections: [
          { artifactId: "artifact-reading-1", interpretationIds: ["lens-1"] },
        ],
        mustPreserve: ["claim-1"],
        estimatedTokens: 800,
        writerSlotId: "writer-1",
        existingDestination: null,
      },
    ],
    seedDispositions: [
      {
        artifactId: "artifact-reading-1",
        seedId: "seed-1",
        disposition: "output",
        outputId: "output-1",
        rationale: "The seed earns an independent durable note.",
      },
    ],
    writerSlots: [
      {
        writerSlotId: "writer-1",
        objective: "Write one coherent project note.",
        outputIds: ["output-1"],
      },
    ],
    concepts: [],
    suggestedConnections: [],
    warnings: [],
  } as const;
}
