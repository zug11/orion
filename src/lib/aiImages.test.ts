// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { buildAIImagePrompt } from "./aiImages";

const NOW = "2026-08-13T00:00:00.000Z";

function note(id: string, title: string, body: string): Note {
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

describe("AI note image prompts", () => {
  it("uses the exact selection, optional direction, and bounded Across this Space context", () => {
    const snapshot = createEmptySnapshot("Variable Width", NOW);
    snapshot.notes = [
      note("origin", "Topology", "The active working note."),
      note("linked", "Width", "Width responds to conceptual density."),
      note("unlinked", "Private aside", "This should not be exposed."),
    ];
    snapshot.spaceOverview = {
      title: "Width and depth",
      body: "Width connects to the topology of the project.",
      relatedNoteIds: ["linked"],
      generatedAt: NOW,
      stale: false,
    };
    snapshot.concepts = [
      {
        id: "concept-width",
        label: "Width",
        aliases: [],
        description: "",
        noteIds: ["linked"],
        canonicalNoteId: "linked",
        color: "#A8B3FF",
        autoLink: true,
      },
    ];

    const result = buildAIImagePrompt(snapshot, {
      originNoteId: "origin",
      selectedMarkdown: "**Concepts widen when ambiguity rises.**",
      selectedText: "Concepts widen when ambiguity rises.",
      instruction: "Use an abstract cartographic style.",
    });

    expect(result.prompt).toContain("Concepts widen when ambiguity rises");
    expect(result.prompt).toContain("abstract cartographic style");
    expect(result.prompt).toContain("Across this Space orientation");
    expect(result.prompt).toContain("Width responds to conceptual density");
    expect(result.prompt).not.toContain("Private aside");
    expect(result.alt).toBe(
      "Generated illustration of Concepts widen when ambiguity rises.",
    );
  });

  it("honors the existing-note context preference", () => {
    const snapshot = createEmptySnapshot("Private", NOW);
    snapshot.settings.includeExistingNotesInAIContext = false;
    snapshot.notes = [
      note("origin", "Origin", "Active prose."),
      note("secret", "Secret note", "Never include this private context."),
    ];
    snapshot.spaceOverview = {
      title: "Secret orientation",
      body: "Never include this overview.",
      relatedNoteIds: ["secret"],
      generatedAt: NOW,
      stale: false,
    };

    const result = buildAIImagePrompt(snapshot, {
      originNoteId: "origin",
      selectedText: "Illustrate only this passage.",
    });

    expect(result.prompt).toContain("Illustrate only this passage");
    expect(result.prompt).not.toContain("Secret orientation");
    expect(result.prompt).not.toContain("Secret note");
  });

  it("requires a focused non-empty selection", () => {
    const snapshot = createEmptySnapshot("Empty", NOW);
    snapshot.notes = [note("origin", "Origin", "Active prose.")];

    expect(() =>
      buildAIImagePrompt(snapshot, { originNoteId: "origin" }),
    ).toThrow("Select the passage");
  });
});
