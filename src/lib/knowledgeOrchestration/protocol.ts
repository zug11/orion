import type {
  OrganizeContentResult,
  OrganizedConcept,
  OrganizedNote,
  OrganizedWikiArticle,
  SuggestedConnection,
} from "../../types";

export type KnowledgeRunId = string;
export type KnowledgeAssignmentId = string;
export type KnowledgeArtifactId = string;
export type KnowledgeCallId = string;

export type KnowledgeReference =
  | { kind: "source"; sourceId: string }
  | { kind: "source-range"; sourceId: string; rangeId: string }
  | { kind: "note-digest-range"; rangeId: string }
  | { kind: "note"; noteId: string; version: string }
  | { kind: "concept"; conceptId: string }
  | { kind: "artifact"; artifactId: KnowledgeArtifactId };

export type KnowledgeAssignmentPurpose =
  | "root"
  | "router"
  | "reading-blueprint"
  | "source-reader"
  | "writing-blueprint"
  | "writer"
  | "evidence"
  | "reconciler"
  | "compressor"
  | "owner"
  | "validator";

export type KnowledgeOutputContract =
  | { kind: "root-result" }
  | {
      kind: "note-routing";
      rangeId: string;
      expectedNotes: Array<{ noteId: string; noteVersion: string }>;
    }
  | {
      kind: "reading-blueprint";
      sourceRanges: Array<{ sourceId: string; rangeId: string }>;
    }
  | { kind: "source-reading"; sourceId: string; rangeId: string }
  | { kind: "writing-blueprint"; readingArtifactIds: KnowledgeArtifactId[] }
  | {
      kind: "writer-result";
      writerSlotId: string;
      outputIds: string[];
    }
  | { kind: "evidence" }
  | { kind: "reconciliation" }
  | { kind: "compression" }
  | { kind: "owner-proposal"; destinationNoteIds: string[] }
  | { kind: "validation"; proposalArtifactIds: KnowledgeArtifactId[] };

export interface KnowledgeAssignmentContract {
  assignmentId: KnowledgeAssignmentId;
  parent:
    | { kind: "run"; runId: KnowledgeRunId }
    | { kind: "assignment"; assignmentId: KnowledgeAssignmentId };
  purpose: KnowledgeAssignmentPurpose;
  objective: string;
  references: KnowledgeReference[];
  constraints: {
    rules: string[];
    mustPreserve: string[];
  };
  authority:
    | { kind: "read-only" }
    | {
        kind: "destination-owner";
        destinationNoteIds: string[];
        baseVersions: Array<{ noteId: string; version: string }>;
      };
  output: KnowledgeOutputContract;
  termination: {
    condition: string;
  };
}

interface CoordinationBase {
  callId: KnowledgeCallId;
}

export type CoordinationCall =
  | (CoordinationBase & {
      primitive: "fan_out";
      assignments: KnowledgeAssignmentContract[];
    })
  | (CoordinationBase & {
      primitive: "reconcile";
      assignment: KnowledgeAssignmentContract;
      inputArtifactIds: KnowledgeArtifactId[];
    })
  | (CoordinationBase & {
      primitive: "compress";
      assignment: KnowledgeAssignmentContract;
      inputArtifactIds: KnowledgeArtifactId[];
      mustPreserve: string[];
    })
  | (CoordinationBase & {
      primitive: "assign_owner";
      assignment: KnowledgeAssignmentContract;
    })
  | (CoordinationBase & {
      primitive: "re_expand";
      assignments: KnowledgeAssignmentContract[];
      fromArtifactIds: KnowledgeArtifactId[];
    })
  | (CoordinationBase & {
      primitive: "validate";
      assignment: KnowledgeAssignmentContract;
      proposalArtifactIds: KnowledgeArtifactId[];
    })
  | (CoordinationBase & {
      primitive: "re_evaluate";
      assignment: KnowledgeAssignmentContract;
      priorArtifactIds: KnowledgeArtifactId[];
      observationIds: string[];
    });

export type KnowledgeModelResponse =
  | { kind: "complete"; payload: KnowledgeCompletionPayload }
  | { kind: "coordinate"; calls: CoordinationCall[] };

export interface KnowledgeClaim {
  text: string;
  references: KnowledgeReference[];
}

export interface KnowledgeOwnerProposal {
  destinationNoteId: string;
  baseVersion: string;
  title: string;
  summary: string;
  body: string;
  aliases: string[];
  tags: string[];
  sourceIds: string[];
}

export interface KnowledgeReadingBlueprint {
  /** A Space-derived reading frame, never evidence about an imported source. */
  spaceExplanation: string;
  spaceFocusConcepts: string[];
  spaceQuestions: string[];
  readers: Array<{
    readerId: string;
    sourceId: string;
    rangeId: string;
    focusQuestions: string[];
    focusConcepts: string[];
    comparisons: Array<{ noteId: string; reason: string }>;
    mustPreserve: string[];
  }>;
  warnings: string[];
}

export type KnowledgeAssessmentLevel = "low" | "medium" | "high";

/** A source-only citation boundary. It intentionally cannot name a note. */
export interface KnowledgeSourceSupport {
  sourceId: string;
  rangeId: string;
}

export interface KnowledgeSourceReading {
  sourceId: string;
  rangeId: string;
  summary: string;
  coverage: {
    complete: boolean;
    limitations: string[];
  };
  sourceAssessment: {
    importance: KnowledgeAssessmentLevel;
    rationale: string;
  };
  spaceAssessment: {
    relevance: KnowledgeAssessmentLevel;
    novelty: KnowledgeAssessmentLevel;
    focusConcepts: string[];
    deprioritizedConcepts: string[];
    reviewedNoteIds: string[];
    rationale: string;
  };
  sourceClaims: Array<{
    claimId: string;
    text: string;
    support: KnowledgeSourceSupport[];
  }>;
  /** Candidate durable knowledge objects grounded in this exact source reading. */
  synthesisSeeds: Array<{
    seedId: string;
    proposedTitle: string;
    thesis: string;
    claimIds: string[];
    importance: KnowledgeAssessmentLevel;
    contribution: "new" | "extends" | "contradicts" | "connects" | "qualifies";
    relatedNoteIds: string[];
    rationale: string;
  }>;
  /** Interpretations through the Space frame; never direct source evidence. */
  spaceInterpretations: Array<{
    interpretationId: string;
    text: string;
    sourceClaimIds: string[];
    relatedNoteIds: string[];
    rationale: string;
  }>;
  mustPreserve: string[];
}

export interface KnowledgeEvidenceSelection {
  artifactId: KnowledgeArtifactId;
  claimIds: string[];
}

export interface KnowledgeLensSelection {
  artifactId: KnowledgeArtifactId;
  interpretationIds: string[];
}

export interface KnowledgeExistingDestination {
  noteId: string;
  baseVersion: string;
}

export type KnowledgeDraftOperation = "create" | "revise";
export type KnowledgeDraftKind = "note" | "wikiArticle";

export interface KnowledgeWritingBlueprintOutput {
  outputId: string;
  operation: KnowledgeDraftOperation;
  kind: KnowledgeDraftKind;
  title: string;
  editorialBrief: string;
  sourceIds: string[];
  claimSelections: KnowledgeEvidenceSelection[];
  lensSelections: KnowledgeLensSelection[];
  mustPreserve: string[];
  estimatedTokens: number;
  writerSlotId: string;
  existingDestination: KnowledgeExistingDestination | null;
}

export interface KnowledgeWritingBlueprint {
  /** Planning context only; source claims remain the evidentiary authority. */
  spaceThesis: string;
  outputs: KnowledgeWritingBlueprintOutput[];
  seedDispositions: Array<{
    artifactId: KnowledgeArtifactId;
    seedId: string;
    disposition: "output" | "merged" | "omitted";
    outputId: string | null;
    rationale: string;
  }>;
  writerSlots: Array<{
    writerSlotId: string;
    objective: string;
    outputIds: string[];
  }>;
  concepts: OrganizedConcept[];
  suggestedConnections: SuggestedConnection[];
  warnings: string[];
}

export interface KnowledgeWriterDraft {
  outputId: string;
  operation: KnowledgeDraftOperation;
  kind: KnowledgeDraftKind;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  aliases: string[];
  links: OrganizedNote["links"];
  /** Empty for an ordinary note; populated for a wiki article. */
  overview: string;
  /** Empty for an ordinary note; populated for a wiki article. */
  spaceRelevance: string;
  /** Empty for an ordinary note; populated for a wiki article. */
  sourceGroundedDetails: string[];
  /** Empty for an ordinary note; populated for a wiki article. */
  uncertainties: string[];
  sourceIds: string[];
  claimSelections: KnowledgeEvidenceSelection[];
  lensSelections: KnowledgeLensSelection[];
  mustPreserve: string[];
  existingDestination: KnowledgeExistingDestination | null;
}

export interface KnowledgeWriterResult {
  writerSlotId: string;
  drafts: KnowledgeWriterDraft[];
  warnings: string[];
}

