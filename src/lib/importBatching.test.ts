import { describe, expect, it } from "vitest";
import {
  DEFAULT_IMPORT_BATCH_BOUNDS,
  partitionImportSourcesForSynthesis,
} from "./importBatching";
import {
  createSourceReadingPlan,
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

function readingInputs(sources: FixtureSource[]) {
  return sources.map(({ id, text }) => ({
    sourceId: id,
    parsed: {
      title: id,
      fileName: `${id}.txt`,
      mimeType: "text/plain",
      format: "text" as const,
      byteSize: new TextEncoder().encode(text).byteLength,
      text,
      warnings: [],
    },
  }));
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

  it.each([
    ["ASCII", "a", 650_001],
    ["CJK", "界", 80_000],
    ["emoji", "😀", 80_000],
  ])("automatically partitions 14 canonical evidence groups for %s text", (_, fill, characters) => {
    const sources = [source("a", characters, fill), source("b", characters, fill)];
    expect(() => createSourceReadingPlan(readingInputs(sources))).toThrow(
      "This batch needs 14 canonical evidence groups",
    );

    const batches = partitionImportSourcesForSynthesis(sources, ({ text }) => text);

    expect(batchIds(batches)).toEqual([["a"], ["b"]]);
    expect(batches.flat()).toEqual(sources);
    for (const batch of batches) {
      const plan = createSourceReadingPlan(readingInputs(batch));
      expect([...plan.values()].flat().length).toBeLessThanOrEqual(MAX_BATCH_SOURCE_READINGS);
      expect(plan.get(batch[0].id)?.map(({ content }) => content).join("")).toBe(batch[0].text);
    }
  });

  it("packs long and short sources up to the minimum reading capacity", () => {
    const sources = [source("long", 350_001), ...Array.from({ length: 10 }, (_, i) => source(`short-${i}`, 10))];

    const batches = partitionImportSourcesForSynthesis(sources, ({ text }) => text);

    expect(batchIds(batches)).toEqual([
      sources.slice(0, 9).map(({ id }) => id),
      ["short-8", "short-9"],
    ]);
    for (const batch of batches) {
      expect(() => createSourceReadingPlan(readingInputs(batch))).not.toThrow();
    }
  });

  it("keeps sources together when their minimum readings exactly fit", () => {
    const sources = [source("a", 600_000), source("b", 600_000)];
    const batches = partitionImportSourcesForSynthesis(sources, ({ text }) => text);

    expect(batchIds(batches)).toEqual([["a", "b"]]);
    expect(() => createSourceReadingPlan(readingInputs(batches[0]))).not.toThrow();
  });

  it("isolates a byte-legal source that cannot fit the reading capacity without losing later sources", () => {
    const sources = [
      source("before", 30),
      source("too-dense", 155_000, "界"),
      source("after", 30),
      source("last", 30),
    ];
    expect(() => createSourceReadingPlan(readingInputs([sources[1]]))).toThrow(
      "needs more canonical evidence groups",
    );

    const batches = partitionImportSourcesForSynthesis(sources, ({ text }) => text);

    expect(batchIds(batches)).toEqual([["before"], ["too-dense"], ["after", "last"]]);
    expect(batches.flat()).toEqual(sources);
    expect(() => createSourceReadingPlan(readingInputs(batches[0]))).not.toThrow();
    expect(() => createSourceReadingPlan(readingInputs(batches[2]))).not.toThrow();
  });

  it("returns no batches for an empty selection", () => {
    expect(
      partitionImportSourcesForSynthesis([] as FixtureSource[], ({ text }) => text),
    ).toEqual([]);
  });
});
