import type {
  CoordinationCall,
  KnowledgeArtifact,
  KnowledgeArtifactId,
  KnowledgeArtifactPayload,
  KnowledgeAssignmentContract,
  KnowledgeAssignmentId,
  KnowledgeAssignmentState,
  KnowledgeCallId,
  KnowledgeCompletionPayload,
  KnowledgeNoteRoutingResult,
  KnowledgeRunId,
  KnowledgeRunResult,
  KnowledgeTelemetry,
} from "./protocol";

const MAX_CHILD_ASSIGNMENTS_PER_PARENT = 100;

export type KnowledgeRuntimeEvent =
  | {
      sequence: number;
      type: "run-created";
      runId: KnowledgeRunId;
      root: KnowledgeAssignmentContract;
    }
  | {
      sequence: number;
      type: "coordination-accepted";
      parentAssignmentId: KnowledgeAssignmentId;
      call: CoordinationCall;
      assignmentIds: KnowledgeAssignmentId[];
    }
  | {
      sequence: number;
      type: "coordination-rejected";
      parentAssignmentId: KnowledgeAssignmentId;
      callId: KnowledgeCallId;
      reason: string;
    }
  | {
      sequence: number;
      type: "coordination-held";
      parentAssignmentId: KnowledgeAssignmentId;
      call: CoordinationCall;
      reason: string;
    }
  | {
      sequence: number;
      type: "assignment-created";
      callId: KnowledgeCallId;
      primitive: CoordinationCall["primitive"];
      assignment: KnowledgeAssignmentContract;
    }
  | {
      sequence: number;
      type: "assignment-started";
      assignmentId: KnowledgeAssignmentId;
      attempt: number;
    }
  | {
      sequence: number;
      type: "assignment-waiting";
      assignmentId: KnowledgeAssignmentId;
    }
  | {
      sequence: number;
      type: "assignment-completed";
      assignmentId: KnowledgeAssignmentId;
      artifactId?: KnowledgeArtifactId;
    }
  | {
      sequence: number;
      type: "assignment-failed";
      assignmentId: KnowledgeAssignmentId;
      error: string;
    }
  | {
      sequence: number;
      type: "assignment-cancelled" | "assignment-superseded";
      assignmentId: KnowledgeAssignmentId;
    }
  | {
      sequence: number;
      type: "artifact-recorded";
      artifact: KnowledgeArtifact;
    }
  | {
      sequence: number;
      type: "destination-owner-granted";
      assignmentId: KnowledgeAssignmentId;
      destinationNoteIds: string[];
    }
  | {
      sequence: number;
      type: "destination-owner-released";
      assignmentId: KnowledgeAssignmentId;
      destinationNoteIds: string[];
    }
  | {
      sequence: number;
      type: "destination-owner-rejected";
      assignmentId: KnowledgeAssignmentId;
      destinationNoteIds: string[];
      reason: string;
    }
  | {
      sequence: number;
      type: "observation-recorded";
      observationId: string;
      assignmentId?: KnowledgeAssignmentId;
      message: string;
    }
  | {
      sequence: number;
      type: "run-completed";
      result: KnowledgeRunResult;
    }
  | { sequence: number; type: "run-failed"; error: string }
  | { sequence: number; type: "run-cancelled" };

type KnowledgeRuntimeEventInput = KnowledgeRuntimeEvent extends infer Event
  ? Event extends { sequence: number }
    ? Omit<Event, "sequence">
    : never
  : never;

export interface ProjectedAssignment {
  contract: KnowledgeAssignmentContract;
  state: KnowledgeAssignmentState;
  attempts: number;
  primitive?: CoordinationCall["primitive"];
  childAssignmentIds: KnowledgeAssignmentId[];
  artifactId?: KnowledgeArtifactId;
  error?: string;
}

export interface ProjectedObservation {
  message: string;
  assignmentId?: KnowledgeAssignmentId;
}

