// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { AppSnapshot, Concept, Note, Source } from "../types";
import {
  buildWebExportDocument,
  linkedNoteIdsForExport,
  notesForExportScope,
} from "./webExport";

const NOW = "2026-08-07T05:00:00.000Z";

function note(id: string, title: string, body: string, summary = ""): Note {
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary,
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

function fixture(): AppSnapshot {
  const snapshot = createEmptySnapshot("Comte seminar", NOW);
  snapshot.workspace.description = "A connected reading of positive philosophy.";
  snapshot.notes = [
    note(
      "note-origin",
      "The positive project",
      [
        "## Argument",
        "Positivism shaped Sociology. Read [Comte](orion-note://note-comte).",
        "",
        "A grounded claim [Lecture](orion-source://source-lecture).",
        "",
        "<script>window.ORION_LEAK = 'source transcript secret';</script>",
        "",
        "<!-- orion-note:note-origin:end -->",
      ].join("\n"),
      "Order, progress, and the sciences.",
    ),
    note("note-comte", "Auguste Comte", "## Life\nA system builder."),
    note("note-sociology", "Sociology", "## Definition\nThe study of society."),
    note("note-unrelated", "Shopping", "- [ ] Buy tea"),
  ];
  const concept: Concept = {
    id: "concept-sociology",
    label: "Sociology",
    aliases: [],
    description: "The systematic study of society.",
    noteIds: ["note-sociology"],
    canonicalNoteId: "note-sociology",
    color: "#8fa2ff",
    autoLink: true,
  };
  snapshot.concepts = [concept];
  const source: Source = {
    id: "source-lecture",
    title: "Lecture on Comte",
    kind: "pdf",
    importedAt: NOW,
    sourceUrl: "https://example.com/comte.pdf",
    text: "source transcript secret",
    noteIds: ["note-origin"],
  };
  snapshot.sources = [source];
  return snapshot;
}

describe("web export scope", () => {
  it("collects explicit and automatic links for exactly one hop", () => {
    const snapshot = fixture();
    const linked = linkedNoteIdsForExport(snapshot.notes[0], snapshot);

    expect(linked).toEqual(["note-comte", "note-sociology"]);
    expect(
      notesForExportScope(snapshot, "linked", "note-origin").map(({ id }) => id),
    ).toEqual(["note-origin", "note-comte", "note-sociology"]);
    expect(
      notesForExportScope(snapshot, "note", "note-origin").map(({ id }) => id),
    ).toEqual(["note-origin"]);
    expect(notesForExportScope(snapshot, "space", null)).toHaveLength(4);
  });
});

describe("self-contained web article", () => {
  it("preserves Orion links and citations without exporting raw source text", () => {
    const result = buildWebExportDocument(fixture(), "linked", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const pageTitles = [...document.querySelectorAll<HTMLElement>(".export-note")]
      .map((page) => page.dataset.pageTitle);

    expect(result.fileName).toBe("the-positive-project.html");
    expect(result.noteIds).toEqual([
      "note-origin",
      "note-comte",
      "note-sociology",
    ]);
    expect(pageTitles).toEqual([
      "The positive project",
      "Auguste Comte",
      "Sociology",
    ]);
    expect(document.querySelector('.orion-link[href*="auguste-comte"]')?.textContent).toBe(
      "Comte",
    );
    expect(document.querySelector('.orion-link[href*="sociology"]')?.textContent).toBe(
      "Sociology",
    );
    expect(document.querySelector(".source-citation")?.textContent).toBe("[1]");
    expect(document.querySelector(".export-references")?.textContent).toContain(
      "Lecture on Comte",
    );
    expect(
      document.querySelector('.export-references a[href="https://example.com/comte.pdf"]'),
    ).not.toBeNull();
    expect(result.html).not.toContain("source transcript secret");
    expect(result.html).not.toContain("orion-note:note-origin:end");
    expect(result.html).not.toContain("window.ORION_LEAK");
  });

  it("renders excluded destinations as inert readable text", () => {
    const result = buildWebExportDocument(fixture(), "note", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");

    expect(result.noteIds).toEqual(["note-origin"]);
    expect(document.querySelectorAll(".export-note")).toHaveLength(1);
    expect(document.querySelector(".orion-link.is-excluded")?.textContent).toMatch(
      /Sociology|Comte/,
    );
    expect(document.querySelector('.orion-link[href*="auguste-comte"]')).toBeNull();
  });

  it("includes an offline CSP, embedded styles, and a whole-Space cover", () => {
    const result = buildWebExportDocument(fixture(), "space", null);
    const document = new DOMParser().parseFromString(result.html, "text/html");

    expect(result.html).toMatch(/^<!doctype html>/);
    expect(
      document
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
    ).toContain("default-src 'none'");
    expect(document.querySelector("style")?.textContent?.length).toBeGreaterThan(5_000);
    expect(document.querySelector("#space-home")?.textContent).toContain("Comte seminar");
    expect(document.querySelectorAll(".export-card")).toHaveLength(4);
    expect(document.querySelector('link[rel="stylesheet"]')).toBeNull();
  });
});
