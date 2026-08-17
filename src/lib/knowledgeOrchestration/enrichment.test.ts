import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { AppSnapshot, Note, OrganizedWikiArticle, Source } from "../../types";
import { createSourceReadingPlan, noteVersion } from "./context";
import {
  finalizeEnrichmentResult,
  runKnowledgeEnrichment,
} from "./enrichment";
import type {
  KnowledgeOwnerProposal,
  KnowledgeResultProvenance,
  KnowledgeRunResult,
} from "./protocol";
import type { KnowledgeRuntimeEvent } from "./runtime";
import type { KnowledgeAssignmentExecutionRequest } from "./service";
import { artifactPayload } from "./testFixtures";

const NOW = "2026-08-11T10:00:00.000Z";

describe("variable-width Space enrichment", () => {
  it("can complete a no-change enrichment in one call", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const origin = note("origin", "Project note", "Useful new knowledge.", "article");
    snapshot.notes = [origin];
    const driver = vi.fn().mockResolvedValue({
      response: { kind: "complete", payload: emptyResult() },
    });
    const output = await runKnowledgeEnrichment({
      snapshot,
      originNote: origin,
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver,
    });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(output.result.wikiArticles).toEqual([]);
  });

  it("routes companion notes once before enriching in a peopled Space", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const origin = note("origin", "Project note", "Useful new knowledge.", "article");
    const companions = Array.from({ length: 4 }, (_, index) =>
      note(
        `companion-${index + 1}`,
        `Companion ${index + 1}`,
        "Existing prose nearby.",
        "wiki",
      ),
    );
    companions[0].summary =
      "Useful new knowledge extends this project note with durable context.";
    snapshot.notes = [origin, ...companions];
    const purposes: string[] = [];
    const output = await runKnowledgeEnrichment({
      snapshot,
      originNote: origin,
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        purposes.push(request.assignment.purpose);
        if (request.assignment.output.kind === "note-routing") {
          expect(request.assignment.objective).toContain("Project note");
          const expected = request.assignment.output.expectedNotes;
          expect(new Set(expected.map(({ noteId }) => noteId))).toEqual(
            new Set([companions[0].id]),
          );
          return {
            response: {
              kind: "complete",
              payload: {
                rangeId: request.assignment.output.rangeId,
                routes: expected.map(({ noteId, noteVersion: version }) => ({
                  noteId,
                  noteVersion: version,
                  relation: "extends",
                  rationale: "A bounded routing judgment.",
                  candidateNoteIds: [],
                })),
                warnings: [],
              },
            },
          };
        }
        expect(request.assignment.purpose).toBe("root");
        expect(
          request.context.spaceOrientation.routedNotes?.map(
            ({ noteId }) => noteId,
          ),
        ).toEqual([companions[0].id]);
        return { response: { kind: "complete", payload: emptyResult() } };
      },
    });

    expect(purposes).toEqual(["router", "root"]);
    expect(output.result.wikiArticles).toEqual([]);
  });

  it("honors disabled existing-note context during installed enrichment", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.settings.includeExistingNotesInAIContext = false;
    const origin = note(
      "origin",
      "Project note",
      "Useful new knowledge.",
      "article",
    );
    const privateWiki = note(
      "private-wiki",
      "Private destination",
      "PRIVATE_EXISTING_BODY",
      "wiki",
    );
    snapshot.notes = [origin, privateWiki];
    snapshot.spaceOverview = {
      title: "PRIVATE_OVERVIEW",
      body: "PRIVATE_OVERVIEW_BODY",
      relatedNoteIds: [privateWiki.id],
      generatedAt: NOW,
      stale: false,
    };
    snapshot.concepts = [
      {
        id: "private-concept",
        label: "PRIVATE_CONCEPT",
        aliases: [],
        description: "PRIVATE_CONCEPT_DESCRIPTION",
        noteIds: [privateWiki.id],
        canonicalNoteId: privateWiki.id,
        color: "#808080",
        autoLink: true,
      },
    ];
    snapshot.relationships = [
      {
        id: "private-relationship",
        fromNoteId: origin.id,
        toNoteId: privateWiki.id,
        kind: "related",
        label: "PRIVATE_RELATIONSHIP",
        strength: 1,
      },
    ];
    snapshot.sources = [
      {
        id: "private-source",
        title: "PRIVATE_PRIOR_SOURCE",
        kind: "text",
        importedAt: NOW,
        text: "PRIVATE_PRIOR_SOURCE_BODY",
        noteIds: [privateWiki.id],
      },
    ];

    const driver = vi.fn(async (request: KnowledgeAssignmentExecutionRequest) => {
      expect(request.assignment.purpose).toBe("root");
      expect(request.assignment.references).toEqual([
        {
          kind: "note",
          noteId: origin.id,
          version: noteVersion(origin),
        },
      ]);
      expect(request.context.spaceOrientation.overview).toBeUndefined();
      expect(request.context.spaceOrientation.noteSignals).toEqual([]);
      expect(request.context.runManifest?.candidateNotes).toEqual([]);
      expect(request.context.runManifest?.concepts).toEqual([]);
      expect(request.context.runManifest?.relationships).toEqual([]);
      expect(JSON.stringify(request.context)).not.toMatch(
        /PRIVATE_EXISTING_BODY|PRIVATE_OVERVIEW|PRIVATE_CONCEPT|PRIVATE_RELATIONSHIP|PRIVATE_PRIOR_SOURCE/,
      );
      return { response: { kind: "complete" as const, payload: emptyResult() } };
    });

    await runKnowledgeEnrichment({
      snapshot,
      originNote: origin,
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver,
    });

    expect(driver).toHaveBeenCalledTimes(1);
  });

  it("rejects a destination grant without a completed exact owner artifact", () => {
    const fixture = ownedEnrichmentFixture();
    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        fixture.history,
      ),
    ).toThrow(/completed exact owner proposal/);
  });

  it("accepts an exact completed owner artifact and still requires a current base", () => {
    const fixture = ownedEnrichmentFixture();
    recordOwnerArtifact(fixture);

    expect(
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        fixture.history,
      ).wikiArticles[0].body,
    ).toContain("Integrated prose");

    fixture.proposal.baseVersion = "stale";
    const artifactEvent = fixture.history[1];
    if (artifactEvent?.type !== "artifact-recorded") {
      throw new Error("Expected the completed owner artifact.");
    }
    artifactEvent.artifact.ownerProposals[0].baseVersion = "stale";
    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        fixture.history,
      ),
    ).toThrow(/stale/);
  });

  it("rejects a root owner proposal mutated after its owner artifact completed", () => {
    const fixture = ownedEnrichmentFixture();
    recordOwnerArtifact(fixture);
    fixture.proposal.body += "\n\nUnreviewed mutation.";

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        fixture.history,
      ),
    ).toThrow(/completed exact owner proposal/);
  });

  it("rejects duplicate root owner proposals for one destination", () => {
    const fixture = ownedEnrichmentFixture();
    recordOwnerArtifact(fixture);
    fixture.value.ownerProposals.push(structuredClone(fixture.proposal));

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        fixture.history,
      ),
    ).toThrow(/repeated an owner proposal/);
  });

  it("rejects a direct overwrite that bypasses ownership", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const origin = note("origin", "Project note", "Useful new knowledge.", "article");
    const wiki = note("wiki", "Durable concept", "Existing prose.", "wiki");
    snapshot.notes = [origin, wiki];
    const value = emptyResult();
    value.result.wikiArticles = [
      {
        title: wiki.title,
        summary: "Overwrite",
        body: "Overwrite",
        overview: "Overwrite",
        spaceRelevance: "",
        sourceGroundedDetails: [],
        uncertainties: [],
        tags: [],
        aliases: [],
        links: [],
      },
    ];
    value.provenance = [
      {
        kind: "wikiArticle",
        title: wiki.title,
        sourceIds: [],
        evidenceReferences: [
          { kind: "note", noteId: origin.id, version: noteVersion(origin) },
        ],
      },
    ];
    expect(() => finalizeEnrichmentResult(value, snapshot, origin, [])).toThrow(
      /without an exclusive owner/,
    );
  });

  it("requires provenance for every final enrichment article", () => {
    const fixture = newArticleFixture();
    fixture.value.provenance = [];

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/Missing enrichment provenance/);
  });

  it("rejects provenance for an article absent from the final result", () => {
    const fixture = newArticleFixture();
    fixture.value.provenance.push({
      ...validProvenance("Unreturned article"),
    });

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/unknown final article/);
  });

  it("rejects duplicate provenance for the same final article", () => {
    const fixture = newArticleFixture();
    fixture.value.provenance.push(
      structuredClone(fixture.value.provenance[0]),
    );

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/repeated New concept/);
  });

  it.each([
    { sourceIds: [], error: /omitted direct sources/ },
    { sourceIds: ["s1", "s1"], error: /repeated direct sources/ },
    { sourceIds: ["unrelated"], error: /unrelated source/ },
  ])("rejects invalid direct provenance source IDs", ({ sourceIds, error }) => {
    const fixture = newArticleFixture();
    fixture.value.provenance[0].sourceIds = sourceIds;

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(error);
  });

  it("requires every claimed source to be reachable from evidence", () => {
    const fixture = newArticleFixture();
    fixture.snapshot.concepts = [
      {
        id: "concept-1",
        label: "Context only",
        aliases: [],
        description: "Space context without imported-source evidence.",
        noteIds: [],
        color: "#808080",
        autoLink: true,
      },
    ];
    fixture.value.provenance[0].evidenceReferences = [
      { kind: "concept", conceptId: "concept-1" },
    ];

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/did not evidence claimed source s1/);

    fixture.value.provenance[0].evidenceReferences = [
      {
        kind: "note",
        noteId: fixture.origin.id,
        version: noteVersion(fixture.origin),
      },
    ];
    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).not.toThrow();
  });

  it("rejects partial and unclaimed evidence in a two-source enrichment", () => {
    const fixture = newArticleFixture();
    const secondSource = { ...source(), id: "s2", title: "Second source" };
    fixture.snapshot.sources.push(secondSource);
    fixture.origin.sourceIds.push(secondSource.id);
    fixture.value.provenance[0].sourceIds = ["s1", "s2"];
    fixture.value.provenance[0].evidenceReferences = [
      { kind: "source", sourceId: "s1" },
    ];

    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/did not evidence claimed source s2/);

    fixture.value.provenance[0].sourceIds = ["s1"];
    fixture.value.provenance[0].evidenceReferences = [
      { kind: "source", sourceId: "s1" },
      { kind: "source", sourceId: "s2" },
    ];
    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/unclaimed source s2/);
  });

  it("recursively resolves source evidence through run artifacts", () => {
    const fixture = newArticleFixture();
    fixture.value.provenance[0].evidenceReferences = [
      { kind: "artifact", artifactId: "artifact:derived" },
    ];
    const history: KnowledgeRuntimeEvent[] = [
      {
        sequence: 0,
        type: "artifact-recorded",
        artifact: {
          ...artifactPayload("Direct source evidence"),
          artifactId: "artifact:source",
          assignmentId: "reader",
          purpose: "evidence",
          references: [
            { kind: "source-range", sourceId: "s1", rangeId: "full" },
          ],
        },
      },
      {
        sequence: 1,
        type: "artifact-recorded",
        artifact: {
          ...artifactPayload("Derived evidence"),
          artifactId: "artifact:derived",
          assignmentId: "reconciler",
          purpose: "reconciler",
          references: [{ kind: "artifact", artifactId: "artifact:source" }],
        },
      },
    ];

    expect(
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        history,
      ).wikiArticles,
    ).toHaveLength(1);
  });

  it("requires source-range references to resolve to a direct source range", () => {
    const fixture = newArticleFixture();
    fixture.snapshot.sources[0].text = [1, 2, 3, 4, 5]
      .map((page) => `## Page ${page}\n\nEvidence from page ${page}.\n\n`)
      .join("");
    const directSource = fixture.snapshot.sources[0];
    const allocatedSections = createSourceReadingPlan([
      {
        sourceId: directSource.id,
        parsed: {
          title: directSource.title,
          fileName: directSource.fileName || `${directSource.title}.txt`,
          mimeType: directSource.mimeType || "text/plain",
          format: directSource.kind,
          byteSize:
            directSource.byteSize ??
            new TextEncoder().encode(directSource.text).byteLength,
          text: directSource.text,
          warnings: [],
          sourceUrl: directSource.sourceUrl,
        },
      },
    ]).get(directSource.id) ?? [];
    const directRange = allocatedSections[0];
    expect(directRange).toBeDefined();
    if (!directRange) throw new Error("Expected a direct source range.");
    const directRangeId = `range-${directRange.index + 1}`;
    fixture.value.provenance[0].evidenceReferences = [
      { kind: "source-range", sourceId: directSource.id, rangeId: directRangeId },
    ];
    expect(
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ).wikiArticles,
    ).toHaveLength(1);

    fixture.value.provenance[0].evidenceReferences = [
      { kind: "source-range", sourceId: "s1", rangeId: "range-999" },
    ];
    expect(() =>
      finalizeEnrichmentResult(
        fixture.value,
        fixture.snapshot,
        fixture.origin,
        [],
      ),
    ).toThrow(/unavailable source range/);
  });
});

