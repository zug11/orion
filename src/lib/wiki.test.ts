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

  it("hides table layout comments from connection excerpts and wiki search", () => {
    const metadata = '<!-- orion-table:v1 {"width":65,"header":true} -->';
    const body = `${metadata}\n| Material | Finding |\n| --- | --- |\n| Glass | Clear |`;
    const snapshot = createEmptySnapshot("Tables", TEST_NOW);
    snapshot.notes = [makeNote({ id: "note-table", title: "Table", body })];
    expect(markdownToPlainText(body)).not.toContain("orion-table");
    expect(makeExcerpt(body)).toContain("Material");
    expect(searchWiki("orion-table", snapshot)).toEqual([]);
    expect(markdownToPlainText(`Literal example: \`${metadata}\``)).toContain("orion-table:v1");
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

describe("automatic link matching at scale", () => {
  const linkConcept = (id: string, label: string, extra: Partial<Concept> = {}): Concept => ({
    id, label, aliases: [], description: "", noteIds: [`note-${id}`], canonicalNoteId: `note-${id}`,
    color: "#000", autoLink: true, ...extra,
  });
  const links = (text: string, concepts: readonly Concept[]) =>
    decorateAutoLinks(text, concepts)
      .filter((segment) => segment.type === "concept")
      .map((segment) => `${segment.start}-${segment.end}:${segment.conceptId}`);

  // The rules, stated directly and without any index: at each position, the
  // first phrase in preference order whose own pattern matches there, respects
  // word boundaries and case, and stays out of protected Markdown.
  const WORD = /[\p{L}\p{N}_]/u;
  const PROTECTED = [/```[\s\S]*?```/g, /`[^`\n]*`/g, /!?\[[^\]\n]*\]\([^)\n]+\)/g, /\[\[[^\]\n]+\]\]/g, /\b(?:https?:\/\/|mailto:)[^\s<]+/gi];
  const normalized = (value: string) => value.normalize("NFKC").replace(/[‐‑‒–—−]/g, "-").replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const phrasePattern = (phrase: string) => [...phrase.trim()].map((character, index, all) =>
    /\s/u.test(character) ? (index > 0 && /\s/u.test(all[index - 1]) ? "" : "\\s+")
      : /[‐‑‒–—−-]/u.test(character) ? "[‐‑‒–—−-]"
      : /['‘’]/u.test(character) ? "['‘’]"
      : character.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join("");
  function oracle(text: string, concepts: readonly Concept[]): string[] {
    const candidates = concepts.filter((item) => item.autoLink).flatMap((item) => {
      const seen = new Set<string>();
      return [item.label, ...item.aliases].flatMap((raw, index) => {
        const phrase = raw.trim();
        if (!phrase || seen.has(normalized(phrase))) return [];
        seen.add(normalized(phrase));
        return [{ phrase, concept: item, isLabel: index === 0, pattern: new RegExp(phrasePattern(phrase), "iuy") }];
      });
    }).sort((a, b) => b.phrase.length - a.phrase.length || Number(b.isLabel) - Number(a.isLabel) || a.phrase.localeCompare(b.phrase));
    const ranges = PROTECTED.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length] as const));
    const found: string[] = [];
    for (let index = 0; index < text.length;) {
      const inside = ranges.find(([start, end]) => index >= start && index < end);
      if (inside) { index = inside[1]; continue; }
      const match = candidates.map((candidate) => {
        candidate.pattern.lastIndex = index;
        const hit = candidate.pattern.exec(text);
        if (!hit) return null;
        const end = index + hit[0].length;
        const value = text.slice(index, end);
        if (ranges.some(([start, stop]) => index < stop && end > start)) return null;
        if (candidate.concept.matchCase ? value !== candidate.phrase : normalized(value) !== normalized(candidate.phrase)) return null;
        const before = index > 0 ? text[index - 1] : "", after = end < text.length ? text[end] : "";
        if (WORD.test(candidate.phrase[0]) && before && WORD.test(before)) return null;
        if (WORD.test(candidate.phrase[candidate.phrase.length - 1]) && after && WORD.test(after)) return null;
        return { end, id: candidate.concept.id };
      }).find(Boolean);
      if (match) { found.push(`${index}-${match.end}:${match.id}`); index = match.end; } else index += 1;
    }
    return found;
  }

  it("falls back to a shorter phrase when a longer one fails its word boundary", () => {
    const concepts = [linkConcept("soa", "state of the art"), linkConcept("state", "state")];
    expect(links("The state of the artist matters.", concepts)).toEqual(["4-9:state"]);
    expect(links("The state of the art matters.", concepts)).toEqual(["4-20:soa"]);
  });

  it("matches phrases that begin or end with symbols and shares opening words", () => {
    const concepts = [
      linkConcept("cpp", "C++"), linkConcept("net", ".NET"), linkConcept("us", "U.S. policy"),
      linkConcept("ny", "New York"), linkConcept("nyu", "New York University"), linkConcept("yu", "York University"),
    ];
    expect(links("Vitamin C, then C++ and .NET.", concepts)).toEqual(["16-19:cpp", "24-28:net"]);
    expect(links("u.s.   POLICY on New\nYork University and New York.", concepts)).toEqual(["0-13:us", "17-36:nyu", "41-49:ny"]);
    expect(links("Old York University", concepts)).toEqual(["4-19:yu"]);
  });

  it("agrees with the plain rules on thousands of generated notes", () => {
    let seed = 20261115;
    const random = () => { seed = (seed + 0x6d2b79f5) | 0; let value = Math.imul(seed ^ (seed >>> 15), 1 | seed); value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value; return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const words = ["state", "of", "the", "art", "New", "York", "University", "e-mail", "rock'n'roll", "C++", ".NET", "U.S.", "policy", "naïve", "Bayes", "Ω", "point", "résumé", "dialectic", "Über", "form", "a", "x_1", "42"];
    const separators = [" ", " ", " ", "  ", "\n", "-", "–", "'", "’", ", ", ". ", "/", "(", ")", ""];
    const wrappers = [(value: string) => value, (value: string) => value, (value: string) => value.toUpperCase(), (value: string) => value.toLowerCase(),
      (value: string) => `\`${value}\``, (value: string) => `[${value}](https://example.com/${value})`, (value: string) => `[[${value}]]`, (value: string) => `https://example.com/${value}`];
    const phrase = () => Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(words)).join(pick([" ", " ", "-", "'"]));
    let compared = 0;
    for (let round = 0; round < 1200; round += 1) {
      const concepts = Array.from({ length: 1 + Math.floor(random() * 14) }, (_, index) => linkConcept(`c${index}`, phrase(), {
        aliases: random() < 0.4 ? [phrase()] : [], matchCase: random() < 0.15, autoLink: random() > 0.1,
      }));
      const text = Array.from({ length: 4 + Math.floor(random() * 30) }, () => pick(wrappers)(random() < 0.5 ? phrase() : pick(words)) + pick(separators)).join("");
      expect(links(text, concepts), JSON.stringify({ text, concepts: concepts.map((item) => [item.label, item.aliases, item.matchCase, item.autoLink]) })).toEqual(oracle(text, concepts));
      compared += links(text, concepts).length;
    }
    // The generator really does produce links to compare.
    expect(compared).toBeGreaterThan(1200);
  });

  it("does not slow down as the vocabulary grows", () => {
    const vocabulary = "recognition dialectic consciousness freedom spirit negation sublation ethical life civil society state history reason absolute knowing master servant labour desire".split(" ");
    const concepts = Array.from({ length: 2_000 }, (_, index) => linkConcept(`c${index}`, `${vocabulary[index % vocabulary.length]} ${vocabulary[(index * 7) % vocabulary.length]} ${index}`));
    const paragraphs = Array.from({ length: 250 }, (_, index) => `The ${vocabulary[index % vocabulary.length]} of ${concepts[(index * 13) % concepts.length].label} returns here, as ${vocabulary[(index + 5) % vocabulary.length]} suggests.`);
    const pass = () => paragraphs.reduce((total, paragraph) => total + links(paragraph, concepts).length, 0);
    expect(pass()).toBe(250);
    const started = performance.now();
    for (let round = 0; round < 5; round += 1) pass();
    // One pass over a 20,000-character note. A single alternation of every
    // phrase took about 1,400 ms here; the indexed matcher takes a few.
    expect((performance.now() - started) / 5).toBeLessThan(150);
  });
});
