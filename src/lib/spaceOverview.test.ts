import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import {
  applySpaceOverviewResult,
  buildLocalSpaceOverview,
  buildSpaceOverviewRequest,
  hasSubstantiveOverviewNote,
  markSpaceOverviewStale,
  spaceKnowledgeFingerprint,
} from "./spaceOverview";

const NOW = "2026-08-05T00:00:00.000Z";

function note(id: string, title: string, body = "Substantive note body."): Note {
  return {
    id,
    title,
    slug: id,
    summary: `${title} summary`,
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

describe("Space overviews", () => {
  it("marks a generated overview stale without disturbing its content", () => {
    const snapshot = createEmptySnapshot("Research", NOW);
    snapshot.spaceOverview = {
      title: "Order and progress",
      body: "A stable orientation.",
      relatedNoteIds: [],
      generatedAt: NOW,
      stale: false,
    };

    const next = markSpaceOverviewStale(snapshot);

    expect(next.spaceOverview).toEqual({
      ...snapshot.spaceOverview,
      stale: true,
    });
    expect(snapshot.spaceOverview.stale).toBe(false);
  });

  it("builds a bounded request that asks for one editorial overview", () => {
    const snapshot = createEmptySnapshot("Sociology", NOW);
    snapshot.notes = [note("note-comte", "Auguste Comte")];

    const request = buildSpaceOverviewRequest(snapshot);

    expect(request.content).toContain("Auguste Comte");
    expect(request.taskInstructions).toContain(
      "return exactly one entry in notes",
    );
    expect(request.taskInstructions).toContain("editorial headline");
    expect(request.taskInstructions).toContain("450–700 words");
  });

  it("stores clean generated text and finds the notes it names", () => {
    const snapshot = createEmptySnapshot("Sociology", NOW);
    snapshot.notes = [note("note-comte", "Auguste Comte")];

    const overview = applySpaceOverviewResult(
      snapshot,
      {
        notes: [
          {
            title: "## **[[Order and progress]]**",
            summary: "",
            body: "[[Auguste Comte]] **anchors** this Space with [positive inquiry](https://example.com). The customer_id target keeps latency < 50ms and throughput > 1k.",
            tags: [],
            aliases: [],
            links: [],
          },
        ],
        wikiArticles: [],
        concepts: [],
        suggestedConnections: [],
      },
      NOW,
    );

    expect(overview.title).toBe("Order and progress");
    expect(overview.body).toBe(
      "Auguste Comte anchors this Space with positive inquiry. The customer_id target keeps latency < 50ms and throughput > 1k.",
    );
    expect(overview.relatedNoteIds).toEqual(["note-comte"]);
    expect(overview.stale).toBe(false);
  });

  it("keeps Home informative without an API key", () => {
    const snapshot = createEmptySnapshot("Writing", NOW);
    snapshot.notes = [
      note(
        "note-story",
        "The Perfect Hell",
        "The Perfect Hell summary develops into a longer body.",
      ),
    ];

    const overview = buildLocalSpaceOverview(snapshot);

    expect(overview.title).toBe("The Perfect Hell");
    expect(overview.body).toContain("1 note");
    expect(overview.body).toContain("The Perfect Hell summary");
    expect(overview.body.match(/The Perfect Hell summary/g)).toHaveLength(1);
    expect(overview.body.split("\n\n")).toHaveLength(2);
    expect(overview.relatedNoteIds).toEqual(["note-story"]);
  });

  it("includes finished reference articles but ignores unfinished and empty pages", () => {
    const reference = {
      ...note("note-sql", "SQL", "SQL organizes relational data into tables."),
      kind: "wiki" as const,
    };
    const pending = {
      ...note(
        "note-pending",
        "Positivism",
        "<!-- orion-link-pending -->\n\n> Orion is writing this article from a source.",
      ),
      kind: "wiki" as const,
      tags: ["orion-link-pending"],
    };
    const empty = {
      ...note("note-empty", "Untitled note", ""),
      summary: "",
    };
    const archived = {
      ...note("note-old", "Old material"),
      status: "archived" as const,
    };
    const snapshot = createEmptySnapshot("Data", NOW);
    snapshot.notes = [reference, pending, empty, archived];

    expect(hasSubstantiveOverviewNote(reference)).toBe(true);
    expect(hasSubstantiveOverviewNote(pending)).toBe(false);
    expect(hasSubstantiveOverviewNote(empty)).toBe(false);
    expect(hasSubstantiveOverviewNote(archived)).toBe(false);

    const request = buildSpaceOverviewRequest(snapshot);
    const local = buildLocalSpaceOverview(snapshot);
    expect(request.content).toContain("SQL organizes relational data");
    expect(request.content).not.toContain("Positivism");
    expect(local.title).toBe("SQL");
    expect(local.relatedNoteIds).toEqual(["note-sql"]);
  });

  it("changes its fingerprint when knowledge changes but not for overview state", () => {
    const snapshot = createEmptySnapshot("Writing", NOW);
    snapshot.notes = [note("note-story", "The Perfect Hell")];
    const original = spaceKnowledgeFingerprint(snapshot);

    snapshot.spaceOverview = {
      title: "A generated title",
      body: "Generated orientation.",
      relatedNoteIds: ["note-story"],
      generatedAt: NOW,
      stale: false,
    };
    expect(spaceKnowledgeFingerprint(snapshot)).toBe(original);

    const originalInstructions = snapshot.settings.organizationInstructions;
    snapshot.settings.organizationInstructions = "Prefer causal structure.";
    expect(spaceKnowledgeFingerprint(snapshot)).not.toBe(original);
    snapshot.settings.organizationInstructions = originalInstructions;

    snapshot.notes[0] = {
      ...snapshot.notes[0],
      body: "Changed knowledge.",
      updatedAt: "2026-08-05T00:00:01.000Z",
    };
    expect(spaceKnowledgeFingerprint(snapshot)).not.toBe(original);
  });
});