export interface KnowledgeRuntimeProjection {
  runId: KnowledgeRunId;
  status: "running" | "completed" | "failed" | "cancelled";
  assignments: Map<KnowledgeAssignmentId, ProjectedAssignment>;
  artifacts: Map<KnowledgeArtifactId, KnowledgeArtifact>;
  observations: Map<string, ProjectedObservation>;
  activeDestinationOwners: Map<string, KnowledgeAssignmentId>;
  acceptedCallIds: Set<KnowledgeCallId>;
  heldCalls: Map<KnowledgeCallId, CoordinationCall>;
  result?: KnowledgeRunResult;
  error?: string;
  telemetry: KnowledgeTelemetry;
}

export interface AcceptCoordinationOptions {
  hold?: (call: CoordinationCall) => string | undefined;
  referenceAllowed?: (
    assignment: KnowledgeAssignmentContract,
  ) => string | undefined;
}

export class KnowledgeRuntime {
  readonly runId: KnowledgeRunId;
  private events: KnowledgeRuntimeEvent[];

  constructor(runId: KnowledgeRunId, root: KnowledgeAssignmentContract) {
    if (
      root.parent.kind !== "run" ||
      root.parent.runId !== runId ||
      root.purpose !== "root"
    ) {
      throw new Error("The root assignment must belong to the created run.");
    }
    this.runId = runId;
    this.events = [{ sequence: 0, type: "run-created", runId, root }];
  }

  history(): readonly KnowledgeRuntimeEvent[] {
    return this.events;
  }

  projection(): KnowledgeRuntimeProjection {
    return replayKnowledgeEvents(this.events);
  }

  acceptCoordination(
    parentAssignmentId: KnowledgeAssignmentId,
    calls: readonly CoordinationCall[],
    options: AcceptCoordinationOptions = {},
  ): KnowledgeAssignmentId[] {
    const created: KnowledgeAssignmentId[] = [];
    for (const call of calls) {
      const projection = this.projection();
      if (projection.status !== "running") break;
      if (projection.acceptedCallIds.has(call.callId)) continue;
      const parent = projection.assignments.get(parentAssignmentId);
      if (!parent || !["accepted", "running", "waiting"].includes(parent.state)) {
        this.append({
          type: "coordination-rejected",
          parentAssignmentId,
          callId: call.callId,
          reason: "The parent assignment is not active.",
        });
        continue;
      }
      const heldReason = options.hold?.(call);
      if (heldReason) {
        this.append({
          type: "coordination-held",
          parentAssignmentId,
          call,
          reason: heldReason,
        });
        continue;
      }
      const assignments = assignmentsForCall(call);
      const validationError = validateAssignmentsForCall(
        call,
        parentAssignmentId,
        projection,
        options.referenceAllowed,
      );
      if (validationError) {
        this.append({
          type: "coordination-rejected",
          parentAssignmentId,
          callId: call.callId,
          reason: validationError,
        });
        continue;
      }
      this.append({
        type: "coordination-accepted",
        parentAssignmentId,
        call,
        assignmentIds: assignments.map(({ assignmentId }) => assignmentId),
      });
      for (const assignment of assignments) {
        this.append({
          type: "assignment-created",
          callId: call.callId,
          primitive: call.primitive,
          assignment,
        });
        if (assignment.authority.kind === "destination-owner") {
          this.append({
            type: "destination-owner-granted",
            assignmentId: assignment.assignmentId,
            destinationNoteIds: assignment.authority.destinationNoteIds,
          });
        }
        created.push(assignment.assignmentId);
      }
    }
    return created;
  }

  acceptHeldCall(callId: KnowledgeCallId): KnowledgeAssignmentId[] {
    const projection = this.projection();
    const call = projection.heldCalls.get(callId);
    if (!call) return [];
    const held = [...this.events]
      .reverse()
      .find(
        (event): event is Extract<
          KnowledgeRuntimeEvent,
          { type: "coordination-held" }
        > => event.type === "coordination-held" && event.call.callId === callId,
      );
    if (!held) return [];
    return this.acceptCoordination(held.parentAssignmentId, [call]);
  }

