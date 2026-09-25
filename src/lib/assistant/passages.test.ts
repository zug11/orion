import { describe, expect, it } from "vitest";
import { exactPassages } from "./context";

describe("exact query passages", () => {
  it.each([996, 997, 999, 3996, 7999])("opens a match crossing the former boundary at %i", (offset) => {
    const body = " ".repeat(offset) + "Zirconium exception" + " background".repeat(1000);
    const passages = exactPassages(body, "zirconium", 3000);
    expect(passages.some((passage) => passage.text.includes("Zirconium exception"))).toBe(true);
    for (const passage of passages) expect(passage.text).toBe(body.slice(passage.start, passage.end));
    expect(passages.reduce((sum, passage) => sum + passage.text.length, 0)).toBeLessThanOrEqual(3000);
  });

  it("finds late two-character and multilingual terms in original coordinates", () => {
    const body = "İ😀 background. ".repeat(600) + "量子 theory and AI evidence" + " ending".repeat(250);
    const passages = exactPassages(body, "量子 AI", 1000);
    expect(passages.some((passage) => passage.text.includes("量子 theory and AI evidence"))).toBe(true);
    for (const passage of passages) expect(passage.text).toBe(body.slice(passage.start, passage.end));
  });

  it("does not let an earlier common term hide another term in the same region", () => {
    const body = " ".repeat(1001) + "common" + " ".repeat(983) + "Zirconium" + " ".repeat(3001);
    expect(body.indexOf("Zirconium")).toBe(1990);
    const passages = exactPassages(body, "common Zirconium", 3000);
    expect(passages.some((passage) => passage.text.includes("Zirconium"))).toBe(true);
    expect(passages.some((passage) => passage.text.includes("common"))).toBe(true);
  });

  it("covers a rare query term before spending the whole budget on a repeated term", () => {
    const body = "common ".repeat(700) + "Zirconium exception" + " filler".repeat(700);
    const passages = exactPassages(body, "common Zirconium", 3000);
    expect(passages.some((passage) => passage.text.includes("Zirconium exception"))).toBe(true);
  });

  it("does not split surrogate pairs or return overlapping duplicated text", () => {
    const body = "😀".repeat(1100) + "boundary evidence" + "😀".repeat(1100);
    const passages = exactPassages(body, "boundary evidence", 2501);
    expect(passages.some((passage) => passage.text.includes("boundary evidence"))).toBe(true);
    for (const [index, passage] of passages.entries()) {
      expect(passage.text).toBe(body.slice(passage.start, passage.end));
      expect(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(passage.text)).toBe(false);
      if (index) expect(passage.start).toBeGreaterThanOrEqual(passages[index - 1].end);
    }
    expect(passages.reduce((sum, passage) => sum + passage.text.length, 0)).toBeLessThanOrEqual(2501);
  });

  it("honors narrow and invalid budgets without inventing or expanding text", () => {
    for (const budget of [0, -1, NaN, Infinity]) expect(exactPassages("source", "source", budget)).toEqual([]);
    expect(exactPassages("😀 text", "text", 1).every((passage) => passage.text.length <= 1)).toBe(true);
    expect(exactPassages("short source", "source", 100)).toEqual([{ start: 0, end: 12, text: "short source" }]);
  });
});
