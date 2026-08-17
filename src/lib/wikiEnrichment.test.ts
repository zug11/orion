// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type {
  Note,
  OrganizeContentResult,
  OrganizedWikiArticle,
} from "../types";
import {
  applyWikiEnrichmentResult,
  buildWikiEnrichmentRequest,
  hasSubstantiveKnowledgeNote,
} from "./wikiEnrichment";

const NOW = "2026-07-29T02:00:00.000Z";

describe("automatic wiki enrichment", () => {
  it("asks for every relevant existing wiki and no duplicate project note", () => {
    const snapshot = createEmptySnapshot("Sociology", NOW, "space-soc");
    const origin = makeNote({
      id: "note-lecture",
      title: "Week four lecture",
      body: "Comte framed positivism as a scientific approach to society.",
    });
    snapshot.notes = [
      makeNote({
        id: "note-project",
        title: "Project plan",
        body: "A non-wiki planning note.",
      }),
      makeNote({
        id: "note-positivism",
        title: "Positivism",
        kind: "wiki",
        body: "A carefully edited overview.",
      }),
      origin,
    ];

    const request = buildWikiEnrichmentRequest(snapshot, origin);

    expect(request.content).toContain(origin.body);
    expect(request.spaceName).toBe("Sociology");
    expect(request.taskInstructions).toContain(
      "return an empty notes array",
    );
    expect(request.taskInstructions).toContain(
      "compact directory records",
    );
    expect(request.taskInstructions).toContain(
      "never for a relabelled version, summary, plan, list, checklist, or paraphrase",
    );
    expect(request.taskInstructions).toContain(
      "never copy its task list into a wiki article",
    );
    expect(request.existingNotes?.[0].title).toBe("Positivism");
    expect(request.existingNotes?.[0].semanticSketch).toContain(
      "carefully edited overview",
    );
    expect(request.existingNotes?.[0]).not.toHaveProperty("body");
  });

  it("applies coherent integrated revisions and creates missing canonical articles", () => {
    const snapshot = createEmptySnapshot("Sociology", NOW, "space-soc");
    const origin = makeNote({
      id: "note-lecture",
      title: "Week four lecture",
      body: "Comte framed positivism as a scientific approach to society.",
      sourceIds: ["source-week-four"],
    });
    const positivism = makeNote({
      id: "note-positivism",
      title: "Positivism",
      kind: "wiki",
      body: "Keep this carefully edited overview.",
    });
    const unrelated = makeNote({
      id: "note-durkheim",
      title: "Émile Durkheim",
      kind: "wiki",
      body: "An unrelated existing article.",
    });
    snapshot.notes = [origin, positivism, unrelated];

    const applied = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([
        makeArticle(
          "Positivism",
          "The lecture presents positivism as an approach to society.",
        ),
        makeArticle(
          "Auguste Comte",
          "The lecture identifies Comte as a system-builder.",
        ),
      ]),
      "2026-07-29T02:05:00.000Z",
    );

    const updated = applied.snapshot.notes.find(
      (note) => note.id === positivism.id,
    );
    expect(updated?.body.startsWith(positivism.body)).toBe(false);
    expect(updated?.body).not.toContain("Context from");
    expect(updated?.body).toContain(
      "The lecture presents positivism as an approach to society.",
    );
    expect(updated?.sourceIds).toContain("source-week-four");
    expect(
      applied.snapshot.notes.find((note) => note.id === unrelated.id)?.body,
    ).toBe(unrelated.body);

    const created = applied.snapshot.notes.find(
      (note) => note.title === "Auguste Comte",
    );
    expect(created).toMatchObject({
      kind: "wiki",
      sourceIds: ["source-week-four"],
    });
    expect(created?.body).toContain("## In this Space");
    expect(applied.updatedNoteIds).toEqual(["note-positivism"]);
    expect(applied.createdNoteIds).toEqual([created?.id]);
  });

  it("replaces the whole integrated revision instead of stacking appendices", () => {
    const snapshot = createEmptySnapshot("Data", NOW, "space-data");
    const origin = makeNote({
      id: "note-query",
      title: "Query notes",
      body: "SQL uses declarative queries.",
    });
    snapshot.notes = [
      origin,
      makeNote({
        id: "note-sql",
        title: "SQL",
        kind: "wiki",
        body: "SQL overview.",
      }),
    ];
    const first = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([makeArticle("SQL", "First source detail.")]),
      "2026-07-29T02:05:00.000Z",
    );
    const second = applyWikiEnrichmentResult(
      first.snapshot,
      origin,
      makeResult([makeArticle("SQL", "Corrected source detail.")]),
      "2026-07-29T02:10:00.000Z",
    );
    const body =
      second.snapshot.notes.find((note) => note.id === "note-sql")?.body ??
      "";

    expect(body).not.toContain("First source detail.");
    expect(body).toContain("Corrected source detail.");
    expect(body).not.toContain("Context from");
  });

  it("does not recreate programmed context headings after a later revision", () => {
    const snapshot = createEmptySnapshot("Data", NOW, "space-data");
    const origin = makeNote({
      id: "note-query",
      title: "Query notes",
      body: "SQL uses declarative queries.",
    });
    snapshot.notes = [
      origin,
      makeNote({
        id: "note-sql",
        title: "SQL",
        kind: "wiki",
        body: "SQL overview.",
      }),
    ];
    const first = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([makeArticle("SQL", "First source detail.")]),
      "2026-07-29T02:05:00.000Z",
    );
    const editedSnapshot = {
      ...first.snapshot,
      notes: first.snapshot.notes.map((note) => ({
        ...note,
        body: note.body.replace(/^<!-- orion-note:[^\n]+ -->\n*/gm, ""),
      })),
    };
    const second = applyWikiEnrichmentResult(
      editedSnapshot,
      origin,
      makeResult([makeArticle("SQL", "Corrected source detail.")]),
      "2026-07-29T02:10:00.000Z",
    );
    const body =
      second.snapshot.notes.find((note) => note.id === "note-sql")?.body ??
      "";

    expect(body).not.toContain("First source detail.");
    expect(body).toContain("Corrected source detail.");
    expect(body).not.toContain("Context from");
  });

  it("rejects a generated shopping-list companion and leaves its source note untouched", () => {
    const snapshot = createEmptySnapshot("Life", NOW, "space-life");
    const origin = makeNote({
      id: "note-shopping",
      title: "Go shopping",
      body: [
        "Things I need this afternoon.",
        "",
        "- [ ] Buy milk",
        "- [ ] Pick up a prescription",
      ].join("\n"),
      status: "ready",
    });
    snapshot.notes = [origin];

    const applied = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([
        {
          ...makeArticle(
            "Shopping list",
            "- [ ] Buy milk\n- [ ] Pick up a prescription",
          ),
          body: [
            "## Shopping list",
            "",
            "- [ ] Buy milk",
            "- [ ] Pick up a prescription",
          ].join("\n"),
        },
      ]),
      "2026-07-29T02:05:00.000Z",
    );

    expect(applied.createdNoteIds).toEqual([]);
    expect(applied.updatedNoteIds).toEqual([]);
    expect(applied.snapshot.notes).toHaveLength(1);
    expect(applied.snapshot.notes[0]).toMatchObject({
      id: origin.id,
      title: origin.title,
      body: origin.body,
      kind: origin.kind,
      status: origin.status,
    });
  });

  it("never overwrites the originating note when the organizer echoes its title", () => {
    const snapshot = createEmptySnapshot("Writing", NOW, "space-writing");
    const origin = makeNote({
      id: "note-outline",
      title: "Essay outline",
      body: "A deliberately written outline with enough detail to be substantive.",
      status: "ready",
    });
    snapshot.notes = [origin];

    const applied = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([
        makeArticle("Essay outline", "An AI-authored replacement body."),
      ]),
      "2026-07-29T02:05:00.000Z",
    );

    expect(applied.snapshot.notes).toHaveLength(1);
    expect(applied.snapshot.notes[0]).toMatchObject({
      id: origin.id,
      body: origin.body,
      kind: origin.kind,
    });
    expect(applied.updatedNoteIds).toEqual([]);
    expect(applied.createdNoteIds).toEqual([]);
  });

  it("keeps tasks in their source note while integrating prose into an existing article", () => {
    const snapshot = createEmptySnapshot("Data", NOW, "space-data");
    const origin = makeNote({
      id: "note-query",
      title: "Query work",
      body: "SQL uses declarative queries.\n\n- [ ] Compare query plans",
    });
    snapshot.notes = [
      origin,
      makeNote({
        id: "note-sql",
        title: "SQL",
        kind: "wiki",
        body: "An existing SQL article.",
      }),
    ];
    const article = makeArticle(
      "SQL",
      "The note distinguishes declarative queries from execution plans.",
    );
    article.body = [
      "## Overview",
      "SQL is a declarative query language.",
      "",
      "## Tasks",
      "- [ ] Compare query plans",
      "",
      "## In this Space",
      "Execution plans are relevant to the current work.",
    ].join("\n");

    const applied = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([article]),
      "2026-07-29T02:05:00.000Z",
    );
    const updated = applied.snapshot.notes.find(
      (note) => note.id === "note-sql",
    );

    expect(updated?.body).toContain("SQL is a declarative query language.");
    expect(updated?.body).toContain("Execution plans are relevant");
    expect(updated?.body).not.toContain("Compare query plans");
    expect(updated?.body).not.toContain("## Tasks");
    expect(
      applied.snapshot.notes.find((note) => note.id === origin.id)?.body,
    ).toContain("- [ ] Compare query plans");
  });

  it("skips a same-title ordinary note instead of rewriting it or creating a duplicate", () => {
    const snapshot = createEmptySnapshot("Data", NOW, "space-data");
    const origin = makeNote({
      id: "note-query",
      title: "Query lecture",
      body: "SQL uses declarative queries and relational tables.",
    });
    const manualSql = makeNote({
      id: "note-sql",
      title: "SQL",
      kind: "article",
      body: "My own carefully written SQL note.",
      status: "ready",
    });
    snapshot.notes = [origin, manualSql];

    const applied = applyWikiEnrichmentResult(
      snapshot,
      origin,
      makeResult([
        makeArticle("SQL", "An AI-authored replacement body."),
      ]),
      "2026-07-29T02:05:00.000Z",
    );

    expect(applied.snapshot.notes).toHaveLength(2);
    expect(
      applied.snapshot.notes.find((note) => note.id === manualSql.id),
    ).toMatchObject({
      body: manualSql.body,
      kind: manualSql.kind,
    });
    expect(applied.updatedNoteIds).toEqual([]);
    expect(applied.createdNoteIds).toEqual([]);
  });

  it("only refreshes substantive non-wiki notes", () => {
    expect(
      hasSubstantiveKnowledgeNote(
        makeNote({ title: "Untitled note", body: "A long draft body." }),
      ),
    ).toBe(false);
    expect(
      hasSubstantiveKnowledgeNote(
        makeNote({
          title: "SQL",
          kind: "wiki",
          body: "A long canonical article body.",
        }),
      ),
    ).toBe(false);
    expect(
      hasSubstantiveKnowledgeNote(
        makeNote({
          title: "Database lecture",
          body: "SQL is a declarative language used to query relational data.",
        }),
      ),
    ).toBe(true);
  });
});

