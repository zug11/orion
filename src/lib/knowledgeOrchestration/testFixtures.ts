import type {
  CoordinationCall,
  KnowledgeArtifact,
  KnowledgeArtifactPayload,
  KnowledgeAssignmentContract,
  KnowledgeNoteRoutingResult,
  KnowledgeOutputContract,
  KnowledgeRunResult,
} from "./protocol";
import type { KnowledgeAssignmentExecutionRequest } from "./service";

export function routingArtifact(
  assignmentId: string,
  routing: KnowledgeNoteRoutingResult,
): KnowledgeArtifact {
  return {
    artifactId: `artifact:${assignmentId}:1`,
    assignmentId,
    purpose: "router",
    summary: "Typed routing coverage.",
    body: "",
    assessment: {
      spaceRelevance: "medium",
      sourceImportance: "medium",
      novelty: "medium",
      focusConcepts: [],
      deprioritizedConcepts: [],
      reviewedNoteIds: routing.routes.map(({ noteId }) => noteId),
      rationale: "Typed routing coverage.",
    },
    claims: [],
    references: [{ kind: "note-digest-range", rangeId: routing.rangeId }],
    mustPreserve: [`Space routing range ${routing.rangeId}`],
    ownerProposals: [],
    routing,
  };
}

export function assignment(
  assignmentId: string,
  parentAssignmentId: string,
  purpose: KnowledgeAssignmentContract["purpose"] = "evidence",
  output: KnowledgeOutputContract = { kind: "evidence" },
): KnowledgeAssignmentContract {
  return {
    assignmentId,
    parent: { kind: "assignment", assignmentId: parentAssignmentId },
    purpose,
    objective: `Resolve ${assignmentId}`,
    references: [{ kind: "source", sourceId: "s1" }],
    constraints: { rules: ["Stay grounded."], mustPreserve: ["source:s1"] },
    authority: { kind: "read-only" },
    output,
    termination: { condition: "Stop when the objective is resolved." },
  };
}

export function rootAssignment(runId = "run-1"): KnowledgeAssignmentContract {
  return {
    assignmentId: "root",
    parent: { kind: "run", runId },
    purpose: "root",
    objective: "Organize the batch.",
    references: [],
    constraints: { rules: ["Stay grounded."], mustPreserve: ["source:s1"] },
    authority: { kind: "read-only" },
    output: { kind: "root-result" },
    termination: { condition: "Return a validated result." },
  };
}

export function ownerAssignment(
  assignmentId: string,
  parentAssignmentId: string,
  noteId: string,
  version = "version-1",
): KnowledgeAssignmentContract {
  return {
    ...assignment(assignmentId, parentAssignmentId, "owner", {
      kind: "owner-proposal",
      destinationNoteIds: [noteId],
    }),
    authority: {
      kind: "destination-owner",
      destinationNoteIds: [noteId],
      baseVersions: [{ noteId, version }],
    },
  };
}

export function artifactPayload(
  summary = "A grounded finding.",
): KnowledgeArtifactPayload {
  return {
    summary,
    body: summary,
    assessment: {
      spaceRelevance: "medium",
      sourceImportance: "medium",
      novelty: "medium",
      focusConcepts: [],
      deprioritizedConcepts: [],
      reviewedNoteIds: [],
      rationale: "The evidence warrants ordinary attention.",
    },
    claims: [],
    references: [{ kind: "source", sourceId: "s1" }],
    mustPreserve: ["source:s1"],
    ownerProposals: [],
    validation: undefined,
  };
}

export function runResult(): KnowledgeRunResult {
  return {
    result: {
      notes: [
        {
          title: "Finding",
          summary: "A finding.",
          body: "# Finding\n\nGrounded prose.",
          tags: [],
          aliases: [],
          links: [],
        },
      ],
      wikiArticles: [],
      concepts: [],
      suggestedConnections: [],
    },
    provenance: [
      {
        kind: "note",
        title: "Finding",
        sourceIds: ["s1"],
        evidenceReferences: [{ kind: "source", sourceId: "s1" }],
      },
    ],
    ownerProposals: [],
    warnings: [],
  };
}

