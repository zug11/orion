import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { AppSnapshot, Concept, Note } from "../types";
import {
  decorateAutoLinks,
  getBacklinks,
  getConceptReferences,
  makeExcerpt,
  markdownToPlainText,
  resolveConceptDestination,
  resolveWikiLink,
  searchWiki,
} from "./wiki";

const TEST_NOW = "2026-07-27T10:00:00.000Z";

describe("decorateAutoLinks", () => {
  const concepts = [
    makeConcept({
      id: "concept-orion-nebula",
      label: "Orion Nebula",
      noteIds: ["note-orion-nebula"],
    }),
    makeConcept({
      id: "concept-orion",
      label: "Orion",
      noteIds: [
        "note-orion-mythology",
        "note-orion-constellation",
        "note-orion-spacecraft",
      ],
    }),
    makeConcept({
      id: "concept-nasa",
      label: "NASA",
      noteIds: ["note-nasa"],
      matchCase: true,
    }),
  ];

  it("uses the longest matching concept phrase", () => {
    const segments = decorateAutoLinks(
      "The Orion Nebula sits within Orion.",
      concepts,
    );
    const links = segments.filter((segment) => segment.type === "concept");

    expect(links.map((link) => link.text)).toEqual(["Orion Nebula", "Orion"]);
    expect(links[0]).toMatchObject({
      conceptId: "concept-orion-nebula",
      ambiguous: false,
    });
    expect(links[1]).toMatchObject({
      conceptId: "concept-orion",
      ambiguous: true,
    });
  });

  it("leaves existing links, code, and URLs untouched", () => {
    const segments = decorateAutoLinks(
      "[Orion](https://example.com) `Orion` [[Orion]] https://orion.test Orion",
      concepts,
    );
    const links = segments.filter((segment) => segment.type === "concept");

    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("Orion");
  });

  it("honors a concept's case-sensitive setting", () => {
    const segments = decorateAutoLinks("NASA and nasa", concepts);
    const links = segments.filter((segment) => segment.type === "concept");

    expect(links.map((link) => link.text)).toEqual(["NASA"]);
  });

  it("normalizes repeated whitespace, dashes, and apostrophes", () => {
    const variants = [
      makeConcept({
        id: "concept-founder-led",
        label: "founder-led sales",
        noteIds: ["note-sales"],
      }),
      makeConcept({
        id: "concept-builders",
        label: "builders' notes",
        noteIds: ["note-builders"],
      }),
    ];
    const segments = decorateAutoLinks(
      "Founder‑led   sales improves builders’ notes.",
      variants,
    );
    const links = segments.filter((segment) => segment.type === "concept");

    expect(links.map((link) => link.text)).toEqual([
      "Founder‑led   sales",
      "builders’ notes",
    ]);
  });

  it("does not let a longer self-only phrase hide a shorter destination", () => {
    const overlapping = [
      makeConcept({
        id: "concept-system",
        label: "Warm evidence system",
        noteIds: ["note-current"],
      }),
      makeConcept({
        id: "concept-warm-evidence",
        label: "Warm evidence",
        noteIds: ["note-destination"],
      }),
    ];
    const links = decorateAutoLinks(
      "Warm evidence system",
      overlapping,
      { excludeNoteIdFromTargets: "note-current" },
    ).filter((segment) => segment.type === "concept");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      text: "Warm evidence",
      conceptId: "concept-warm-evidence",
    });
  });

  it("suppresses a canonical article's self-link", () => {
    const canonical = makeConcept({
      id: "concept-sql",
      label: "SQL",
      noteIds: ["note-sql"],
      canonicalNoteId: "note-sql",
    });

    expect(
      decorateAutoLinks("SQL", [canonical], {
        excludeNoteIdFromTargets: "note-sql",
      }),
    ).toEqual([
      {
        type: "text",
        text: "SQL",
        start: 0,
        end: 3,
      },
    ]);
  });
});

