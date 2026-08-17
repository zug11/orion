import { describe, expect, it } from "vitest";
import { KnowledgeRuntime, replayKnowledgeEvents } from "./runtime";
import {
  artifactPayload,
  assignment,
  fanOut,
  ownerAssignment,
  rootAssignment,
} from "./testFixtures";
import type {
  CoordinationCall,
  KnowledgeAssignmentContract,
} from "./protocol";

describe("knowledge causal runtime", () => {
  it("replays an identical logical projection and deduplicates a callId", () => {
    const runtime = new KnowledgeRuntime("run-1", rootAssignment());
    runtime.startAssignment("root");
    const call = fanOut("fan-1", "root", ["a", "b"]);
    expect(runtime.acceptCoordination("root", [call])).toEqual(["a", "b"]);
    expect(runtime.acceptCoordination("root", [call])).toEqual([]);
    runtime.waitAssignment("root");
    runtime.startAssignment("a");
    runtime.completeAssignment("a", artifactPayload("A"));

    const live = runtime.projection();
    const replayed = replayKnowledgeEvents(runtime.history());
    expect([...replayed.assignments.entries()]).toEqual([
      ...live.assignments.entries(),
    ]);
    expect(replayed.telemetry).toEqual(live.telemetry);
    expect(live.assignments).toHaveLength(3);
  });

  it("records a typed router completion in a safe artifact wrapper", () => {
    const runtime = new KnowledgeRuntime("run-1", rootAssignment());
    runtime.startAssignment("root");
    const router: KnowledgeAssignmentContract = {
      assignmentId: "router-1",
      parent: { kind: "assignment", assignmentId: "root" },
      purpose: "router",
      objective: "Route the exact digest range.",
      references: [{ kind: "note-digest-range", rangeId: "range-1" }],
      constraints: {
        rules: ["Route every digest once."],
        mustPreserve: ["Space routing range range-1"],
      },
      authority: { kind: "read-only" },
      output: {
        kind: "note-routing",
        rangeId: "range-1",
        expectedNotes: [{ noteId: "note-a", noteVersion: "version-a" }],
      },
      termination: { condition: "Stop after exact routing coverage." },
    };
    runtime.acceptCoordination("root", [
      { primitive: "fan_out", callId: "routing", assignments: [router] },
    ]);
    runtime.waitAssignment("root");
    runtime.startAssignment("router-1");
    runtime.completeAssignment("router-1", {
      rangeId: "range-1",
      routes: [
        {
          noteId: "note-a",
          noteVersion: "version-a",
          relation: "extends",
          rationale: "The imported material develops this note.",
          candidateNoteIds: [],
        },
      ],
      warnings: [],
    });

    const artifact = [...runtime.projection().artifacts.values()][0];
    expect(artifact).toMatchObject({
      purpose: "router",
      references: [{ kind: "note-digest-range", rangeId: "range-1" }],
      routing: {
        rangeId: "range-1",
        routes: [{ noteId: "note-a", relation: "extends" }],
      },
      assessment: { reviewedNoteIds: ["note-a"] },
    });
  });

  it("keeps observations inert and physical width separate from logical width", () => {
    const runtime = new KnowledgeRuntime("run-1", rootAssignment());
    runtime.startAssignment("root");
    runtime.acceptCoordination(
      "root",
      [fanOut("fan-1", "root", ["a", "b", "c"])],
    );
    runtime.waitAssignment("root");
    runtime.startAssignment("a");
    runtime.observe("observation-1", "A contradiction was noticed.", "a");

    expect(runtime.projection().assignments).toHaveLength(4);
    expect(runtime.projection().telemetry).toMatchObject({
      logicalWidth: 4,
      physicalWidth: 1,
    });
  });

  it("rejects overlapping owners but permits disjoint notes", () => {
    const runtime = new KnowledgeRuntime("run-1", rootAssignment());
    runtime.startAssignment("root");
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "assign_owner",
          callId: "owner-a",
          assignment: ownerAssignment("owner-a", "root", "note-a"),
        },
      ]),
    ).toEqual(["owner-a"]);
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "assign_owner",
          callId: "owner-conflict",
          assignment: ownerAssignment("owner-conflict", "root", "note-a"),
        },
      ]),
    ).toEqual([]);
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "assign_owner",
          callId: "owner-b",
          assignment: ownerAssignment("owner-b", "root", "note-b"),
        },
      ]),
    ).toEqual(["owner-b"]);
    expect(runtime.projection().telemetry.writeWidth).toBe(2);
  });

  it("ignores late completion after cancellation", () => {
    const runtime = new KnowledgeRuntime("run-1", rootAssignment());
    runtime.startAssignment("root");
    runtime.cancelAssignment("root");
    expect(runtime.completeAssignment("root", artifactPayload() as never)).toBe(
      false,
    );
    expect(runtime.projection().assignments.get("root")?.state).toBe(
      "cancelled",
    );
  });

  it("accepts primitive operands only when child artifact references match exactly", () => {
    const runtime = runtimeWithArtifacts();
    runtime.observe("observation-root", "Reconsider this.", "root");
    const calls: CoordinationCall[] = [
      {
        primitive: "reconcile",
        callId: "reconcile-valid",
        assignment: assignmentWithArtifacts(
          "reconciler",
          "reconciler",
          { kind: "reconciliation" },
          ["artifact:a:1", "artifact:b:1"],
        ),
        inputArtifactIds: ["artifact:a:1", "artifact:b:1"],
      },
      {
        primitive: "compress",
        callId: "compress-valid",
        assignment: assignmentWithArtifacts(
          "compressor",
          "compressor",
          { kind: "compression" },
          ["artifact:a:1"],
        ),
        inputArtifactIds: ["artifact:a:1"],
        mustPreserve: ["source:s1"],
      },
      {
        primitive: "validate",
        callId: "validate-valid",
        assignment: assignmentWithArtifacts(
          "validator",
          "validator",
          {
            kind: "validation",
            proposalArtifactIds: ["artifact:b:1"],
          },
          ["artifact:b:1"],
        ),
        proposalArtifactIds: ["artifact:b:1"],
      },
      {
        primitive: "re_evaluate",
        callId: "reevaluate-valid",
        assignment: assignmentWithArtifacts(
          "reevaluator",
          "evidence",
          { kind: "evidence" },
          ["artifact:c:1"],
        ),
        priorArtifactIds: ["artifact:c:1"],
        observationIds: ["observation-root"],
      },
    ];

    expect(runtime.acceptCoordination("root", calls)).toEqual([
      "reconciler",
      "compressor",
      "validator",
      "reevaluator",
    ]);
  });

  it("rejects omitted, substituted, extra, and output-mismatched artifacts", () => {
    const runtime = runtimeWithArtifacts();
    runtime.observe("observation-root", "Reconsider this.", "root");
    const omitted = assignmentWithArtifacts(
      "omitted",
      "reconciler",
      { kind: "reconciliation" },
      ["artifact:a:1"],
    );
    const substituted = assignmentWithArtifacts(
      "substituted",
      "compressor",
      { kind: "compression" },
      ["artifact:a:1", "artifact:c:1"],
    );
    const extra = assignmentWithArtifacts(
      "extra",
      "evidence",
      { kind: "evidence" },
      ["artifact:a:1", "artifact:b:1"],
    );
    const outputMismatch = assignmentWithArtifacts(
      "output-mismatch",
      "validator",
      { kind: "validation", proposalArtifactIds: ["artifact:b:1"] },
      ["artifact:a:1"],
    );

    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "reconcile",
          callId: "omitted-call",
          assignment: omitted,
          inputArtifactIds: ["artifact:a:1", "artifact:b:1"],
        },
      ]),
    ).toEqual([]);
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "compress",
          callId: "substituted-call",
          assignment: substituted,
          inputArtifactIds: ["artifact:a:1", "artifact:b:1"],
          mustPreserve: ["source:s1"],
        },
      ]),
    ).toEqual([]);
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "re_evaluate",
          callId: "extra-call",
          assignment: extra,
          priorArtifactIds: ["artifact:a:1"],
          observationIds: ["observation-root"],
        },
      ]),
    ).toEqual([]);
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "validate",
          callId: "output-mismatch-call",
          assignment: outputMismatch,
          proposalArtifactIds: ["artifact:a:1"],
        },
      ]),
    ).toEqual([]);

    const reasons = runtime.history().flatMap((event) =>
      event.type === "coordination-rejected" ? [event.reason] : [],
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/Missing: artifact:b:1/),
        expect.stringMatching(/Unexpected: artifact:c:1/),
        expect.stringMatching(/Unexpected: artifact:b:1/),
        expect.stringMatching(/output proposalArtifactIds.*exactly match/),
      ]),
    );
  });

  it("requires a compression assignment to preserve exactly its declared values", () => {
    const runtime = runtimeWithArtifacts();
    const compressor = assignmentWithArtifacts(
      "compress-must-preserve",
      "compressor",
      { kind: "compression" },
      ["artifact:a:1"],
    );

    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "compress",
          callId: "compress-must-preserve-call",
          assignment: compressor,
          inputArtifactIds: ["artifact:a:1"],
          mustPreserve: ["source:s2"],
        },
      ]),
    ).toEqual([]);
    expect(
      runtime.history().find(
        (event) =>
          event.type === "coordination-rejected" &&
          event.callId === "compress-must-preserve-call",
      ),
    ).toMatchObject({
      reason: expect.stringMatching(
        /compress assignment mustPreserve.*Missing: source:s2.*Unexpected: source:s1/,
      ),
    });
  });

  it("allows run or parent observations but rejects unknown and sibling scope", () => {
    const runtime = runtimeWithArtifacts();
    runtime.observe("observation-root", "Root contradiction.", "root");
    runtime.observe("observation-run", "Run-wide constraint.");
    runtime.observe("observation-sibling", "Sibling-only detail.", "a");

    const reevaluation = (assignmentId: string, observationIds: string[]) => ({
      primitive: "re_evaluate" as const,
      callId: "call-" + assignmentId,
      assignment: assignmentWithArtifacts(
        assignmentId,
        "evidence",
        { kind: "evidence" },
        ["artifact:a:1"],
      ),
      priorArtifactIds: ["artifact:a:1"],
      observationIds,
    });

    expect(
      runtime.acceptCoordination("root", [
        reevaluation("valid-observations", [
          "observation-root",
          "observation-run",
        ]),
      ]),
    ).toEqual(["valid-observations"]);
    expect(
      runtime.acceptCoordination("root", [
        reevaluation("unknown-observation", ["observation-missing"]),
      ]),
    ).toEqual([]);
    expect(
      runtime.acceptCoordination("root", [
        reevaluation("sibling-observation", ["observation-sibling"]),
      ]),
    ).toEqual([]);

    const reasons = runtime.history().flatMap((event) =>
      event.type === "coordination-rejected" ? [event.reason] : [],
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        "Unknown observation reference: observation-missing",
        "Observation is outside the coordinating parent scope: observation-sibling",
      ]),
    );
  });

  it("requires re-expanded children to cover only the declared source artifacts", () => {
    const runtime = runtimeWithArtifacts();
    const fromA = assignmentWithArtifacts(
      "expand-a",
      "evidence",
      { kind: "evidence" },
      ["artifact:a:1"],
    );
    const fromB = assignmentWithArtifacts(
      "expand-b",
      "evidence",
      { kind: "evidence" },
      ["artifact:b:1"],
    );
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "re_expand",
          callId: "expand-valid",
          assignments: [fromA, fromB],
          fromArtifactIds: ["artifact:a:1", "artifact:b:1"],
        },
      ]),
    ).toEqual(["expand-a", "expand-b"]);

    const substituted = assignmentWithArtifacts(
      "expand-substituted",
      "evidence",
      { kind: "evidence" },
      ["artifact:c:1"],
    );
    expect(
      runtime.acceptCoordination("root", [
        {
          primitive: "re_expand",
          callId: "expand-invalid",
          assignments: [substituted],
          fromArtifactIds: ["artifact:a:1"],
        },
      ]),
    ).toEqual([]);
  });

  it("caps cumulative children across separate calls from one parent", () => {
    const runtime = new KnowledgeRuntime("run-1", rootAssignment());
    runtime.startAssignment("root");
    expect(
      runtime.acceptCoordination("root", [
        fanOut(
          "first-children",
          "root",
          Array.from({ length: 18 }, (_, index) => `first-${index + 1}`),
        ),
      ]),
    ).toHaveLength(18);
    expect(
      runtime.acceptCoordination("root", [
        fanOut(
          "overflow-children",
          "root",
          Array.from({ length: 83 }, (_, index) => `overflow-${index + 1}`),
        ),
      ]),
    ).toEqual([]);
    expect(runtime.projection().assignments).toHaveLength(19);
    expect(
      runtime.history().find(
        (event) =>
          event.type === "coordination-rejected" &&
          event.callId === "overflow-children",
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/cannot create more than 100 child assignments/),
    });
  });
});

function runtimeWithArtifacts(): KnowledgeRuntime {
  const runtime = new KnowledgeRuntime("run-1", rootAssignment());
  runtime.startAssignment("root");
  runtime.acceptCoordination(
    "root",
    [fanOut("seed-artifacts", "root", ["a", "b", "c"])],
  );
  runtime.waitAssignment("root");
  for (const assignmentId of ["a", "b", "c"]) {
    runtime.startAssignment(assignmentId);
    runtime.completeAssignment(assignmentId, artifactPayload(assignmentId));
  }
  return runtime;
}

function assignmentWithArtifacts(
  assignmentId: string,
  purpose: KnowledgeAssignmentContract["purpose"],
  output: KnowledgeAssignmentContract["output"],
  artifactIds: string[],
): KnowledgeAssignmentContract {
  const contract = assignment(assignmentId, "root", purpose, output);
  contract.references.push(
    ...artifactIds.map((artifactId) => ({
      kind: "artifact" as const,
      artifactId,
    })),
  );
  return contract;
}
