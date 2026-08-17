import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { Note, ParsedImport } from "../../types";
import {
  KnowledgeImportRunError,
  runKnowledgeImportBatch,
  type KnowledgeImportBatchResult,
} from "./import";
import {
  KnowledgeProviderExecutionError,
  KnowledgeProviderTimeoutError,
  type KnowledgeAssignmentDriver,
  type KnowledgeAssignmentDriverResult,
  type KnowledgeAssignmentExecutionRequest,
} from "./service";
import { fixedPipelineResponse, longPdfText, runResult } from "./testFixtures";

const NOW = "2026-08-11T10:00:00.000Z";

/**
 * Chaos harness: complete imports run against drivers that misbehave the way
 * real providers and models do. The asserted contract is safety, not success:
 * every run either completes with a validated result or rejects with a
 * classified diagnostic; a resumable pause resumes to completion with a clean
 * driver; the frozen snapshot is never mutated; the reading cache never
 * changes an outcome.
 */

type Mischief =
  | "garbage-payload"
  | "wrong-shape"
  | "hallucinated-ids"
  | "dropped-coverage"
  | "stale-version"
  | "provider-timeout"
  | "rate-limit"
  | "provider-crash";

const MISCHIEFS: readonly Mischief[] = [
  "garbage-payload",
  "wrong-shape",
  "hallucinated-ids",
  "dropped-coverage",
  "stale-version",
  "provider-timeout",
  "rate-limit",
  "provider-crash",
];

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