describe("wiki resolution", () => {
  const snapshot = createWikiFixture();

  it("opens a canonical wiki article directly while unresolved phrases branch", () => {
    const notes = [
      makeNote({
        id: "note-sql",
        title: "SQL",
        kind: "wiki",
      }),
      makeNote({
        id: "note-migration",
        title: "Database migration",
      }),
    ];
    const canonical = makeConcept({
      id: "concept-sql",
      label: "SQL",
      noteIds: ["note-sql", "note-migration"],
      canonicalNoteId: "note-sql",
    });
    const unresolved = makeConcept({
      id: "concept-unresolved-sql",
      label: "SQL",
      noteIds: ["note-sql", "note-migration"],
    });

    expect(resolveConceptDestination(canonical, notes)).toEqual({
      kind: "note",
      noteId: "note-sql",
    });
    expect(
      decorateAutoLinks("SQL", [canonical]).find(
        (segment) => segment.type === "concept",
      ),
    ).toMatchObject({
      targetNoteIds: ["note-sql", "note-migration"],
      ambiguous: false,
    });

    expect(resolveConceptDestination(unresolved, notes)).toEqual({
      kind: "connections",
      noteIds: ["note-sql", "note-migration"],
    });
    expect(
      decorateAutoLinks("SQL", [unresolved]).find(
        (segment) => segment.type === "concept",
      ),
    ).toMatchObject({
      ambiguous: true,
    });
  });

  it("resolves an ambiguous concept to every destination", () => {
    const resolution = resolveWikiLink(
      "[[Orion|the shared name]]",
      snapshot.notes,
      snapshot.concepts,
    );

    expect(resolution.kind).toBe("concept");
    expect(resolution.label).toBe("the shared name");
    expect(resolution.ambiguous).toBe(true);
    expect(resolution.noteIds).toEqual(
      expect.arrayContaining([
        "note-orion-mythology",
        "note-orion-constellation",
        "note-orion-spacecraft",
      ]),
    );
  });

  it("supports an explicit note namespace and slug", () => {
    const resolution = resolveWikiLink(
      "[[note:orion-the-constellation|winter sky]]",
      snapshot.notes,
      snapshot.concepts,
    );

    expect(resolution).toMatchObject({
      kind: "note",
      label: "winter sky",
      noteIds: ["note-orion-constellation"],
      ambiguous: false,
    });
  });
});

