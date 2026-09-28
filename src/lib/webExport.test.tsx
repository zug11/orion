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
import { serializeNoteImageTitle } from "./noteImageLayout";
import { createNoteExcerptSelection, encodeNoteExcerptTitle } from "./noteExcerpts";

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


describe("preview editor export compatibility", () => {
  it("preserves table metadata code examples while suppressing actual layout comments", () => {
    const snapshot = fixture();
    const metadata = '<!-- orion-table:v1 {"width":74,"header":false,"columns":[127,220]} -->';
    snapshot.notes[0].body = ["```markdown", metadata, "| | |", "| --- | --- |", "| Example | Code |", "```", "", `Inline: \`${metadata}\``, "", metadata, "| | |", "| --- | --- |", "| Actual | Content |"].join("\n");
    const document = new DOMParser().parseFromString(buildWebExportDocument(snapshot, "note", "note-origin").html, "text/html");
    const prose = document.querySelector(".export-prose")!;
    expect(prose.querySelector("pre code")?.textContent).toContain(metadata);
    expect(prose.querySelector("p code")?.textContent).toBe(metadata);
    expect(prose.textContent?.match(/orion-table:v1/g)).toHaveLength(2);
    const table = prose.querySelector<HTMLElement>(".note-table-reading")!;
    expect(table.style.width).toBe("74%");
    expect(table.dataset.header).toBe("false");
    expect(table.querySelector("thead")).toBeNull();
    expect(table.querySelector("col")?.getAttribute("style")).toContain("127px");
  });

  it("preserves headerless table rows, column widths and banding after document normalization", () => {
    const snapshot = fixture();
    snapshot.notes[0].body = [
      "---", "private: frontmatter", "---", "", "# The positive project", "",
      '<!-- orion-table:v1 {"width":65,"header":false,"banded":false,"columns":[160,220]} -->',
      "| | |", "| --- | --- |", "| First author row | Right cell |", "| Second author row | More evidence |",
    ].join("\n");
    const result = buildWebExportDocument(snapshot, "note", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const wrapper = document.querySelector<HTMLElement>(".note-table-reading")!;
    expect(wrapper.style.width).toBe("65%");
    expect(wrapper.dataset.header).toBe("false");
    expect(wrapper.dataset.banded).toBe("false");
    expect(wrapper.querySelector("thead")).toBeNull();
    expect([...wrapper.querySelectorAll("tbody tr")].map((row) => row.textContent)).toEqual([
      "First author rowRight cell", "Second author rowMore evidence",
    ]);
    expect([...wrapper.querySelectorAll<HTMLElement>("col")].map((column) => column.style.width)).toEqual(["160px", "220px"]);
    expect(window.getComputedStyle(wrapper.querySelector("table")!).display).toBe("table");
    expect(result.html).not.toContain("orion-table:v1");
    expect(result.html).not.toContain("private: frontmatter");
  });

  it("never hides an authored header merely because pasted metadata claims it is synthetic", () => {
    const snapshot = fixture();
    snapshot.notes[0].body = '<!-- orion-table:v1 {"header":false,"width":"35%;color:red","columns":[-100,999999]} -->\n| Keep this header | Evidence |\n| --- | --- |\n| A | B |';
    const result = buildWebExportDocument(snapshot, "note", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const wrapper = document.querySelector<HTMLElement>(".note-table-reading")!;
    expect(wrapper.dataset.header).toBe("true");
    expect(wrapper.querySelector("thead")?.textContent).toContain("Keep this header");
    expect(wrapper.style.width).toBe("100%");
    expect([...wrapper.querySelectorAll<HTMLElement>("col")].map((column) => column.style.width)).toEqual(["48px", "2000px"]);
    expect(result.html).not.toContain("35%;color:red");
  });

  it("exports anchored image wrapping and caption as inert text without leaking layout payloads", () => {
    const snapshot = fixture();
    snapshot.notes[0].summary = "";
    const caption = 'A curved surface ) <img src=x onerror="leak()">';
    const title = serializeNoteImageTitle({ placement: "wrap", alignment: "right", widthPercent: 45, gap: 22, caption, showCaption: true }, "Original photograph");
    snapshot.notes[0].body = `![Surface](orion-image://localhost/image_123456789012345678 "${title}")\n\nOrdinary surrounding prose.`;
    const result = buildWebExportDocument(snapshot, "space", null);
    const document = new DOMParser().parseFromString(result.html, "text/html");
    const wrapper = document.querySelector<HTMLElement>(".note-image-reading")!;
    expect(wrapper.style.float).toBe("right");
    expect(wrapper.style.width).toBe("45%");
    expect(wrapper.getAttribute("style")).toContain("margin-left:22px");
    expect(wrapper.textContent).toBe(caption);
    expect(wrapper.querySelector("img")?.getAttribute("title")).toBe("Original photograph");
    expect(wrapper.querySelectorAll("img")).toHaveLength(1);
    expect(wrapper.querySelector("[onerror]")).toBeNull();
    expect(document.querySelector("style")?.textContent).toMatch(/\.export-prose\s*\{[^}]*display:\s*flow-root/);
    expect(document.querySelector(".export-card span")?.textContent).toBe("Surface Ordinary surrounding prose.");
    expect(result.html).not.toContain("orion-image-layout:v1:");
  });

  it("rejects active and remote image URLs even when they carry valid layout metadata", () => {
    const snapshot = fixture();
    const metadata = serializeNoteImageTitle({ placement: "wrap", alignment: "left", widthPercent: 40 });
    snapshot.notes[0].body = `![Remote](https://example.com/tracker.png "${metadata}")\n\n![Active](data:image/svg+xml;base64,PHN2Zz4= "${metadata}")`;
    const document = new DOMParser().parseFromString(buildWebExportDocument(snapshot, "note", "note-origin").html, "text/html");
    expect(document.querySelectorAll(".export-prose img")).toHaveLength(0);
    expect(document.querySelector(".export-prose")?.textContent).toContain("Image: Remote");
    expect(document.querySelector(".export-prose")?.textContent).toContain("Image: Active");
  });

  it("exports bounded free image placement with an intrinsic caption box and no active payload", () => {
    const snapshot = fixture();
    const title = serializeNoteImageTitle({ placement: "wrap", widthPercent: 35, xPercent: 17.25, offsetY: 140,
      gap: 20, caption: '<img src=x onerror="leak()">', showCaption: true });
    snapshot.notes[0].body = `![Surface](orion-image://localhost/image_123456789012345678 "${title}")\n\nProse can flow above and beside this image.`;
    const document = new DOMParser().parseFromString(buildWebExportDocument(snapshot, "note", "note-origin").html, "text/html");
    const wrapper = document.querySelector<HTMLElement>(".note-image-reading")!;
    const content = wrapper.querySelector<HTMLElement>(".note-image-free-content")!;
    expect(wrapper.style.width).toBe("100%");
    expect(wrapper.style.float).toBe("left");
    expect(wrapper.style.paddingTop).toBe("160px");
    expect(wrapper.getAttribute("style")).toContain("shape-outside:inset(140px max(0px, calc(47.75% - 20px)) 0 0)");
    expect(wrapper.style.pointerEvents).toBe("none");
    expect(content.style.width).toBe("35%");
    expect(content.style.marginLeft).toBe("17.25%");
    expect(content.style.pointerEvents).toBe("auto");
    expect(content.style.position).toBe("");
    expect(content.textContent).toBe('<img src=x onerror="leak()">');
    expect(content.querySelectorAll("img")).toHaveLength(1);
    expect(content.querySelector("[onerror]")).toBeNull();
    expect(document.querySelector(".export-prose")?.textContent).not.toContain("orion-image-layout");
  });

  it("gives all six heading levels unique outline targets after removing the duplicate note title", () => {
    const snapshot = fixture();
    snapshot.notes[0].body = "# The positive project\n\n# Opening\n\n## Theme\n\n### Theme\n\n#### Close reading\n\n##### Evidence\n\n###### Qualification\n\n###### Qualification";
    const document = new DOMParser().parseFromString(buildWebExportDocument(snapshot, "note", "note-origin").html, "text/html");
    const headings = [...document.querySelectorAll<HTMLElement>(".export-prose h1, .export-prose h2, .export-prose h3, .export-prose h4, .export-prose h5, .export-prose h6")];
    const links = [...document.querySelectorAll<HTMLAnchorElement>(".export-outline a")];
    expect(headings.map((heading) => heading.tagName)).toEqual(["H1", "H2", "H3", "H4", "H5", "H6", "H6"]);
    expect(new Set(headings.map((heading) => heading.id)).size).toBe(7);
    expect(links.map((link) => link.dataset.depth)).toEqual(["1", "2", "3", "4", "5", "6", "6"]);
    links.forEach((link, index) => expect(document.getElementById(link.hash.slice(1))).toBe(headings[index]));
    expect(document.querySelector("style")?.textContent).toContain(".export-prose h6");
    expect(document.querySelector("style")?.textContent).toMatch(/\.export-prose h6\s*\{[^}]*font-style:\s*italic/);
  });

  it("preserves frozen excerpt words and source attribution within the chosen one-hop scope", () => {
    const snapshot = fixture();
    const source = snapshot.notes[1];
    source.body = "A first precise sentence. A second precise sentence.\n\n[Further reading](orion-note://note-unrelated)";
    const selection = createNoteExcerptSelection(source, [{ from: 0, to: 25 }, { from: 25, to: 51 }]);
    const metadata = encodeNoteExcerptTitle(selection);
    snapshot.notes[0].body = `> ${selection.text}\n>\n> [${source.title}](orion-note://${source.id} "${metadata}")`;
    // Source changes after capture must not rewrite the quoted words.
    source.body = "The source was rewritten.\n\n[Further reading](orion-note://note-unrelated)";
    const single = buildWebExportDocument(snapshot, "note", "note-origin");
    const singleDoc = new DOMParser().parseFromString(single.html, "text/html");
    expect(singleDoc.querySelector("blockquote")?.textContent).toContain(selection.text);
    expect(singleDoc.querySelector(".note-excerpt-source-link .is-excluded")?.textContent).toBe(source.title);
    expect(singleDoc.querySelector(".note-excerpt-source-link a")).toBeNull();
    const linked = buildWebExportDocument(snapshot, "linked", "note-origin");
    const linkedDoc = new DOMParser().parseFromString(linked.html, "text/html");
    expect(linked.noteIds).toEqual(["note-origin", "note-comte"]);
    const link = linkedDoc.querySelector<HTMLAnchorElement>(".note-excerpt-source-link a")!;
    expect(linkedDoc.getElementById(link.hash.slice(1))?.dataset.pageTitle).toBe(source.title);
    expect(linked.html).not.toContain("orion-excerpt:v1:");
    expect(link.hasAttribute("title")).toBe(false);
  });

  it("does not resolve an excerpt's missing note ID to a same-title note in this Space", () => {
    const snapshot = fixture();
    const outside = note("other-space-note", snapshot.notes[1].title, "Outside quote");
    const selection = createNoteExcerptSelection(outside, [{ from: 0, to: 13 }]);
    snapshot.notes[0].body = `> Outside quote\n>\n> [${outside.title}](orion-note://${outside.id} "${encodeNoteExcerptTitle(selection)}")`;
    const result = buildWebExportDocument(snapshot, "linked", "note-origin");
    const document = new DOMParser().parseFromString(result.html, "text/html");
    expect(result.noteIds).toEqual(["note-origin"]);
    expect(document.querySelector(".note-excerpt-source-link a")).toBeNull();
    expect(document.querySelector(".note-excerpt-source-link")?.textContent).toBe(outside.title);
  });

  it("keeps table metadata out of whole-Space preview snippets and visible word counts", () => {
    const snapshot = fixture();
    snapshot.notes[0].summary = "";
    snapshot.notes[0].body = '<!-- orion-table:v1 {"width":65,"header":true,"banded":false,"columns":[160,220]} -->\n| Material | Finding |\n| --- | --- |\n| Glass | Clear |';
    const document = new DOMParser().parseFromString(buildWebExportDocument(snapshot, "space", null).html, "text/html");
    expect(document.querySelector(".export-card span")?.textContent).toBe("Material Finding Glass Clear");
    expect(document.querySelector(".export-note-meta")?.textContent).toContain("4 words");
    expect(document.body.textContent).not.toContain("orion-table:v1");
  });
});
