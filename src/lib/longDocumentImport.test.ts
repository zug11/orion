import { describe, expect, it, vi } from "vitest";
import {
  buildLongDocumentSynthesis,
  isLongDocument,
  mapLongDocumentSections,
  splitDocumentForParallelReading,
  splitDocumentIntoReadingSections,
  splitLongDocument,
} from "./longDocumentImport";
import type { OrganizeContentResult } from "../types";

function longPdfText(pageCount = 206, charactersPerPage = 1_900): string {
  return Array.from(
    { length: pageCount },
    (_, index) =>
      `## Page ${index + 1}\n\n${String.fromCharCode(65 + (index % 26)).repeat(charactersPerPage)}`,
  ).join("\n\n");
}

describe("long document import", () => {
  it("turns a 206-page book into nine balanced, page-aware sections", () => {
    const text = longPdfText();
    expect(isLongDocument(text)).toBe(true);
    const sections = splitLongDocument(text);

    expect(sections).toHaveLength(9);
    expect(sections[0]).toMatchObject({ index: 0, total: 9, pageStart: 1 });
    expect(sections[sections.length - 1]).toMatchObject({
      index: 8,
      total: 9,
      pageEnd: 206,
    });
    expect(sections.every(({ content }) => content.length < 50_000)).toBe(true);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
  });

  it("hard-splits a long source with no structural boundaries without losing text", () => {
    const text = "A".repeat(130_003);
    const sections = splitLongDocument(text);

    expect(sections).toHaveLength(3);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(sections.every(({ content }) => content.length > 0)).toBe(true);
    expect(Math.max(...sections.map(({ content }) => content.length))).toBeLessThan(
      44_000,
    );
  });

  it("creates enough balanced passes when a long source has too few paragraphs", () => {
    const text = `${"A".repeat(92_000)}\n\n${"B".repeat(92_000)}`;
    const sections = splitLongDocument(text);

    expect(sections).toHaveLength(5);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(sections.every(({ total }) => total === 5)).toBe(true);
  });

  it("uses line boundaries for pathological CSV while preserving exact coverage", () => {
    const row = `${"field".repeat(1_000)},${"value".repeat(1_000)}\n`;
    const text = row.repeat(20);
    const sections = splitLongDocument(text);

    expect(text.length).toBeGreaterThan(60_000);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(sections.slice(0, -1).every(({ content }) => content.endsWith("\n"))).toBe(
      true,
    );
  });

  it("hard-splits minified JSON without breaking surrogate pairs", () => {
    const atom = `{"label":"dialectic-🜁","value":123456789},`;
    const text = `[${atom.repeat(2_500)}{}]`;
    const sections = splitLongDocument(text);

    expect(text.length).toBeGreaterThan(60_000);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(
      sections.every(({ content }) => {
        const first = content.charCodeAt(0);
        const last = content.charCodeAt(content.length - 1);
        return !(
          (first >= 0xdc00 && first <= 0xdfff) ||
          (last >= 0xd800 && last <= 0xdbff)
        );
      }),
    ).toBe(true);
  });

  it("keeps page identity when a few unusually dense pages need subdivision", () => {
    const text = longPdfText(2, 55_000);
    const sections = splitLongDocument(text);

    expect(sections).toHaveLength(3);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(sections.every(({ pageStart, pageEnd }) => pageStart && pageEnd)).toBe(
      true,
    );
    expect(sections[0].pageStart).toBe(1);
    expect(sections[sections.length - 1]?.pageEnd).toBe(2);
  });

  it("honors an exact planner width while preserving complete PDF page identity", () => {
    const text = longPdfText(5, 22_000);
    const sections = splitDocumentIntoReadingSections(text, 8);

    expect(sections).toHaveLength(8);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(sections.every(({ pageStart, pageEnd }) => pageStart && pageEnd)).toBe(
      true,
    );
    expect(sections[0].pageStart).toBe(1);
    expect(sections[sections.length - 1]?.pageEnd).toBe(5);
  });

  it("caps pathological sources at twelve complete ordered sections", () => {
    const text = "x".repeat(1_000_003);
    const sections = splitLongDocument(text);

    expect(sections).toHaveLength(12);
    expect(sections.map(({ content }) => content).join("")).toBe(text);
    expect(sections.map(({ index }) => index)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
  });

  it("parallelizes a modest page-aware source without slowing plain short text", () => {
    const fivePages = longPdfText(5, 500);
    const sections = splitDocumentForParallelReading(fivePages);

    expect(isLongDocument(fivePages)).toBe(false);
    expect(sections).toHaveLength(3);
    expect(sections.map(({ pageStart, pageEnd }) => [pageStart, pageEnd])).toEqual([
      [1, 2],
      [3, 4],
      [5, 5],
    ]);
    expect(splitDocumentForParallelReading("A compact source without pages.")).toEqual([]);
  });

  it("runs independent readers with bounded parallelism and keeps source order", async () => {
    const sections = splitLongDocument(longPdfText(48, 1_900));
    let active = 0;
    let maximumActive = 0;
    const progress = vi.fn();
    const outcomes = await mapLongDocumentSections(
      sections,
      async (section) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return section.index;
      },
      progress,
      3,
    );

    expect(maximumActive).toBe(3);
    expect(outcomes.map(({ value }) => value)).toEqual(
      sections.map(({ index }) => index),
    );
    expect(progress).toHaveBeenLastCalledWith(sections.length, sections.length);
  });

  it("uses six readers by default for a sufficiently long source", async () => {
    const sections = splitLongDocument(longPdfText(160, 1_900));
    let active = 0;
    let maximumActive = 0;
    const outcomes = await mapLongDocumentSections(sections, async (section) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active -= 1;
      return section.index;
    });

    expect(sections.length).toBeGreaterThan(6);
    expect(maximumActive).toBe(6);
    expect(outcomes.every(({ value }) => value !== undefined)).toBe(true);
  });

  it("builds a bounded ordered synthesis from successful evidence packets", () => {
    const sections = splitLongDocument(longPdfText());
    const result: OrganizeContentResult = {
      notes: [
        {
          title: "Dialectical movement",
          summary: "A section argument.",
          body: "The section develops determinate negation.",
          tags: [],
          aliases: [],
          links: [],
        },
      ],
      wikiArticles: [],
      concepts: [],
      suggestedConnections: [],
    };
    const synthesis = buildLongDocumentSynthesis("Hegel", [
      { section: sections[0], value: result },
      { section: sections[1], error: new Error("retry") },
      { section: sections[2], value: result },
    ]);

    expect(synthesis).toContain("Evidence packet 1 of 2");
    expect(synthesis).toContain("Dialectical movement");
    expect(synthesis).not.toContain("retry");
    expect(synthesis.length).toBeLessThanOrEqual(96_000);
  });
});
