import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import {
  expandOrionWikiLinks,
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
  stripOrionLinksToTargets,
  stripOrionNoteMarkers,
} from "./markdown";
import type { Concept, Note } from "../types";

const TEST_NOW = "2026-07-27T10:00:00.000Z";

describe("Markdown frontmatter preservation", () => {
  it("keeps imported metadata byte-for-byte outside the visual editor", () => {
    const markdown =
      "---\ntitle: Field notes\ntags:\n  - research\n---\n\n## Findings\n\nText.";
    const split = splitMarkdownFrontmatter(markdown);

    expect(split.prefix).toBe(
      "---\ntitle: Field notes\ntags:\n  - research\n---\n\n",
    );
    expect(split.content).toBe("## Findings\n\nText.");
    expect(
      restoreMarkdownFrontmatter(split.prefix, split.content),
    ).toBe(markdown);
  });

  it("leaves ordinary note content unchanged", () => {
    const markdown = "A paragraph with a --- divider inside it.";
    const split = splitMarkdownFrontmatter(markdown);

    expect(split).toEqual({ content: markdown, prefix: "" });
  });

  it("hides raw and editor-escaped Orion note markers", () => {
    const markdown = [
      "## Context from Lecture",
      "",
      "Source-grounded detail.",
      "",
      "<!-- orion-note:note-tlXRJO_2S8:end -->",
      "",
      "&lt;!-- orion-note:note-other:start --&gt;",
      "",
      "Visible prose.",
    ].join("\n");

    expect(stripOrionNoteMarkers(markdown)).toBe(
      [
        "## Context from Lecture",
        "",
        "Source-grounded detail.",
        "",
        "Visible prose.",
      ].join("\n"),
    );
  });

  it("preserves Tiptap table spacing when there are no legacy markers", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        TableKit.configure({
          table: { resizable: false, renderWrapper: true },
        }),
        Markdown.configure({ markedOptions: { gfm: true } }),
      ],
      content: "Before\n\nAfter",
      contentType: "markdown",
    });
    editor.commands.setTextSelection(7);
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
    editor.commands.insertContent("First cell");

    const serialized = editor.getMarkdown();
    expect(serialized).toContain("Before\n\n\n| First cell");
    expect(stripOrionNoteMarkers(serialized)).toBe(serialized);

    editor.destroy();
  });

  it("round-trips images and rich formatting through the visual editor", () => {
    const editor = new Editor({
      extensions: [
        StarterKit,
        Image,
        Markdown.configure({ markedOptions: { gfm: true } }),
      ],
      content:
        "## Findings\n\n**Strong evidence**\n\n![Constellation](https://example.com/orion.png)",
      contentType: "markdown",
    });

    expect(editor.getMarkdown()).toContain("## Findings");
    expect(editor.getMarkdown()).toContain("**Strong evidence**");
    expect(editor.getMarkdown()).toContain(
      "![Constellation](https://example.com/orion.png)",
    );
    editor.destroy();
  });
});

describe("visual wiki links", () => {
  const concept: Concept = {
    id: "concept-positivism",
    label: "Positivism",
    aliases: ["positive philosophy"],
    description: "",
    noteIds: ["note-positivism"],
    canonicalNoteId: "note-positivism",
    color: "#8ea4ff",
    autoLink: true,
  };
  const note: Note = {
    id: "note-positivism",
    title: "Positivism",
    slug: "positivism",
    summary: "",
    body: "",
    aliases: [],
    tags: [],
    kind: "wiki",
    status: "ready",
    conceptIds: [concept.id],
    sourceIds: [],
    createdAt: TEST_NOW,
    updatedAt: TEST_NOW,
  };

  it("turns readable AI wiki syntax into an Orion concept link", () => {
    expect(
      expandOrionWikiLinks(
        "Comte treated [[Positivism]] as an alternative.",
        [note],
        [concept],
      ),
    ).toBe(
      "Comte treated [Positivism](orion-concept://concept-positivism) as an alternative.",
    );
  });

  it("supports aliases, labels, and explicit note destinations", () => {
    expect(
      expandOrionWikiLinks(
        "[[positive philosophy|Comte's method]] and [[note:positivism|its article]]",
        [note],
        [concept],
      ),
    ).toBe(
      "[Comte's method](orion-concept://concept-positivism) and [its article](orion-note://note-positivism)",
    );
  });

  it("repairs wiki brackets escaped by the visual editor", () => {
    expect(
      expandOrionWikiLinks(
        "Comte treated \\[\\[Positivism\\]\\] as an alternative.",
        [note],
        [concept],
      ),
    ).toBe(
      "Comte treated [Positivism](orion-concept://concept-positivism) as an alternative.",
    );
  });

  it("hides unresolved storage syntax without mutating code examples", () => {
    const markdown = [
      "An [[Unresolved idea]] remains readable.",
      "",
      "`[[Positivism]]`",
      "",
      "```md",
      "[[Positivism]]",
      "```",
    ].join("\n");

    expect(expandOrionWikiLinks(markdown, [note], [concept])).toBe(
      [
        "An Unresolved idea remains readable.",
        "",
        "`[[Positivism]]`",
        "",
        "```md",
        "[[Positivism]]",
        "```",
      ].join("\n"),
    );
  });

  it("removes deleted Orion destinations without deleting their words", () => {
    const markdown =
      "[Positivism](orion-concept://concept-positivism), [its article](orion-note://note-positivism), and [Lecture 4](orion-source://source-lecture) remain readable beside [Comte](orion-note://note-comte).";

    expect(
      stripOrionLinksToTargets(markdown, {
        conceptIds: ["concept-positivism"],
        noteIds: ["note-positivism"],
        sourceIds: ["source-lecture"],
      }),
    ).toBe(
      "Positivism, its article, and Lecture 4 remain readable beside [Comte](orion-note://note-comte).",
    );
  });
});
