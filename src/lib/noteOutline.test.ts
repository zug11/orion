import { describe, expect, it } from "vitest";
import {
  extractNoteOutline,
  resolveActiveOutlineHeading,
} from "./noteOutline";

describe("extractNoteOutline", () => {
  it("extracts all heading levels with stable duplicate anchors", () => {
    expect(
      extractNoteOutline(
        [
          "# Document title",
          "## First **section**",
          "### [Details](https://example.com)",
          "## First section",
        ].join("\n"),
      ),
    ).toEqual([
      {id:"heading-document-title",text:"Document title",level:1,line:1},
      {
        id: "heading-first-section",
        text: "First section",
        level: 2,
        line: 2,
      },
      {
        id: "heading-details",
        text: "Details",
        level: 3,
        line: 3,
      },
      {
        id: "heading-first-section-2",
        text: "First section",
        level: 2,
        line: 4,
      },
    ]);
  });

  it("keeps deep headings visible and ignores unsupported levels", () => {
    expect(extractNoteOutline("#### Four\n##### Five\n###### Six\n####### Not a heading").map(({level})=>level)).toEqual([4,5,6]);
  });

  it("ignores headings inside fenced code blocks", () => {
    expect(
      extractNoteOutline(
        ["## Visible", "```md", "## Hidden", "```", "### Visible too"].join(
          "\n",
        ),
      ).map((heading) => heading.text),
    ).toEqual(["Visible", "Visible too"]);
  });

  it("keeps the final section active when it cannot reach the top threshold", () => {
    const headings = [
      { id: "heading-first", top: 80 },
      { id: "heading-last", top: 460 },
    ];

    expect(resolveActiveOutlineHeading(headings, 112)).toBe("heading-first");
    expect(resolveActiveOutlineHeading(headings, 112, true)).toBe(
      "heading-last",
    );
  });
});