  startAssignment(assignmentId: KnowledgeAssignmentId): boolean {
    const assignment = this.projection().assignments.get(assignmentId);
    if (!assignment || !["accepted", "waiting"].includes(assignment.state)) {
      return false;
    }
    this.append({
      type: "assignment-started",
      assignmentId,
      attempt: assignment.attempts + 1,
    });
    return true;
  }

  waitAssignment(assignmentId: KnowledgeAssignmentId): boolean {
    const assignment = this.projection().assignments.get(assignmentId);
    if (!assignment || !["accepted", "running"].includes(assignment.state)) {
      return false;
    }
    this.append({ type: "assignment-waiting", assignmentId });
    return true;
  }

  completeAssignment(
    assignmentId: KnowledgeAssignmentId,
    payload: KnowledgeCompletionPayload,
  ): boolean {
    const projection = this.projection();
    const assignment = projection.assignments.get(assignmentId);
    if (!assignment || assignment.state !== "running") return false;
    if (assignment.contract.purpose === "root") {
      this.append({ type: "assignment-completed", assignmentId });
      this.append({ type: "run-completed", result: payload as KnowledgeRunResult });
      return true;
    }
    if (assignment.contract.output.kind === "note-routing") {
      if (
        assignment.contract.purpose !== "router" ||
        !isKnowledgeNoteRoutingResult(payload)
      ) {
        throw new Error("A router assignment must complete with typed note routing.");
      }
      const artifactId = stableArtifactId(assignmentId, assignment.attempts);
      const artifact: KnowledgeArtifact = {
        artifactId,
        assignmentId,
        purpose: "router",
        summary: `Routed ${payload.routes.length} note digest${payload.routes.length === 1 ? "" : "s"} in ${payload.rangeId}.`,
        body: "",
        assessment: {
          spaceRelevance: "medium",
          sourceImportance: "medium",
          novelty: "medium",
          focusConcepts: [],
          deprioritizedConcepts: [],
          reviewedNoteIds: payload.routes.map(({ noteId }) => noteId),
          rationale: "Typed host-owned routing coverage.",
        },
        claims: [],
        references: structuredClone(assignment.contract.references),
        mustPreserve: [...assignment.contract.constraints.mustPreserve],
        ownerProposals: [],
        routing: structuredClone(payload),
      };
      this.append({ type: "artifact-recorded", artifact });
      this.append({ type: "assignment-completed", assignmentId, artifactId });
      return true;
    }
    if (
      assignment.contract.purpose === "reading-blueprint" ||
      assignment.contract.purpose === "source-reader" ||
      assignment.contract.purpose === "writing-blueprint" ||
      assignment.contract.purpose === "writer"
    ) {
      throw new Error(
        "Fixed import-pipeline completions cannot enter the legacy artifact runtime.",
      );
    }
    if (!isKnowledgeArtifactPayload(payload)) {
      throw new Error("A legacy knowledge assignment returned the wrong completion payload.");
    }
    const artifactId = stableArtifactId(assignmentId, assignment.attempts);
    const artifact: KnowledgeArtifact = {
      ...payload,
      artifactId,
      assignmentId,
      purpose: assignment.contract.purpose,
    };
    this.append({ type: "artifact-recorded", artifact });
    this.append({ type: "assignment-completed", assignmentId, artifactId });
    this.releaseOwnership(assignment);
    return true;
  }

  failAssignment(assignmentId: KnowledgeAssignmentId, error: string): boolean {
    const assignment = this.projection().assignments.get(assignmentId);
    if (!assignment || !["running", "waiting", "accepted"].includes(assignment.state)) {
      return false;
    }
    this.append({ type: "assignment-failed", assignmentId, error });
    this.releaseOwnership(assignment);
    return true;
  }

  cancelAssignment(assignmentId: KnowledgeAssignmentId): boolean {
    const assignment = this.projection().assignments.get(assignmentId);
    if (!assignment || isTerminalAssignmentState(assignment.state)) return false;
    this.append({ type: "assignment-cancelled", assignmentId });
    this.releaseOwnership(assignment);
    return true;
  }