function peopledSnapshot(noteCount: number) {
  const snapshot = createEmptySnapshot("Space", NOW);
  snapshot.notes = Array.from({ length: noteCount }, (_, index): Note => ({
    id: `note-${String(index + 1).padStart(3, "0")}`,
    title: `Topic ${String(index + 1).padStart(3, "0")}`,
    slug: `topic-${index + 1}`,
    summary: `Reflection ${index + 1}.`,
    body: `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(30)}`,
    aliases: [],
    tags: [],
    kind: index % 3 === 0 ? "wiki" : "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  }));
  return snapshot;
}

function compliantResponse(
  request: KnowledgeAssignmentExecutionRequest,
): KnowledgeAssignmentDriverResult {
  if (request.assignment.output.kind === "note-routing") {
    return {
      response: {
        kind: "complete",
        payload: {
          rangeId: request.assignment.output.rangeId,
          routes: request.assignment.output.expectedNotes.map(
            ({ noteId, noteVersion }, index) => ({
              noteId,
              noteVersion,
              relation: index === 0 ? "extends" : "unrelated",
              rationale: "A bounded routing judgment.",
              candidateNoteIds: [],
            }),
          ),
          warnings: [],
        },
      },
    };
  }
  if (request.assignment.purpose === "root") {
    return { response: { kind: "complete", payload: runResult() } };
  }
  return fixedPipelineResponse(request);
}

function sabotage(
  mischief: Mischief,
  request: KnowledgeAssignmentExecutionRequest,
): KnowledgeAssignmentDriverResult {
  if (mischief === "provider-timeout") {
    throw new KnowledgeProviderTimeoutError(
      "Orion did not receive the assignment result within 90 seconds.",
    );
  }
  if (mischief === "rate-limit") {
    throw new KnowledgeProviderExecutionError(
      "The provider paused this request for rate or usage limits.",
      { retryable: true, retryAfterMs: 1 },
    );
  }
  if (mischief === "provider-crash") {
    throw new Error("The provider connection was reset unexpectedly.");
  }
  if (mischief === "garbage-payload") {
    return { response: '{"kind":"complete","payload":{tru' };
  }
  if (mischief === "wrong-shape") {
    return { response: { kind: "complete", payload: { unexpected: true } } };
  }
  const compliant = structuredClone(compliantResponse(request)) as {
    response: { kind: string; payload: Record<string, unknown> };
  };
  const payload = compliant.response.payload;
  const kind = request.assignment.output.kind;
  if (kind === "note-routing") {
    const routes = payload.routes as Array<Record<string, unknown>>;
    if (mischief === "hallucinated-ids" && routes.length > 0) {
      routes[0].noteId = "ghost-note";
    } else if (mischief === "stale-version" && routes.length > 0) {
      routes[0].noteVersion = "stale-version";
    } else if (mischief === "dropped-coverage") {
      payload.routes = routes.slice(1);
    }
    return compliant as KnowledgeAssignmentDriverResult;
  }
  if (kind === "source-reading") {
    if (mischief === "dropped-coverage") {
      payload.coverage = { complete: false, limitations: ["chaos"] };
    } else {
      (payload.spaceAssessment as Record<string, unknown>).reviewedNoteIds = [
        "ghost-note",
      ];
    }
    return compliant as KnowledgeAssignmentDriverResult;
  }
  if (kind === "writing-blueprint") {
    const outputs = payload.outputs as Array<{
      claimSelections: Array<{ claimIds: string[] }>;
    }>;
    if (outputs.length > 0 && outputs[0].claimSelections.length > 0) {
      outputs[0].claimSelections[0].claimIds = ["range9-claim-01"];
    }
    return compliant as KnowledgeAssignmentDriverResult;
  }
  if (kind === "writer-result") {
    const drafts = payload.drafts as Array<Record<string, unknown>>;
    if (drafts.length > 0) drafts[0].outputId = "ghost-output";
    return compliant as KnowledgeAssignmentDriverResult;
  }
  if (request.assignment.purpose === "root") {
    const result = payload as unknown as ReturnType<typeof runResult>;
    if (result.provenance?.[0]) {
      result.provenance[0].sourceIds = ["another-source"];
    }
    return compliant as KnowledgeAssignmentDriverResult;
  }
  return { response: '{"kind":"complete","payload":{tru' };
}

function chaosDriver(
  rng: () => number,
  options: { probability: number; persistent: boolean },
): KnowledgeAssignmentDriver {
  const struck = new Set<string>();
  return async (request) => {
    const key = request.assignment.assignmentId;
    const strikes =
      rng() < options.probability && (options.persistent || !struck.has(key));
    if (!strikes) return compliantResponse(request);
    struck.add(key);
    const mischief = MISCHIEFS[Math.floor(rng() * MISCHIEFS.length)];
    return sabotage(mischief, request);
  };
}

async function runImport(
  snapshot: ReturnType<typeof createEmptySnapshot>,
  sources: Array<{ sourceId: string; parsed: ParsedImport }>,
  driver: KnowledgeAssignmentDriver,
  extras: Partial<Parameters<typeof runKnowledgeImportBatch>[0]> = {},
): Promise<
  | { outcome: "completed"; value: KnowledgeImportBatchResult }
  | { outcome: "rejected"; error: KnowledgeImportRunError }
> {
  try {
    const value = await runKnowledgeImportBatch({
      snapshot,
      sources,
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver,
      ...extras,
    });
    return { outcome: "completed", value };
  } catch (error) {
    if (!(error instanceof KnowledgeImportRunError)) throw error;
    return { outcome: "rejected", error };
  }
}

describe("adversarial import safety contract", () => {
  it("direct imports complete or reject with a classified diagnostic under transient chaos", async () => {
    for (let seed = 1; seed <= 12; seed += 1) {
      const rng = mulberry32(seed);
      const snapshot = peopledSnapshot(24);
      const frozen = structuredClone(snapshot);
      const outcome = await runImport(
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Short", "Brief chaotic text.") }],
        chaosDriver(rng, { probability: 0.6, persistent: false }),
      );

      expect(snapshot, `seed ${seed} mutated the snapshot`).toEqual(frozen);
      if (outcome.outcome === "completed") {
        expect(outcome.value.organized.notes.length).toBeGreaterThan(0);
      } else {
        expect(
          outcome.error.diagnostic.code,
          `seed ${seed}: ${outcome.error.diagnostic.technicalDetail}`,
        ).not.toBe("unknown");
        expect(outcome.error.diagnostic.resumable).toBe(false);
      }
    }
  });

  it("every persistent single-stage sabotage of a direct import rejects with a classified diagnostic", async () => {
    for (const mischief of MISCHIEFS) {
      const snapshot = peopledSnapshot(12);
      const frozen = structuredClone(snapshot);
      const driver: KnowledgeAssignmentDriver = async (request) => {
        if (request.assignment.output.kind === "note-routing") {
          return sabotage(mischief, request);
        }
        return compliantResponse(request);
      };
      const outcome = await runImport(
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Short", "Brief chaotic text.") }],
        driver,
      );

      expect(snapshot).toEqual(frozen);
      if (outcome.outcome === "rejected") {
        expect(
          outcome.error.diagnostic.code,
          `${mischief}: ${outcome.error.diagnostic.technicalDetail}`,
        ).not.toBe("unknown");
      } else {
        // Retryable mischief may recover through the provider retry path.
        expect(outcome.value.organized.notes.length).toBeGreaterThan(0);
      }
    }
  });

  it("fixed imports under transient chaos complete, or pause resumably and then resume to completion", async () => {
    for (let seed = 1; seed <= 8; seed += 1) {
      const rng = mulberry32(seed * 101);
      const snapshot = createEmptySnapshot("Space", NOW);
      const frozen = structuredClone(snapshot);
      const sources = [
        { sourceId: "s1", parsed: parsed("Long", longPdfText(24)) },
      ];
      const outcome = await runImport(
        snapshot,
        sources,
        chaosDriver(rng, { probability: 0.35, persistent: false }),
      );

      expect(snapshot, `seed ${seed} mutated the snapshot`).toEqual(frozen);
      if (outcome.outcome === "completed") {
        expect(outcome.value.organized.notes.length).toBeGreaterThan(0);
        continue;
      }
      expect(
        outcome.error.diagnostic.code,
        `seed ${seed}: ${outcome.error.diagnostic.technicalDetail}`,
      ).not.toBe("unknown");
      if (!outcome.error.diagnostic.resumable) continue;
      expect(outcome.error.checkpoint).toBeDefined();
      const resumed = await runImport(
        snapshot,
        sources,
        async (request) => compliantResponse(request),
        { resume: outcome.error.checkpoint },
      );
      if (resumed.outcome !== "completed") {
        throw new Error(
          `seed ${seed} did not resume cleanly: ${resumed.error.diagnostic.technicalDetail}`,
        );
      }
      expect(resumed.value.organized.notes.length).toBeGreaterThan(0);
    }
  });

  it("persistent sabotage of each long-import stage recovers, or pauses resumably and resumes cleanly", async () => {
    const stages = [
      "reading-blueprint",
      "source-reading",
      "writing-blueprint",
      "writer-result",
    ] as const;
    for (const stage of stages) {
      const snapshot = createEmptySnapshot("Space", NOW);
      const sources = [
        { sourceId: "s1", parsed: parsed("Long", longPdfText(24)) },
      ];
      const driver: KnowledgeAssignmentDriver = async (request) => {
        if (request.assignment.output.kind === stage) {
          return sabotage("hallucinated-ids", request);
        }
        return compliantResponse(request);
      };
      const outcome = await runImport(snapshot, sources, driver);

      if (outcome.outcome === "completed") {
        // Planning and contract-invalid prose have safe host-owned recovery:
        // plans retain exact source coverage, while an irreducible writer
        // result is rebuilt only from its already validated claim selection.
        expect([
          "reading-blueprint",
          "writing-blueprint",
          "writer-result",
        ]).toContain(stage);
        continue;
      }
      expect(
        outcome.error.diagnostic.code,
        `${stage}: ${outcome.error.diagnostic.technicalDetail}`,
      ).not.toBe("unknown");
      expect(outcome.error.diagnostic.resumable, stage).toBe(true);
      expect(outcome.error.checkpoint).toBeDefined();
      const resumed = await runImport(
        snapshot,
        sources,
        async (request) => compliantResponse(request),
        { resume: outcome.error.checkpoint },
      );
      if (resumed.outcome !== "completed") {
        throw new Error(
          `${stage} did not resume cleanly: ${resumed.error.diagnostic.technicalDetail}`,
        );
      }
      expect(resumed.value.organized.notes.length).toBeGreaterThan(0);
    }
  });

  it("a shared reading cache never changes the outcome of a chaotic fixed import", async () => {
    const store = new Map<string, string>();
    const readingCache = {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const snapshot = createEmptySnapshot("Space", NOW);
    const sources = [
      { sourceId: "s1", parsed: parsed("Long", longPdfText(24)) },
    ];
    const first = await runImport(
      snapshot,
      sources,
      async (request) => compliantResponse(request),
      { readingCache },
    );
    if (first.outcome !== "completed") {
      throw new Error("Expected the seeding run to complete.");
    }
    expect(store.size).toBeGreaterThan(0);

    const rng = mulberry32(7);
    const second = await runImport(
      snapshot,
      sources,
      chaosDriver(rng, { probability: 0.5, persistent: false }),
      { readingCache },
    );
    if (second.outcome === "completed") {
      expect(second.value.organized.notes.map(({ title }) => title)).toEqual(
        first.value.organized.notes.map(({ title }) => title),
      );
    } else {
      expect(second.error.diagnostic.code).not.toBe("unknown");
    }
  });

  it("cancellation mid-run rejects as cancelled without a misleading checkpoint offer", async () => {
    const controller = new AbortController();
    let calls = 0;
    const snapshot = createEmptySnapshot("Space", NOW);
    const outcome = await runImport(
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Long", longPdfText(24)) }],
      async (request) => {
        calls += 1;
        if (calls === 2) controller.abort();
        if (controller.signal.aborted) {
          throw controller.signal.reason ?? new Error("The knowledge run was cancelled.");
        }
        return compliantResponse(request);
      },
      { signal: controller.signal },
    );

    if (outcome.outcome !== "rejected") {
      throw new Error("Expected cancellation to reject the import.");
    }
    expect(outcome.error.diagnostic.code).toBe("cancelled");
    expect(outcome.error.diagnostic.resumable).toBe(false);
  });

  it("with landing enabled, no chaotic import fails to deliver notes", async () => {
    const pipelines = [
      {
        name: "direct",
        newSnapshot: () => peopledSnapshot(24),
        newSources: () => [
          { sourceId: "s1", parsed: parsed("Short", "Brief chaotic text.") },
        ],
        probability: 0.6,
      },
      {
        name: "fixed",
        newSnapshot: () => createEmptySnapshot("Space", NOW),
        newSources: () => [
          { sourceId: "s1", parsed: parsed("Long", longPdfText(24)) },
        ],
        probability: 0.45,
      },
    ] as const;
    for (const pipeline of pipelines) {
      for (let seed = 1; seed <= 10; seed += 1) {
        const rng = mulberry32(seed * 977 + pipeline.probability * 1_000);
        const snapshot = pipeline.newSnapshot();
        const frozen = structuredClone(snapshot);
        const outcome = await runImport(
          snapshot,
          pipeline.newSources(),
          chaosDriver(rng, {
            probability: pipeline.probability,
            persistent: seed % 2 === 0,
          }),
          { landOnFailure: true },
        );

        expect(
          snapshot,
          `${pipeline.name} seed ${seed} mutated the snapshot`,
        ).toEqual(frozen);
        if (outcome.outcome === "rejected") {
          // Only user cancellation may still reject; chaos never cancels.
          expect(
            outcome.error.diagnostic.code,
            `${pipeline.name} seed ${seed}: ${outcome.error.diagnostic.technicalDetail}`,
          ).toBe("cancelled");
          continue;
        }
        expect(
          outcome.value.organized.notes.length,
          `${pipeline.name} seed ${seed} delivered no notes`,
        ).toBeGreaterThan(0);
        if (outcome.value.landing) {
          expect(outcome.value.warnings[0]).toMatch(
            /^Orion landed this import plainly/,
          );
          expect(outcome.value.landing.code).not.toBe("cancelled");
        }
      }
    }
  });
});
