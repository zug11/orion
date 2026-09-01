// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmptyVault } from "../data/defaults";
import { clearBrowserSnapshot, loadSnapshot, saveSnapshot } from "./storage";

afterEach(() => clearBrowserSnapshot());
beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

describe("argument relationship persistence", () => {
  it("round-trips new kinds alongside legacy contrasts without a schema reset", async () => {
    const vault = createEmptyVault("Arguments", "2026-08-31T00:00:00.000Z");
    vault.spaces[0].relationships = ["supports", "qualifies", "conflicts", "contrasts"].map((kind, index) => ({
      id: `relationship-${index}`, fromNoteId: "a", toNoteId: "b",
      kind: kind as "supports" | "qualifies" | "conflicts" | "contrasts",
      label: kind, strength: 0.8, context: "A meaningful argument relationship.",
    }));
    await saveSnapshot(vault);
    const loaded = await loadSnapshot();
    expect(loaded?.spaces[0].relationships).toEqual(vault.spaces[0].relationships);
  });
});
