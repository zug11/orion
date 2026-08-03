import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type {
  Concept,
  Note,
  OrganizeContentResult,
  OrganizedWikiArticle,
  ParsedImport,
} from "../types";
import { buildImportPayload } from "./ImportStudio";

const TEST_NOW = "2026-07-27T10:00:00.000Z";

describe("buildImportPayload", () => {
  it("reuses one canonical wiki article and applies the latest integrated body", () => {
    const snapshot = createEmptySnapshot("Research Space", TEST_NOW);
    const originalBody =
      "# SQL\n\n## Existing knowledge\n\nKeep this carefully edited paragraph.";
    snapshot.notes = [
      makeNote({
        id: "note-sql",
        title: "SQL",
        slug: "sql",
        body: originalBody,
        kind: "wiki",
      }),
    ];
    snapshot.concepts = [
      makeConcept({
        id: "concept-sql",
        label: "SQL",
        noteIds: ["note-sql"],
        canonicalNoteId: "note-sql",
      }),
    ];

    const payload = buildImportPayload(
      [
        makeOrganizedSource(
          "import-architecture",
          makeParsedImport(
            "Architecture interview",
            "architecture-interview.md",
            "The service stores customer records in SQL.",
          ),
          makeOrganizeResult(
            "Architecture interview notes",
            makeWikiArticle(
              "SQL",
              "SQL supports the service's durable records.",
            ),
          ),
        ),
        makeOrganizedSource(
          "import-migration",
          makeParsedImport(
            "Migration memo",
            "migration-memo.md",
            "The migration retains SQL for reporting.",
          ),
          makeOrganizeResult(
            "Migration memo notes",
            makeWikiArticle(
              "SQL",
              "SQL remains the reporting interface after migration.",
            ),
          ),
        ),
      ],
      snapshot,
    );

    const sqlNotes = payload.notes.filter((note) => note.id === "note-sql");
    expect(sqlNotes).toHaveLength(1);
    expect(sqlNotes[0].createdAt).toBe(TEST_NOW);
    expect(sqlNotes[0].body.startsWith(originalBody)).toBe(false);
    expect(sqlNotes[0].body).not.toContain("Context from");
    expect(sqlNotes[0].body).toContain(
      "SQL remains the reporting interface after migration.",
    );
    expect(sqlNotes[0].sourceIds).toHaveLength(2);

    for (const source of payload.sources) {
      expect(source.noteIds.filter((noteId) => noteId === "note-sql")).toEqual([
        "note-sql",
      ]);
    }

    const sqlConcepts = payload.concepts.filter(
      (concept) =>
        concept.autoLink &&
        concept.label.toLocaleLowerCase() === "sql",
    );
    expect(sqlConcepts).toHaveLength(1);
    expect(sqlConcepts[0]).toMatchObject({
      canonicalNoteId: "note-sql",
      noteIds: ["note-sql"],
    });
  });

  it("preserves pasted text in the manual import draft and source", () => {
    const snapshot = createEmptySnapshot("Manual Space", TEST_NOW);
    const text =
      "The first paragraph stays intact.\n\n- A preserved list item";
    const parsed = makeParsedImport(
      "Pasted field notes",
      "pasted-notes.txt",
      text,
    );

    const payload = buildImportPayload(
      [makeOrganizedSource("import-paste", parsed)],
      snapshot,
    );

    expect(payload.notes).toHaveLength(1);
    expect(payload.notes[0].body).toBe(
      `# Pasted field notes\n\n${text}`,
    );
    expect(payload.sources).toHaveLength(1);
    expect(payload.sources[0].text).toBe(text);
    expect(payload.sources[0].noteIds).toEqual([payload.notes[0].id]);
  });
});

function makeOrganizedSource(
  id: string,
  parsed: ParsedImport,
  result?: OrganizeContentResult,
) {
  return {
    item: {
      id,
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      byteSize: parsed.byteSize,
      status: "ready" as const,
      included: true,
      parsed,
    },
    result,
  };
}

function makeParsedImport(
  title: string,
  fileName: string,
  text: string,
): ParsedImport {
  return {
    title,
    fileName,
    mimeType: "text/markdown",
    format: "markdown",
    byteSize: text.length,
    text,
    warnings: [],
  };
}

function makeOrganizeResult(
  noteTitle: string,
  article: OrganizedWikiArticle,
): OrganizeContentResult {
  return {
    notes: [
      {
        title: noteTitle,
        summary: `${noteTitle} summary`,
        body: `# ${noteTitle}`,
        tags: ["imported"],
        aliases: [],
        links: [],
      },
    ],
    wikiArticles: [article],
    concepts: [
      {
        label: article.title,
        aliases: article.aliases,
        description: article.summary,
        canonicalTitle: article.title,
        relatedTitles: [],
      },
    ],
    suggestedConnections: [],
  };
}

function makeWikiArticle(
  title: string,
  detail: string,
): OrganizedWikiArticle {
  return {
    title,
    summary: "Structured Query Language.",
    body: `## Overview\n\nSQL is a language for relational data.\n\n## In this Space\n\n${detail}`,
    overview: "SQL is a language for relational data.",
    spaceRelevance: "It is part of the imported system design.",
    sourceGroundedDetails: [detail],
    uncertainties: [],
    tags: ["databases"],
    aliases: ["Structured Query Language"],
    links: [],
  };
}

function makeNote(
  overrides: Pick<Note, "id" | "title"> & Partial<Note>,
): Note {
  return {
    id: overrides.id,
    title: overrides.title,
    slug: overrides.slug ?? overrides.id,
    summary: overrides.summary ?? "",
    body: overrides.body ?? "",
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    kind: overrides.kind ?? "article",
    status: overrides.status ?? "ready",
    conceptIds: overrides.conceptIds ?? [],
    sourceIds: overrides.sourceIds ?? [],
    createdAt: overrides.createdAt ?? TEST_NOW,
    updatedAt: overrides.updatedAt ?? TEST_NOW,
  };
}

function makeConcept(
  overrides: Pick<Concept, "id" | "label" | "noteIds"> & Partial<Concept>,
): Concept {
  return {
    id: overrides.id,
    label: overrides.label,
    aliases: overrides.aliases ?? [],
    description: overrides.description ?? "",
    noteIds: overrides.noteIds,
    canonicalNoteId: overrides.canonicalNoteId,
    color: overrides.color ?? "#8ea6ff",
    autoLink: overrides.autoLink ?? true,
    matchCase: overrides.matchCase,
  };
}
