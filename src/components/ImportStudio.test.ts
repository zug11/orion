import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type {
  Concept,
  Note,
  OrganizeContentResult,
  OrganizedWikiArticle,
  ParsedImport,
} from "../types";
import {
  buildImportOrganizationInstructions,
  buildImportPayload,
  classifyImportUrl,
  pastedTextToParsedImport,
  replaceImportItem,
  settleImportItem,
  type ImportItem,
  type OrganizedSource,
} from "./ImportStudio";

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

  it("preserves pasted text in the manual import note and source", () => {
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
    expect(payload.notes[0]).toMatchObject({
      kind: "article",
      status: "ready",
    });
    expect(payload.notes[0].tags).not.toContain("ai-draft");
  });

  it("keeps the complete source record when the editable note is a bounded preview", () => {
    const snapshot = createEmptySnapshot("Manual Space", TEST_NOW);
    const text = `${"A".repeat(200_000)}SOURCE_TAIL`;
    const parsed = makeParsedImport(
      "Long pasted notes",
      "long-pasted-notes.txt",
      text,
    );

    const payload = buildImportPayload(
      [makeOrganizedSource("import-long-paste", parsed)],
      snapshot,
    );

    expect(payload.sources[0].text).toBe(text);
    const previewBody = payload.notes[0].body;
    const heading = "# Long pasted notes\n\n";
    expect(previewBody.startsWith(heading)).toBe(true);
    expect(previewBody.slice(heading.length)).toHaveLength(200_000);
    expect(previewBody).not.toContain("SOURCE_TAIL");
  });

  it("persists batch guidance on every source", () => {
    const snapshot = createEmptySnapshot("Guided Space", TEST_NOW);
    const guidance =
      "Focus on the disputed claims, preserve examples, and extract explicit tasks.";
    const payload = buildImportPayload(
      [
        makeOrganizedSource(
          "import-one",
          makeParsedImport("First source", "first.md", "First source body."),
        ),
        makeOrganizedSource(
          "import-two",
          makeParsedImport("Second source", "second.md", "Second source body."),
        ),
      ],
      snapshot,
      guidance,
    );

    expect(payload.sources).toHaveLength(2);
    expect(payload.sources.every((source) => source.importGuidance === guidance)).toBe(
      true,
    );
  });

  it("keeps one batch note while attaching every proven source", () => {
    const snapshot = createEmptySnapshot("Batch Space", TEST_NOW);
    const first = makeOrganizedSource(
      "item-one",
      makeParsedImport("First", "first.md", "First evidence."),
      {
        notes: [
          {
            title: "Shared finding",
            summary: "A finding grounded across the batch.",
            body: "# Shared finding\n\nIntegrated evidence.",
            tags: [],
            aliases: [],
            links: [],
          },
        ],
        wikiArticles: [],
        concepts: [],
        suggestedConnections: [],
      },
    );
    const second = makeOrganizedSource(
      "item-two",
      makeParsedImport("Second", "second.md", "Second evidence."),
      { notes: [], wikiArticles: [], concepts: [], suggestedConnections: [] },
    );
    const payload = buildImportPayload(
      [
        {
          ...first,
          provenance: [
            {
              kind: "note" as const,
              title: "Shared finding",
              sourceIds: ["item-one", "item-two"],
              evidenceReferences: [
                { kind: "source" as const, sourceId: "item-one" },
                { kind: "source" as const, sourceId: "item-two" },
              ],
            },
          ],
        },
        second,
      ],
      snapshot,
    );

    expect(payload.notes).toHaveLength(1);
    expect(payload.notes[0].sourceIds).toHaveLength(2);
    expect(payload.sources).toHaveLength(2);
    expect(payload.sources.every(({ noteIds }) => noteIds.length === 1)).toBe(
      true,
    );
    expect(payload.sources[0].noteIds[0]).toBe(payload.sources[1].noteIds[0]);
  });

  it("keeps every proven batch note beyond the legacy per-source slice", () => {
    const snapshot = createEmptySnapshot("Batch Space", TEST_NOW);
    const items: OrganizedSource[] = Array.from({ length: 12 }, (_, index) =>
      makeOrganizedSource(
        `item-${index + 1}`,
        makeParsedImport(
          `Source ${index + 1}`,
          `source-${index + 1}.md`,
          `Evidence ${index + 1}.`,
        ),
        { notes: [], wikiArticles: [], concepts: [], suggestedConnections: [] },
      ),
    );
    const notes = items.map((_, index) => ({
      title: `Finding ${index + 1}`,
      summary: `Finding ${index + 1}.`,
      body: `# Finding ${index + 1}\n\nGrounded evidence.`,
      tags: [],
      aliases: [],
      links: [],
    }));
    items[0] = {
      ...items[0],
      result: {
        notes,
        wikiArticles: [],
        concepts: [],
        suggestedConnections: [],
      },
      provenance: notes.map((note, index) => ({
        kind: "note" as const,
        title: note.title,
        sourceIds: [`item-${index + 1}`],
        evidenceReferences: [
          { kind: "source" as const, sourceId: `item-${index + 1}` },
        ],
      })),
    };

    const payload = buildImportPayload(items, snapshot);

    expect(payload.notes).toHaveLength(12);
    expect(payload.sources).toHaveLength(12);
    expect(payload.sources.every(({ noteIds }) => noteIds.length === 1)).toBe(
      true,
    );
  });

  it("rejects an oversized batch visibly instead of silently dropping notes", () => {
    const snapshot = createEmptySnapshot("Batch Space", TEST_NOW);
    const source = makeOrganizedSource(
      "item-one",
      makeParsedImport("Source", "source.md", "Evidence."),
    );
    const notes = Array.from({ length: 31 }, (_, index) => ({
      title: `Finding ${index + 1}`,
      summary: "Finding.",
      body: `# Finding ${index + 1}`,
      tags: [],
      aliases: [],
      links: [],
    }));

    expect(() =>
      buildImportPayload(
        [
          {
            ...source,
            result: {
              notes,
              wikiArticles: [],
              concepts: [],
              suggestedConnections: [],
            },
            provenance: notes.map((note) => ({
              kind: "note" as const,
              title: note.title,
              sourceIds: ["item-one"],
              evidenceReferences: [
                { kind: "source" as const, sourceId: "item-one" },
              ],
            })),
          },
        ],
        snapshot,
      ),
    ).toThrow(/more than 30 new notes/);
  });

  it("never defaults unresolved batch provenance to the first source", () => {
    const snapshot = createEmptySnapshot("Batch Space", TEST_NOW);
    const source = makeOrganizedSource(
      "item-one",
      makeParsedImport("Source", "source.md", "Evidence."),
      {
        notes: [
          {
            title: "Finding",
            summary: "Finding.",
            body: "# Finding",
            tags: [],
            aliases: [],
            links: [],
          },
        ],
        wikiArticles: [],
        concepts: [],
        suggestedConnections: [],
      },
    );

    expect(() =>
      buildImportPayload(
        [
          {
            ...source,
            provenance: [
              {
                kind: "note" as const,
                title: "Finding",
                sourceIds: ["missing-item"],
                evidenceReferences: [
                  { kind: "source" as const, sourceId: "missing-item" },
                ],
              },
            ],
          },
        ],
        snapshot,
      ),
    ).toThrow(/outside this import/);
  });
});

