import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { Note } from "../../types";
import {
  createKnowledgeRunContext,
  createNoteRoutingCall,
  createRootAssignment,
  createSeededRoutingArtifact,
  createSpaceDigestCall,
  KnowledgeArtifactRegistry,
  noteVersion,
  validateCompleteNoteRoutingCoverage,
} from "./context";
import type { KnowledgeAssignmentContract } from "./protocol";
import {
  KNOWLEDGE_TOTAL_BUDGET_MS,
  runKnowledgeOrchestration,
  validateArtifactCompletion,
} from "./service";
import {
  KnowledgeDeadlineExceededError,
  type KnowledgeAssignmentExecutionRequest,
  KnowledgeProviderExecutionError,
  KnowledgeProviderTimeoutError,
} from "./service";
import {
  artifactPayload,
  assignment,
  fanOut,
  routingArtifact,
  runResult,
} from "./testFixtures";

const NOW = "2026-08-11T10:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

describe("knowledge orchestration service", () => {
  it("completes a trivial import in one provider call", async () => {
    const { context, root } = setup();
    const driver = vi.fn().mockResolvedValue({
      response: { kind: "complete", payload: runResult() },
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
    });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(outcome.result.result.notes[0].title).toBe("Finding");
    expect(outcome.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("gives direct root synthesis four minutes inside the primary window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { context, root } = setup();
    const timeouts: number[] = [];
    await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        return { response: { kind: "complete", payload: runResult() } };
      },
    });

    expect(timeouts).toEqual([4 * 60_000]);
  });

  it("lets an active import synthesis finish across the soft finalization boundary", async () => {
    vi.useFakeTimers();
    const { context, root } = setup();
    const driver = vi.fn(async (_request, signal?: AbortSignal) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(signal?.aborted).toBe(false);
      return { response: { kind: "complete", payload: runResult() } };
    });
    const pending = runKnowledgeOrchestration({
      runContext: context, rootAssignment: root, model: "gpt-5.6-sol", effort: "high",
      elapsedTimeMs: 4_000, explorationTimeMs: 1_200, preserveActiveRoot: true, driver,
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect((await pending).result).toEqual(runResult());
    expect(driver).toHaveBeenCalledOnce();
    expect(driver.mock.calls[0][0].timeoutMs).toBe(3_900);
  });

  it("does not start work when the caller signal is already aborted", async () => {
    const { context, root } = setup();
    const controller = new AbortController();
    const driver = vi.fn();
    controller.abort(new Error("cancelled before start"));

    await expect(
      runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        model: "gpt-5.6-sol",
        effort: "high",
        signal: controller.signal,
        driver,
      }),
    ).rejects.toThrow("cancelled before start");
    expect(driver).not.toHaveBeenCalled();
  });

  it("settles at the hard deadline even when the driver ignores cancellation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { context, root } = setup();
    const driver = vi.fn(
      () => new Promise<never>(() => undefined),
    );
    const outcome = runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
      elapsedTimeMs: 999_999,
      explorationTimeMs: 1_200,
      maxCallTimeMs: 2_000,
    });
    const rejection = expect(outcome).rejects.toBeInstanceOf(
      KnowledgeDeadlineExceededError,
    );

    await vi.advanceTimersByTimeAsync(KNOWLEDGE_TOTAL_BUDGET_MS);
    await rejection;
    expect(driver).toHaveBeenCalledTimes(1);
  });

  it("uses the reserve for one bounded root finalizer and ignores late coordination", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { context, root } = setup();
    const requests: Array<{
      finalizing: boolean;
      timeoutMs: number;
    }> = [];
    const driver = vi.fn(async (request, signal) => {
      requests.push({
        finalizing: request.finalizing,
        timeoutMs: request.timeoutMs,
      });
      if (!request.finalizing) {
        return new Promise<{ response: unknown }>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              resolve({
                response: {
                  kind: "coordinate",
                  calls: [fanOut("too-late", "root", ["late-child"])],
                },
              });
            },
            { once: true },
          );
        });
      }
      return { response: { kind: "complete", payload: runResult() } };
    });
    const outcome = runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
      elapsedTimeMs: 3_000,
      explorationTimeMs: 1_200,
      maxCallTimeMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(1_200);
    const completed = await outcome;

    expect(requests).toEqual([
      { finalizing: false, timeoutMs: 1_100 },
      { finalizing: true, timeoutMs: 1_700 },
    ]);
    expect(
      completed.history.some(
        (event) =>
          event.type === "assignment-created" &&
          event.assignment.assignmentId === "late-child",
      ),
    ).toBe(false);
    expect(
      completed.history.some(
        (event) =>
          event.type === "observation-recorded" &&
          event.message.startsWith("The import is in its finalization reserve"),
      ),
    ).toBe(false);
  });

  it("moves an exploratory root timeout into the finalization reserve", async () => {
    const { context, root } = setup();
    const phases: boolean[] = [];
    const driver = vi.fn(async (request) => {
      phases.push(request.finalizing);
      if (!request.finalizing) {
        throw new KnowledgeProviderTimeoutError(
          "OpenAI did not respond within 90 seconds.",
        );
      }
      return { response: { kind: "complete", payload: runResult() } };
    });

    await expect(
      runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        model: "gpt-5.6-sol",
        effort: "high",
        driver,
      }),
    ).resolves.toMatchObject({ result: runResult() });
    expect(phases).toEqual([false, true]);
  });

  it("reports a finalizing root timeout as the product deadline", async () => {
    const { context, root } = setup();
    const driver = vi.fn(async () => {
      throw new KnowledgeProviderTimeoutError(
        "OpenAI did not respond within 60 seconds.",
      );
    });

    await expect(
      runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        model: "gpt-5.6-sol",
        effort: "high",
        driver,
      }),
    ).rejects.toBeInstanceOf(KnowledgeDeadlineExceededError);
    expect(driver).toHaveBeenCalledTimes(2);
  });

  it("still starts finalization when an aborted driver reports a transport error", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { context, root } = setup();
    const phases: boolean[] = [];
    const driver = vi.fn(async (request, signal) => {
      phases.push(request.finalizing);
      if (!request.finalizing) {
        return new Promise<{ response: unknown }>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("native transport closed")),
            { once: true },
          );
        });
      }
      return { response: { kind: "complete", payload: runResult() } };
    });
    const outcome = runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
      elapsedTimeMs: 3_000,
      explorationTimeMs: 1_200,
    });

    await vi.advanceTimersByTimeAsync(1_200);
    await expect(outcome).resolves.toMatchObject({ result: runResult() });
    expect(phases).toEqual([false, true]);
  });

  it("keeps more than six logical assignments while executing at most six", async () => {
    const { context, root } = setup();
    let active = 0;
    let maximum = 0;
    let rootTurns = 0;
    const driver = vi.fn(async ({ assignment: current }) => {
      if (current.assignmentId === "root") {
        rootTurns += 1;
        return rootTurns === 1
          ? {
              response: {
                kind: "coordinate",
                calls: [
                  fanOut(
                    "wide",
                    "root",
                    Array.from({ length: 9 }, (_, index) => `child-${index}`),
                  ),
                ],
              },
            }
          : { response: { kind: "complete", payload: runResult() } };
      }
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 4));
      active -= 1;
      return {
        response: { kind: "complete", payload: artifactPayload(current.assignmentId) },
      };
    });
    const telemetry: number[] = [];
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
      physicalConcurrency: 6,
      onTelemetry: ({ logicalWidth }) => telemetry.push(logicalWidth),
    });
    expect(maximum).toBe(6);
    expect(Math.max(...telemetry)).toBeGreaterThan(6);
    expect(outcome.artifacts).toHaveLength(9);
  });

  it("derives reader timeouts from the remaining exploration boundary", async () => {
    const { context, root } = setup();
    const timeouts = new Map<string, number>();
    const efforts = new Map<string, string>();
    let rootTurns = 0;
    await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      explorationTimeMs: 53_000,
      driver: async ({ assignment: current, timeoutMs, effort }) => {
        timeouts.set(current.assignmentId, timeoutMs);
        efforts.set(current.assignmentId, effort);
        if (current.assignmentId === "root") {
          rootTurns += 1;
          return rootTurns === 1
            ? {
                response: {
                  kind: "coordinate",
                  calls: [fanOut("bounded-source", "root", ["source-reader"])],
                },
              }
            : { response: { kind: "complete", payload: runResult() } };
        }
        return {
          response: {
            kind: "complete",
            payload: artifactPayload(current.assignmentId),
          },
        };
      },
    });

    expect(timeouts.get("source-reader")).toBeGreaterThan(50_000);
    expect(timeouts.get("source-reader")).toBeLessThanOrEqual(53_000);
    expect(timeouts.get("root")).toBeGreaterThan(50_000);
    expect(timeouts.get("root")).toBeLessThanOrEqual(53_000);
    expect(efforts.get("source-reader")).toBe("medium");
    expect(efforts.get("root")).toBe("high");

    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 72 }, (_, index) => ({
      id: `note-${index + 1}`,
      title: `Note ${index + 1}`,
      slug: `note-${index + 1}`,
      summary: "A compact summary.",
      body: "A note body.",
      aliases: [],
      tags: [],
      kind: "article" as const,
      status: "ready" as const,
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const digestContext = createKnowledgeRunContext(
      "run-digests",
      snapshot,
      context.sources.map((source) => ({
        sourceId: source.sourceId,
        parsed: {
          title: source.title,
          fileName: source.fileName,
          mimeType: source.mimeType,
          format: source.kind,
          byteSize: source.byteSize,
          text: "Text",
          warnings: [],
        },
      })),
      "",
    );
    const digestRoot = createRootAssignment(digestContext, "digest-root");
    const digestCall = createSpaceDigestCall(
      digestContext,
      digestRoot.assignmentId,
    );
    if (!digestCall) throw new Error("Expected a Space digest call.");
    const digestTimeouts: number[] = [];
    const digestEfforts: string[] = [];
    const digestOutcome = await runKnowledgeOrchestration({
      runContext: digestContext,
      rootAssignment: digestRoot,
      initialCoordinationCalls: [digestCall],
      model: "gpt-5.6-sol",
      effort: "high",
      explorationTimeMs: 53_000,
      driver: async ({ assignment: current, timeoutMs, effort }) => {
        if (current.purpose === "root") {
          return { response: { kind: "complete", payload: runResult() } };
        }
        digestTimeouts.push(timeoutMs);
        digestEfforts.push(effort);
        if (current.output.kind !== "note-routing") {
          throw new Error("Expected a typed note router.");
        }
        return {
          response: {
            kind: "complete",
            payload: {
              rangeId: current.output.rangeId,
              routes: current.output.expectedNotes.map(
                ({ noteId, noteVersion }) => ({
                  noteId,
                  noteVersion,
                  relation: "unrelated",
                  rationale: "This note is not relevant to the current import.",
                  candidateNoteIds: [],
                }),
              ),
              warnings: [],
            },
          },
        };
      },
    });
    expect(digestTimeouts).toHaveLength(3);
    expect(digestTimeouts.every((timeout) => timeout > 50_000)).toBe(true);
    expect(digestTimeouts.every((timeout) => timeout <= 53_000)).toBe(true);
    expect(digestEfforts).toEqual(["medium", "medium", "medium"]);
    expect(digestOutcome.artifacts.every(({ routing }) => routing !== undefined)).toBe(
      true,
    );
    expect(
      validateCompleteNoteRoutingCoverage(digestContext, digestOutcome.artifacts),
    ).toHaveLength(3);
  });

  it("finishes mandatory initial coverage before the first root model call", async () => {
    const { context, root } = setup();
    const callOrder: string[] = [];
    const initialCoverage = fanOut("mandatory-coverage", "root", ["a", "b", "c"]);
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      physicalConcurrency: 2,
      initialCoordinationCalls: [initialCoverage],
      driver: async ({ assignment: current, completedChildArtifacts, attempt }) => {
        callOrder.push(current.assignmentId);
        if (current.assignmentId === "root") {
          expect(attempt).toBe(1);
          expect(completedChildArtifacts).toHaveLength(3);
          return { response: { kind: "complete", payload: runResult() } };
        }
        return {
          response: {
            kind: "complete",
            payload: {
              ...artifactPayload(current.assignmentId),
              references: current.references,
              mustPreserve: current.constraints.mustPreserve,
            },
          },
        };
      },
    });

    expect(callOrder[callOrder.length - 1]).toBe("root");
    expect(callOrder.slice(0, -1).sort()).toEqual(["a", "b", "c"]);
    expect(outcome.artifacts).toHaveLength(3);
  });

  it("rejects a root result when a host router leaves routing coverage incomplete", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = [serviceNote("note-a", "Existing", "Body", "article")];
    const context = createKnowledgeRunContext(
      "routing-failure",
      snapshot,
      [sourceInput("s1")],
      "",
    );
    const root = createRootAssignment(context, "routing-root");
    const routing = createSpaceDigestCall(context, root.assignmentId);
    if (!routing || routing.primitive !== "fan_out") {
      throw new Error("Expected routing coverage.");
    }

    await expect(
      runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        initialCoordinationCalls: [routing],
        model: "gpt-5.6-sol",
        effort: "high",
        driver: async ({ assignment: current }) => {
          if (current.purpose === "router") {
            throw new Error("The router did not complete.");
          }
          return { response: { kind: "complete", payload: runResult() } };
        },
      }),
    ).rejects.toThrow(/Note routing omitted digest range/);
  });

  it("seeds validated routing artifacts and completes without a router child", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = [
      serviceNote("note-a", "Existing A", "Grounded body A.", "article"),
      serviceNote("note-b", "Existing B", "Grounded body B.", "article"),
    ];
    const context = createKnowledgeRunContext(
      "seeded-routing",
      snapshot,
      [sourceInput("s1")],
      "",
    );
    const root = createRootAssignment(context, "seeded-root");
    const digests = context.materials.noteDigestRanges.get(
      "note-digests-inline",
    )!;
    const seeded = createSeededRoutingArtifact(context, [
      {
        rangeId: "note-digests-inline",
        routes: digests.map(({ noteId, version }, index) => ({
          noteId,
          noteVersion: version,
          relation: index === 0 ? "extends" : "unrelated",
          rationale: "A bounded routing judgment.",
          candidateNoteIds: [],
        })),
        warnings: [],
      },
    ]);
    const driver = vi.fn(async ({ assignment: current, context: packet }) => {
      expect(current.purpose).toBe("root");
      expect(
        packet.spaceOrientation.routedNotes?.map(
          ({ relation }: { relation: string }) => relation,
        ),
      ).toEqual(["extends"]);
      return { response: { kind: "complete", payload: runResult() } };
    });

    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      initialArtifacts: seeded,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
    });

    expect(driver).toHaveBeenCalledTimes(1);
    expect(outcome.artifacts.map(({ artifactId }) => artifactId)).toEqual([
      seeded[0].artifactId,
    ]);
    expect(outcome.result.result.notes[0].title).toBe("Finding");
  });

  it("keeps the routing coverage gate active for a seeded run", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = [
      serviceNote("note-a", "Existing A", "Grounded body A.", "article"),
      serviceNote("note-b", "Existing B", "Grounded body B.", "article"),
    ];
    const context = createKnowledgeRunContext(
      "seeded-routing-gap",
      snapshot,
      [sourceInput("s1")],
      "",
    );
    const root = createRootAssignment(context, "seeded-gap-root");
    const digests = context.materials.noteDigestRanges.get(
      "note-digests-inline",
    )!;
    const seeded = createSeededRoutingArtifact(context, [
      {
        rangeId: "note-digests-inline",
        routes: digests.slice(1).map(({ noteId, version }) => ({
          noteId,
          noteVersion: version,
          relation: "unrelated",
          rationale: "A bounded routing judgment.",
          candidateNoteIds: [],
        })),
        warnings: [],
      },
    ]);

    await expect(
      runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        initialArtifacts: seeded,
        model: "gpt-5.6-sol",
        effort: "high",
        driver: async () => ({
          response: { kind: "complete", payload: runResult() },
        }),
      }),
    ).rejects.toThrow(/did not cover .* exactly once/);
  });

  it("returns an incomplete root proposal for correction instead of committing it", async () => {
    const { context, root } = setup();
    let rootTurns = 0;
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ observations }) => {
        rootTurns += 1;
        if (rootTurns === 2) {
          expect(observations[0]?.message).toContain("not complete");
        }
        return { response: { kind: "complete", payload: runResult() } };
      },
      validateRootResult: (result) => {
        if (rootTurns === 1) throw new Error("One source range was omitted.");
        return result;
      },
    });

    expect(rootTurns).toBe(2);
    expect(outcome.result.result.notes).toHaveLength(1);
  });

  it("gives a malformed root response one bounded correction turn", async () => {
    const { context, root } = setup();
    let rootTurns = 0;
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ observations }) => {
        rootTurns += 1;
        if (rootTurns === 1) {
          return {
            response: {
              kind: "complete",
              payload: { unexpected: "not a root result" },
            },
          };
        }
        expect(observations[observations.length - 1]?.message).toContain(
          "did not match Orion's knowledge contract",
        );
        return { response: { kind: "complete", payload: runResult() } };
      },
    });

    expect(rootTurns).toBe(2);
    expect(outcome.result.result.notes[0].title).toBe("Finding");
  });

  it("supports nested coordination without occupying a waiting parent slot", async () => {
    const { context, root } = setup();
    const turns = new Map<string, number>();
    const driver = vi.fn(async ({ assignment: current }) => {
      const turn = (turns.get(current.assignmentId) ?? 0) + 1;
      turns.set(current.assignmentId, turn);
      if (current.assignmentId === "root" && turn === 1) {
        return {
          response: {
            kind: "coordinate",
            calls: [fanOut("root-fan", "root", ["child"])],
          },
        };
      }
      if (current.assignmentId === "child" && turn === 1) {
        return {
          response: {
            kind: "coordinate",
            calls: [fanOut("child-fan", "child", ["grandchild"])],
          },
        };
      }
      if (current.assignmentId === "root") {
        return { response: { kind: "complete", payload: runResult() } };
      }
      return {
        response: { kind: "complete", payload: artifactPayload(current.assignmentId) },
      };
    });
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
      physicalConcurrency: 1,
    });
    expect(outcome.artifacts.map(({ assignmentId }) => assignmentId).sort()).toEqual([
      "child",
      "grandchild",
    ]);
  });

  it("cancels late results without completing the run", async () => {
    const { context, root } = setup();
    const controller = new AbortController();
    const promise = runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      signal: controller.signal,
      driver: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { response: { kind: "complete", payload: runResult() } };
      },
    });
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
  });

  it("retries a throttled assignment without rewriting its logical identity", async () => {
    const { context, root } = setup();
    let rootTurn = 0;
    let childAttempts = 0;
    const output = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ assignment: current }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          return rootTurn === 1
            ? {
                response: {
                  kind: "coordinate",
                  calls: [fanOut("one-child", "root", ["child"])],
                },
              }
            : { response: { kind: "complete", payload: runResult() } };
        }
        childAttempts += 1;
        if (childAttempts === 1) {
          throw new KnowledgeProviderExecutionError("rate limited", {
            retryable: true,
          });
        }
        return { response: { kind: "complete", payload: artifactPayload() } };
      },
    });
    expect(childAttempts).toBe(2);
    expect(
      output.history.filter(
        (event) =>
          event.type === "assignment-created" &&
          event.assignment.assignmentId === "child",
      ),
    ).toHaveLength(1);
  });

  it("does not start a retry that cannot fit its complete call budget", async () => {
    const { context, root } = setup();
    const driver = vi.fn().mockRejectedValue(
      new KnowledgeProviderExecutionError("rate limited", {
        retryable: true,
        retryAfterMs: 200,
      }),
    );

    await expect(
      runKnowledgeOrchestration({
        runContext: context,
        rootAssignment: root,
        model: "gpt-5.6-sol",
        effort: "high",
        driver,
        elapsedTimeMs: 3_000,
        explorationTimeMs: 1_200,
        maxCallTimeMs: 2_000,
      }),
    ).rejects.toThrow("rate limited");
    expect(driver).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("automatically retries the direct root with one identity, exhausted=%s", async (exhausted) => {
    const { context, root } = setup();
    const assignmentIds: string[] = [];
    const driver = vi.fn(async ({ assignment: current }: KnowledgeAssignmentExecutionRequest) => {
      assignmentIds.push(current.assignmentId);
      if (exhausted || assignmentIds.length < 3) {
        throw new KnowledgeProviderExecutionError("Connection reset", { retryable: true });
      }
      return { response: { kind: "complete" as const, payload: runResult() } };
    });
    const outcome = runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver,
    });
    if (exhausted) await expect(outcome).rejects.toThrow("Connection reset");
    else await expect(outcome).resolves.toHaveProperty("result");
    expect(driver).toHaveBeenCalledTimes(3);
    expect(new Set(assignmentIds).size).toBe(1);
  });

  it("rejects hidden primitive operands and gives the root a corrective observation", async () => {
    const { context, root } = setup();
    let rootTurn = 0;
    let hiddenWorkerRan = false;
    const output = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({
        assignment: current,
        completedChildArtifacts,
        observations,
      }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            return {
              response: {
                kind: "coordinate",
                calls: [fanOut("read-for-invalid-reconcile", "root", ["a", "b"])],
              },
            };
          }
          if (rootTurn === 2) {
            const artifactIds = completedChildArtifacts.map(
              ({ artifactId }) => artifactId,
            );
            const hiddenOperand = assignment(
              "hidden-reconciler",
              "root",
              "reconciler",
              { kind: "reconciliation" },
            );
            hiddenOperand.references = [
              { kind: "artifact", artifactId: artifactIds[0] },
            ];
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "reconcile",
                    callId: "hidden-reconcile-call",
                    assignment: hiddenOperand,
                    inputArtifactIds: artifactIds,
                  },
                ],
              },
            };
          }
          expect(
            observations.some(({ message }) =>
              message.includes("must exactly match the primitive operands"),
            ),
          ).toBe(true);
          return { response: { kind: "complete", payload: runResult() } };
        }
        if (current.assignmentId === "hidden-reconciler") {
          hiddenWorkerRan = true;
        }
        return {
          response: {
            kind: "complete",
            payload: artifactPayload(current.assignmentId),
          },
        };
      },
    });

    expect(hiddenWorkerRan).toBe(false);
    expect(rootTurn).toBe(3);
    expect(
      output.history.find(
        (event) =>
          event.type === "coordination-rejected" &&
          event.callId === "hidden-reconcile-call",
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/Missing: artifact:b:1/),
    });
  });

  it("delivers selected parent observations to a re-evaluation child", async () => {
    const { context, root } = setup();
    let rootTurn = 0;
    let selectedObservationId = "";
    let reevaluatorReceivedObservation = false;
    await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({
        assignment: current,
        completedChildArtifacts,
        observations,
      }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            return {
              response: {
                kind: "coordinate",
                calls: [fanOut("read-before-reevaluation", "root", ["reader"])],
              },
            };
          }
          const artifactId = completedChildArtifacts[0].artifactId;
          if (rootTurn === 2) {
            const invalidCompressor = assignment(
              "invalid-compressor",
              "root",
              "compressor",
              { kind: "compression" },
            );
            invalidCompressor.references.push({
              kind: "artifact",
              artifactId,
            });
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "compress",
                    callId: "invalid-compression",
                    assignment: invalidCompressor,
                    inputArtifactIds: [artifactId],
                    mustPreserve: ["source:s2"],
                  },
                ],
              },
            };
          }
          if (rootTurn === 3) {
            const selected = observations.find(({ message }) =>
              message.includes("compress assignment mustPreserve"),
            );
            expect(selected).toBeDefined();
            selectedObservationId = selected!.observationId;
            const reevaluator = assignment("reevaluator", "root");
            reevaluator.references.push({ kind: "artifact", artifactId });
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "re_evaluate",
                    callId: "reevaluate-after-observation",
                    assignment: reevaluator,
                    priorArtifactIds: [artifactId],
                    observationIds: [selectedObservationId],
                  },
                ],
              },
            };
          }
          return { response: { kind: "complete", payload: runResult() } };
        }
        if (current.assignmentId === "reevaluator") {
          reevaluatorReceivedObservation = observations.some(
            ({ observationId, message }) =>
              observationId === selectedObservationId &&
              message.includes("compress assignment mustPreserve"),
          );
        }
        return {
          response: {
            kind: "complete",
            payload: {
              ...artifactPayload(current.assignmentId),
              references: current.references,
              mustPreserve: current.constraints.mustPreserve,
            },
          },
        };
      },
    });

    expect(rootTurn).toBe(4);
    expect(reevaluatorReceivedObservation).toBe(true);
  });

  it("rejects a validator receipt that does not exactly name its proposals", async () => {
    const { context, root } = setup();
    let rootTurn = 0;
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({
        assignment: current,
        completedChildArtifacts,
        observations,
      }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            return {
              response: {
                kind: "coordinate",
                calls: [fanOut("proposals", "root", ["proposal-a", "proposal-b"])],
              },
            };
          }
          if (rootTurn === 2) {
            const artifactIds = completedChildArtifacts.map(
              ({ artifactId }) => artifactId,
            );
            const validator = assignment(
              "validator",
              "root",
              "validator",
              { kind: "validation", proposalArtifactIds: artifactIds },
            );
            validator.references.push(
              ...artifactIds.map((artifactId) => ({
                kind: "artifact" as const,
                artifactId,
              })),
            );
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "validate",
                    callId: "validate-proposals",
                    assignment: validator,
                    proposalArtifactIds: artifactIds,
                  },
                ],
              },
            };
          }
          expect(
            observations.some(({ message }) =>
              message.includes("exactly the proposal artifacts"),
            ),
          ).toBe(true);
          return { response: { kind: "complete", payload: runResult() } };
        }
        if (current.assignmentId === "validator") {
          const expected =
            current.output.kind === "validation"
              ? current.output.proposalArtifactIds
              : [];
          return {
            response: {
              kind: "complete",
              payload: {
                ...artifactPayload("Incomplete validation"),
                references: current.references,
                mustPreserve: current.constraints.mustPreserve,
                validation: {
                  valid: true,
                  issues: [],
                  checkedArtifactIds: expected.slice(0, 1),
                },
              },
            },
          };
        }
        return {
          response: {
            kind: "complete",
            payload: {
              ...artifactPayload(current.assignmentId),
              references: current.references,
              mustPreserve: current.constraints.mustPreserve,
            },
          },
        };
      },
    });

    expect(
      outcome.history.find(
        (event) =>
          event.type === "assignment-failed" &&
          event.assignmentId === "validator",
      ),
    ).toMatchObject({
      error: expect.stringMatching(/exactly the proposal artifacts/),
    });
    expect(
      outcome.artifacts.some(({ assignmentId }) => assignmentId === "validator"),
    ).toBe(false);
  });

  it("rejects an owner source that is in the run but outside its declared evidence", async () => {
    const { context, root, wiki } = ownerSetup();
    let rootTurn = 0;
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ assignment: current, observations }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "assign_owner",
                    callId: "owner-with-hidden-source",
                    assignment: ownerContract(wiki, [
                      { kind: "source", sourceId: "s1" },
                    ]),
                  },
                ],
              },
            };
          }
          expect(
            observations.some(({ message }) =>
              message.includes("outside its declared evidence"),
            ),
          ).toBe(true);
          return { response: { kind: "complete", payload: runResult() } };
        }
        return {
          response: {
            kind: "complete",
            payload: ownerPayload(current, wiki, "s2"),
          },
        };
      },
    });

    expect(
      outcome.history.find(
        (event) =>
          event.type === "assignment-failed" &&
          event.assignmentId === "owner",
      ),
    ).toMatchObject({
      error: expect.stringMatching(/outside its declared evidence/),
    });
  });

  it("allows an owner source reached recursively through a declared artifact", async () => {
    const { context, root, wiki } = ownerSetup();
    let rootTurn = 0;
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ assignment: current, completedChildArtifacts }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            const reader = assignment("source-two-reader", "root");
            reader.references = [{ kind: "source", sourceId: "s2" }];
            reader.constraints.mustPreserve = ["source:s2"];
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "fan_out",
                    callId: "read-source-two",
                    assignments: [reader],
                  },
                ],
              },
            };
          }
          if (rootTurn === 2) {
            const artifactId = completedChildArtifacts[0].artifactId;
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "assign_owner",
                    callId: "owner-through-artifact",
                    assignment: ownerContract(wiki, [
                      { kind: "artifact", artifactId },
                    ]),
                  },
                ],
              },
            };
          }
          return { response: { kind: "complete", payload: runResult() } };
        }
        if (current.assignmentId === "owner") {
          return {
            response: {
              kind: "complete",
              payload: ownerPayload(current, wiki, "s2"),
            },
          };
        }
        return {
          response: {
            kind: "complete",
            payload: {
              ...artifactPayload(current.assignmentId),
              references: current.references,
              mustPreserve: current.constraints.mustPreserve,
            },
          },
        };
      },
    });

    expect(
      outcome.artifacts.some(({ assignmentId }) => assignmentId === "owner"),
    ).toBe(true);
  });

  it("binds a duplicate merge owner to its exact router artifact and frozen version", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const wiki = serviceNote("wiki", "Existing concept", "Existing prose.", "wiki");
    snapshot.notes = [wiki];
    const context = createKnowledgeRunContext(
      "routed-owner-run",
      snapshot,
      [sourceInput("s1")],
      "",
      {
        includeExistingNotes: true,
        hybridNoteRouting: true,
        hybridRoutingMatchText: wiki.title,
      },
    );
    const root = createRootAssignment(context, "root");
    const routing = createNoteRoutingCall(context, root.assignmentId);
    if (!routing || routing.primitive !== "fan_out") {
      throw new Error("Expected one typed routing assignment.");
    }
    const router = routing.assignments[0];
    if (router.output.kind !== "note-routing") {
      throw new Error("Expected typed routing output.");
    }
    const routerArtifact = routingArtifact(router.assignmentId, {
      rangeId: router.output.rangeId,
      routes: router.output.expectedNotes.map(({ noteId, noteVersion }) => ({
        noteId,
        noteVersion,
        relation: "duplicate" as const,
        rationale: "The imported material is already represented here.",
        candidateNoteIds: [],
      })),
      warnings: [],
    });
    const registry = new KnowledgeArtifactRegistry();
    registry.record(routerArtifact);
    const owner = ownerContract(wiki, [
      { kind: "artifact", artifactId: routerArtifact.artifactId },
      { kind: "source", sourceId: "s1" },
    ]);

    expect(() =>
      validateArtifactCompletion(
        owner,
        ownerPayload(owner, wiki, "s1"),
        context,
        registry,
      ),
    ).not.toThrow();

    const withoutRouter = structuredClone(owner);
    withoutRouter.references = withoutRouter.references.filter(
      ({ kind }) => kind !== "artifact",
    );
    expect(() =>
      validateArtifactCompletion(
        withoutRouter,
        ownerPayload(withoutRouter, wiki, "s1"),
        context,
        registry,
      ),
    ).toThrow(/requires the router artifact/);
  });

  it("rejects a later fan-out that would exceed 100 cumulative children", async () => {
    const { context, root } = setup();
    const initial = fanOut(
      "initial-eighteen",
      "root",
      Array.from({ length: 18 }, (_, index) => `initial-${index + 1}`),
    );
    let rootTurn = 0;
    let overflowWorkerRan = false;
    const outcome = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      initialCoordinationCalls: [initial],
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ assignment: current, observations }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            return {
              response: {
                kind: "coordinate",
                calls: [
                  fanOut(
                    "overflow-eighty-three",
                    "root",
                    Array.from(
                      { length: 83 },
                      (_, index) => `overflow-${index + 1}`,
                    ),
                  ),
                ],
              },
            };
          }
          expect(
            observations.some(({ message }) =>
              message.includes("more than 100 child assignments"),
            ),
          ).toBe(true);
          return { response: { kind: "complete", payload: runResult() } };
        }
        if (current.assignmentId.startsWith("overflow-")) {
          overflowWorkerRan = true;
        }
        return {
          response: {
            kind: "complete",
            payload: {
              ...artifactPayload(current.assignmentId),
              references: current.references,
              mustPreserve: current.constraints.mustPreserve,
            },
          },
        };
      },
    });

    expect(overflowWorkerRan).toBe(false);
    expect(outcome.artifacts).toHaveLength(18);
    expect(
      outcome.history.find(
        (event) =>
          event.type === "coordination-rejected" &&
          event.callId === "overflow-eighty-three",
      ),
    ).toMatchObject({
      reason: expect.stringMatching(/more than 100 child assignments/),
    });
  });

  it("supports staged reconciliation and model-chosen re-expansion", async () => {
    const { context, root } = setup();
    let rootTurn = 0;
    const output = await runKnowledgeOrchestration({
      runContext: context,
      rootAssignment: root,
      model: "gpt-5.6-sol",
      effort: "high",
      driver: async ({ assignment: current, completedChildArtifacts }) => {
        if (current.assignmentId === "root") {
          rootTurn += 1;
          if (rootTurn === 1) {
            return {
              response: {
                kind: "coordinate",
                calls: [fanOut("read", "root", ["a", "b"])],
              },
            };
          }
          if (rootTurn === 2) {
            const artifactIds = completedChildArtifacts.map(
              ({ artifactId }) => artifactId,
            );
            const reconcile = assignment(
              "reconcile",
              "root",
              "reconciler",
              { kind: "reconciliation" },
            );
            reconcile.references = artifactIds.map((artifactId) => ({
              kind: "artifact" as const,
              artifactId,
            }));
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "reconcile",
                    callId: "reconcile-call",
                    assignment: reconcile,
                    inputArtifactIds: artifactIds,
                  },
                ],
              },
            };
          }
          if (rootTurn === 3) {
            const reconciled = completedChildArtifacts.find(
              ({ assignmentId }) => assignmentId === "reconcile",
            )!;
            const expanded = assignment("expanded", "root");
            expanded.references = [
              { kind: "artifact", artifactId: reconciled.artifactId },
            ];
            return {
              response: {
                kind: "coordinate",
                calls: [
                  {
                    primitive: "re_expand",
                    callId: "expand-call",
                    assignments: [expanded],
                    fromArtifactIds: [reconciled.artifactId],
                  },
                ],
              },
            };
          }
          return { response: { kind: "complete", payload: runResult() } };
        }
        const references = current.references;
        return {
          response: {
            kind: "complete",
            payload: {
              ...artifactPayload(current.assignmentId),
              references,
              mustPreserve: [...current.constraints.mustPreserve],
            },
          },
        };
      },
    });
    expect(output.artifacts.map(({ assignmentId }) => assignmentId)).toEqual(
      expect.arrayContaining(["a", "b", "reconcile", "expanded"]),
    );
    expect(
      output.history.filter((event) => event.type === "coordination-accepted").map(
        (event) => event.call.primitive,
      ),
    ).toEqual(["fan_out", "reconcile", "re_expand"]);
  });
});

