import Image from "@tiptap/extension-image";
import { Markdown } from "@tiptap/markdown";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import {
  expandOrionWikiLinks,
  restoreMarkdownFrontmatter,
  splitMarkdownFrontmatter,
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
});
