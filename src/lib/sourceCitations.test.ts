import { describe, expect, it } from "vitest";
import type { Source } from "../types";
import {
  canonicalizeSourceCitations,
  removeSourceCitations,
} from "./sourceCitations";

const sources: Source[] = [
  {
    id: "source-alpha",
    title: "Alpha [field] notes",
    kind: "pdf",
    importedAt: "2026-08-07T00:00:00.000Z",
    text: "Alpha",
    noteIds: [],
  },
  {
    id: "source-beta",
    title: "Beta lecture",
    kind: "audio",
    importedAt: "2026-08-07T00:00:00.000Z",
    text: "Beta",
    noteIds: [],
  },
];

describe("source citation Markdown", () => {
  it("numbers legacy links by first appearance and generates one bottom entry per source", () => {
    const result = canonicalizeSourceCitations(
      "Alpha [Alpha field notes](orion-source://source-alpha), beta [Beta lecture](orion-source://source-beta), alpha again [old label](orion-source://source-alpha).",
      sources,
    );

    expect(result.body).toBe(
      "Alpha [1](orion-source://source-alpha), beta [2](orion-source://source-beta), alpha again [1](orion-source://source-alpha).",
    );
    expect(result.references.map(({ number, sourceId, title }) => ({
      number,
      sourceId,
      title,
    }))).toEqual([
      { number: 1, sourceId: "source-alpha", title: "Alpha [field] notes" },
      { number: 2, sourceId: "source-beta", title: "Beta lecture" },
    ]);
    expect(
      result.markdown.endsWith(
        "## References\n\n1. [Alpha \\[field\\] notes](orion-source://source-alpha)\n2. [Beta lecture](orion-source://source-beta)",
      ),
    ).toBe(true);
  });

  it("keeps generated references out of the editable body and remains idempotent", () => {
    const first = canonicalizeSourceCitations(
      "Claim [Lecture](orion-source://source-beta).",
      sources,
    );
    const reopened = canonicalizeSourceCitations(first.markdown, sources);

    expect(reopened).toEqual(first);
    expect(reopened.body).not.toContain("## References");
  });

  it("leaves source-link examples inside code untouched", () => {
    const markdown =
      "`[Example](orion-source://source-alpha)`\n\n```md\n[Example](orion-source://source-beta)\n```";

    expect(canonicalizeSourceCitations(markdown, sources)).toEqual({
      body: markdown,
      markdown,
      references: [],
    });
  });

  it("does not mistake a footer-shaped fenced example for managed references", () => {
    const markdown =
      "```md\n## References\n\n1. [Alpha](orion-source://source-alpha)";

    expect(canonicalizeSourceCitations(markdown, sources)).toEqual({
      body: markdown,
      markdown,
      references: [],
    });
  });

  it("preserves frontmatter, escaped links, and image syntax", () => {
    const markdown = [
      "---",
      "example: '[Alpha](orion-source://source-alpha)'",
      "---",
      "",
      "\\[Alpha](orion-source://source-alpha)",
      "",
      "![Alpha](orion-source://source-alpha)",
    ].join("\n");

    expect(canonicalizeSourceCitations(markdown, sources)).toEqual({
      body: markdown,
      markdown,
      references: [],
    });
  });

  it("recognizes a canonical References footer with CRLF line endings", () => {
    const markdown =
      "Claim [1](orion-source://source-alpha).\r\n\r\n## References\r\n\r\n1. [Alpha field notes](orion-source://source-alpha)";
    const result = canonicalizeSourceCitations(markdown, sources);

    expect(result.body).toBe("Claim [1](orion-source://source-alpha).");
    expect(result.references).toHaveLength(1);
    expect(result.markdown.match(/## References/g)).toHaveLength(1);
  });

  it("removes numeric citations to a deleted source and compacts survivors", () => {
    const canonical = canonicalizeSourceCitations(
      "First [Alpha](orion-source://source-alpha). Second [Beta](orion-source://source-beta).",
      sources,
    ).markdown;

    expect(
      removeSourceCitations(canonical, ["source-alpha"], [sources[1]]),
    ).toBe(
      "First. Second [1](orion-source://source-beta).\n\n## References\n\n1. [Beta lecture](orion-source://source-beta)",
    );
  });

  it("keeps descriptive prose from legacy links when their source is deleted", () => {
    expect(
      removeSourceCitations(
        "Read [the field notes](orion-source://source-alpha) next.",
        ["source-alpha"],
        [sources[1]],
      ),
    ).toBe("Read the field notes next.");
  });

  it("leaves unrelated citation Markdown byte-for-byte unchanged on deletion", () => {
    const markdown =
      "Read [Beta lecture](orion-source://source-beta).\n\nExtra spacing.\n";

    expect(
      removeSourceCitations(markdown, ["source-alpha"], [sources[1]]),
    ).toBe(markdown);
  });

  it("retains a numeric legacy label when no generated footer identifies it as a marker", () => {
    expect(
      removeSourceCitations(
        "The [2024](orion-source://source-alpha) report.",
        ["source-alpha"],
        [sources[1]],
      ),
    ).toBe("The 2024 report.");
  });
});