export type KnowledgeNoteRoutingRelation =
  | "unrelated"
  | "duplicate"
  | "extends"
  | "contradicts"
  | "uncertain";

export interface KnowledgeNoteRoutingRoute {
  noteId: string;
  noteVersion: string;
  relation: KnowledgeNoteRoutingRelation;
  rationale: string;
  /** Empty when no concrete existing-note target is justified. */
  candidateNoteIds: string[];
}

export interface KnowledgeNoteRoutingResult {
  rangeId: string;
  routes: KnowledgeNoteRoutingRoute[];
  warnings: string[];
}

export interface KnowledgeValidationResult {
  valid: boolean;
  issues: string[];
  checkedArtifactIds: KnowledgeArtifactId[];
}

export type KnowledgeRelevanceLevel = "low" | "medium" | "high";

export interface KnowledgeRelevanceAssessment {
  spaceRelevance: KnowledgeRelevanceLevel;
  sourceImportance: KnowledgeRelevanceLevel;
  novelty: KnowledgeRelevanceLevel;
  focusConcepts: string[];
  deprioritizedConcepts: string[];
  reviewedNoteIds: string[];
  rationale: string;
}

export interface KnowledgeArtifactPayload {
  summary: string;
  body: string;
  assessment: KnowledgeRelevanceAssessment;
  claims: KnowledgeClaim[];
  references: KnowledgeReference[];
  mustPreserve: string[];
  ownerProposals: KnowledgeOwnerProposal[];
  validation?: KnowledgeValidationResult;
}

export interface KnowledgeArtifact extends KnowledgeArtifactPayload {
  artifactId: KnowledgeArtifactId;
  assignmentId: KnowledgeAssignmentId;
  purpose: Exclude<
    KnowledgeAssignmentPurpose,
    "root" | "reading-blueprint" | "source-reader" | "writing-blueprint" | "writer"
  >;
  /** Present only on the host-created router artifact wrapper. */
  routing?: KnowledgeNoteRoutingResult;
}

export interface KnowledgeResultProvenance {
  kind: "note" | "wikiArticle";
  title: string;
  sourceIds: string[];
  evidenceReferences: KnowledgeReference[];
}

export interface KnowledgeRunResult {
  result: OrganizeContentResult;
  provenance: KnowledgeResultProvenance[];
  ownerProposals: KnowledgeOwnerProposal[];
  warnings: string[];
}

export type KnowledgeCompletionPayload =
  | KnowledgeRunResult
  | KnowledgeReadingBlueprint
  | KnowledgeSourceReading
  | KnowledgeWritingBlueprint
  | KnowledgeWriterResult
  | KnowledgeNoteRoutingResult
  | KnowledgeArtifactPayload;

export interface KnowledgeProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface KnowledgeProviderResult {
  response: KnowledgeModelResponse;
  usage?: KnowledgeProviderUsage;
}

export type KnowledgeAssignmentState =
  | "accepted"
  | "held"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded";

export interface KnowledgeTelemetry {
  runId: KnowledgeRunId;
  logicalWidth: number;
  physicalWidth: number;
  writeWidth: number;
  completedAssignments: number;
  failedAssignments: number;
  activeAssignments: number;
  waitingAssignments: number;
  currentPrimitives: CoordinationCall["primitive"][];
  phase?: "exploring" | "finalizing";
  elapsedMs?: number;
  remainingMs?: number;
  sourceSummaryTotal?: number;
  sourceSummaryCompleted?: number;
  spaceSummaryTotal?: number;
  spaceSummaryCompleted?: number;
  pipelineStage?:
    | "reading-plan"
    | "reading"
    | "writing-plan"
    | "writing"
    | "assembling";
  readingCompleted?: number;
  readingTotal?: number;
  writingCompleted?: number;
  writingTotal?: number;
  status: "running" | "completed" | "failed" | "cancelled";
}

export function parseKnowledgeModelResponse(
  value: unknown,
  expectedOutput: KnowledgeOutputContract,
): KnowledgeModelResponse {
  const object = strictObject(value, ["kind", "payload", "calls"]);
  const kind = stringValue(object.kind, "response.kind");
  if (kind === "coordinate") {
    if (
      expectedOutput.kind === "note-routing" ||
      expectedOutput.kind === "reading-blueprint" ||
      expectedOutput.kind === "source-reading" ||
      expectedOutput.kind === "writing-blueprint" ||
      expectedOutput.kind === "writer-result"
    ) {
      throw new Error(
        `The host-created ${expectedOutput.kind} contract must complete directly.`,
      );
    }
    exactKeys(object, ["kind", "calls"]);
    const calls = arrayValue(object.calls, "response.calls").map(
      parseCoordinationCall,
    );
    if (calls.length === 0) {
      throw new Error("A coordinate response must contain at least one call.");
    }
    const callIds = new Set<string>();
    for (const call of calls) {
      if (callIds.has(call.callId)) {
        throw new Error(`Duplicate coordination callId: ${call.callId}`);
      }
      callIds.add(call.callId);
    }
    return { kind: "coordinate", calls };
  }
  if (kind !== "complete") {
    throw new Error("Knowledge response kind must be complete or coordinate.");
  }
  exactKeys(object, ["kind", "payload"]);
  return {
    kind: "complete",
    payload: parseCompletionPayload(object.payload, expectedOutput),
  };
}

export function parseCoordinationCall(value: unknown): CoordinationCall {
  const object = recordValue(value, "coordination call");
  const primitive = stringValue(object.primitive, "coordination primitive");
  const callId = boundedIdentifier(object.callId, "coordination callId");
  if (primitive === "fan_out") {
    exactKeys(object, ["primitive", "callId", "assignments"]);
    return {
      primitive,
      callId,
      assignments: nonEmptyArray(object.assignments, "fan_out assignments").map(
        parseAssignmentContract,
      ),
    };
  }
  if (primitive === "reconcile") {
    exactKeys(object, ["primitive", "callId", "assignment", "inputArtifactIds"]);
    return {
      primitive,
      callId,
      assignment: parseAssignmentContract(object.assignment),
      inputArtifactIds: identifierArray(
        object.inputArtifactIds,
        "reconcile inputArtifactIds",
        2,
      ),
    };
  }
  if (primitive === "compress") {
    exactKeys(object, [
      "primitive",
      "callId",
      "assignment",
      "inputArtifactIds",
      "mustPreserve",
    ]);
    const mustPreserve = stringArray(object.mustPreserve, "compress mustPreserve");
    if (mustPreserve.length === 0) {
      throw new Error("compress must preserve at least one declared value.");
    }
    return {
      primitive,
      callId,
      assignment: parseAssignmentContract(object.assignment),
      inputArtifactIds: identifierArray(
        object.inputArtifactIds,
        "compress inputArtifactIds",
        1,
      ),
      mustPreserve,
    };
  }
  if (primitive === "assign_owner") {
    exactKeys(object, ["primitive", "callId", "assignment"]);
    const assignment = parseAssignmentContract(object.assignment);
    if (
      assignment.purpose !== "owner" ||
      assignment.authority.kind !== "destination-owner" ||
      assignment.output.kind !== "owner-proposal"
    ) {
      throw new Error("assign_owner requires an owner assignment and exact destinations.");
    }
    return { primitive, callId, assignment };
  }
  if (primitive === "re_expand") {
    exactKeys(object, ["primitive", "callId", "assignments", "fromArtifactIds"]);
    return {
      primitive,
      callId,
      assignments: nonEmptyArray(object.assignments, "re_expand assignments").map(
        parseAssignmentContract,
      ),
      fromArtifactIds: identifierArray(
        object.fromArtifactIds,
        "re_expand fromArtifactIds",
        1,
      ),
    };
  }
  if (primitive === "validate") {
    exactKeys(object, ["primitive", "callId", "assignment", "proposalArtifactIds"]);
    const assignment = parseAssignmentContract(object.assignment);
    if (assignment.purpose !== "validator" || assignment.output.kind !== "validation") {
      throw new Error("validate requires a validator assignment.");
    }
    return {
      primitive,
      callId,
      assignment,
      proposalArtifactIds: identifierArray(
        object.proposalArtifactIds,
        "validate proposalArtifactIds",
        1,
      ),
    };
  }
  if (primitive === "re_evaluate") {
    exactKeys(object, [
      "primitive",
      "callId",
      "assignment",
      "priorArtifactIds",
      "observationIds",
    ]);
    return {
      primitive,
      callId,
      assignment: parseAssignmentContract(object.assignment),
      priorArtifactIds: identifierArray(
        object.priorArtifactIds,
        "re_evaluate priorArtifactIds",
        1,
      ),
      observationIds: identifierArray(
        object.observationIds,
        "re_evaluate observationIds",
        1,
      ),
    };
  }
  throw new Error(`Unknown coordination primitive: ${primitive}`);
}

