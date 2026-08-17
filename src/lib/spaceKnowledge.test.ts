import { describe, expect, it } from "vitest";
import type { Note, OrganizeContentResult } from "../types";
import { createEmptySnapshot } from "../data/defaults";
import {
  applySpaceBlueprintResult,
  applySpaceRootResult,
  buildSpaceBlueprintOrientation,
  buildSpaceNoteDigests,
  getSpaceKnowledgeRoot,
  pendingSpaceBlueprints,
  prepareSpaceKnowledgeIndex,
  spaceKnowledgeIsCurrent,
} from "./spaceKnowledge";

const NOW = "2026-08-13T10:00:00.000Z";

function note(id: string, body: string, title = `Note ${id}`): Note {
  return {
    id,
    title,
    slug: id,
    summary: `Summary for ${title}`,
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

function result(title: string, body: string): OrganizeContentResult {
  return {
    notes: [
      {
        title,
        summary: body.slice(0, 80),
        body,
        tags: [],
        aliases: [],
        links: [],
      },
    ],
    wikiArticles: [],
    concepts: [],
    suggestedConnections: [],
  };
}

describe("persistent Space knowledge topology", () => {
  it("builds a distributed whole-body digest with an explicit fingerprint and quality", () => {
    const snapshot = createEmptySnapshot("Topology", NOW);
    snapshot.notes = [
      note(
        "n1",
        [
          "# Beginning",
          `BEGIN_MARKER ${"alpha ".repeat(80)}`,
          "## Middle",
          `MIDDLE_MARKER ${"beta ".repeat(100)}`,
          "## Ending",
          `END_MARKER ${"gamma ".repeat(80)}`,
        ].join("\n\n"),
      ),
    ];

    const [digest] = buildSpaceNoteDigests(snapshot);
    expect(digest.headings).toEqual(["Beginning", "Middle", "Ending"]);
    expect(digest.wholeBodySketch).toContain("BEGIN MARKER");
    expect(digest.wholeBodySketch).toContain("alpha");
    expect(digest.wholeBodySketch).toContain("beta");
    expect(digest.wholeBodySketch).toContain("gamma");
    expect(digest.contentFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(digest.quality).toBe("complete");
  });

  it("partitions a complete directory, reuses unchanged provider clusters, and invalidates ancestors", () => {
    const snapshot = createEmptySnapshot("Topology", NOW);
    snapshot.notes = Array.from({ length: 64 }, (_, index) =>
      note(`n-${String(index).padStart(2, "0")}`, `Body ${index} `.repeat(20)),
    );
    let index = prepareSpaceKnowledgeIndex(snapshot, NOW);
    const leafIds = index.blueprints
      .filter(({ level }) => level === 0)
      .map(({ id }) => id);
    expect(leafIds).toHaveLength(2);
    expect(
      index.blueprints
        .filter(({ level }) => level === 0)
        .map(({ noteIds }) => noteIds.length),
    ).toEqual([32, 32]);

    for (const blueprint of pendingSpaceBlueprints(index)) {
      index = applySpaceBlueprintResult(
        index,
        blueprint.id,
        result(`Cluster ${blueprint.id}`, `Provider blueprint for ${blueprint.id}.`),
        NOW,
      );
    }
    index = applySpaceRootResult(
      index,
      result("Root thesis", "A provider-authored root Space blueprint."),
      NOW,
    );
    snapshot.spaceKnowledge = index;
    expect(index.stale).toBe(false);
    expect(spaceKnowledgeIsCurrent(snapshot)).toBe(true);

    const preservedLeaf = index.blueprints.find(({ id }) => id === leafIds[1]);
    snapshot.notes[0] = {
      ...snapshot.notes[0],
      body: `${snapshot.notes[0].body}\nChanged knowledge.`,
      updatedAt: "2026-08-13T10:05:00.000Z",
    };
    const refreshed = prepareSpaceKnowledgeIndex(snapshot, "2026-08-13T10:05:00.000Z");
    expect(refreshed.stale).toBe(true);
    expect(refreshed.blueprints.find(({ id }) => id === leafIds[1])).toEqual(
      preservedLeaf,
    );
    expect(refreshed.blueprints.find(({ id }) => id === leafIds[0])?.origin).toBe(
      "local",
    );
    expect(getSpaceKnowledgeRoot(refreshed)?.origin).toBe("local");
  });

  it("creates another hierarchy level when leaf summaries cannot fit one root merge", () => {
    const snapshot = createEmptySnapshot("Large topology", NOW);
    snapshot.notes = Array.from({ length: 1_056 }, (_, index) =>
      note(`n-${String(index).padStart(4, "0")}`, `Substantive body ${index}. `.repeat(3)),
    );
    const index = prepareSpaceKnowledgeIndex(snapshot, NOW);
    const leafCount = index.blueprints.filter(({ level }) => level === 0).length;
    expect(leafCount).toBe(33);
    expect(index.blueprints.some(({ level }) => level === 1)).toBe(true);
    expect(getSpaceKnowledgeRoot(index)?.level).toBe(2);
    expect(getSpaceKnowledgeRoot(index)?.noteIds).toHaveLength(1_056);
  });

  it("coalesces five related additions into one affected cluster", () => {
    const snapshot = createEmptySnapshot("Incremental topology", NOW);
    snapshot.notes = Array.from({ length: 54 }, (_, index) =>
      note(
        `n-${String(index).padStart(2, "0")}`,
        index < 27
          ? `Phenomenology consciousness dialectic ${index}. `.repeat(4)
          : `Botany woodland ecology ${index}. `.repeat(4),
      ),
    );
    let index = prepareSpaceKnowledgeIndex(snapshot, NOW);
    for (const blueprint of pendingSpaceBlueprints(index)) {
      index = applySpaceBlueprintResult(
        index,
        blueprint.id,
        result(blueprint.title, blueprint.body),
        NOW,
      );
    }
    index = applySpaceRootResult(index, result("Root", "Current root."), NOW);
    snapshot.spaceKnowledge = index;

    snapshot.notes.push(
      ...Array.from({ length: 5 }, (_, offset) =>
        note(
          `new-${offset}`,
          `Phenomenology consciousness dialectic addition ${offset}. `.repeat(4),
        ),
      ),
    );
    const refreshed = prepareSpaceKnowledgeIndex(
      snapshot,
      "2026-08-13T10:10:00.000Z",
    );
    const changedLeaves = pendingSpaceBlueprints(refreshed).filter(
      ({ level }) => level === 0,
    );
    expect(changedLeaves).toHaveLength(1);
    expect(
      changedLeaves[0].noteIds.filter((noteId) => noteId.startsWith("new-")).length,
    ).toBe(5);
  });

  it("selects bounded relevant child blueprints only while the hierarchy is current", () => {
    const snapshot = createEmptySnapshot("Routing topology", NOW);
    snapshot.notes = Array.from({ length: 64 }, (_, index) =>
      note(
        `n-${String(index).padStart(2, "0")}`,
        index < 32
          ? `Phenomenology consciousness dialectic ${index}. `.repeat(4)
          : `Botany ecology woodland ${index}. `.repeat(4),
      ),
    );
    let index = prepareSpaceKnowledgeIndex(snapshot, NOW);
    for (const blueprint of pendingSpaceBlueprints(index)) {
      const firstMember = blueprint.noteIds[0];
      const isPhenomenology = Number(firstMember.split("-")[1]) < 32;
      index = applySpaceBlueprintResult(
        index,
        blueprint.id,
        result(
          isPhenomenology ? "Phenomenology" : "Botany",
          isPhenomenology
            ? "Consciousness and dialectic organize this cluster."
            : "Woodland ecology organizes this cluster.",
        ),
        NOW,
      );
    }
    index = applySpaceRootResult(
      index,
      result("Two domains", "The Space contains phenomenology and botany."),
      NOW,
    );
    snapshot.spaceKnowledge = index;

    const orientation = buildSpaceBlueprintOrientation(
      snapshot,
      "Hegelian phenomenology and consciousness",
      1,
    );
    expect(orientation?.root.title).toBe("Two domains");
    expect(orientation?.clusters).toHaveLength(1);
    expect(orientation?.clusters[0].title).toBe("Phenomenology");

    snapshot.notes[0] = {
      ...snapshot.notes[0],
      body: `${snapshot.notes[0].body}\nUnindexed change`,
      updatedAt: "2026-08-13T11:00:00.000Z",
    };
    expect(
      buildSpaceBlueprintOrientation(snapshot, "phenomenology", 1),
    ).toBeUndefined();
  });

  it("rejects a fingerprint-matching index with incomplete or duplicate membership", () => {
    const snapshot = createEmptySnapshot("Integrity", NOW);
    snapshot.notes = Array.from({ length: 40 }, (_, index) =>
      note(`n-${index}`, `Substantive knowledge ${index}. `.repeat(5)),
    );
    const index = prepareSpaceKnowledgeIndex(snapshot, NOW);
    snapshot.spaceKnowledge = index;
    expect(spaceKnowledgeIsCurrent(snapshot)).toBe(true);

    const firstLeaf = index.blueprints.find(({ level }) => level === 0);
    expect(firstLeaf).toBeDefined();
    snapshot.spaceKnowledge = {
      ...index,
      blueprints: index.blueprints.map((blueprint) =>
        blueprint.id === firstLeaf?.id
          ? {
              ...blueprint,
              noteIds: [blueprint.noteIds[0], blueprint.noteIds[0]],
            }
          : blueprint,
      ),
    };
    expect(spaceKnowledgeIsCurrent(snapshot)).toBe(false);
    const rebuilt = prepareSpaceKnowledgeIndex(snapshot, NOW);
    expect(rebuilt.blueprints.every(({ noteIds }) => new Set(noteIds).size === noteIds.length)).toBe(
      true,
    );
  });
});