describe("wiki discovery helpers", () => {
  const snapshot = createWikiFixture();

  it("finds explicit and semantic backlinks", () => {
    const backlinks = getBacklinks("note-orion-spacecraft", snapshot);

    expect(backlinks.some((link) => link.noteId === "note-artemis-program")).toBe(
      true,
    );
    expect(backlinks.some((link) => link.noteId === "note-orion-hub")).toBe(
      true,
    );
  });

  it("searches notes and ambiguous concepts together", () => {
    const results = searchWiki("Apollo", snapshot);

    expect(results[0].title).toBe("Apollo");
    expect(results[0]).toMatchObject({
      kind: "concept",
      noteIds: ["note-apollo-god", "note-apollo-program"],
    });
    expect(results.some((result) => result.title === "Apollo — lunar program")).toBe(
      true,
    );
  });

  it("does not duplicate a canonical wiki article as a concept result", () => {
    const canonicalSnapshot = createEmptySnapshot(
      "Canonical wiki",
      TEST_NOW,
    );
    canonicalSnapshot.notes = [
      makeNote({
        id: "note-sql",
        title: "SQL",
        kind: "wiki",
        summary: "Structured Query Language.",
      }),
      makeNote({
        id: "note-migration",
        title: "Database migration",
        body: "The migration uses SQL.",
      }),
    ];
    canonicalSnapshot.concepts = [
      makeConcept({
        id: "concept-sql",
        label: "SQL",
        noteIds: ["note-sql", "note-migration"],
        canonicalNoteId: "note-sql",
      }),
    ];

    const matches = searchWiki("SQL", canonicalSnapshot).filter(
      (result) => result.title === "SQL",
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      id: "note-sql",
      kind: "note",
      noteIds: ["note-sql"],
    });
  });

  it("keeps private lifecycle tags out of search and result labels", () => {
    const taggedSnapshot = createEmptySnapshot("Tags", TEST_NOW);
    taggedSnapshot.notes = [
      makeNote({
        id: "note-private-tag",
        title: "Research note",
        tags: ["ai-draft", "research"],
      }),
    ];

    expect(searchWiki("ai-draft", taggedSnapshot)).toEqual([]);
    expect(searchWiki("Research note", taggedSnapshot)[0].subtitle).toBe(
      "research",
    );
  });

  it("creates readable excerpts around a match", () => {
    const excerpt = makeExcerpt(
      "First sentence. A long discussion of Betelgeuse follows here. Last.",
      "Betelgeuse",
      12,
    );

    expect(excerpt).toContain("Betelgeuse");
    expect(excerpt.startsWith("…")).toBe(true);
  });

  it("removes Orion link targets from visible excerpts", () => {
    expect(
      markdownToPlainText(
        "[Vector clocks](orion-concept://concept_phrase_1ni96tt) keep ordering explicit.",
      ),
    ).toBe("Vector clocks keep ordering explicit.");
  });

  it("removes raw and editor-escaped wiki brackets from visible excerpts", () => {
    expect(
      markdownToPlainText(
        "[[Positivism]] and \\[\\[Auguste Comte\\]\\] belong in clean prose.",
      ),
    ).toBe("Positivism and Auguste Comte belong in clean prose.");
  });

  it("does not expose hidden frontmatter as concept references", () => {
    const concept = makeConcept({
      id: "concept-warm-evidence",
      label: "warm evidence",
      noteIds: ["note-target"],
    });
    const note = makeNote({
      id: "note-metadata",
      title: "Imported note",
      body: "---\ntopic: warm evidence\n---\n\nBody without the phrase.",
    });

    expect(
      getConceptReferences(concept.id, {
        notes: [note],
        concepts: [concept],
      }),
    ).toEqual([]);
  });
});

function createWikiFixture(): AppSnapshot {
  const snapshot = createEmptySnapshot("Test vault", TEST_NOW);
  snapshot.notes = [
    makeNote({
      id: "note-orion-mythology",
      title: "Orion — mythology",
    }),
    makeNote({
      id: "note-orion-constellation",
      title: "Orion — the constellation",
      slug: "orion-the-constellation",
    }),
    makeNote({
      id: "note-orion-spacecraft",
      title: "Orion — spacecraft",
      slug: "orion-spacecraft",
    }),
    makeNote({
      id: "note-orion-hub",
      title: "Orion",
      body: "Orion is a shared name with several meanings.",
    }),
    makeNote({
      id: "note-artemis-program",
      title: "Artemis program",
      body: "Artemis uses [[note:orion-spacecraft|the Orion spacecraft]].",
    }),
    makeNote({
      id: "note-apollo-god",
      title: "Apollo — deity",
    }),
    makeNote({
      id: "note-apollo-program",
      title: "Apollo — lunar program",
      body: "Apollo carried people to the Moon.",
    }),
  ];
  snapshot.concepts = [
    makeConcept({
      id: "concept-orion",
      label: "Orion",
      noteIds: [
        "note-orion-mythology",
        "note-orion-constellation",
        "note-orion-spacecraft",
      ],
    }),
    makeConcept({
      id: "concept-apollo",
      label: "Apollo",
      noteIds: ["note-apollo-god", "note-apollo-program"],
    }),
  ];
  return snapshot;
}

function makeNote(
  overrides: Pick<Note, "id" | "title"> & Partial<Note>,
): Note {
  return {
    id: overrides.id,
    title: overrides.title,
    slug: overrides.slug ?? overrides.id.replace(/^note-/, ""),
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
    color: overrides.color ?? "#8ea6ff",
    autoLink: overrides.autoLink ?? true,
    matchCase: overrides.matchCase,
    canonicalNoteId: overrides.canonicalNoteId,
  };
}