  supersedeAssignment(assignmentId: KnowledgeAssignmentId): boolean {
    const assignment = this.projection().assignments.get(assignmentId);
    if (!assignment || isTerminalAssignmentState(assignment.state)) return false;
    this.append({ type: "assignment-superseded", assignmentId });
    this.releaseOwnership(assignment);
    return true;
  }

  observe(
    observationId: string,
    message: string,
    assignmentId?: KnowledgeAssignmentId,
  ): void {
    this.append({
      type: "observation-recorded",
      observationId,
      ...(assignmentId ? { assignmentId } : {}),
      message,
    });
  }

  failRun(error: string): void {
    if (this.projection().status !== "running") return;
    this.append({ type: "run-failed", error });
  }

  cancelRun(): void {
    const projection = this.projection();
    if (projection.status !== "running") return;
    for (const [assignmentId, assignment] of projection.assignments) {
      if (!isTerminalAssignmentState(assignment.state)) {
        this.cancelAssignment(assignmentId);
      }
    }
    this.append({ type: "run-cancelled" });
  }

  private releaseOwnership(assignment: ProjectedAssignment) {
    if (assignment.contract.authority.kind !== "destination-owner") return;
    this.append({
      type: "destination-owner-released",
      assignmentId: assignment.contract.assignmentId,
      destinationNoteIds: assignment.contract.authority.destinationNoteIds,
    });
  }

  private append(
    event: KnowledgeRuntimeEventInput,
  ): void {
    this.events = [
      ...this.events,
      { ...event, sequence: this.events.length } as KnowledgeRuntimeEvent,
    ];
  }
}

function isKnowledgeNoteRoutingResult(
  payload: KnowledgeCompletionPayload,
): payload is KnowledgeNoteRoutingResult {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "rangeId" in payload &&
    typeof payload.rangeId === "string" &&
    "routes" in payload &&
    Array.isArray(payload.routes) &&
    "warnings" in payload &&
    Array.isArray(payload.warnings)
  );
}

function isKnowledgeArtifactPayload(
  payload: KnowledgeCompletionPayload,
): payload is KnowledgeArtifactPayload {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "summary" in payload &&
    typeof payload.summary === "string" &&
    "assessment" in payload &&
    "claims" in payload &&
    Array.isArray(payload.claims) &&
    "references" in payload &&
    Array.isArray(payload.references) &&
    "mustPreserve" in payload &&
    Array.isArray(payload.mustPreserve) &&
    "ownerProposals" in payload &&
    Array.isArray(payload.ownerProposals)
  );
}

