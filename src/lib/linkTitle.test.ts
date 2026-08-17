import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Concept, Note } from "../types";
import {
  buildLinkTitleRequest,
  normalizeGeneratedLinkTitle,
} from "./linkTitle";

const NOW = "2026-08-08T10:00:00.000Z";

describe("AI link titles", () => {
  it("builds a narrow low-effort request with selection and Space vocabulary", () => {
    const snapshot = createEmptySnapshot(NOW, "space-test");
    snapshot.workspace.name = "Database redesign";
    snapshot.settings.model = "gpt-5.2";
    snapshot.notes = [
      note("note-origin", "Architecture notes", "The system uses SQL."),
      note("note-existing", "Role inheritance", "Permissions flow by role."),
    ];
    snapshot.concepts = [concept("concept-sql", "SQL")];

    const request = buildLinkTitleRequest(
      snapshot,
      "note-origin",
      "A join combines related rows from two tables.",
    );

    expect(request.model).toBe("gpt-5.2");
    expect(request.effort).toBe("low");
    expect(request.history).toEqual([]);
    expect(request.sources).toEqual([]);
    expect(request.notes[0]).toMatchObject({
      title: "Selected passage",
      body: "A join combines related rows from two tables.",
    });
    expect(request.notes.map((item) => item.title)).toEqual([
      "Selected passage",
      "Architecture notes",
      "Role inheritance",
    ]);
    expect(request.concepts).toEqual([
      { label: "SQL", description: "SQL concept" },
    ]);
    expect(request.prompt).not.toContain("A join combines");
  });

  it("keeps both ends of a very large selection within request bounds", () => {
    const snapshot = createEmptySnapshot(NOW, "space-test");
    const selected = `BEGIN ${"middle ".repeat(1_200)} END`;

    const body = buildLinkTitleRequest(snapshot, "missing", selected).notes[0]
      .body;

    expect(body).toContain("BEGIN");
    expect(body).toContain("END");
    expect(body).toContain("middle omitted");
    expect([...body].length).toBeLessThanOrEqual(6_000);
  });

  it.each([
    ["SQL joins", "SQL joins"],
    ["Title: Role inheritance", "Role inheritance"],
    ["## **Permission model**", "Permission model"],
    ["“Relational algebra”", "Relational algebra"],
    ['{"title":"Query planning"}', "Query planning"],
    ["Index design\nThis is the explanation.", "Index design"],
  ])("normalizes %j to %j", (reply, expected) => {
    expect(normalizeGeneratedLinkTitle(reply)).toBe(expected);
  });

  it("rejects blank, invalid, and oversized suggestions", () => {
    expect(() => normalizeGeneratedLinkTitle("  ")).toThrow(/usable/i);
    expect(() => normalizeGeneratedLinkTitle("A")).toThrow(/usable/i);
    expect(() => normalizeGeneratedLinkTitle("x".repeat(121))).toThrow(
      /too long/i,
    );
  });
});

function note(id: string, title: string, body: string): Note {
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary: `${title} summary`,
    body,
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function concept(id: string, label: string): Concept {
  return {
    id,
    label,
    aliases: [],
    description: `${label} concept`,
    noteIds: [],
    autoLink: true,
    color: "#8798ff",
  };
}