export function parseAssignmentContract(
  value: unknown,
): KnowledgeAssignmentContract {
  const object = strictObject(value, [
    "assignmentId",
    "parent",
    "purpose",
    "objective",
    "references",
    "constraints",
    "authority",
    "output",
    "termination",
  ]);
  exactKeys(object, [
    "assignmentId",
    "parent",
    "purpose",
    "objective",
    "references",
    "constraints",
    "authority",
    "output",
    "termination",
  ]);
  const purpose = enumValue(
    object.purpose,
    [
      "root",
      "evidence",
      "reconciler",
      "compressor",
      "owner",
      "validator",
    ] as const,
    "assignment purpose",
  );
  const parentObject = recordValue(object.parent, "assignment parent");
  const parentKind = enumValue(
    parentObject.kind,
    ["run", "assignment"] as const,
    "assignment parent kind",
  );
  const parent =
    parentKind === "run"
      ? (() => {
          exactKeys(parentObject, ["kind", "runId"]);
          return {
            kind: "run" as const,
            runId: boundedIdentifier(parentObject.runId, "parent runId"),
          };
        })()
      : (() => {
          exactKeys(parentObject, ["kind", "assignmentId"]);
          return {
            kind: "assignment" as const,
            assignmentId: boundedIdentifier(
              parentObject.assignmentId,
              "parent assignmentId",
            ),
          };
        })();
  const constraints = strictObject(object.constraints, ["rules", "mustPreserve"]);
  exactKeys(constraints, ["rules", "mustPreserve"]);
  const authorityObject = recordValue(object.authority, "assignment authority");
  const authorityKind = enumValue(
    authorityObject.kind,
    ["read-only", "destination-owner"] as const,
    "assignment authority kind",
  );
  const authority =
    authorityKind === "read-only"
      ? (() => {
          exactKeys(authorityObject, ["kind"]);
          return { kind: "read-only" as const };
        })()
      : (() => {
          exactKeys(authorityObject, ["kind", "destinationNoteIds", "baseVersions"]);
          const destinationNoteIds = identifierArray(
            authorityObject.destinationNoteIds,
            "destinationNoteIds",
            1,
          );
          const baseVersions = arrayValue(
            authorityObject.baseVersions,
            "baseVersions",
          ).map((value) => {
            const entry = strictObject(value, ["noteId", "version"]);
            exactKeys(entry, ["noteId", "version"]);
            return {
              noteId: boundedIdentifier(entry.noteId, "base version noteId"),
              version: boundedIdentifier(entry.version, "base version"),
            };
          });
          if (
            baseVersions.length !== destinationNoteIds.length ||
            destinationNoteIds.some(
              (noteId) =>
                baseVersions.filter((entry) => entry.noteId === noteId).length !== 1,
            )
          ) {
            throw new Error("baseVersions must name every destination note exactly once.");
          }
          return {
            kind: "destination-owner" as const,
            destinationNoteIds,
            baseVersions,
          };
        })();
  const output = parseOutputContract(object.output);
  if (
    output.kind === "note-routing" ||
    output.kind === "reading-blueprint" ||
    output.kind === "source-reading" ||
    output.kind === "writing-blueprint" ||
    output.kind === "writer-result"
  ) {
    throw new Error(
      "Fixed import pipeline assignments cannot be created by model coordination.",
    );
  }
  if (purpose === "root" && output.kind !== "root-result") {
    throw new Error("A root assignment must request a root-result.");
  }
  if (purpose === "owner" && output.kind !== "owner-proposal") {
    throw new Error("An owner assignment must request owner-proposal output.");
  }
  if (purpose === "validator" && output.kind !== "validation") {
    throw new Error("A validator assignment must request validation output.");
  }
  if (purpose !== "owner" && authority.kind === "destination-owner") {
    throw new Error("Only an owner assignment may own destination notes.");
  }
  const termination = strictObject(object.termination, ["condition"]);
  exactKeys(termination, ["condition"]);
  return {
    assignmentId: boundedIdentifier(object.assignmentId, "assignmentId"),
    parent,
    purpose,
    objective: boundedText(object.objective, "assignment objective", 2_000),
    references: arrayValue(object.references, "assignment references").map(
      parseKnowledgeReference,
    ),
    constraints: {
      rules: stringArray(constraints.rules, "constraint rules"),
      mustPreserve: stringArray(
        constraints.mustPreserve,
        "constraint mustPreserve",
      ),
    },
    authority,
    output,
    termination: {
      condition: boundedText(
        termination.condition,
        "termination condition",
        1_000,
      ),
    },
  };
}

export function parseKnowledgeReference(value: unknown): KnowledgeReference {
  const object = recordValue(value, "knowledge reference");
  const kind = enumValue(
    object.kind,
    [
      "source",
      "source-range",
      "note-digest-range",
      "note",
      "concept",
      "artifact",
    ] as const,
    "knowledge reference kind",
  );
  if (kind === "source") {
    exactKeys(object, ["kind", "sourceId"]);
    return { kind, sourceId: boundedIdentifier(object.sourceId, "sourceId") };
  }
  if (kind === "source-range") {
    exactKeys(object, ["kind", "sourceId", "rangeId"]);
    return {
      kind,
      sourceId: boundedIdentifier(object.sourceId, "sourceId"),
      rangeId: boundedIdentifier(object.rangeId, "rangeId"),
    };
  }
  if (kind === "note-digest-range") {
    exactKeys(object, ["kind", "rangeId"]);
    return {
      kind,
      rangeId: boundedIdentifier(object.rangeId, "note digest rangeId"),
    };
  }
  if (kind === "note") {
    exactKeys(object, ["kind", "noteId", "version"]);
    return {
      kind,
      noteId: boundedIdentifier(object.noteId, "noteId"),
      version: boundedIdentifier(object.version, "note version"),
    };
  }
  if (kind === "concept") {
    exactKeys(object, ["kind", "conceptId"]);
    return { kind, conceptId: boundedIdentifier(object.conceptId, "conceptId") };
  }
  exactKeys(object, ["kind", "artifactId"]);
  return {
    kind,
    artifactId: boundedIdentifier(object.artifactId, "artifactId"),
  };
}

export function parseCompletionPayload(
  value: unknown,
  expectedOutput: KnowledgeOutputContract,
): KnowledgeCompletionPayload {
  if (expectedOutput.kind === "root-result") {
    return parseKnowledgeRunResult(value);
  }
  if (expectedOutput.kind === "note-routing") {
    return parseKnowledgeNoteRoutingResult(
      value,
      expectedOutput.rangeId,
      expectedOutput.expectedNotes,
    );
  }
  if (expectedOutput.kind === "reading-blueprint") {
    return parseKnowledgeReadingBlueprint(value, expectedOutput.sourceRanges);
  }
  if (expectedOutput.kind === "source-reading") {
    return parseKnowledgeSourceReading(
      value,
      expectedOutput.sourceId,
      expectedOutput.rangeId,
    );
  }
  if (expectedOutput.kind === "writing-blueprint") {
    return parseKnowledgeWritingBlueprint(
      value,
      expectedOutput.readingArtifactIds,
    );
  }
  if (expectedOutput.kind === "writer-result") {
    return parseKnowledgeWriterResult(
      value,
      expectedOutput.writerSlotId,
      expectedOutput.outputIds,
    );
  }
  const artifact = parseArtifactPayload(value);
  if (expectedOutput.kind === "owner-proposal") {
    if (artifact.ownerProposals.length === 0) {
      throw new Error("An owner completion must contain at least one proposal.");
    }
    const expected = new Set(expectedOutput.destinationNoteIds);
    if (
      artifact.ownerProposals.some(
        ({ destinationNoteId }) => !expected.has(destinationNoteId),
      )
    ) {
      throw new Error("An owner proposed a destination outside its output contract.");
    }
  }
  if (expectedOutput.kind === "validation" && !artifact.validation) {
    throw new Error("A validator completion must contain validation results.");
  }
  if (expectedOutput.kind === "compression") {
    const retained = new Set(artifact.mustPreserve);
    const missing = artifact.references.length === 0 && artifact.claims.length === 0;
    if (missing || retained.size === 0) {
      throw new Error("A compression completion must retain evidence and mustPreserve values.");
    }
  }
  return artifact;
}

