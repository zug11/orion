import { describe, expect, it } from "vitest";
import type { Concept, Note } from "../types";
import {
  ensureCanonicalConceptPhrase,
  reconcileConceptVocabulary,
  registerConceptPhrase,
} from "./concepts";

const NOW = "2026-07-27T10:00:00.000Z";

describe("reconcileConceptVocabulary", () => {
  it("repairs a pooled shared alias without swallowing note titles", () => {
    const notes = [
      makeNote("note-tracker", "VibeDB outreach tracker", {
        aliases: ["VibeDB"],
      }),
      makeNote("note-strategy", "VibeDB outreach strategy", {
        aliases: ["VibeDB"],
      }),
    ];
    const pooled = makeConcept("concept-vibedb", "VibeDB", [
      "note-tracker",
      "note-strategy",
    ]);
    pooled.aliases = [
      "VibeDB outreach tracker",
      "VibeDB outreach strategy",
    ];
    pooled.canonicalNoteId = "note-tracker";

    const result = reconcileConceptVocabulary(notes, [pooled]);
    const shared = result.concepts.find(
      (concept) => concept.label === "VibeDB",
    );
    const trackerTitle = result.concepts.find(
      (concept) => concept.label === "VibeDB outreach tracker",
    );
    const strategyTitle = result.concepts.find(
      (concept) => concept.label === "VibeDB outreach strategy",
    );

    expect(shared?.noteIds).toEqual(["note-tracker", "note-strategy"]);
    expect(shared?.aliases).not.toContain("VibeDB outreach tracker");
    expect(shared?.aliases).not.toContain("VibeDB outreach strategy");
    expect(shared?.canonicalNoteId).toBeUndefined();
    expect(trackerTitle?.noteIds).toEqual(["note-tracker"]);
    expect(strategyTitle?.noteIds).toEqual(["note-strategy"]);
    expect(result.notes[0].conceptIds).toEqual(
      expect.arrayContaining([shared!.id, trackerTitle!.id]),
    );
    expect(result.notes[1].conceptIds).toEqual(
      expect.arrayContaining([shared!.id, strategyTitle!.id]),
    );
  });

  it("promotes reusable aliases without treating organizational tags as concepts", () => {
    const notes = [
      makeNote("note-one", "Warm-route playbook", {
        aliases: ["warm evidence"],
        tags: ["founder-led-sales", "CRM"],
      }),
      makeNote("note-two", "Discovery call notes", {
        aliases: ["warm evidence"],
        tags: ["founder-led-sales"],
      }),
    ];

    const result = reconcileConceptVocabulary(notes, []);
    const sharedAlias = result.concepts.find(
      (concept) => concept.label === "warm evidence",
    );
    const conceptPhrases = result.concepts.flatMap((concept) => [
      concept.label.toLocaleLowerCase(),
      ...concept.aliases.map((alias) => alias.toLocaleLowerCase()),
    ]);

    expect(sharedAlias?.noteIds).toEqual(["note-one", "note-two"]);
    expect(conceptPhrases).not.toContain("founder-led-sales");
    expect(conceptPhrases).not.toContain("founder led sales");
    expect(conceptPhrases).not.toContain("crm");
  });

  it("is idempotent and keeps title concepts stable across reconciliation", () => {
    const notes = [makeNote("note-one", "A durable title")];
    const first = reconcileConceptVocabulary(notes, []);
    const second = reconcileConceptVocabulary(first.notes, first.concepts);

    expect(second).toEqual(first);
  });

  it("updates a managed title concept on rename and keeps the old title as an alias", () => {
    const initial = reconcileConceptVocabulary(
      [makeNote("note-one", "Old title")],
      [],
    );
    const renamedNote = {
      ...initial.notes[0],
      title: "New title",
    };
    const renamed = reconcileConceptVocabulary(
      [renamedNote],
      initial.concepts,
    );
    const canonical = renamed.concepts.find(
      (concept) => concept.canonicalNoteId === "note-one",
    );

    expect(canonical?.label).toBe("New title");
    expect(canonical?.aliases).toContain("Old title");
  });
});

