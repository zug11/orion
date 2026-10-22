// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from "vitest";
import { createEmptyVault } from "../data/defaults";
import { clearBrowserSnapshot, loadSnapshot } from "./storage";

beforeEach(() => {
  const values = new Map<string, string>();
  const storage: Storage = {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  clearBrowserSnapshot();
});
afterEach(() => clearBrowserSnapshot());
it("accepts an older vault without Perplexity settings and round-trips web evidence without keys", async () => {
  const vault = createEmptyVault();
  delete vault.spaces[0].settings.perplexityApiKeyConfigured;
  window.localStorage.setItem("orion:vault:v2", JSON.stringify(vault));
  expect((await loadSnapshot())?.spaces[0].settings.perplexityApiKeyConfigured).toBeUndefined();
  vault.spaces[0].settings.perplexityApiKeyConfigured = true;
  vault.spaces[0].studio.messages = [{ id: "web-reply", role: "assistant", content: "Finding [1](#orion-evidence-e1)", cardIds: [], contextCardIds: [], createdAt: "2026-10-22",
    evidence: [{ id: "e1", kind: "web", entityId: "web-1", title: "Paper", version: "v1", text: "Evidence", start: 0, end: 8, offsetUnit: "utf16",
      web: { url: "https://example.org/paper", retrievedAt: "2026-10-22T00:00:00Z" } }] }];
  window.localStorage.setItem("orion:vault:v2", JSON.stringify(vault));
  const loaded = await loadSnapshot();
  expect(loaded?.spaces[0].studio.messages[0].evidence).toEqual(vault.spaces[0].studio.messages[0].evidence);
  expect(JSON.stringify(loaded)).not.toContain("perplexityApiKey\"");
});
