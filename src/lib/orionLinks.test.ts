import { describe, expect, it } from "vitest";
import { parseOrionNoteLink } from "./orionLinks";

describe("parseOrionNoteLink", () => {
  it("resolves an exact Space-scoped note citation", () => {
    expect(
      parseOrionNoteLink(
        "orion://open?space_id=space-alpha&note_id=note-auguste%20comte",
      ),
    ).toEqual({
      spaceId: "space-alpha",
      noteId: "note-auguste comte",
    });
  });

  it("rejects unrelated or incomplete deep links", () => {
    expect(parseOrionNoteLink("https://example.com")).toBeNull();
    expect(parseOrionNoteLink("orion://open?space_id=space-alpha")).toBeNull();
    expect(parseOrionNoteLink("orion://settings")).toBeNull();
  });
});
