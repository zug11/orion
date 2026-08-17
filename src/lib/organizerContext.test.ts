// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, OrganizedWikiArticle } from "../types";
import {
  buildCompactOrganizerContext,
  compactOrganizerContextBytes,
  MAX_COMPACT_ORGANIZER_CONTEXT_BYTES,
  mergeGeneratedOrganizerArticles,
} from "./organizerContext";

const NOW = "2026-08-13T04:00:00.000Z";

describe("compact organizer context", () => {
  it("builds a deterministic semantic directory without note bodies", () => {
    const snapshot = createEmptySnapshot("Ideas", NOW, "space-ideas");
    const note = makeNote({
      id: "note-dialectic",
      title: "Dialectic",
      summary: "A compact summary of dialectical development.",
      body: [
        "# Dialectic",
        "Beginning evidence about an unfolding argument. ".repeat(20),
        "## Mediation",
        "Middle evidence about mediation and determinate negation. ".repeat(20),
        "## Consequence",
        "Closing evidence about the result retained at the end.",
      ].join("\n\n"),
      tags: ["philosophy"],
    });
    snapshot.notes = [note];

    const first = buildCompactOrganizerContext(snapshot, {
      matchText: "dialectical mediation",
    });
    const second = buildCompactOrganizerContext(snapshot, {
      matchText: "dialectical mediation",
    });

    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(first?.[0]).toMatchObject({
      id: note.id,
      title: note.title,
      headings: ["Dialectic", "Mediation", "Consequence"],
      bodyCharacters: note.body.length,
    });
    expect(first?.[0].version).toBeTruthy();
    expect(first?.[0].semanticSketch).toContain("Closing evidence");
    expect(first?.[0]).not.toHaveProperty("body");
  });

  it("contracts a large Space to graph anchors and positive semantic matches", () => {
    const snapshot = createEmptySnapshot("Data", NOW, "space-data");
    const origin = makeNote({
      id: "note-origin",
      title: "Database lecture",
      body: "The lecture discusses SQL joins.",
    });
    const sql = makeNote({
      id: "note-sql",
      title: "SQL",
      summary: "Relational queries and joins.",
      kind: "wiki",
    });
    const graphAnchor = makeNote({
      id: "note-anchor",
      title: "Explicitly connected note",
      summary: "A graph neighbour with different vocabulary.",
    });
    snapshot.notes = [
      origin,
      sql,
      graphAnchor,
      ...Array.from({ length: 90 }, (_, index) =>
        makeNote({
          id: `note-unrelated-${index}`,
          title: `Unrelated archive ${index}`,
          summary: "Material about ceramics and pigment.",
        }),
      ),
    ];
    snapshot.relationships = [
      {
        id: "relationship-anchor",
        fromNoteId: origin.id,
        toNoteId: graphAnchor.id,
        kind: "related",
        label: "explicit context",
        strength: 0.8,
      },
    ];

    const contexts = buildCompactOrganizerContext(snapshot, {
      focusNoteIds: [origin.id],
      excludeNoteIds: [origin.id],
      matchText: "SQL joins",
    });
    const ids = contexts?.map(({ id }) => id);

    expect(ids).toContain(sql.id);
    expect(ids).toContain(graphAnchor.id);
    expect(ids?.some((id) => id.startsWith("note-unrelated"))).toBe(false);
  });

  it("enforces a serialized byte budget instead of a first-N note rule", () => {
    const snapshot = createEmptySnapshot("Dense", NOW, "space-dense");
    snapshot.notes = Array.from({ length: 70 }, (_, index) =>
      makeNote({
        id: `note-${index}`,
        title: `Dense note ${index}`,
        summary: `${String(index).padStart(2, "0")} ${"summary ".repeat(100)}`,
        body: `${"whole body detail ".repeat(100)} ending ${index}`,
      }),
    );

    const contexts = buildCompactOrganizerContext(snapshot);

    expect(contexts).toBeDefined();
    expect(contexts!.length).toBeLessThan(snapshot.notes.length);
    expect(compactOrganizerContextBytes(contexts!)).toBeLessThanOrEqual(
      MAX_COMPACT_ORGANIZER_CONTEXT_BYTES,
    );
    expect(contexts?.every((context) => context.body === undefined)).toBe(true);
  });

  it("honors disabled existing-note context", () => {
    const snapshot = createEmptySnapshot("Private", NOW, "space-private");
    snapshot.notes = [makeNote({ id: "note-private", title: "Private" })];
    snapshot.settings.includeExistingNotesInAIContext = false;

    expect(buildCompactOrganizerContext(snapshot, { matchText: "Private" })).toBeUndefined();
  });

  it("carries generated batch articles forward as compact priority records", () => {
    const existing = [
      {
        id: "note-sql",
        title: "SQL",
        aliases: ["Structured Query Language"],
        summary: "Old compact description.",
        reference: true,
      },
    ];
    const article = makeArticle({
      title: "SQL",
      summary: "Updated compact description.",
      body: "# SQL\n\nSQL is declarative.\n\n## Joins\n\nJoins combine relations.",
    });

    const merged = mergeGeneratedOrganizerArticles(existing, [article]);

    expect(merged).toHaveLength(1);
    expect(merged?.[0]).toMatchObject({
      id: "note-sql",
      summary: "Updated compact description.",
      headings: ["SQL", "Joins"],
      reference: true,
    });
    expect(merged?.[0]).not.toHaveProperty("body");
  });
});

function makeNote(overrides: Partial<Note> & Pick<Note, "id" | "title">): Note {
  const { id, title, ...rest } = overrides;
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary: "",
    body: "A substantive local note body.",
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
  };
}

function makeArticle(
  overrides: Partial<OrganizedWikiArticle> & Pick<OrganizedWikiArticle, "title">,
): OrganizedWikiArticle {
  const { title, ...rest } = overrides;
  return {
    title,
    summary: "",
    body: "",
    overview: "",
    spaceRelevance: "",
    sourceGroundedDetails: [],
    uncertainties: [],
    tags: [],
    aliases: [],
    links: [],
    ...rest,
  };
}