describe("buildImportOrganizationInstructions", () => {
  it("places this import's guidance before Orion's import rules", () => {
    const instructions = buildImportOrganizationInstructions(
      "Prioritise arguments against the central thesis.",
    );

    expect(instructions).toContain("User guidance for this import batch:");
    expect(instructions.indexOf("Prioritise arguments")).toBeLessThan(
      instructions.indexOf("Import-refresh requirement"),
    );
    expect(instructions.length).toBeLessThanOrEqual(2_000);
  });

  it("bounds long batch guidance independently of the Space preference", () => {
    const instructions = buildImportOrganizationInstructions("x".repeat(5_000));

    expect(instructions.length).toBeLessThanOrEqual(2_000);
    expect(instructions).toContain("Import-refresh requirement");
  });
});

describe("import queue helpers", () => {
  it("classifies public HTTPS pages and specific YouTube videos", () => {
    expect(classifyImportUrl("https://example.org/essay#section")).toEqual({
      kind: "webpage",
      url: "https://example.org/essay",
    });
    expect(
      classifyImportUrl("https://www.youtube.com/watch?v=orion"),
    ).toEqual({
      kind: "youtube",
      url: "https://www.youtube.com/watch?v=orion",
    });
  });

  it.each([
    "http://example.org/essay",
    "https://localhost/private",
    "https://127.0.0.1/private",
    "https://[::1]/private",
    "https://notes.internal/private",
    "https://youtube.com/",
  ])("rejects an unsafe or incomplete URL: %s", (url) => {
    expect(() => classifyImportUrl(url)).toThrow();
  });

  it("does not resurrect an item removed while preprocessing", () => {
    const parsed = makeParsedImport("Late page", "late.html", "Late body");
    const queue: ImportItem[] = [];

    expect(settleImportItem(queue, "deleted-item", { parsed })).toBe(queue);
    expect(
      replaceImportItem(queue, "deleted-item", [
        makeImportItem("replacement", parsed),
      ]),
    ).toBe(queue);
  });

  it("settles parsed text and bounds placeholder expansion", () => {
    const placeholder: ImportItem = {
      id: "pending-media",
      fileName: "Media",
      mimeType: "audio/video",
      byteSize: 0,
      status: "parsing",
      included: false,
    };
    const settled = settleImportItem([placeholder], placeholder.id, {
      parsed: makeParsedImport("Transcript", "transcript.md", "Body"),
    });
    expect(settled[0]).toMatchObject({
      status: "ready",
      included: true,
      fileName: "transcript.md",
    });

    const existing = [
      makeImportItem("one", makeParsedImport("One", "one.md", "One")),
      placeholder,
      makeImportItem("two", makeParsedImport("Two", "two.md", "Two")),
    ];
    const replacements = [
      makeImportItem("a", makeParsedImport("A", "a.md", "A")),
      makeImportItem("b", makeParsedImport("B", "b.md", "B")),
      makeImportItem("c", makeParsedImport("C", "c.md", "C")),
    ];
    expect(
      replaceImportItem(existing, placeholder.id, replacements, 4),
    ).toHaveLength(4);
  });

  it("turns pasted text into a UTF-8 source with an optional title", () => {
    const parsed = pastedTextToParsedImport("", "  Orion ✨  ");

    expect(parsed).toMatchObject({
      title: "Pasted notes",
      fileName: "pasted-notes.txt",
      text: "Orion ✨",
    });
    expect(parsed.byteSize).toBe(
      new TextEncoder().encode("Orion ✨").byteLength,
    );
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

function makeImportItem(id: string, parsed: ParsedImport): ImportItem {
  return {
    id,
    fileName: parsed.fileName,
    mimeType: parsed.mimeType,
    byteSize: parsed.byteSize,
    status: "ready",
    included: true,
    parsed,
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