export function parseKnowledgeNoteRoutingResult(
  value: unknown,
  expectedRangeId: string,
  expectedNotes: ReadonlyArray<{ noteId: string; noteVersion: string }>,
): KnowledgeNoteRoutingResult {
  const object = strictObject(value, ["rangeId", "routes", "warnings"]);
  exactKeys(object, ["rangeId", "routes", "warnings"]);
  const rangeId = boundedIdentifier(object.rangeId, "note routing rangeId");
  if (rangeId !== expectedRangeId) {
    throw new Error("A note-routing result must match its exact digest range contract.");
  }
  const expectedById = new Map<string, string>();
  for (const expected of expectedNotes) {
    const noteId = boundedIdentifier(expected.noteId, "expected routing noteId");
    const noteVersion = boundedIdentifier(
      expected.noteVersion,
      "expected routing noteVersion",
    );
    if (expectedById.has(noteId)) {
      throw new Error("The note-routing contract cannot contain duplicate note IDs.");
    }
    expectedById.set(noteId, noteVersion);
  }
  if (expectedById.size === 0) {
    throw new Error("A note-routing contract must name at least one expected note.");
  }
  const routes = nonEmptyArray(object.routes, "note routing routes").map(
    (item, index): KnowledgeNoteRoutingRoute => {
      const route = strictObject(item, [
        "noteId",
        "noteVersion",
        "relation",
        "rationale",
        "candidateNoteIds",
      ]);
      exactKeys(route, [
        "noteId",
        "noteVersion",
        "relation",
        "rationale",
        "candidateNoteIds",
      ]);
      const noteId = boundedIdentifier(
        route.noteId,
        `note routing routes[${index}].noteId`,
      );
      const noteVersion = boundedIdentifier(
        route.noteVersion,
        `note routing routes[${index}].noteVersion`,
      );
      const relation = enumValue(
        route.relation,
        [
          "unrelated",
          "duplicate",
          "extends",
          "contradicts",
          "uncertain",
        ] as const,
        `note routing routes[${index}].relation`,
      );
      const candidateNoteIds = identifierArray(
        route.candidateNoteIds,
        `note routing routes[${index}].candidateNoteIds`,
        0,
      );
      if (candidateNoteIds.includes(noteId)) {
        throw new Error("A note-routing route cannot select itself as a candidate.");
      }
      if (relation === "unrelated" && candidateNoteIds.length > 0) {
        throw new Error("An unrelated note-routing route cannot name candidates.");
      }
      return {
        noteId,
        noteVersion,
        relation,
        rationale: boundedText(
          route.rationale,
          `note routing routes[${index}].rationale`,
          2_000,
        ),
        candidateNoteIds,
      };
    },
  );
  assertUnique(routes.map(({ noteId }) => noteId), "note routing route IDs");
  if (
    routes.length !== expectedById.size ||
    routes.some(
      ({ noteId, noteVersion }) => expectedById.get(noteId) !== noteVersion,
    )
  ) {
    throw new Error(
      "Note routing must cover every contracted note ID and version exactly once.",
    );
  }
  return {
    rangeId,
    routes,
    warnings: stringArray(object.warnings, "note routing warnings"),
  };
}

export function parseKnowledgeReadingBlueprint(
  value: unknown,
  expectedRanges: ReadonlyArray<{ sourceId: string; rangeId: string }>,
): KnowledgeReadingBlueprint {
  const object = strictObject(value, [
    "spaceExplanation",
    "spaceFocusConcepts",
    "spaceQuestions",
    "readers",
    "warnings",
  ]);
  exactKeys(object, [
    "spaceExplanation",
    "spaceFocusConcepts",
    "spaceQuestions",
    "readers",
    "warnings",
  ]);
  const readers = nonEmptyArray(object.readers, "reading blueprint readers").map(
    (item, index) => {
      const entry = strictObject(item, [
        "readerId",
        "sourceId",
        "rangeId",
        "focusQuestions",
        "focusConcepts",
        "comparisons",
        "mustPreserve",
      ]);
      exactKeys(entry, [
        "readerId",
        "sourceId",
        "rangeId",
        "focusQuestions",
        "focusConcepts",
        "comparisons",
        "mustPreserve",
      ]);
      const comparisons = arrayValue(
        entry.comparisons,
        `reading blueprint readers[${index}].comparisons`,
      ).map((comparison) => {
        const compared = strictObject(comparison, ["noteId", "reason"]);
        exactKeys(compared, ["noteId", "reason"]);
        return {
          noteId: boundedIdentifier(compared.noteId, "comparison noteId"),
          reason: boundedText(compared.reason, "comparison reason", 2_000),
        };
      });
      return {
        readerId: boundedIdentifier(entry.readerId, "readerId"),
        sourceId: boundedIdentifier(entry.sourceId, "reader sourceId"),
        rangeId: boundedIdentifier(entry.rangeId, "reader rangeId"),
        focusQuestions: stringArray(entry.focusQuestions, "reader focusQuestions"),
        focusConcepts: stringArray(entry.focusConcepts, "reader focusConcepts"),
        comparisons,
        mustPreserve: stringArray(entry.mustPreserve, "reader mustPreserve"),
      };
    },
  );
  assertUnique(readers.map(({ readerId }) => readerId), "reader IDs");
  const expectedKeys = expectedRanges.map(sourceRangeKey);
  const receivedKeys = readers.map(sourceRangeKey);
  assertExactSet(receivedKeys, expectedKeys, "reading blueprint source ranges");
  return {
    spaceExplanation: boundedText(
      object.spaceExplanation,
      "reading blueprint spaceExplanation",
      8_000,
    ),
    spaceFocusConcepts: stringArray(
      object.spaceFocusConcepts,
      "reading blueprint spaceFocusConcepts",
    ),
    spaceQuestions: stringArray(
      object.spaceQuestions,
      "reading blueprint spaceQuestions",
    ),
    readers,
    warnings: stringArray(object.warnings, "reading blueprint warnings"),
  };
}

