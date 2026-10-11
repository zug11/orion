import { describe, expect, it } from "vitest";
import type { Source } from "../types";
import {
  canonicalizeSourceCitations,
  removeSourceCitations,
  proseSourceCitationIds,
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
  it("finds only authored prose links when imports reconcile provenance", () => {
    const literal = [
      "---\nexample: '[Frontmatter](orion-source://frontmatter)'\n---\n",
      "`[Inline](orion-source://inline)`",
      "```md\n[Fence](orion-source://fence)\n```",
      "    [Indented](orion-source://indented)",
      "> ```md\n> [Quoted fence](orion-source://quoted-fence)\n> ```",
      "- Example:\n\n  ```md\n  [Nested fence](orion-source://nested-fence)\n  ```",
      "![Image](orion-source://image)",
      "![alt [Nested](orion-source://image-alt)](https://example.com/image)",
      "\\[Escaped](orion-source://escaped)",
      "<!-- [Comment](orion-source://comment) -->",
      "<div>\n[HTML block](orion-source://html-block)\n</div>",
      "<span>[HTML inline](orion-source://html-inline)</span>",
      "Real [Evidence](orion-source://exact-id).",
      "| Claim | Source |\n| --- | --- |\n| A | [Table](orion-source://table) |",
      "> A quoted claim [Quote](orion-source://quote).",
      "- A list claim [List](orion-source://list).",
      "## References\n\n1. [Unused](orion-source://footer-only)",
    ].join("\n\n");
    expect(proseSourceCitationIds(literal)).toEqual(["exact-id", "table", "quote", "list"]);
  });
  it("does not let a literal candidate authorize another link spelling with the same ID", () => {
    const markdown = '<div>[Literal](orion-source://same)</div>\n\n[Reference][source]\n\n[source]: orion-source://same\n\n<orion-source://same>';
    expect(proseSourceCitationIds(markdown)).toEqual([]);
  });
  it.each(["source&copy;", "source&#49;"])("rejects entity-normalized destinations instead of treating %s as an opaque ID", (id) => {
    expect(proseSourceCitationIds(`[Reference](orion-source://${id})`)).toEqual([]);
  });
  it("does not let an escaped link example consume a later real source citation", () => {
    const result = canonicalizeSourceCitations("\\[example\\]\\(https://example.com\\)\n\nOriginal: [Alpha](orion-source://source-alpha)", sources);
    expect(result.references.map((reference) => reference.sourceId)).toEqual(["source-alpha"]);
    expect(removeSourceCitations(result.markdown, ["source-alpha"], [])).not.toContain("orion-source://source-alpha");
  });
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

  it.each(["~~~", "```"])("closes CRLF %s examples before the prose and managed footer", (fence) => {
    const example = `${fence}md\r\n[Literal](orion-source://source-beta)\r\n${fence}\r\n`;
    const markdown = `---\r\nexample: '[Metadata](orion-source://source-beta)'\r\n---\r\n\r\n${example}\r\nClaim [1](orion-source://source-alpha).\r\n\r\n## References\r\n\r\n1. [Alpha field notes](orion-source://source-alpha)`;
    let result = canonicalizeSourceCitations(markdown, sources);
    expect(result.body).toContain(example);
    expect(result.references.map((item) => item.sourceId)).toEqual(["source-alpha"]);
    expect(proseSourceCitationIds(markdown)).toEqual(["source-alpha"]);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const reopened = canonicalizeSourceCitations(result.markdown, sources);
      expect(reopened).toEqual(result);
      expect(reopened.markdown.match(/## References/g)).toHaveLength(1);
      result = reopened;
    }
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

  it("preserves authored escaped brackets, backslashes and marks when removing a descriptive link", () => {
    const label = String.raw`field \[draft\] **notes** and \\ paths`;
    expect(removeSourceCitations(`Read [${label}](orion-source://source-alpha) next.`, ["source-alpha"], []))
      .toBe(`Read ${label} next.`);
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
