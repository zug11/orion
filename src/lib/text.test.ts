import { describe, expect, it } from "vitest";
import { truncateUnicode } from "./text";

describe("truncateUnicode", () => {
  it("bounds code points without splitting emoji", () => {
    expect(truncateUnicode("A🪐B", 2)).toBe("A🪐");
    expect([...truncateUnicode("🪐".repeat(2_500), 2_000)]).toHaveLength(2_000);
  });
});