export function parseKnowledgeSourceReading(
  value: unknown,
  expectedSourceId: string,
  expectedRangeId: string,
): KnowledgeSourceReading {
  const object = strictObject(value, [
    "sourceId",
    "rangeId",
    "summary",
    "coverage",
    "sourceAssessment",
    "spaceAssessment",
    "sourceClaims",
    "synthesisSeeds",
    "spaceInterpretations",
    "mustPreserve",
  ]);
  exactKeys(object, [
    "sourceId",
    "rangeId",
    "summary",
    "coverage",
    "sourceAssessment",
    "spaceAssessment",
    "sourceClaims",
    "synthesisSeeds",
    "spaceInterpretations",
    "mustPreserve",
  ]);
  const sourceId = boundedIdentifier(object.sourceId, "source reading sourceId");
  const rangeId = boundedIdentifier(object.rangeId, "source reading rangeId");
  if (sourceId !== expectedSourceId || rangeId !== expectedRangeId) {
    throw new Error("A source reading must match its exact source and range contract.");
  }
  const coverageObject = strictObject(object.coverage, [
    "complete",
    "limitations",
  ]);
  exactKeys(coverageObject, ["complete", "limitations"]);
  const sourceAssessmentObject = strictObject(object.sourceAssessment, [
    "importance",
    "rationale",
  ]);
  exactKeys(sourceAssessmentObject, ["importance", "rationale"]);
  const spaceAssessmentObject = strictObject(object.spaceAssessment, [
    "relevance",
    "novelty",
    "focusConcepts",
    "deprioritizedConcepts",
    "reviewedNoteIds",
    "rationale",
  ]);
  exactKeys(spaceAssessmentObject, [
    "relevance",
    "novelty",
    "focusConcepts",
    "deprioritizedConcepts",
    "reviewedNoteIds",
    "rationale",
  ]);
  const sourceClaims = arrayValue(object.sourceClaims, "source claims").map(
    (item): KnowledgeSourceReading["sourceClaims"][number] => {
      const claim = strictObject(item, ["claimId", "text", "support"]);
      exactKeys(claim, ["claimId", "text", "support"]);
      const support = nonEmptyArray(claim.support, "source claim support").map(
        (supportItem): KnowledgeSourceSupport => {
          const supported = strictObject(supportItem, ["sourceId", "rangeId"]);
          exactKeys(supported, ["sourceId", "rangeId"]);
          const candidate = {
            sourceId: boundedIdentifier(
              supported.sourceId,
              "source claim support sourceId",
            ),
            rangeId: boundedIdentifier(
              supported.rangeId,
              "source claim support rangeId",
            ),
          };
          if (
            candidate.sourceId !== expectedSourceId ||
            candidate.rangeId !== expectedRangeId
          ) {
            throw new Error(
              "A source claim may cite only the source range assigned to its reader.",
            );
          }
          return candidate;
        },
      );
      assertUnique(support.map(sourceRangeKey), "source claim support");
      return {
        claimId: boundedIdentifier(claim.claimId, "source claimId"),
        text: boundedText(claim.text, "source claim text", 4_000),
        support,
      };
    },
  );
  assertUnique(sourceClaims.map(({ claimId }) => claimId), "source claim IDs");
  const knownClaimIds = new Set(sourceClaims.map(({ claimId }) => claimId));
  const synthesisSeeds = arrayValue(
    object.synthesisSeeds,
    "synthesis seeds",
  ).map((item, index): KnowledgeSourceReading["synthesisSeeds"][number] => {
    const seed = strictObject(item, [
      "seedId",
      "proposedTitle",
      "thesis",
      "claimIds",
      "importance",
      "contribution",
      "relatedNoteIds",
      "rationale",
    ]);
    exactKeys(seed, [
      "seedId",
      "proposedTitle",
      "thesis",
      "claimIds",
      "importance",
      "contribution",
      "relatedNoteIds",
      "rationale",
    ]);
    const claimIds = identifierArray(
      seed.claimIds,
      `synthesis seeds[${index}].claimIds`,
      1,
    );
    if (claimIds.length > 4) {
      throw new Error(
        `synthesis seeds[${index}].claimIds may contain at most 4 atomic claims.`,
      );
    }
    if (claimIds.some((claimId) => !knownClaimIds.has(claimId))) {
      throw new Error("A synthesis seed selected an unknown source claim.");
    }
    return {
      seedId: boundedIdentifier(seed.seedId, `synthesis seeds[${index}].seedId`),
      proposedTitle: boundedText(
        seed.proposedTitle,
        `synthesis seeds[${index}].proposedTitle`,
        300,
      ),
      thesis: boundedText(
        seed.thesis,
        `synthesis seeds[${index}].thesis`,
        4_000,
      ),
      claimIds,
      importance: assessmentLevel(
        seed.importance,
        `synthesis seeds[${index}].importance`,
      ),
      contribution: enumValue(
        seed.contribution,
        ["new", "extends", "contradicts", "connects", "qualifies"] as const,
        `synthesis seeds[${index}].contribution`,
      ),
      relatedNoteIds: identifierArray(
        seed.relatedNoteIds,
        `synthesis seeds[${index}].relatedNoteIds`,
        0,
      ),
      rationale: boundedText(
        seed.rationale,
        `synthesis seeds[${index}].rationale`,
        4_000,
      ),
    };
  });
  assertUnique(
    synthesisSeeds.map(({ seedId }) => seedId),
    "synthesis seed IDs",
  );
  assertUnique(
    synthesisSeeds.map(({ proposedTitle }) => normalizeTitle(proposedTitle)),
    "synthesis seed titles",
  );
  assertUnique(
    synthesisSeeds.map(({ thesis }) => normalizeTitle(thesis)),
    "synthesis seed theses",
  );
  const seededClaimIds = synthesisSeeds.flatMap(({ claimIds }) => claimIds);
  if (
    seededClaimIds.length !== knownClaimIds.size ||
    new Set(seededClaimIds).size !== seededClaimIds.length ||
    seededClaimIds.some((claimId) => !knownClaimIds.has(claimId))
  ) {
    throw new Error(
      "Synthesis seeds must partition every source claim exactly once.",
    );
  }
  const spaceInterpretations = arrayValue(
    object.spaceInterpretations,
    "space interpretations",
  ).map((item): KnowledgeSourceReading["spaceInterpretations"][number] => {
    const interpretation = strictObject(item, [
      "interpretationId",
      "text",
      "sourceClaimIds",
      "relatedNoteIds",
      "rationale",
    ]);
    exactKeys(interpretation, [
      "interpretationId",
      "text",
      "sourceClaimIds",
      "relatedNoteIds",
      "rationale",
    ]);
    const sourceClaimIds = identifierArray(
      interpretation.sourceClaimIds,
      "interpretation sourceClaimIds",
      1,
    );
    if (sourceClaimIds.some((claimId) => !knownClaimIds.has(claimId))) {
      throw new Error("A Space interpretation selected an unknown source claim.");
    }
    return {
      interpretationId: boundedIdentifier(
        interpretation.interpretationId,
        "interpretationId",
      ),
      text: boundedText(interpretation.text, "interpretation text", 4_000),
      sourceClaimIds,
      relatedNoteIds: identifierArray(
        interpretation.relatedNoteIds,
        "interpretation relatedNoteIds",
        0,
      ),
      rationale: boundedText(
        interpretation.rationale,
        "interpretation rationale",
        4_000,
      ),
    };
  });
  assertUnique(
    spaceInterpretations.map(({ interpretationId }) => interpretationId),
    "Space interpretation IDs",
  );
  return {
    sourceId,
    rangeId,
    summary: boundedText(object.summary, "source reading summary", 8_000),
    coverage: {
      complete: booleanValue(coverageObject.complete, "coverage complete"),
      limitations: stringArray(coverageObject.limitations, "coverage limitations"),
    },
    sourceAssessment: {
      importance: assessmentLevel(
        sourceAssessmentObject.importance,
        "source assessment importance",
      ),
      rationale: boundedText(
        sourceAssessmentObject.rationale,
        "source assessment rationale",
        4_000,
      ),
    },
    spaceAssessment: {
      relevance: assessmentLevel(
        spaceAssessmentObject.relevance,
        "space assessment relevance",
      ),
      novelty: assessmentLevel(
        spaceAssessmentObject.novelty,
        "space assessment novelty",
      ),
      focusConcepts: stringArray(
        spaceAssessmentObject.focusConcepts,
        "space assessment focusConcepts",
      ),
      deprioritizedConcepts: stringArray(
        spaceAssessmentObject.deprioritizedConcepts,
        "space assessment deprioritizedConcepts",
      ),
      reviewedNoteIds: identifierArray(
        spaceAssessmentObject.reviewedNoteIds,
        "space assessment reviewedNoteIds",
        0,
      ),
      rationale: boundedText(
        spaceAssessmentObject.rationale,
        "space assessment rationale",
        4_000,
      ),
    },
    sourceClaims,
    synthesisSeeds,
    spaceInterpretations,
    mustPreserve: stringArray(object.mustPreserve, "source reading mustPreserve"),
  };
}

export function parseKnowledgeWritingBlueprint(
  value: unknown,
  expectedReadingArtifactIds: readonly KnowledgeArtifactId[],
): KnowledgeWritingBlueprint {
  const object = strictObject(value, [
    "spaceThesis",
    "outputs",
    "seedDispositions",
    "writerSlots",
    "concepts",
    "suggestedConnections",
    "warnings",
  ]);
  exactKeys(object, [
    "spaceThesis",
    "outputs",
    "seedDispositions",
    "writerSlots",
    "concepts",
    "suggestedConnections",
    "warnings",
  ]);
  const allowedArtifacts = new Set(expectedReadingArtifactIds);
  const outputs = nonEmptyArray(object.outputs, "writing blueprint outputs").map(
    (item) => parseWritingBlueprintOutput(item, allowedArtifacts),
  );
  if (outputs.length > 30) {
    throw new Error("A writing blueprint may contain at most 30 outputs.");
  }
  assertUnique(outputs.map(({ outputId }) => outputId), "blueprint output IDs");
  assertUnique(
    outputs.map(({ title }) => normalizeTitle(title)),
    "blueprint output titles",
  );
  assertUnique(
    outputs
      .map(({ existingDestination }) => existingDestination?.noteId)
      .filter((noteId): noteId is string => Boolean(noteId)),
    "blueprint revision destinations",
  );
  const outputIds = new Set(outputs.map(({ outputId }) => outputId));
  const seedDispositions = arrayValue(
    object.seedDispositions,
    "writing blueprint seedDispositions",
  ).map((item, index): KnowledgeWritingBlueprint["seedDispositions"][number] => {
    const entry = strictObject(item, [
      "artifactId",
      "seedId",
      "disposition",
      "outputId",
      "rationale",
    ]);
    exactKeys(entry, [
      "artifactId",
      "seedId",
      "disposition",
      "outputId",
      "rationale",
    ]);
    const artifactId = boundedIdentifier(
      entry.artifactId,
      `writing blueprint seedDispositions[${index}].artifactId`,
    );
    if (!allowedArtifacts.has(artifactId)) {
      throw new Error(
        "A writing blueprint seed disposition selected an artifact outside its contract.",
      );
    }
    const disposition = enumValue(
      entry.disposition,
      ["output", "merged", "omitted"] as const,
      `writing blueprint seedDispositions[${index}].disposition`,
    );
    const outputId =
      entry.outputId === null
        ? null
        : boundedIdentifier(
            entry.outputId,
            `writing blueprint seedDispositions[${index}].outputId`,
          );
    if (disposition === "omitted" && outputId !== null) {
      throw new Error("An omitted synthesis seed must have a null outputId.");
    }
    if (disposition !== "omitted" && outputId === null) {
      throw new Error(
        "An output or merged synthesis seed requires a non-null outputId.",
      );
    }
    if (outputId !== null && !outputIds.has(outputId)) {
      throw new Error(
        "A synthesis seed disposition must reference a declared blueprint output.",
      );
    }
    return {
      artifactId,
      seedId: boundedIdentifier(
        entry.seedId,
        `writing blueprint seedDispositions[${index}].seedId`,
      ),
      disposition,
      outputId,
      rationale: boundedText(
        entry.rationale,
        `writing blueprint seedDispositions[${index}].rationale`,
        4_000,
      ),
    };
  });
  assertUnique(
    seedDispositions.map(({ artifactId, seedId }) => `${artifactId}\u0000${seedId}`),
    "writing blueprint synthesis seed dispositions",
  );
  const writerSlots = nonEmptyArray(
    object.writerSlots,
    "writing blueprint writerSlots",
  ).map((item) => {
    const slot = strictObject(item, ["writerSlotId", "objective", "outputIds"]);
    exactKeys(slot, ["writerSlotId", "objective", "outputIds"]);
    return {
      writerSlotId: boundedIdentifier(slot.writerSlotId, "writerSlotId"),
      objective: boundedText(slot.objective, "writer slot objective", 2_000),
      outputIds: identifierArray(slot.outputIds, "writer slot outputIds", 1),
    };
  });
  if (writerSlots.length > 6) {
    throw new Error("A writing blueprint may use at most six writer slots.");
  }
  assertUnique(
    writerSlots.map(({ writerSlotId }) => writerSlotId),
    "writer slot IDs",
  );
  const partitionedOutputIds = writerSlots.flatMap(({ outputIds }) => outputIds);
  assertUnique(partitionedOutputIds, "writer slot output partition");
  assertExactSet(
    partitionedOutputIds,
    outputs.map(({ outputId }) => outputId),
    "writer slot output partition",
  );
  const slotByOutput = new Map(
    writerSlots.flatMap(({ writerSlotId, outputIds }) =>
      outputIds.map((outputId) => [outputId, writerSlotId] as const),
    ),
  );
  for (const output of outputs) {
    if (slotByOutput.get(output.outputId) !== output.writerSlotId) {
      throw new Error(
        `Blueprint output ${output.outputId} does not match its writer slot partition.`,
      );
    }
  }
  return {
    spaceThesis: boundedText(object.spaceThesis, "writing blueprint spaceThesis", 8_000),
    outputs,
    seedDispositions,
    writerSlots,
    concepts: arrayValue(object.concepts, "blueprint concepts").map(
      parseOrganizedConcept,
    ),
    suggestedConnections: arrayValue(
      object.suggestedConnections,
      "blueprint suggestedConnections",
    ).map(parseSuggestedConnection),
    warnings: stringArray(object.warnings, "writing blueprint warnings"),
  };
}