export function replayKnowledgeEvents(
  events: readonly KnowledgeRuntimeEvent[],
): KnowledgeRuntimeProjection {
  const created = events[0];
  if (!created || created.type !== "run-created") {
    throw new Error("Knowledge history must begin with run-created.");
  }
  const assignments = new Map<KnowledgeAssignmentId, ProjectedAssignment>([
    [
      created.root.assignmentId,
      {
        contract: created.root,
        state: "accepted",
        attempts: 0,
        childAssignmentIds: [],
      },
    ],
  ]);
  const artifacts = new Map<KnowledgeArtifactId, KnowledgeArtifact>();
  const observations = new Map<string, ProjectedObservation>();
  const activeDestinationOwners = new Map<string, KnowledgeAssignmentId>();
  const acceptedCallIds = new Set<KnowledgeCallId>();
  const heldCalls = new Map<KnowledgeCallId, CoordinationCall>();
  let status: KnowledgeRuntimeProjection["status"] = "running";
  let result: KnowledgeRunResult | undefined;
  let error: string | undefined;

  for (const event of events.slice(1)) {
    if (event.type === "coordination-accepted") {
      acceptedCallIds.add(event.call.callId);
      heldCalls.delete(event.call.callId);
      const parent = assignments.get(event.parentAssignmentId);
      if (parent) parent.childAssignmentIds.push(...event.assignmentIds);
    } else if (event.type === "coordination-held") {
      heldCalls.set(event.call.callId, event.call);
    } else if (event.type === "coordination-rejected") {
      acceptedCallIds.add(event.callId);
      heldCalls.delete(event.callId);
    } else if (event.type === "assignment-created") {
      assignments.set(event.assignment.assignmentId, {
        contract: event.assignment,
        state: "accepted",
        attempts: 0,
        primitive: event.primitive,
        childAssignmentIds: [],
      });
    } else if (event.type === "assignment-started") {
      const assignment = assignments.get(event.assignmentId);
      if (assignment) {
        assignment.state = "running";
        assignment.attempts = event.attempt;
        delete assignment.error;
      }
    } else if (event.type === "assignment-waiting") {
      const assignment = assignments.get(event.assignmentId);
      if (assignment) assignment.state = "waiting";
    } else if (event.type === "assignment-completed") {
      const assignment = assignments.get(event.assignmentId);
      if (assignment) {
        assignment.state = "completed";
        assignment.artifactId = event.artifactId;
      }
    } else if (event.type === "assignment-failed") {
      const assignment = assignments.get(event.assignmentId);
      if (assignment) {
        assignment.state = "failed";
        assignment.error = event.error;
      }
    } else if (event.type === "assignment-cancelled") {
      const assignment = assignments.get(event.assignmentId);
      if (assignment) assignment.state = "cancelled";
    } else if (event.type === "assignment-superseded") {
      const assignment = assignments.get(event.assignmentId);
      if (assignment) assignment.state = "superseded";
    } else if (event.type === "artifact-recorded") {
      artifacts.set(event.artifact.artifactId, event.artifact);
    } else if (event.type === "destination-owner-granted") {
      for (const noteId of event.destinationNoteIds) {
        activeDestinationOwners.set(noteId, event.assignmentId);
      }
    } else if (event.type === "destination-owner-released") {
      for (const noteId of event.destinationNoteIds) {
        if (activeDestinationOwners.get(noteId) === event.assignmentId) {
          activeDestinationOwners.delete(noteId);
        }
      }
    } else if (event.type === "observation-recorded") {
      observations.set(event.observationId, {
        message: event.message,
        ...(event.assignmentId ? { assignmentId: event.assignmentId } : {}),
      });
    } else if (event.type === "run-completed") {
      status = "completed";
      result = event.result;
    } else if (event.type === "run-failed") {
      status = "failed";
      error = event.error;
    } else if (event.type === "run-cancelled") {
      status = "cancelled";
    }
  }

  const unresolved = [...assignments.values()].filter(
    ({ state }) => !isTerminalAssignmentState(state),
  );
  const primitiveSet = new Set(
    unresolved.flatMap(({ primitive }) => (primitive ? [primitive] : [])),
  );
  const telemetry: KnowledgeTelemetry = {
    runId: created.runId,
    logicalWidth: unresolved.length,
    physicalWidth: unresolved.filter(({ state }) => state === "running").length,
    writeWidth: activeDestinationOwners.size,
    completedAssignments: [...assignments.values()].filter(
      ({ state }) => state === "completed",
    ).length,
    failedAssignments: [...assignments.values()].filter(
      ({ state }) => state === "failed",
    ).length,
    activeAssignments: unresolved.filter(({ state }) =>
      ["accepted", "running"].includes(state),
    ).length,
    waitingAssignments: unresolved.filter(({ state }) => state === "waiting")
      .length,
    currentPrimitives: [...primitiveSet],
    status,
  };
  return {
    runId: created.runId,
    status,
    assignments,
    artifacts,
    observations,
    activeDestinationOwners,
    acceptedCallIds,
    heldCalls,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    telemetry,
  };
}

export function assignmentsForCall(
  call: CoordinationCall,
): KnowledgeAssignmentContract[] {
  return "assignments" in call ? call.assignments : [call.assignment];
}

export function isTerminalAssignmentState(
  state: KnowledgeAssignmentState,
): boolean {
  return ["completed", "failed", "cancelled", "superseded"].includes(state);
}

