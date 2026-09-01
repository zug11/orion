import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { ParsedImport } from "../../types";
import { runKnowledgeImportBatch } from "./import";
import {
  KnowledgeProviderExecutionError,
  KnowledgeProviderTimeoutError,
  type KnowledgeAssignmentExecutionRequest,
} from "./service";
import { fixedPipelineResponse, longPdfText } from "./testFixtures";

const NOW = "2026-08-31T10:00:00.000Z";

function source(sourceId: string, text: string) {
  const parsed: ParsedImport = {
    title: sourceId, fileName: `${sourceId}.txt`, mimeType: "text/plain",
    format: "text", byteSize: text.length, text, warnings: [],
  };
  return { sourceId, parsed };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("fair adaptive source scheduling", () => {
  it("starts four fair readers, keeps idle slots busy, caches settled evidence, then grows to six", async () => {
    const snapshot = createEmptySnapshot("Fresh", NOW);
    const started: Array<{ sourceId: string; rangeId: string; gate: ReturnType<typeof deferred> }> = [];
    let active = 0;
    let maximum = 0;
    let finished = 0;
    let planned = 0;
    let writingStarted = false;
    const cache = new Map<string, string>();
    const pending = runKnowledgeImportBatch({
      snapshot,
      sources: [source("book", longPdfText(160, 5_000)), source("meeting", "Meeting evidence."), source("csv", "Table evidence.")],
      importGuidance: "", model: snapshot.settings.model, effort: "high",
      readingCache: {
        get: async (key) => cache.get(key),
        put: async (key, value) => { cache.set(key, value); },
      },
      driver: async (request) => {
        const output = request.assignment.output;
        if (output.kind === "reading-blueprint") planned = output.sourceRanges.length;
        if (output.kind === "source-reading") {
          const gate = deferred();
          started.push({ sourceId: output.sourceId, rangeId: output.rangeId, gate });
          active += 1;
          maximum = Math.max(maximum, active);
          await gate.promise;
          active -= 1;
          finished += 1;
        }
        if (output.kind === "writing-blueprint" || output.kind === "writer-result") {
          writingStarted = true;
          expect(finished).toBe(planned);
          expect(active).toBe(0);
        }
        return fixedPipelineResponse(request);
      },
    });

    await vi.waitFor(() => expect(started).toHaveLength(4));
    expect(started.map(({ sourceId }) => sourceId)).toEqual(["book", "meeting", "csv", "book"]);
    expect(active).toBe(4);
    started[0].gate.resolve();
    await vi.waitFor(() => expect(started).toHaveLength(5));
    expect(cache.size).toBe(1);
    expect(active).toBe(4);
    expect(writingStarted).toBe(false);

    started.slice(1, 4).forEach(({ gate }) => gate.resolve());
    await vi.waitFor(() => expect(active).toBe(6));
    while (finished < planned) {
      started.forEach(({ gate }) => gate.resolve());
      await vi.waitFor(() => expect(finished === planned || started.length > finished).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const result = await pending;
    expect(maximum).toBe(6);
    expect(started).toHaveLength(planned);
    expect(new Set(started.map(({ sourceId, rangeId }) => `${sourceId}/${rangeId}`)).size).toBe(planned);
    expect(result.provenance[0].sourceIds.sort()).toEqual(["book", "csv", "meeting"]);
    expect(snapshot.notes).toEqual([]);
  });

  it("defers child repairs until original readers settle and never writes before complete coverage", async () => {
    const snapshot = createEmptySnapshot("Fresh", NOW);
    const originals: Array<{ rangeId: string; gate: ReturnType<typeof deferred> }> = [];
    let expectedOriginals = 0;
    let settledOriginals = 0;
    const children: string[] = [];
    const pending = runKnowledgeImportBatch({
      snapshot, sources: [source("book", "A".repeat(800_000))],
      importGuidance: "", model: snapshot.settings.model, effort: "high",
      driver: async (request) => {
        const output = request.assignment.output;
        if (output.kind === "reading-blueprint") expectedOriginals = output.sourceRanges.length;
        if (output.kind !== "source-reading") {
          if (output.kind === "writing-blueprint") {
            expect(settledOriginals).toBe(expectedOriginals);
            expect(children).toEqual(["range-1.part-1", "range-1.part-2"]);
          }
          return fixedPipelineResponse(request);
        }
        if (output.rangeId.includes(".part-")) {
          expect(settledOriginals).toBe(expectedOriginals);
          children.push(output.rangeId);
          return fixedPipelineResponse(request);
        }
        const gate = deferred();
        originals.push({ rangeId: output.rangeId, gate });
        if (output.rangeId !== "range-1") await gate.promise;
        settledOriginals += 1;
        const response = fixedPipelineResponse(request);
        if (output.rangeId === "range-1") {
          const payload = response.response.payload as { coverage: { complete: boolean; limitations: string[] } };
          payload.coverage = { complete: false, limitations: ["A closer reading is needed."] };
        }
        return response;
      },
    });
    await vi.waitFor(() => expect(originals.length).toBe(5));
    expect(children).toEqual([]);
    // The failed cohort has not widened: four originals remain live.
    expect(originals.length - settledOriginals).toBe(4);
    while (settledOriginals < expectedOriginals) {
      originals.forEach(({ gate }) => gate.resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const result = await pending;
    expect(result.organized.notes).toHaveLength(1);
    expect(originals.map(({ rangeId }) => rangeId)).toHaveLength(expectedOriginals);
    expect(children).toEqual(["range-1.part-1", "range-1.part-2"]);
  });

  it.each([
    ["timeout", () => new KnowledgeProviderTimeoutError("The transport timed out.")],
    ["authentication", () => new KnowledgeProviderExecutionError("Authentication failed.", { retryable: false, retryAfterMs: 0 })],
    ["billing", () => new KnowledgeProviderExecutionError("Billing quota exhausted.", { retryable: false, retryAfterMs: 0 })],
  ])("never widens or subdivides after a provider-wide %s failure", async (_label, failure) => {
    const snapshot = createEmptySnapshot("Fresh", NOW);
    const readers: KnowledgeAssignmentExecutionRequest[] = [];
    let writerCalls = 0;
    await expect(runKnowledgeImportBatch({
      snapshot, sources: [source("book", "A".repeat(800_000))],
      importGuidance: "", model: snapshot.settings.model, effort: "high",
      driver: async (request, signal) => {
        if (request.assignment.output.kind === "source-reading") {
          readers.push(request);
          if (request.assignment.output.rangeId === "range-1") throw failure();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        if (request.assignment.output.kind === "writer-result") writerCalls += 1;
        return fixedPipelineResponse(request);
      },
    })).rejects.toThrow();
    expect(readers).toHaveLength(4);
    expect(readers.every(({ assignment }) => assignment.output.kind === "source-reading" && !assignment.output.rangeId.includes(".part-"))).toBe(true);
    expect(writerCalls).toBe(0);
    expect(snapshot.notes).toEqual([]);
  });
});