export function parseKnowledgeWriterResult(
  value: unknown,
  expectedWriterSlotId: string,
  expectedOutputIds: readonly string[],
): KnowledgeWriterResult {
  const object = strictObject(value, ["writerSlotId", "drafts", "warnings"]);
  exactKeys(object, ["writerSlotId", "drafts", "warnings"]);
  const writerSlotId = boundedIdentifier(object.writerSlotId, "writer result slotId");
  if (writerSlotId !== expectedWriterSlotId) {
    throw new Error("A writer result must match its exact writer slot contract.");
  }
  const drafts = nonEmptyArray(object.drafts, "writer result drafts").map(
    parseWriterDraft,
  );
  assertUnique(drafts.map(({ outputId }) => outputId), "writer draft output IDs");
  assertExactSet(
    drafts.map(({ outputId }) => outputId),
    expectedOutputIds,
    "writer result outputs",
  );
  return {
    writerSlotId,
    drafts,
    warnings: stringArray(object.warnings, "writer result warnings"),
  };
}

function parseWritingBlueprintOutput(
  value: unknown,
  allowedArtifacts: ReadonlySet<string>,
): KnowledgeWritingBlueprintOutput {
  const object = strictObject(value, [
    "outputId",
    "operation",
    "kind",
    "title",
    "editorialBrief",
    "sourceIds",
    "claimSelections",
    "lensSelections",
    "mustPreserve",
    "estimatedTokens",
    "writerSlotId",
    "existingDestination",
  ]);
  exactKeys(object, [
    "outputId",
    "operation",
    "kind",
    "title",
    "editorialBrief",
    "sourceIds",
    "claimSelections",
    "lensSelections",
    "mustPreserve",
    "estimatedTokens",
    "writerSlotId",
    "existingDestination",
  ]);
  const operation = draftOperation(object.operation, "blueprint output operation");
  const existingDestination = parseExistingDestination(object.existingDestination);
  assertDestinationMatchesOperation(operation, existingDestination);
  return {
    outputId: boundedIdentifier(object.outputId, "blueprint outputId"),
    operation,
    kind: draftKind(object.kind, "blueprint output kind"),
    title: boundedText(object.title, "blueprint output title", 300),
    editorialBrief: boundedText(
      object.editorialBrief,
      "blueprint editorialBrief",
      4_000,
    ),
    sourceIds: identifierArray(object.sourceIds, "blueprint sourceIds", 1),
    claimSelections: parseEvidenceSelections(
      object.claimSelections,
      "blueprint claimSelections",
      allowedArtifacts,
      true,
    ),
    lensSelections: parseLensSelections(
      object.lensSelections,
      "blueprint lensSelections",
      allowedArtifacts,
    ),
    mustPreserve: stringArray(object.mustPreserve, "blueprint mustPreserve"),
    estimatedTokens: boundedInteger(
      object.estimatedTokens,
      "blueprint estimatedTokens",
      128,
      12_000,
    ),
    writerSlotId: boundedIdentifier(object.writerSlotId, "blueprint writerSlotId"),
    existingDestination,
  };
}

function parseWriterDraft(value: unknown): KnowledgeWriterDraft {
  const object = strictObject(value, [
    "outputId",
    "operation",
    "kind",
    "title",
    "summary",
    "body",
    "tags",
    "aliases",
    "links",
    "overview",
    "spaceRelevance",
    "sourceGroundedDetails",
    "uncertainties",
    "sourceIds",
    "claimSelections",
    "lensSelections",
    "mustPreserve",
    "existingDestination",
  ]);
  exactKeys(object, [
    "outputId",
    "operation",
    "kind",
    "title",
    "summary",
    "body",
    "tags",
    "aliases",
    "links",
    "overview",
    "spaceRelevance",
    "sourceGroundedDetails",
    "uncertainties",
    "sourceIds",
    "claimSelections",
    "lensSelections",
    "mustPreserve",
    "existingDestination",
  ]);
  const operation = draftOperation(object.operation, "writer draft operation");
  const kind = draftKind(object.kind, "writer draft kind");
  const existingDestination = parseExistingDestination(object.existingDestination);
  assertDestinationMatchesOperation(operation, existingDestination);
  const overview = boundedText(object.overview, "writer draft overview", 4_000, true);
  const spaceRelevance = boundedText(
    object.spaceRelevance,
    "writer draft spaceRelevance",
    8_000,
    true,
  );
  const sourceGroundedDetails = stringArray(
    object.sourceGroundedDetails,
    "writer draft sourceGroundedDetails",
  );
  const uncertainties = stringArray(
    object.uncertainties,
    "writer draft uncertainties",
  );
  if (
    kind === "note" &&
    (overview ||
      spaceRelevance ||
      sourceGroundedDetails.length > 0 ||
      uncertainties.length > 0)
  ) {
    throw new Error("An ordinary note must leave wiki-only draft fields empty.");
  }
  return {
    outputId: boundedIdentifier(object.outputId, "writer draft outputId"),
    operation,
    kind,
    title: boundedText(object.title, "writer draft title", 300),
    summary: boundedText(object.summary, "writer draft summary", 2_000, true),
    body: boundedText(object.body, "writer draft body", 100_000, true),
    tags: stringArray(object.tags, "writer draft tags"),
    aliases: stringArray(object.aliases, "writer draft aliases"),
    links: parseLinks(object.links),
    overview,
    spaceRelevance,
    sourceGroundedDetails,
    uncertainties,
    sourceIds: identifierArray(object.sourceIds, "writer draft sourceIds", 1),
    claimSelections: parseEvidenceSelections(
      object.claimSelections,
      "writer draft claimSelections",
      undefined,
      true,
    ),
    lensSelections: parseLensSelections(
      object.lensSelections,
      "writer draft lensSelections",
      undefined,
    ),
    mustPreserve: stringArray(
      object.mustPreserve,
      "writer draft mustPreserve",
    ),
    existingDestination,
  };
}

function parseEvidenceSelections(
  value: unknown,
  label: string,
  allowedArtifacts: ReadonlySet<string> | undefined,
  requireOne: boolean,
): KnowledgeEvidenceSelection[] {
  const selections = arrayValue(value, label).map((item) => {
    const selection = strictObject(item, ["artifactId", "claimIds"]);
    exactKeys(selection, ["artifactId", "claimIds"]);
    const artifactId = boundedIdentifier(
      selection.artifactId,
      `${label} artifactId`,
    );
    if (allowedArtifacts && !allowedArtifacts.has(artifactId)) {
      throw new Error(`${label} selected an artifact outside its contract.`);
    }
    return {
      artifactId,
      claimIds: identifierArray(selection.claimIds, `${label} claimIds`, 1),
    };
  });
  if (requireOne && selections.length === 0) {
    throw new Error(`${label} requires at least one source-claim selection.`);
  }
  assertUnique(
    selections.map(({ artifactId }) => artifactId),
    `${label} artifact IDs`,
  );
  return selections;
}

function parseLensSelections(
  value: unknown,
  label: string,
  allowedArtifacts: ReadonlySet<string> | undefined,
): KnowledgeLensSelection[] {
  const selections = arrayValue(value, label).map((item) => {
    const selection = strictObject(item, ["artifactId", "interpretationIds"]);
    exactKeys(selection, ["artifactId", "interpretationIds"]);
    const artifactId = boundedIdentifier(
      selection.artifactId,
      `${label} artifactId`,
    );
    if (allowedArtifacts && !allowedArtifacts.has(artifactId)) {
      throw new Error(`${label} selected an artifact outside its contract.`);
    }
    return {
      artifactId,
      interpretationIds: identifierArray(
        selection.interpretationIds,
        `${label} interpretationIds`,
        1,
      ),
    };
  });
  assertUnique(
    selections.map(({ artifactId }) => artifactId),
    `${label} artifact IDs`,
  );
  return selections;
}

