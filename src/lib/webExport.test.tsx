// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { AppSnapshot, Concept, Note, Source } from "../types";
import {
  buildWebExportDocument,
  linkedNoteIdsForExport,
  notesForExportScope,
} from "./webExport";
import { resolveThemePalette, type ThemePalette } from "./theme";

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

function expectExportPalette(
  styles: string,
  palette: ThemePalette,
  mode: "dark" | "light",
) {
  const expected = {
    "--canvas": palette.canvas,
    "--canvas-deep": palette.canvasDeep,
    "--surface": `color-mix(in srgb, ${palette.surface1} 92%, transparent)`,
    "--surface-0": palette.surface0,
    "--surface-solid": palette.surface1,
    "--surface-2": palette.surface2,
    "--surface-3": palette.surface3,
    "--surface-raised": palette.surfaceRaised,
    "--text": palette.text,
    "--text-soft": palette.textSoft,
    "--muted": palette.muted,
    "--faint": palette.faint,
    "--line": palette.line,
    "--line-strong": palette.lineStrong,
    "--accent": palette.accent,
    "--accent-soft": `color-mix(in srgb, ${palette.accent} ${mode === "dark" ? 13 : 10}%, transparent)`,
    "--accent-strong": palette.accentStrong,
    "--accent-ink": palette.accentInk,
    "--mint": palette.mint,
    "--gold": palette.gold,
    "--rose": palette.rose,
    "--danger": palette.danger,
    "--code": palette.surface2,
    "--shadow-soft": palette.shadowSm,
    "--shadow": palette.shadowMd,
    "--shadow-lg": palette.shadowLg,
  };

  for (const [name, value] of Object.entries(expected)) {
    expect(styles).toContain(`${name}: ${value};`);
  }
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
  it("keeps managed note images for native offline inlining", () => {
    const snapshot = fixture();
    snapshot.notes[0].body +=
      "\n\n![System map](orion-image://localhost/image_123456789012345678)";
    const result = buildWebExportDocument(snapshot, "note", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");

    expect(
      document.querySelector('img[alt="System map"]')?.getAttribute("src"),
    ).toBe("orion-image://localhost/image_123456789012345678");
    expect(result.html).toContain("img-src data:");
  });

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

  it.each([
    {
      name: "curated tuning",
      settings: {
        themePreset: "grove" as const,
        themeAccent: "moss" as const,
        themeAccentCustom: "",
        themeCanvasTone: "airy" as const,
        themeCanvasCustom: "",
        themeSurfaceLift: "lifted" as const,
        themeSurfaceCustom: "",
        themeTextWarmth: "cool" as const,
        themeContrast: "soft" as const,
      },
    },
    {
      name: "custom color overrides",
      settings: {
        themePreset: "ember" as const,
        themeAccent: "tide" as const,
        themeAccentCustom: "#56A8D8",
        themeCanvasTone: "deep" as const,
        themeCanvasCustom: "#102030",
        themeSurfaceLift: "quiet" as const,
        themeSurfaceCustom: "#17283A",
        themeTextWarmth: "warm" as const,
        themeContrast: "high" as const,
      },
    },
  ])("inherits the full $name palette in an explicit mode", ({ settings }) => {
    const snapshot = fixture();
    snapshot.settings = { ...snapshot.settings, ...settings, theme: "dark" };
    const expected = resolveThemePalette(snapshot.settings, "dark");
    const result = buildWebExportDocument(snapshot, "note", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const styles = document.querySelector("style")?.textContent ?? "";

    expectExportPalette(styles, expected, "dark");
    expect(styles).not.toContain("@media (prefers-color-scheme: dark)");
    expect(
      document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
    ).toBe("dark");
    expect(
      document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
    ).toBe(expected.canvas);
  });

  it("keeps a customized System theme adaptive in the exported webpage", () => {
    const snapshot = fixture();
    snapshot.settings = {
      ...snapshot.settings,
      theme: "system",
      themePreset: "tide",
      themeAccent: "iris",
      themeCanvasTone: "deep",
      themeSurfaceLift: "lifted",
      themeTextWarmth: "warm",
      themeContrast: "high",
    };
    const light = resolveThemePalette(snapshot.settings, "light");
    const dark = resolveThemePalette(snapshot.settings, "dark");
    const result = buildWebExportDocument(snapshot, "space", null);
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const styles = document.querySelector("style")?.textContent ?? "";

    expectExportPalette(styles, light, "light");
    expectExportPalette(styles, dark, "dark");
    expect(styles).toContain("@media (prefers-color-scheme: dark)");
    expect(
      document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
    ).toBe("light dark");
    expect(
      document
        .querySelector('meta[name="theme-color"][media="(prefers-color-scheme: light)"]')
        ?.getAttribute("content"),
    ).toBe(light.canvas);
    expect(
      document
        .querySelector('meta[name="theme-color"][media="(prefers-color-scheme: dark)"]')
        ?.getAttribute("content"),
    ).toBe(dark.canvas);
  });

  it("derives safe export colors without serializing settings or CSS-like input", () => {
    const snapshot = fixture();
    snapshot.settings.organizationInstructions = "PRIVATE EXPORT INSTRUCTIONS";
    snapshot.settings.themeAccentCustom = "#112233;}</style><script>unsafe()</script>";
    const result = buildWebExportDocument(snapshot, "note", "note-origin");

    expect(result.html).not.toContain("PRIVATE EXPORT INSTRUCTIONS");
    expect(result.html).not.toContain("unsafe()");
    expect(result.html).not.toContain("#112233;");
  });
});