function setup() {
  const snapshot = createEmptySnapshot("Space", NOW);
  const context = createKnowledgeRunContext(
    "run-1",
    snapshot,
    [
      {
        sourceId: "s1",
        parsed: {
          title: "Source",
          fileName: "source.txt",
          mimeType: "text/plain",
          format: "text",
          byteSize: 4,
          text: "Text",
          warnings: [],
        },
      },
    ],
    "",
  );
  const root = createRootAssignment(context, "root");
  return { context, root };
}

function ownerSetup() {
  const snapshot = createEmptySnapshot("Space", NOW);
  const wiki = serviceNote("wiki", "Existing concept", "Existing prose.", "wiki");
  snapshot.notes = [wiki];
  const context = createKnowledgeRunContext(
    "owner-run",
    snapshot,
    [sourceInput("s1"), sourceInput("s2")],
    "",
    { includeExistingNotes: true },
  );
  return {
    context,
    root: createRootAssignment(context, "root"),
    wiki,
  };
}

function ownerContract(
  wiki: Note,
  evidenceReferences: KnowledgeAssignmentContract["references"],
): KnowledgeAssignmentContract {
  const contract = assignment("owner", "root", "owner", {
    kind: "owner-proposal",
    destinationNoteIds: [wiki.id],
  });
  contract.references = [
    { kind: "note", noteId: wiki.id, version: noteVersion(wiki) },
    ...evidenceReferences,
  ];
  contract.authority = {
    kind: "destination-owner",
    destinationNoteIds: [wiki.id],
    baseVersions: [{ noteId: wiki.id, version: noteVersion(wiki) }],
  };
  return contract;
}

function ownerPayload(
  assignmentContract: KnowledgeAssignmentContract,
  wiki: Note,
  sourceId: string,
) {
  return {
    ...artifactPayload("Integrated owner revision"),
    references: assignmentContract.references,
    mustPreserve: assignmentContract.constraints.mustPreserve,
    ownerProposals: [
      {
        destinationNoteId: wiki.id,
        baseVersion: noteVersion(wiki),
        title: wiki.title,
        summary: "Integrated",
        body: "# Existing concept\n\nIntegrated prose.",
        aliases: [],
        tags: [],
        sourceIds: [sourceId],
      },
    ],
  };
}

function sourceInput(sourceId: string) {
  return {
    sourceId,
    parsed: {
      title: `Source ${sourceId}`,
      fileName: `${sourceId}.txt`,
      mimeType: "text/plain",
      format: "text" as const,
      byteSize: 4,
      text: "Text",
      warnings: [],
    },
  };
}

function serviceNote(
  id: string,
  title: string,
  body: string,
  kind: Note["kind"],
): Note {
  return {
    id,
    title,
    slug: id,
    summary: body,
    body,
    aliases: [],
    tags: [],
    kind,
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}