interface OwnedEnrichmentFixture {
  snapshot: AppSnapshot;
  origin: Note;
  wiki: Note;
  value: KnowledgeRunResult;
  proposal: KnowledgeOwnerProposal;
  history: KnowledgeRuntimeEvent[];
}

function ownedEnrichmentFixture(): OwnedEnrichmentFixture {
  const snapshot = createEmptySnapshot("Space", NOW);
  const origin = note("origin", "Project note", "Useful new knowledge.", "article");
  const wiki = note("wiki", "Durable concept", "Existing prose.", "wiki");
  origin.sourceIds = ["s1"];
  snapshot.notes = [origin, wiki];
  snapshot.sources = [source()];
  const proposal: KnowledgeOwnerProposal = {
    destinationNoteId: wiki.id,
    baseVersion: noteVersion(wiki),
    title: wiki.title,
    summary: "Integrated",
    body: "# Durable concept\n\nIntegrated prose.",
    aliases: [],
    tags: [],
    sourceIds: ["s1"],
  };
  const value = emptyResult();
  value.ownerProposals = [proposal];
  value.provenance = [validProvenance(wiki.title)];
  return {
    snapshot,
    origin,
    wiki,
    value,
    proposal,
    history: [
      {
        sequence: 0,
        type: "destination-owner-granted",
        assignmentId: "owner",
        destinationNoteIds: [wiki.id],
      },
    ],
  };
}

