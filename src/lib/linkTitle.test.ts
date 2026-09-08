import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Concept, Note } from "../types";
import {
  buildLinkTitleRequest,
  generateLinkTitleWithDeduplication,
  linkTitleConflict,
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
    snapshot.concepts = [
      concept("concept-origin", "Architecture notes", "note-origin"),
      concept("concept-sql", "SQL"),
    ];

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
    expect(request.prompt).toContain(
      'Never return the origin title or one of its aliases ("Architecture notes")',
    );
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

  it("keeps other Space vocabulary local when existing-note AI context is disabled", () => {
    const snapshot = titleSnapshot();
    snapshot.settings.includeExistingNotesInAIContext = false;
    snapshot.notes.push(note("private", "Private unrelated subject", "Private body"));
    snapshot.concepts.push(concept("private-concept", "Private vocabulary", "private"));

    const request = buildLinkTitleRequest(snapshot, "origin", "Selected passage");

    expect(request.notes.map((item) => item.title)).toEqual(["Selected passage", "Database notes"]);
    expect(request.concepts).toEqual([]);
    expect(JSON.stringify(request)).not.toContain("Private");
  });

  it("automatically retries the origin title and its concept alias before returning a distinct subject", async () => {
    const snapshot = titleSnapshot();
    snapshot.concepts[0].aliases = ["Earlier database title"];
    const request = vi.fn()
      .mockResolvedValueOnce({ reply: "  DATABASE   NOTES " })
      .mockResolvedValueOnce({ reply: "Earlier database title" })
      .mockResolvedValueOnce({ reply: "SQL joins" });

    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "A join combines table rows.", request,
    )).resolves.toBe("SQL joins");

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][0].prompt).toContain('"DATABASE NOTES"');
    expect(request.mock.calls[2][0].prompt).toContain('"Earlier database title"');
    expect(request.mock.calls[2][0].prompt).toContain("Do not repeat these titles or add a number suffix");
    expect(snapshot.notes).toHaveLength(1);
  });

  it("reuses an existing canonical title through its alias without another naming request", async () => {
    const snapshot = titleSnapshot();
    const existing = { ...note("sql", "SQL", "Human-authored knowledge."), aliases: ["Structured Query Language"] };
    snapshot.notes.push(existing);
    const before = JSON.stringify(snapshot);
    const request = vi.fn().mockResolvedValue({ reply: "structured query language" });

    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "Querying relational tables.", request,
    )).resolves.toBe("SQL");

    expect(request).toHaveBeenCalledOnce();
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("rechecks live Space destinations and retries an ambiguous title", async () => {
    const snapshot = titleSnapshot();
    const request = vi.fn().mockImplementationOnce(async () => {
      snapshot.notes.push(note("sql-one", "SQL", "First article."), note("sql-two", "sql", "Second article."));
      return { reply: "SQL" };
    }).mockResolvedValueOnce({ reply: "Relational join semantics" });

    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "A join combines table rows.", request,
    )).resolves.toBe("Relational join semantics");

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].prompt).toContain('"SQL"');
  });

  it("bounds repeated collisions without creating or renaming any note", async () => {
    const snapshot = titleSnapshot();
    const before = JSON.stringify(snapshot);
    const request = vi.fn().mockResolvedValue({ reply: "Database notes" });

    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "Selected passage", request,
    )).rejects.toThrow(/more specific page title/);

    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("does not retry a collision after the composer cancels", async () => {
    const snapshot = titleSnapshot();
    const controller = new AbortController();
    const request = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { reply: "Database notes" };
    });

    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "Selected passage", request, controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("stops naming if the active Space changes or the source note is deleted", async () => {
    let snapshot = titleSnapshot();
    const request = vi.fn().mockImplementation(async () => {
      snapshot = createEmptySnapshot("Other Space", NOW, "other-space");
      return { reply: "SQL joins" };
    });
    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "Selected passage", request,
    )).rejects.toThrow(/active Space changed/);
    expect(request).toHaveBeenCalledOnce();

    snapshot = titleSnapshot();
    request.mockImplementation(async () => {
      snapshot.notes = [];
      return { reply: "SQL joins" };
    });
    await expect(generateLinkTitleWithDeduplication(
      () => snapshot, "origin", "Selected passage", request,
    )).rejects.toThrow(/source note was removed/);
  });

  it("recognizes normalized origin aliases without blocking an unrelated article", () => {
    const snapshot = titleSnapshot();
    snapshot.notes[0].aliases = ["Query–planning"];
    snapshot.notes.push(note("joins", "SQL joins", "Existing article."));

    expect(linkTitleConflict(snapshot, "origin", "QUERY-PLANNING")).toBe("self");
    expect(linkTitleConflict(snapshot, "origin", "SQL joins")).toBeNull();
  });
});

function titleSnapshot() {
  const snapshot = createEmptySnapshot("Databases", NOW, "space-test");
  snapshot.notes = [note("origin", "Database notes", "A source passage about SQL joins.")];
  snapshot.concepts = [concept("concept-origin", "Database notes", "origin")];
  return snapshot;
}

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

function concept(
  id: string,
  label: string,
  canonicalNoteId?: string,
): Concept {
  return {
    id,
    label,
    aliases: [],
    description: `${label} concept`,
    noteIds: canonicalNoteId ? [canonicalNoteId] : [],
    canonicalNoteId,
    autoLink: true,
    color: "#8798ff",
  };
}
