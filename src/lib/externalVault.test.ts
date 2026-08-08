import { describe, expect, it } from "vitest";
import { createEmptySnapshot, createEmptyVault } from "../data/defaults";
import { spacesNeedingOverviewRefresh, shouldAcceptExternalVault } from "./externalVault";

const NOW = "2026-08-05T12:00:00.123Z";

describe("external vault reconciliation", () => {
  it("accepts a distinct sub-millisecond disk revision", () => {
    expect(
      shouldAcceptExternalVault(NOW, "2026-08-05T12:00:00.123456789Z"),
    ).toBe(true);
    expect(shouldAcceptExternalVault(NOW, NOW)).toBe(false);
  });

  it("schedules a changed non-active Space with a missing overview", () => {
    const previous = createEmptyVault("Active", NOW);
    const dormant = createEmptySnapshot("Dormant", NOW, "space-dormant");
    previous.spaces.push(dormant);
    const incoming = structuredClone(previous);
    incoming.spaces[1].notes.push({
      id: "note-mcp",
      title: "MCP note",
      slug: "mcp-note",
      summary: "Claude added a meaningful note to this dormant Space.",
      body: "This content should orient the living Space overview.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: "2026-08-05T12:00:01.000Z",
    });

    expect(spacesNeedingOverviewRefresh(previous, incoming)).toEqual([
      "space-dormant",
    ]);
  });
});
