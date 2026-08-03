// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Concept, Note } from "../types";
import {
  collectTasksFromNote,
  setTaskChecked,
} from "./tasks";

const NOW = "2026-07-31T09:00:00.000Z";

describe("note tasks", () => {
  it("collects GFM tasks and assigns the strongest Space concept", () => {
    const note = makeNote(
      "- [ ] Compare SQL migrations\n- [x] Read [Comte](orion-concept://concept-comte)\n\n```\n- [ ] Ignore code examples\n```",
    );
    const concepts = [
      makeConcept("concept-sql", "SQL"),
      makeConcept("concept-comte", "Auguste Comte", ["Comte"]),
    ];

    expect(collectTasksFromNote(note, concepts)).toMatchObject([
      {
        text: "Compare SQL migrations",
        checked: false,
        conceptLabel: "SQL",
      },
      {
        text: "Read Comte",
        checked: true,
        conceptLabel: "Auguste Comte",
      },
    ]);
  });

  it("toggles the exact persisted task line", () => {
    const markdown = "Intro\n\n- [ ] Review evidence\n- [x] Done";
    expect(setTaskChecked(markdown, 2, true)).toBe(
      "Intro\n\n- [x] Review evidence\n- [x] Done",
    );
  });
});

function makeNote(body: string): Note {
  return {
    id: "note-plan",
    title: "Project plan",
    slug: "project-plan",
    summary: "",
    body,
    aliases: [],
    tags: [],
    kind: "project",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeConcept(
  id: string,
  label: string,
  aliases: string[] = [],
): Concept {
  return {
    id,
    label,
    aliases,
    description: "",
    noteIds: ["note-wiki"],
    canonicalNoteId: "note-wiki",
    color: "#8798ff",
    autoLink: true,
  };
}