function parseExistingDestination(
  value: unknown,
): KnowledgeExistingDestination | null {
  if (value === null) return null;
  const object = strictObject(value, ["noteId", "baseVersion"]);
  exactKeys(object, ["noteId", "baseVersion"]);
  return {
    noteId: boundedIdentifier(object.noteId, "existing destination noteId"),
    baseVersion: boundedIdentifier(
      object.baseVersion,
      "existing destination baseVersion",
    ),
  };
}

function assertDestinationMatchesOperation(
  operation: KnowledgeDraftOperation,
  destination: KnowledgeExistingDestination | null,
): void {
  if (operation === "create" && destination) {
    throw new Error("A create output cannot name an existing destination.");
  }
  if (operation === "revise" && !destination) {
    throw new Error("A revise output requires an exact existing destination.");
  }
}

function draftOperation(value: unknown, label: string): KnowledgeDraftOperation {
  return enumValue(value, ["create", "revise"] as const, label);
}

function draftKind(value: unknown, label: string): KnowledgeDraftKind {
  return enumValue(value, ["note", "wikiArticle"] as const, label);
}

function assessmentLevel(
  value: unknown,
  label: string,
): KnowledgeAssessmentLevel {
  return enumValue(value, ["low", "medium", "high"] as const, label);
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function boundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function sourceRangeKey(value: { sourceId: string; rangeId: string }): string {
  return `${value.sourceId}\u0000${value.rangeId}`;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} cannot contain duplicates.`);
  }
}

function assertExactSet(
  received: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  assertUnique(received, label);
  assertUnique(expected, `${label} contract`);
  if (
    received.length !== expected.length ||
    received.some((value) => !new Set(expected).has(value))
  ) {
    throw new Error(`${label} must match its exact output contract.`);
  }
}

export function parseKnowledgeRunResult(value: unknown): KnowledgeRunResult {
  const object = strictObject(value, [
    "result",
    "provenance",
    "ownerProposals",
    "warnings",
  ]);
  exactKeys(object, ["result", "provenance", "ownerProposals", "warnings"]);
  const result = parseOrganizeContentResult(object.result);
  const provenance = arrayValue(object.provenance, "result provenance").map(
    (item): KnowledgeResultProvenance => {
      const entry = strictObject(item, [
        "kind",
        "title",
        "sourceIds",
        "evidenceReferences",
      ]);
      exactKeys(entry, ["kind", "title", "sourceIds", "evidenceReferences"]);
      return {
        kind: enumValue(
          entry.kind,
          ["note", "wikiArticle"] as const,
          "provenance kind",
        ),
        title: boundedText(entry.title, "provenance title", 300),
        sourceIds: identifierArray(entry.sourceIds, "provenance sourceIds", 0),
        evidenceReferences: arrayValue(
          entry.evidenceReferences,
          "provenance evidenceReferences",
        ).map(parseKnowledgeReference),
      };
    },
  );
  const expected = [
    ...result.notes.map(({ title }) => `note:${normalizeTitle(title)}`),
    ...result.wikiArticles.map(
      ({ title }) => `wikiArticle:${normalizeTitle(title)}`,
    ),
  ];
  const received = new Set(
    provenance.map(({ kind, title }) => `${kind}:${normalizeTitle(title)}`),
  );
  for (const key of expected) {
    if (!received.has(key)) {
      throw new Error(`Missing source provenance for ${key}.`);
    }
  }
  return {
    result,
    provenance,
    ownerProposals: arrayValue(
      object.ownerProposals,
      "root ownerProposals",
    ).map(parseOwnerProposal),
    warnings: stringArray(object.warnings, "root warnings"),
  };
}

function parseArtifactPayload(value: unknown): KnowledgeArtifactPayload {
  const object = strictObject(value, [
    "summary",
    "body",
    "assessment",
    "claims",
    "references",
    "mustPreserve",
    "ownerProposals",
    "validation",
  ]);
  const allowed = [
    "summary",
    "body",
    "assessment",
    "claims",
    "references",
    "mustPreserve",
    "ownerProposals",
    "validation",
  ];
  exactKeys(object, allowed);
  const validation =
    object.validation == null
      ? undefined
      : parseValidationResult(object.validation);
  const assessment = strictObject(object.assessment, [
    "spaceRelevance",
    "sourceImportance",
    "novelty",
    "focusConcepts",
    "deprioritizedConcepts",
    "reviewedNoteIds",
    "rationale",
  ]);
  exactKeys(assessment, [
    "spaceRelevance",
    "sourceImportance",
    "novelty",
    "focusConcepts",
    "deprioritizedConcepts",
    "reviewedNoteIds",
    "rationale",
  ]);
  return {
    summary: boundedText(object.summary, "artifact summary", 4_000),
    body: boundedText(object.body, "artifact body", 64_000, true),
    assessment: {
      spaceRelevance: enumValue(
        assessment.spaceRelevance,
        ["low", "medium", "high"] as const,
        "assessment spaceRelevance",
      ),
      sourceImportance: enumValue(
        assessment.sourceImportance,
        ["low", "medium", "high"] as const,
        "assessment sourceImportance",
      ),
      novelty: enumValue(
        assessment.novelty,
        ["low", "medium", "high"] as const,
        "assessment novelty",
      ),
      focusConcepts: stringArray(
        assessment.focusConcepts,
        "assessment focusConcepts",
      ),
      deprioritizedConcepts: stringArray(
        assessment.deprioritizedConcepts,
        "assessment deprioritizedConcepts",
      ),
      reviewedNoteIds: identifierArray(
        assessment.reviewedNoteIds,
        "assessment reviewedNoteIds",
        0,
      ),
      rationale: boundedText(
        assessment.rationale,
        "assessment rationale",
        4_000,
      ),
    },
    claims: arrayValue(object.claims, "artifact claims").map((claim) => {
      const entry = strictObject(claim, ["text", "references"]);
      exactKeys(entry, ["text", "references"]);
      return {
        text: boundedText(entry.text, "claim text", 4_000),
        references: arrayValue(entry.references, "claim references").map(
          parseKnowledgeReference,
        ),
      };
    }),
    references: arrayValue(object.references, "artifact references").map(
      parseKnowledgeReference,
    ),
    mustPreserve: stringArray(object.mustPreserve, "artifact mustPreserve"),
    ownerProposals: arrayValue(
      object.ownerProposals,
      "artifact ownerProposals",
    ).map(parseOwnerProposal),
    ...(validation ? { validation } : {}),
  };
}

function parseOwnerProposal(value: unknown): KnowledgeOwnerProposal {
  const object = strictObject(value, [
    "destinationNoteId",
    "baseVersion",
    "title",
    "summary",
    "body",
    "aliases",
    "tags",
    "sourceIds",
  ]);
  exactKeys(object, [
    "destinationNoteId",
    "baseVersion",
    "title",
    "summary",
    "body",
    "aliases",
    "tags",
    "sourceIds",
  ]);
  return {
    destinationNoteId: boundedIdentifier(
      object.destinationNoteId,
      "proposal destinationNoteId",
    ),
    baseVersion: boundedIdentifier(object.baseVersion, "proposal baseVersion"),
    title: boundedText(object.title, "proposal title", 300),
    summary: boundedText(object.summary, "proposal summary", 2_000, true),
    body: boundedText(object.body, "proposal body", 100_000, true),
    aliases: stringArray(object.aliases, "proposal aliases"),
    tags: stringArray(object.tags, "proposal tags"),
    sourceIds: identifierArray(object.sourceIds, "proposal sourceIds", 0),
  };
}

function parseValidationResult(value: unknown): KnowledgeValidationResult {
  const object = strictObject(value, ["valid", "issues", "checkedArtifactIds"]);
  exactKeys(object, ["valid", "issues", "checkedArtifactIds"]);
  if (typeof object.valid !== "boolean") {
    throw new Error("validation.valid must be a boolean.");
  }
  return {
    valid: object.valid,
    issues: stringArray(object.issues, "validation issues"),
    checkedArtifactIds: identifierArray(
      object.checkedArtifactIds,
      "validation checkedArtifactIds",
      1,
    ),
  };
}

function parseOutputContract(value: unknown): KnowledgeOutputContract {
  const object = recordValue(value, "output contract");
  const kind = enumValue(
    object.kind,
    [
      "root-result",
      "note-routing",
      "reading-blueprint",
      "source-reading",
      "writing-blueprint",
      "writer-result",
      "evidence",
      "reconciliation",
      "compression",
      "owner-proposal",
      "validation",
    ] as const,
    "output contract kind",
  );
  if (kind === "note-routing") {
    exactKeys(object, ["kind", "rangeId", "expectedNotes"]);
    const expectedNotes = nonEmptyArray(
      object.expectedNotes,
      "output expectedNotes",
    ).map((item, index) => {
      const note = strictObject(item, ["noteId", "noteVersion"]);
      exactKeys(note, ["noteId", "noteVersion"]);
      return {
        noteId: boundedIdentifier(
          note.noteId,
          `output expectedNotes[${index}].noteId`,
        ),
        noteVersion: boundedIdentifier(
          note.noteVersion,
          `output expectedNotes[${index}].noteVersion`,
        ),
      };
    });
    assertUnique(
      expectedNotes.map(({ noteId }) => noteId),
      "output expected note IDs",
    );
    return {
      kind,
      rangeId: boundedIdentifier(object.rangeId, "output routing rangeId"),
      expectedNotes,
    };
  }
  if (kind === "reading-blueprint") {
    exactKeys(object, ["kind", "sourceRanges"]);
    const sourceRanges = nonEmptyArray(
      object.sourceRanges,
      "output sourceRanges",
    ).map((item) => {
      const range = strictObject(item, ["sourceId", "rangeId"]);
      exactKeys(range, ["sourceId", "rangeId"]);
      return {
        sourceId: boundedIdentifier(range.sourceId, "output sourceId"),
        rangeId: boundedIdentifier(range.rangeId, "output rangeId"),
      };
    });
    assertUnique(sourceRanges.map(sourceRangeKey), "output source ranges");
    return { kind, sourceRanges };
  }
  if (kind === "source-reading") {
    exactKeys(object, ["kind", "sourceId", "rangeId"]);
    return {
      kind,
      sourceId: boundedIdentifier(object.sourceId, "output sourceId"),
      rangeId: boundedIdentifier(object.rangeId, "output rangeId"),
    };
  }
  if (kind === "writing-blueprint") {
    exactKeys(object, ["kind", "readingArtifactIds"]);
    return {
      kind,
      readingArtifactIds: identifierArray(
        object.readingArtifactIds,
        "output readingArtifactIds",
        1,
      ),
    };
  }
  if (kind === "writer-result") {
    exactKeys(object, ["kind", "writerSlotId", "outputIds"]);
    return {
      kind,
      writerSlotId: boundedIdentifier(
        object.writerSlotId,
        "output writerSlotId",
      ),
      outputIds: identifierArray(object.outputIds, "output outputIds", 1),
    };
  }
  if (kind === "owner-proposal") {
    exactKeys(object, ["kind", "destinationNoteIds"]);
    return {
      kind,
      destinationNoteIds: identifierArray(
        object.destinationNoteIds,
        "output destinationNoteIds",
        1,
      ),
    };
  }
  if (kind === "validation") {
    exactKeys(object, ["kind", "proposalArtifactIds"]);
    return {
      kind,
      proposalArtifactIds: identifierArray(
        object.proposalArtifactIds,
        "output proposalArtifactIds",
        1,
      ),
    };
  }
  exactKeys(object, ["kind"]);
  return { kind };
}

function parseOrganizeContentResult(value: unknown): OrganizeContentResult {
  const object = strictObject(value, [
    "notes",
    "wikiArticles",
    "concepts",
    "suggestedConnections",
  ]);
  exactKeys(object, ["notes", "wikiArticles", "concepts", "suggestedConnections"]);
  return {
    notes: arrayValue(object.notes, "organized notes").map(parseOrganizedNote),
    wikiArticles: arrayValue(
      object.wikiArticles,
      "organized wikiArticles",
    ).map(parseOrganizedWikiArticle),
    concepts: arrayValue(object.concepts, "organized concepts").map(
      parseOrganizedConcept,
    ),
    suggestedConnections: arrayValue(
      object.suggestedConnections,
      "suggestedConnections",
    ).map(parseSuggestedConnection),
  };
}

function parseOrganizedNote(value: unknown): OrganizedNote {
  const object = strictObject(value, [
    "title",
    "summary",
    "body",
    "tags",
    "aliases",
    "links",
  ]);
  exactKeys(object, ["title", "summary", "body", "tags", "aliases", "links"]);
  return {
    title: boundedText(object.title, "note title", 300),
    summary: boundedText(object.summary, "note summary", 2_000, true),
    body: boundedText(object.body, "note body", 100_000, true),
    tags: stringArray(object.tags, "note tags"),
    aliases: stringArray(object.aliases, "note aliases"),
    links: parseLinks(object.links),
  };
}

function parseOrganizedWikiArticle(value: unknown): OrganizedWikiArticle {
  const object = strictObject(value, [
    "title",
    "summary",
    "body",
    "overview",
    "spaceRelevance",
    "sourceGroundedDetails",
    "uncertainties",
    "tags",
    "aliases",
    "links",
  ]);
  exactKeys(object, [
    "title",
    "summary",
    "body",
    "overview",
    "spaceRelevance",
    "sourceGroundedDetails",
    "uncertainties",
    "tags",
    "aliases",
    "links",
  ]);
  return {
    title: boundedText(object.title, "wiki title", 300),
    summary: boundedText(object.summary, "wiki summary", 2_000, true),
    body: boundedText(object.body, "wiki body", 100_000, true),
    overview: boundedText(object.overview, "wiki overview", 4_000, true),
    spaceRelevance: boundedText(
      object.spaceRelevance,
      "wiki spaceRelevance",
      8_000,
      true,
    ),
    sourceGroundedDetails: stringArray(
      object.sourceGroundedDetails,
      "wiki sourceGroundedDetails",
    ),
    uncertainties: stringArray(object.uncertainties, "wiki uncertainties"),
    tags: stringArray(object.tags, "wiki tags"),
    aliases: stringArray(object.aliases, "wiki aliases"),
    links: parseLinks(object.links),
  };
}

function parseOrganizedConcept(value: unknown): OrganizedConcept {
  const object = strictObject(value, [
    "label",
    "aliases",
    "description",
    "canonicalTitle",
    "relatedTitles",
  ]);
  exactKeys(object, [
    "label",
    "aliases",
    "description",
    "canonicalTitle",
    "relatedTitles",
  ]);
  return {
    label: boundedText(object.label, "concept label", 300),
    aliases: stringArray(object.aliases, "concept aliases"),
    description: boundedText(object.description, "concept description", 4_000, true),
    canonicalTitle: boundedText(object.canonicalTitle, "canonical title", 300),
    relatedTitles: stringArray(object.relatedTitles, "related titles"),
  };
}

function parseSuggestedConnection(value: unknown): SuggestedConnection {
  const object = strictObject(value, ["fromTitle", "toTitle", "reason"]);
  exactKeys(object, ["fromTitle", "toTitle", "reason"]);
  return {
    fromTitle: boundedText(object.fromTitle, "connection fromTitle", 300),
    toTitle: boundedText(object.toTitle, "connection toTitle", 300),
    reason: boundedText(object.reason, "connection reason", 2_000),
  };
}

function parseLinks(value: unknown): OrganizedNote["links"] {
  return arrayValue(value, "organized links").map((link) => {
    const object = strictObject(link, ["targetTitle", "context"]);
    exactKeys(object, ["targetTitle", "context"]);
    return {
      targetTitle: boundedText(object.targetTitle, "link targetTitle", 300),
      context: boundedText(object.context, "link context", 2_000, true),
    };
  });
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function strictObject(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const object = recordValue(value, "value");
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unexpected field: ${key}`);
    }
  }
  return object;
}