function validateAssignmentsForCall(
  call: CoordinationCall,
  parentAssignmentId: KnowledgeAssignmentId,
  projection: KnowledgeRuntimeProjection,
  referenceAllowed?: (
    assignment: KnowledgeAssignmentContract,
  ) => string | undefined,
): string | undefined {
  const assignments = assignmentsForCall(call);
  const assignmentIds = assignments.map(({ assignmentId }) => assignmentId);
  const existingChildCount =
    projection.assignments.get(parentAssignmentId)?.childAssignmentIds.length ?? 0;
  if (
    existingChildCount + assignments.length >
    MAX_CHILD_ASSIGNMENTS_PER_PARENT
  ) {
    return `A parent assignment cannot create more than ${MAX_CHILD_ASSIGNMENTS_PER_PARENT} child assignments across coordination calls.`;
  }
  if (new Set(assignmentIds).size !== assignmentIds.length) {
    return "A coordination call cannot repeat an assignment ID.";
  }
  if (assignmentIds.some((id) => projection.assignments.has(id))) {
    return "A coordination call cannot recreate an existing assignment.";
  }
  for (const assignment of assignments) {
    if (
      assignment.parent.kind !== "assignment" ||
      assignment.parent.assignmentId !== parentAssignmentId
    ) {
      return "Every child assignment must name the coordinating parent.";
    }
    const referenceError = referenceAllowed?.(assignment);
    if (referenceError) return referenceError;
    for (const reference of assignment.references) {
      if (
        reference.kind === "artifact" &&
        !projection.artifacts.has(reference.artifactId)
      ) {
        return `Unknown artifact reference: ${reference.artifactId}`;
      }
    }
  }
  const requiredArtifacts = artifactInputsForCall(call);
  if (requiredArtifacts.some((id) => !projection.artifacts.has(id))) {
    return "A coordination call references an unavailable artifact.";
  }
  const operandError = validatePrimitiveOperands(
    call,
    parentAssignmentId,
    projection,
  );
  if (operandError) return operandError;
  const proposedOwners = assignments.flatMap((assignment) =>
    assignment.authority.kind === "destination-owner"
      ? assignment.authority.destinationNoteIds.map((noteId) => ({
          noteId,
          assignmentId: assignment.assignmentId,
        }))
      : [],
  );
  const ownerNotes = proposedOwners.map(({ noteId }) => noteId);
  if (new Set(ownerNotes).size !== ownerNotes.length) {
    return "A coordination call cannot grant overlapping destination ownership.";
  }
  for (const { noteId } of proposedOwners) {
    if (projection.activeDestinationOwners.has(noteId)) {
      return `Destination note is already owned: ${noteId}`;
    }
  }
  return undefined;
}