function makeResult(
  wikiArticles: OrganizedWikiArticle[],
): OrganizeContentResult {
  return {
    notes: [],
    wikiArticles,
    concepts: wikiArticles.map((article) => ({
      label: article.title,
      aliases: article.aliases,
      description: article.summary,
      canonicalTitle: article.title,
      relatedTitles: [],
    })),
    suggestedConnections: [],
  };
}

function makeArticle(
  title: string,
  detail: string,
): OrganizedWikiArticle {
  return {
    title,
    summary: `A canonical article about ${title}.`,
    body: [
      "## Overview",
      `${title} is a durable concept.`,
      "## In this Space",
      `${title} matters to this Space. ${detail}`,
    ].join("\n\n"),
    overview: `${title} is a durable concept.`,
    spaceRelevance: `${title} matters to this Space.`,
    sourceGroundedDetails: [detail],
    uncertainties: [],
    tags: ["concept"],
    aliases: [],
    links: [],
  };
}

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: overrides.id ?? "note-default",
    title: overrides.title ?? "A note",
    slug: overrides.slug ?? "a-note",
    summary: overrides.summary ?? "",
    body: overrides.body ?? "",
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    kind: overrides.kind ?? "article",
    status: overrides.status ?? "draft",
    conceptIds: overrides.conceptIds ?? [],
    sourceIds: overrides.sourceIds ?? [],
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    color: overrides.color,
  };
}