function exactKeys(object: Record<string, unknown>, expected: readonly string[]) {
  const expectedSet = new Set(expected);
  const actual = Object.keys(object);
  for (const key of expected) {
    if (!(key in object)) throw new Error(`Missing required field: ${key}`);
  }
  for (const key of actual) {
    if (!expectedSet.has(key)) throw new Error(`Unexpected field: ${key}`);
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  const text = stringValue(value, label).trim();
  if ((!allowEmpty && !text) || text.length > maximum) {
    throw new Error(`${label} must contain ${allowEmpty ? "at most" : "1 to"} ${maximum} characters.`);
  }
  return text;
}

function boundedIdentifier(value: unknown, label: string): string {
  const identifier = boundedText(value, label, 300);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(identifier)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
  return identifier;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > 200) throw new Error(`${label} exceeds its safe bound.`);
  return value;
}

function nonEmptyArray(value: unknown, label: string): unknown[] {
  const items = arrayValue(value, label);
  if (items.length === 0) throw new Error(`${label} cannot be empty.`);
  return items;
}

function stringArray(value: unknown, label: string): string[] {
  return arrayValue(value, label).map((item, index) =>
    boundedText(item, `${label}[${index}]`, 4_000),
  );
}

function identifierArray(
  value: unknown,
  label: string,
  minimum: number,
): string[] {
  const identifiers = arrayValue(value, label).map((item, index) =>
    boundedIdentifier(item, `${label}[${index}]`),
  );
  if (identifiers.length < minimum) {
    throw new Error(`${label} requires at least ${minimum} value(s).`);
  }
  if (new Set(identifiers).size !== identifiers.length) {
    throw new Error(`${label} cannot contain duplicates.`);
  }
  return identifiers;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  const text = stringValue(value, label);
  if (!values.includes(text)) throw new Error(`Invalid ${label}: ${text}`);
  return text as T[number];
}

function normalizeTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
