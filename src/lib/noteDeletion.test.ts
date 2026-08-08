import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { deleteNoteFromSnapshot } from "./noteDeletion";

const NOW = "2026-07-29T01:00:00.000Z";

describe("deleteNoteFromSnapshot", () => {
  it("removes the note and cleans links, concepts, relationships, and provenance", () => {
    const snapshot = createEmptySnapshot(
      "Philosophy",
      NOW,
      "space-philosophy",
    );
    const origin = makeNote("note-origin", "Lecture", {
      body: "Read [Positivism](orion-concept://concept-positivism) in [the article](orion-note://note-positivism).",
    });
    const target = makeNote("note-positivism", "Positivism", {
      kind: "wiki",
      conceptIds: ["concept-positivism"],
      sourceIds: ["source-lecture"],
    });
    snapshot.notes = [origin, target];
    snapshot.concepts = [
      {
        id: "concept-positivism",
        label: "Positivism",
        aliases: [],
        description: "",
        noteIds: [target.id],
        canonicalNoteId: target.id,
        color: "#8798ff",
        autoLink: true,
      },
    ];
    snapshot.relationships = [
      {
        id: "relationship-positivism",
        fromNoteId: origin.id,
        toNoteId: target.id,
        kind: "mentions",
        label: "mentions",
        strength: 1,
        conceptId: "concept-positivism",
      },
    ];
    snapshot.sources = [
      {
        id: "source-lecture",
        title: "Lecture",
        kind: "text",
        importedAt: NOW,
        text: "Positivism.",
        noteIds: [origin.id, target.id],
      },
    ];
    snapshot.activeNoteId = target.id;
    snapshot.spaceOverview = {
      title: "A changing field",
      body: "Positivism connects the lecture.",
      relatedNoteIds: [origin.id, target.id],
      generatedAt: NOW,
      stale: false,
    };

    const result = deleteNoteFromSnapshot(
      snapshot,
      target.id,
      "2026-07-29T01:05:00.000Z",
    );

    expect(result.deleted).toBe(true);
    expect(result.removedConceptIds).toContain("concept-positivism");
    expect(result.snapshot.notes.map((note) => note.id)).toEqual([
      origin.id,
    ]);
    expect(result.snapshot.notes[0]?.body).toBe(
      "Read Positivism in the article.",
    );
    expect(result.snapshot.relationships).toEqual([]);
    expect(result.snapshot.sources[0]?.noteIds).toEqual([origin.id]);
    expect(result.snapshot.spaceOverview?.relatedNoteIds).toEqual([origin.id]);
    expect(result.snapshot.activeNoteId).toBeNull();
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
    slug: title.toLocaleLowerCase(),
    summary: "",
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