function recordOwnerArtifact(fixture: OwnedEnrichmentFixture): void {
  fixture.history.push({
    sequence: fixture.history.length,
    type: "artifact-recorded",
    artifact: {
      ...artifactPayload("Integrated owner revision"),
      artifactId: "artifact:owner:1",
      assignmentId: "owner",
      purpose: "owner",
      ownerProposals: [structuredClone(fixture.proposal)],
    },
  });
}

function newArticleFixture() {
  const snapshot = createEmptySnapshot("Space", NOW);
  const origin = note("origin", "Project note", "Useful new knowledge.", "article");
  origin.sourceIds = ["s1"];
  snapshot.notes = [origin];
  snapshot.sources = [source()];
  const value = emptyResult();
  value.result.wikiArticles = [article("New concept")];
  value.provenance = [validProvenance("New concept")];
  return { snapshot, origin, value };
}

function validProvenance(title: string): KnowledgeResultProvenance {
  return {
    kind: "wikiArticle",
    title,
    sourceIds: ["s1"],
    evidenceReferences: [
      { kind: "source-range", sourceId: "s1", rangeId: "full" },
    ],
  };
}

function article(title: string): OrganizedWikiArticle {
  return {
    title,
    summary: "Grounded summary.",
    body: `# ${title}\n\nGrounded body.`,
    overview: "Grounded summary.",
    spaceRelevance: "Relevant to this Space.",
    sourceGroundedDetails: ["Grounded detail."],
    uncertainties: [],
    tags: [],
    aliases: [],
    links: [],
  };
}

function source(): Source {
  return {
    id: "s1",
    title: "Source",
    kind: "text",
    importedAt: NOW,
    fileName: "source.txt",
    mimeType: "text/plain",
    byteSize: 4,
    text: "Text",
    noteIds: ["origin"],
  };
}

function emptyResult(): KnowledgeRunResult {
  return {
    result: {
      notes: [],
      wikiArticles: [],
      concepts: [],
      suggestedConnections: [],
    },
    provenance: [],
    ownerProposals: [],
    warnings: [],
  };
}

function note(
  id: string,
  title: string,
  body: string,
  kind: Note["kind"],
): Note {
  return {
    id,
    title,
    slug: id,
    summary: body,
    body,
    aliases: [],
    tags: [],
    kind,
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}