describe("registerConceptPhrase", () => {
  it("creates one durable concept and reuses it for additional destinations", () => {
    const notes = [
      makeNote("note-one", "First note"),
      makeNote("note-two", "Second note"),
    ];
    const first = registerConceptPhrase(notes, [], {
      phrase: "warm evidence",
      noteIds: ["note-one"],
    });
    const second = registerConceptPhrase(first.notes, first.concepts, {
      phrase: "Warm evidence",
      noteIds: ["note-two"],
    });

    const matches = second.concepts.filter((concept) =>
      [concept.label, ...concept.aliases].some(
        (phrase) => phrase.toLocaleLowerCase() === "warm evidence",
      ),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].noteIds).toEqual(["note-one", "note-two"]);
    expect(second.notes[0].conceptIds).toContain(matches[0].id);
    expect(second.notes[1].conceptIds).toContain(matches[0].id);
  });

  it("keeps a title phrase canonical after adding another destination", () => {
    const notes = [
      makeNote("note-one", "Warm evidence"),
      makeNote("note-two", "Second note"),
    ];
    const initial = reconcileConceptVocabulary(notes, []);
    const linked = registerConceptPhrase(initial.notes, initial.concepts, {
      phrase: "Warm evidence",
      noteIds: ["note-two"],
    });
    const rerun = reconcileConceptVocabulary(
      linked.notes,
      linked.concepts,
    );
    const linkable = rerun.concepts.filter(
      (concept) =>
        concept.autoLink &&
        concept.label.toLocaleLowerCase() === "warm evidence",
    );

    expect(linkable).toHaveLength(1);
    expect(linkable[0]).toMatchObject({
      noteIds: ["note-one"],
      canonicalNoteId: "note-one",
    });
  });

  it("uses one branching concept when two notes share an exact title", () => {
    const notes = [
      makeNote("note-one", "Decision log"),
      makeNote("note-two", "Decision log"),
    ];
    const result = reconcileConceptVocabulary(notes, []);
    const linkable = result.concepts.filter(
      (concept) => concept.autoLink && concept.label === "Decision log",
    );

    expect(linkable).toHaveLength(1);
    expect(linkable[0].noteIds).toEqual(["note-one", "note-two"]);
    expect(result.notes[0].conceptIds).toContain(linkable[0].id);
    expect(result.notes[1].conceptIds).toContain(linkable[0].id);
  });

  it("preserves an unlink choice and re-enables it when taught again", () => {
    const initial = reconcileConceptVocabulary(
      [makeNote("note-sql", "SQL", { kind: "wiki" })],
      [],
    );
    const concept = initial.concepts.find(
      (candidate) => candidate.canonicalNoteId === "note-sql",
    )!;
    const disabled = reconcileConceptVocabulary(initial.notes, [
      { ...concept, autoLink: false },
    ]);

    expect(
      disabled.concepts.find((candidate) => candidate.id === concept.id)
        ?.autoLink,
    ).toBe(false);

    const relinked = registerConceptPhrase(
      disabled.notes,
      disabled.concepts,
      {
        phrase: "SQL",
        noteIds: ["note-sql"],
      },
    );
    expect(
      relinked.concepts.find((candidate) => candidate.id === concept.id)
        ?.autoLink,
    ).toBe(true);
  });
});

describe("ensureCanonicalConceptPhrase", () => {
  it("creates a supplied draft wiki article for a new phrase", () => {
    const candidate = makeNote("note-sql", "SQL", {
      kind: "wiki",
      status: "draft",
      tags: ["wiki-article"],
    });

    const result = ensureCanonicalConceptPhrase([], [], {
      phrase: "SQL",
      candidateArticle: candidate,
    });

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toMatchObject({
      id: "note-sql",
      title: "SQL",
      kind: "wiki",
      status: "draft",
    });
    expect(
      result.concepts.find((concept) => concept.id === result.conceptId),
    ).toMatchObject({
      label: "SQL",
      noteIds: ["note-sql"],
      canonicalNoteId: "note-sql",
    });
  });

  it("reuses an exact-title article without creating a duplicate", () => {
    const existing = makeNote("note-sql", "SQL", { kind: "wiki" });
    const result = ensureCanonicalConceptPhrase([existing], [], {
      phrase: "SQL",
      candidateArticle: makeNote("note-unused", "SQL", { kind: "wiki" }),
    });

    expect(result.notes.map((note) => note.id)).toEqual(["note-sql"]);
    expect(
      result.concepts.find((concept) => concept.id === result.conceptId),
    ).toMatchObject({
      canonicalNoteId: "note-sql",
      noteIds: ["note-sql"],
    });
  });

  it("reuses a canonical concept when the phrase is one of its aliases", () => {
    const note = makeNote("note-sql", "SQL", {
      kind: "wiki",
      aliases: ["Structured Query Language"],
    });
    const concept = makeConcept("concept-sql", "SQL", ["note-sql"]);
    concept.aliases = ["Structured Query Language"];
    concept.canonicalNoteId = "note-sql";

    const result = ensureCanonicalConceptPhrase([note], [concept], {
      phrase: "Structured Query Language",
      candidateArticle: makeNote(
        "note-unused",
        "Structured Query Language",
        { kind: "wiki" },
      ),
    });

    expect(result.conceptId).toBe("concept-sql");
    expect(result.notes.some((candidate) => candidate.id === "note-unused")).toBe(
      false,
    );
  });

  it("preserves an existing ambiguous concept instead of inventing an article", () => {
    const notes = [
      makeNote("note-language", "Orion language"),
      makeNote("note-spacecraft", "Orion spacecraft"),
    ];
    const concept = makeConcept("concept-orion", "Orion", [
      "note-language",
      "note-spacecraft",
    ]);

    const result = ensureCanonicalConceptPhrase(notes, [concept], {
      phrase: "Orion",
      candidateArticle: makeNote("note-unused", "Orion", { kind: "wiki" }),
    });
    const preserved = result.concepts.find(
      (candidate) => candidate.id === result.conceptId,
    );

    expect(result.conceptId).toBe("concept-orion");
    expect(preserved?.noteIds).toEqual(["note-language", "note-spacecraft"]);
    expect(preserved?.canonicalNoteId).toBeUndefined();
    expect(result.notes.some((note) => note.id === "note-unused")).toBe(false);
  });
});

function makeNote(
  id: string,
  title: string,
  overrides: Partial<Note> = {},
): Note {
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary: `${title} summary`,
    body: "",
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeConcept(
  id: string,
  label: string,
  noteIds: string[],
): Concept {
  return {
    id,
    label,
    aliases: [],
    description: "",
    noteIds,
    color: "#8ea4ff",
    autoLink: true,
  };
}
