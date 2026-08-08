// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Concept, Note } from "../types";
import {
  collectNoteTasks,
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

  it("shows one authoritative task when a derived wiki copies a manual task", () => {
    const manual = makeNote(
      "- [ ] Buy milk\n- [ ] Pick up a prescription",
      {
        id: "note-shopping",
        title: "Go shopping",
        kind: "article",
      },
    );
    const generated = makeNote(
      "## Shopping list\n\n- [ ] Buy milk.\n- [ ] Pick up a prescription",
      {
        id: "note-shopping-wiki",
        title: "Shopping list",
        kind: "wiki",
      },
    );

    expect(collectNoteTasks([generated, manual], [])).toMatchObject([
      { noteId: manual.id, text: "Buy milk" },
      { noteId: manual.id, text: "Pick up a prescription" },
    ]);
  });

  it("deduplicates tasks derived from the same imported source", () => {
    const first = makeNote("- [ ] Send the revised agenda", {
      id: "note-first",
      sourceIds: ["source-meeting"],
    });
    const second = makeNote("- [ ] Send the revised agenda.", {
      id: "note-second",
      sourceIds: ["source-meeting"],
    });

    expect(collectNoteTasks([first, second], [])).toHaveLength(1);
  });

  it("keeps identical recurring tasks from unrelated ordinary notes", () => {
    const monday = makeNote("- [ ] Buy milk", {
      id: "note-monday",
    });
    const friday = makeNote("- [ ] Buy milk", {
      id: "note-friday",
    });

    expect(collectNoteTasks([monday, friday], [])).toMatchObject([
      { noteId: "note-monday" },
      { noteId: "note-friday" },
    ]);
  });
});

function makeNote(body: string, overrides: Partial<Note> = {}): Note {
  return {
    id: overrides.id ?? "note-plan",
    title: overrides.title ?? "Project plan",
    slug: overrides.slug ?? "project-plan",
    summary: overrides.summary ?? "",
    body,
    aliases: overrides.aliases ?? [],
    tags: overrides.tags ?? [],
    kind: overrides.kind ?? "project",
    status: overrides.status ?? "ready",
    conceptIds: overrides.conceptIds ?? [],
    sourceIds: overrides.sourceIds ?? [],
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    color: overrides.color,
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