export function fanOut(
  callId: string,
  parentAssignmentId: string,
  assignmentIds: string[],
): CoordinationCall {
  return {
    primitive: "fan_out",
    callId,
    assignments: assignmentIds.map((id) => assignment(id, parentAssignmentId)),
  };
}

export function longPdfText(pageCount = 160, charactersPerPage = 1_900): string {
  return Array.from(
    { length: pageCount },
    (_, index) =>
      `## Page ${index + 1}\n\n${String.fromCharCode(65 + (index % 26)).repeat(charactersPerPage)}`,
  ).join("\n\n");
}

export function fixedPipelineResponse(
  request: KnowledgeAssignmentExecutionRequest,
) {
  const { assignment, context } = request;
  if (assignment.output.kind === "reading-blueprint") {
    return {
      response: {
        kind: "complete",
        payload: {
          spaceExplanation: "This Space tests a bounded long-document import.",
          spaceFocusConcepts: [],
          spaceQuestions: ["What matters in the source?"],
          readers: assignment.output.sourceRanges.map(
            ({ sourceId, rangeId }, index) => ({
              readerId: `reader-${index + 1}`,
              sourceId,
              rangeId,
              focusQuestions: ["What does this range establish?"],
              focusConcepts: [],
              comparisons: [],
              mustPreserve: [`Source range ${sourceId}/${rangeId}`],
            }),
          ),
          warnings: [],
        },
      },
    };
  }
  if (assignment.output.kind === "source-reading") {
    const { sourceId, rangeId } = assignment.output;
    return {
      response: {
        kind: "complete",
        payload: {
          sourceId,
          rangeId,
          summary: `Complete summary of ${rangeId}.`,
          coverage: { complete: true, limitations: [] },
          sourceAssessment: {
            importance: "high",
            rationale: "The range develops the source argument.",
          },
          spaceAssessment: {
            relevance: "high",
            novelty: "medium",
            focusConcepts: [],
            deprioritizedConcepts: [],
            reviewedNoteIds: [],
            rationale: "It bears on the active Space.",
          },
          sourceClaims: [
            {
              claimId: "claim-1",
              text: `Grounded claim from ${rangeId}.`,
              support: [{ sourceId, rangeId }],
            },
          ],
          synthesisSeeds: [
            {
              seedId: "seed-1",
              proposedTitle: "Finding",
              thesis: `Grounded claim from ${rangeId}.`,
              claimIds: ["claim-1"],
              importance: "high",
              contribution: "new",
              relatedNoteIds: [],
              rationale:
                "The synthetic fixture represents one repeated knowledge object.",
            },
          ],
          spaceInterpretations: [],
          mustPreserve: [...assignment.constraints.mustPreserve],
        },
      },
    };
  }
  if (assignment.output.kind === "note-routing") {
    return {
      response: {
        kind: "complete",
        payload: {
          rangeId: assignment.output.rangeId,
          routes: assignment.output.expectedNotes.map(
            ({ noteId, noteVersion }) => ({
              noteId,
              noteVersion,
              relation: "extends" as const,
              rationale: "The completed readings overlap this note.",
              candidateNoteIds: [],
            }),
          ),
          warnings: [],
        },
      },
    };
  }
  if (assignment.output.kind === "evidence") {
    const digestMaterial = context.resolvedMaterials.find(
      ({ reference }) => reference.kind === "note-digest-range",
    )?.material as { noteDigests?: Array<{ noteId: string }> } | undefined;
    return {
      response: {
        kind: "complete",
        payload: {
          ...artifactPayload(assignment.assignmentId),
          assessment: {
            ...artifactPayload().assessment,
            reviewedNoteIds:
              digestMaterial?.noteDigests?.map(({ noteId }) => noteId) ?? [],
          },
          references: [...assignment.references],
          mustPreserve: [...assignment.constraints.mustPreserve],
        },
      },
    };
  }
  if (assignment.output.kind === "writing-blueprint") {
    const readings = context.pipelineMaterials
      ?.filter(({ kind }) => kind === "source-reading")
      .map(({ payload }) => payload as {
        artifactId: string;
        reading: {
          sourceId: string;
          sourceClaims: Array<{ claimId: string }>;
          synthesisSeeds: Array<{
            seedId: string;
            claimIds: string[];
            importance: "low" | "medium" | "high";
          }>;
          mustPreserve: string[];
        };
      }) ?? [];
    const sourceIds = [...new Set(readings.map(({ reading }) => reading.sourceId))];
    const retainedSeeds = readings.flatMap(({ artifactId, reading }) =>
      reading.synthesisSeeds
        .filter(({ importance }) => importance !== "low")
        .map((seed) => ({ artifactId, seed })),
    );
    const primarySeed = retainedSeeds[0];
    if (!primarySeed) throw new Error("Expected one retained synthesis seed.");
    return {
      response: {
        kind: "complete",
        payload: {
          spaceThesis: "The selected claims form one coherent project note.",
          outputs: [
            {
              outputId: "output-1",
              operation: "create",
              kind: "note",
              title: "Finding",
              editorialBrief: "Synthesize every selected range claim.",
              sourceIds,
              claimSelections: readings.map(({ artifactId, reading }) => ({
                artifactId,
                claimIds: [
                  ...new Set(
                    reading.synthesisSeeds
                      .filter(({ importance }) => importance !== "low")
                      .flatMap(({ claimIds }) => claimIds),
                  ),
                ],
              })),
              lensSelections: [],
              mustPreserve: [
                ...new Set(
                  readings.flatMap(({ reading }) => reading.mustPreserve),
                ),
              ],
              estimatedTokens: 800,
              writerSlotId: "writer-1",
              existingDestination: null,
            },
          ],
          seedDispositions: readings.flatMap(({ artifactId, reading }) =>
            reading.synthesisSeeds.map((seed) => {
              if (seed.importance === "low") {
                return {
                  artifactId,
                  seedId: seed.seedId,
                  disposition: "omitted" as const,
                  outputId: null,
                  rationale: "This low-value fixture claim is intentionally omitted.",
                };
              }
              const primary =
                artifactId === primarySeed.artifactId &&
                seed.seedId === primarySeed.seed.seedId;
              return {
                artifactId,
                seedId: seed.seedId,
                disposition: primary ? ("output" as const) : ("merged" as const),
                outputId: "output-1",
                rationale: primary
                  ? "This seed defines the fixture output."
                  : "This compatible seed merges into the same fixture output.",
              };
            }),
          ),
          writerSlots: [
            {
              writerSlotId: "writer-1",
              objective: "Write the project note.",
              outputIds: ["output-1"],
            },
          ],
          concepts: [],
          suggestedConnections: [],
          warnings: [],
        },
      },
    };
  }
  if (assignment.output.kind === "writer-result") {
    const material = context.pipelineMaterials?.find(
      ({ kind }) => kind === "writing-blueprint",
    )?.payload as
      | {
          assignedOutputs: Array<{
            outputId: string;
            operation: "create" | "revise";
            kind: "note" | "wikiArticle";
            title: string;
            sourceIds: string[];
            claimSelections: Array<{ artifactId: string; claimIds: string[] }>;
            lensSelections: Array<{
              artifactId: string;
              interpretationIds: string[];
            }>;
            mustPreserve: string[];
            existingDestination: { noteId: string; baseVersion: string } | null;
          }>;
        }
      | undefined;
    if (!material) throw new Error("Expected scoped writer blueprint material.");
    return {
      response: {
        kind: "complete",
        payload: {
          writerSlotId: assignment.output.writerSlotId,
          drafts: material.assignedOutputs.map((output) => ({
            outputId: output.outputId,
            operation: output.operation,
            kind: output.kind,
            title: output.title,
            summary: "A grounded finding.",
            body: "# Finding\n\nA grounded finding from the complete source.",
            tags: [],
            aliases: [],
            links: [],
            overview: "",
            spaceRelevance: "",
            sourceGroundedDetails: [],
            uncertainties: [],
            sourceIds: [...output.sourceIds],
            claimSelections: structuredClone(output.claimSelections),
            lensSelections: structuredClone(output.lensSelections),
            mustPreserve: [...output.mustPreserve],
            existingDestination: structuredClone(output.existingDestination),
          })),
          warnings: [],
        },
      },
    };
  }
  throw new Error(`Unexpected fixed-pipeline assignment: ${assignment.purpose}`);
}
