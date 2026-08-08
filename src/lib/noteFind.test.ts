import { describe, expect, it } from "vitest";
import { findTextMatches, wrapMatchIndex } from "./noteFind";

describe("findTextMatches", () => {
  it("finds non-overlapping matches without case sensitivity", () => {
    expect(findTextMatches("Orion orion ORION", "orion")).toEqual([
      { from: 0, to: 5 },
      { from: 6, to: 11 },
      { from: 12, to: 17 },
    ]);
  });

  it("does not create results for whitespace-only queries", () => {
    expect(findTextMatches("Anything", "   ")).toEqual([]);
  });
});

describe("wrapMatchIndex", () => {
  it("wraps in both directions", () => {
    expect(wrapMatchIndex(3, 3)).toBe(0);
    expect(wrapMatchIndex(-1, 3)).toBe(2);
    expect(wrapMatchIndex(8, 0)).toBe(0);
  });
});
