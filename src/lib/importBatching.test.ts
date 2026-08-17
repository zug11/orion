import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORT_BATCH_BOUNDS,
  partitionImportSourcesForSynthesis,
} from "./importBatching";
import {
  MAX_BATCH_SOURCE_READINGS,
  MAX_BATCH_SOURCE_UTF8_BYTES,
} from "./knowledgeOrchestration/context";

interface FixtureSource {
  id: string;
  text: string;
}

function source(id: string, characters: number, fill = "a"): FixtureSource {
  return { id, text: fill.repeat(characters) };
}

function batchIds(batches: FixtureSource[][]): string[][] {
  return batches.map((batch) => batch.map(({ id }) => id));
}

describe("import batch partitioning", () => {
  it("packs deterministically while preserving the selection order", () => {
    const sources = [
      source("a", 40),
      source("b", 40),
      source("c", 40),
      source("d", 40),
      source("e", 40),
    ];

    const first = partitionImportSourcesForSynthesis(
      sources,
      ({ text }) => text,
      { maxUtf8Bytes: 100, maxSources: 12 },
    );
    const second = partitionImportSourcesForSynthesis(
      sources,
      ({ text }) => text,
      { maxUtf8Bytes: 100, maxSources: 12 },
    );

    expect(batchIds(first)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(batchIds(second)).toEqual(batchIds(first));
    expect(first.flat()).toEqual(sources);
  });

  it("respects the batch byte bound, measuring UTF-8 rather than characters", () => {
    // Each source is 4 two-byte characters (8 UTF-8 bytes), so a 16-byte
    // batch holds exactly two of them even though 4 fit by character count.
    const sources = [
      source("a", 4, "ß"),
      source("b", 4, "ß"),
      source("c", 4, "ß"),
    ];

    const batches = partitionImportSourcesForSynthesis(
      sources,
      ({ text }) => text,
      { maxUtf8Bytes: 16, maxSources: 12 },
    );

    expect(batchIds(batches)).toEqual([["a", "b"], ["c"]]);
    for (const batch of batches) {
      const bytes = batch.reduce(
        (total, { text }) => total + new TextEncoder().encode(text).byteLength,
        0,
      );
      expect(bytes).toBeLessThanOrEqual(16);
    }
  });

  it("respects the batch source-count bound", () => {
    const sources = Array.from({ length: 7 }, (_, index) =>
      source(`s${index + 1}`, 1),
    );

    const batches = partitionImportSourcesForSynthesis(
      sources,
      ({ text }) => text,
      { maxUtf8Bytes: 1_000, maxSources: 3 },
    );

    expect(batchIds(batches)).toEqual([
      ["s1", "s2", "s3"],
      ["s4", "s5", "s6"],
      ["s7"],
    ]);
  });

  it("passes a singleton oversized source through as its own batch", () => {
    const sources = [
      source("small-before", 30),
      source("oversized", 500),
      source("small-after", 30),
      source("small-last", 30),
    ];

    const batches = partitionImportSourcesForSynthesis(
      sources,
      ({ text }) => text,
      { maxUtf8Bytes: 100, maxSources: 12 },
    );

    expect(batchIds(batches)).toEqual([
      ["small-before"],
      ["oversized"],
      ["small-after", "small-last"],
    ]);
  });

  it("keeps one modest selection in a single batch under the real bounds", () => {
    expect(DEFAULT_IMPORT_BATCH_BOUNDS).toEqual({
      maxUtf8Bytes: MAX_BATCH_SOURCE_UTF8_BYTES,
      maxSources: MAX_BATCH_SOURCE_READINGS,
    });

    const sources = [source("a", 50_000), source("b", 50_000)];

    expect(
      batchIds(partitionImportSourcesForSynthesis(sources, ({ text }) => text)),
    ).toEqual([["a", "b"]]);
  });

  it("returns no batches for an empty selection", () => {
    expect(
      partitionImportSourcesForSynthesis([] as FixtureSource[], ({ text }) => text),
    ).toEqual([]);
  });
});
