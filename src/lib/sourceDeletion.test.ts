import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import {
  attachSourceToNoteInSnapshot,
  deleteSourceFromSnapshot,
} from "./sourceDeletion";

const CREATED_AT = "2026-08-07T00:00:00.000Z";
const DELETED_AT = "2026-08-07T00:05:00.000Z";

describe("deleteSourceFromSnapshot", () => {
  it("deletes only the source and cleans every durable source reference", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      CREATED_AT,
      "space-research",
    );
    const affectedNote = makeNote("note-affected", "Affected", {
      sourceIds: ["source-delete", "source-keep"],
      body: "A claim cites [Delete me](orion-source://source-delete) and [Keep me](orion-source://source-keep).",
    });
    const unrelatedNote = makeNote("note-unrelated", "Unrelated", {
      sourceIds: ["source-keep"],
    });
    snapshot.notes = [affectedNote, unrelatedNote];
    snapshot.sources = [
      {
        id: "source-delete",
        title: "Delete me",
        kind: "text",
        importedAt: CREATED_AT,
        text: "Original material",
        noteIds: [affectedNote.id],
      },
      {
        id: "source-keep",
        title: "Keep me",
        kind: "pdf",
        importedAt: CREATED_AT,
        text: "Other material",
        noteIds: [affectedNote.id, unrelatedNote.id],
      },
    ];
    snapshot.concepts = [
      {
        id: "concept-keep",
        label: "Keep",
        aliases: [],
        description: "Unrelated concept",
        noteIds: [unrelatedNote.id],
        canonicalNoteId: unrelatedNote.id,
        color: "#8798ff",
        autoLink: true,
      },
    ];
    snapshot.relationships = [
      {
        id: "relationship-detach",
        fromNoteId: affectedNote.id,
        toNoteId: unrelatedNote.id,
        kind: "supports",
        label: "supports",
        strength: 0.8,
        sourceId: "source-delete",
        context: "Keep this relationship without deleted provenance.",
      },
      {
        id: "relationship-keep",
        fromNoteId: unrelatedNote.id,
        toNoteId: affectedNote.id,
        kind: "related",
        label: "related",
        strength: 0.4,
        sourceId: "source-keep",
      },
    ];
    snapshot.studio.cards = [
      {
        id: "legacy-card",
        kind: "evidence",
        title: "Legacy evidence",
        body: "Compatibility data",
        epistemicStatus: "sourced",
        origin: "user",
        stage: "accepted",
        dialecticRole: "none",
        conceptIds: [],
        noteIds: [affectedNote.id],
        sourceIds: ["source-delete", "source-keep"],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      },
    ];
    snapshot.activeNoteId = affectedNote.id;
    snapshot.spaceOverview = {
      title: "Research overview",
      body: "The current overview.",
      relatedNoteIds: [affectedNote.id],
      generatedAt: CREATED_AT,
      stale: false,
    };

    const result = deleteSourceFromSnapshot(
      snapshot,
      "source-delete",
      DELETED_AT,
    );

    expect(result.deleted).toBe(true);
    expect(result.detachedNoteIds).toEqual([affectedNote.id]);
    expect(result.snapshot.sources).toEqual([snapshot.sources[1]]);
    expect(result.snapshot.notes[0]).toEqual({
      ...affectedNote,
      sourceIds: ["source-keep"],
      body: "A claim cites Delete me and [1](orion-source://source-keep).\n\n## References\n\n1. [Keep me](orion-source://source-keep)",
      updatedAt: DELETED_AT,
    });
    expect(result.snapshot.notes[1]).toBe(unrelatedNote);
    expect(result.snapshot.relationships[0]).toEqual({
      id: "relationship-detach",
      fromNoteId: affectedNote.id,
      toNoteId: unrelatedNote.id,
      kind: "supports",
      label: "supports",
      strength: 0.8,
      context: "Keep this relationship without deleted provenance.",
    });
    expect(result.snapshot.relationships[1]).toBe(
      snapshot.relationships[1],
    );
    expect(result.snapshot.studio.cards[0]?.sourceIds).toEqual([
      "source-keep",
    ]);
    expect(result.snapshot.concepts).toBe(snapshot.concepts);
    expect(result.snapshot.activeNoteId).toBe(affectedNote.id);
    expect(result.snapshot.spaceOverview).toBe(snapshot.spaceOverview);
    expect(result.snapshot.updatedAt).toBe(DELETED_AT);
  });

  it("returns the original snapshot when the source does not exist", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      CREATED_AT,
      "space-research",
    );

    const result = deleteSourceFromSnapshot(
      snapshot,
      "source-missing",
      DELETED_AT,
    );

    expect(result).toEqual({
      snapshot,
      deleted: false,
      detachedNoteIds: [],
    });
    expect(result.snapshot).toBe(snapshot);
  });
});

describe("attachSourceToNoteInSnapshot", () => {
  it("writes both sides of a previously unrelated provenance edge atomically", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      CREATED_AT,
      "space-research",
    );
    snapshot.notes = [makeNote("note-new", "New note")];
    snapshot.sources = [
      {
        id: "source-space",
        title: "Space source",
        kind: "pdf",
        importedAt: CREATED_AT,
        text: "Original material",
        noteIds: [],
      },
    ];

    const next = attachSourceToNoteInSnapshot(
      snapshot,
      "note-new",
      "source-space",
      DELETED_AT,
    );

    expect(next).not.toBe(snapshot);
    expect(next.notes[0]?.sourceIds).toEqual(["source-space"]);
    expect(next.sources[0]?.noteIds).toEqual(["note-new"]);
    expect(next.notes[0]?.updatedAt).toBe(DELETED_AT);
    expect(next.updatedAt).toBe(DELETED_AT);
  });

  it("repairs an asymmetric edge and leaves a complete edge unchanged", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      CREATED_AT,
      "space-research",
    );
    snapshot.notes = [
      makeNote("note-new", "New note", { sourceIds: ["source-space"] }),
    ];
    snapshot.sources = [
      {
        id: "source-space",
        title: "Space source",
        kind: "pdf",
        importedAt: CREATED_AT,
        text: "Original material",
        noteIds: [],
      },
    ];

    const repaired = attachSourceToNoteInSnapshot(
      snapshot,
      "note-new",
      "source-space",
      DELETED_AT,
    );
    expect(repaired.notes[0]?.sourceIds).toEqual(["source-space"]);
    expect(repaired.sources[0]?.noteIds).toEqual(["note-new"]);
    expect(
      attachSourceToNoteInSnapshot(
        repaired,
        "note-new",
        "source-space",
        "2026-08-07T00:10:00.000Z",
      ),
    ).toBe(repaired);
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
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}