function validatePrimitiveOperands(
  call: CoordinationCall,
  parentAssignmentId: KnowledgeAssignmentId,
  projection: KnowledgeRuntimeProjection,
): string | undefined {
  if (call.primitive === "reconcile") {
    return exactArtifactReferenceError(
      call.primitive,
      call.assignment,
      call.inputArtifactIds,
    );
  }
  if (call.primitive === "compress") {
    const referenceError = exactArtifactReferenceError(
      call.primitive,
      call.assignment,
      call.inputArtifactIds,
    );
    if (referenceError) return referenceError;
    return exactIdentifierSetError(
      "compress assignment mustPreserve",
      call.mustPreserve,
      call.assignment.constraints.mustPreserve,
    );
  }
  if (call.primitive === "validate") {
    const referenceError = exactArtifactReferenceError(
      call.primitive,
      call.assignment,
      call.proposalArtifactIds,
    );
    if (referenceError) return referenceError;
    if (call.assignment.output.kind !== "validation") {
      return "A validate assignment must use the validation output contract.";
    }
    return exactIdentifierSetError(
      "validate output proposalArtifactIds",
      call.proposalArtifactIds,
      call.assignment.output.proposalArtifactIds,
    );
  }
  if (call.primitive === "re_evaluate") {
    const referenceError = exactArtifactReferenceError(
      call.primitive,
      call.assignment,
      call.priorArtifactIds,
    );
    if (referenceError) return referenceError;
    if (new Set(call.observationIds).size !== call.observationIds.length) {
      return "re_evaluate observationIds cannot contain duplicates.";
    }
    for (const observationId of call.observationIds) {
      const observation = projection.observations.get(observationId);
      if (!observation) {
        return "Unknown observation reference: " + observationId;
      }
      if (
        observation.assignmentId !== undefined &&
        observation.assignmentId !== parentAssignmentId
      ) {
        return (
          "Observation is outside the coordinating parent scope: " +
          observationId
        );
      }
    }
    return undefined;
  }
  if (call.primitive === "re_expand") {
    if (new Set(call.fromArtifactIds).size !== call.fromArtifactIds.length) {
      return "re_expand fromArtifactIds cannot contain duplicates.";
    }
    const declared = new Set(call.fromArtifactIds);
    const referenced = new Set<KnowledgeArtifactId>();
    for (const assignment of call.assignments) {
      const assignmentReferences = artifactReferenceIds(assignment);
      if (assignmentReferences.length === 0) {
        return (
          "re_expand assignment " +
          assignment.assignmentId +
          " must reference at least one fromArtifactId."
        );
      }
      if (new Set(assignmentReferences).size !== assignmentReferences.length) {
        return (
          "re_expand assignment " +
          assignment.assignmentId +
          " repeats an artifact reference."
        );
      }
      for (const artifactId of assignmentReferences) {
        if (!declared.has(artifactId)) {
          return (
            "re_expand assignment " +
            assignment.assignmentId +
            " substituted an undeclared artifact: " +
            artifactId
          );
        }
        referenced.add(artifactId);
      }
    }
    const missing = call.fromArtifactIds.filter(
      (artifactId) => !referenced.has(artifactId),
    );
    if (missing.length > 0) {
      return (
        "re_expand assignments omitted declared artifact reference(s): " +
        missing.join(", ")
      );
    }
  }
  return undefined;
}

function exactArtifactReferenceError(
  primitive: CoordinationCall["primitive"],
  assignment: KnowledgeAssignmentContract,
  operandArtifactIds: readonly KnowledgeArtifactId[],
): string | undefined {
  return exactIdentifierSetError(
    primitive + " assignment artifact references",
    operandArtifactIds,
    artifactReferenceIds(assignment),
  );
}

function artifactReferenceIds(
  assignment: KnowledgeAssignmentContract,
): KnowledgeArtifactId[] {
  return assignment.references.flatMap((reference) =>
    reference.kind === "artifact" ? [reference.artifactId] : [],
  );
}

function exactIdentifierSetError(
  label: string,
  declaredIds: readonly string[],
  referencedIds: readonly string[],
): string | undefined {
  if (new Set(declaredIds).size !== declaredIds.length) {
    return label + " declared duplicate IDs.";
  }
  if (new Set(referencedIds).size !== referencedIds.length) {
    return label + " repeated IDs.";
  }
  const declared = new Set(declaredIds);
  const referenced = new Set(referencedIds);
  const missing = declaredIds.filter((id) => !referenced.has(id));
  const extra = referencedIds.filter((id) => !declared.has(id));
  if (missing.length === 0 && extra.length === 0) return undefined;
  return (
    label +
    " must exactly match the primitive operands." +
    (missing.length > 0 ? " Missing: " + missing.join(", ") + "." : "") +
    (extra.length > 0 ? " Unexpected: " + extra.join(", ") + "." : "")
  );
}

function artifactInputsForCall(call: CoordinationCall): KnowledgeArtifactId[] {
  if ("inputArtifactIds" in call) return call.inputArtifactIds;
  if ("fromArtifactIds" in call) return call.fromArtifactIds;
  if ("proposalArtifactIds" in call) return call.proposalArtifactIds;
  if ("priorArtifactIds" in call) return call.priorArtifactIds;
  return [];
}

function stableArtifactId(
  assignmentId: KnowledgeAssignmentId,
  attempt: number,
): KnowledgeArtifactId {
  return `artifact:${assignmentId}:${attempt}`;
}
