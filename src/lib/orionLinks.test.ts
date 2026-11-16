import { describe, expect, it } from "vitest";
import { parseOrionNoteLink } from "./orionLinks";

describe("parseOrionNoteLink", () => {
  it('keeps ticket/board destinations scoped and rejects malformed targets',()=>{
    expect(parseOrionNoteLink('orion://open?space_id=s&note_id=n&ticket_id=t')).toEqual({spaceId:'s',noteId:'n',ticketId:'t'});
    expect(parseOrionNoteLink('orion://open?space_id=s&note_id=n&board_id=b')).toEqual({spaceId:'s',noteId:'n',boardId:'b'});
    expect(parseOrionNoteLink('orion://open?space_id=s&note_id=n&ticket_id=t&board_id=b')).toBeNull();
    expect(parseOrionNoteLink('orion://open?space_id=s&note_id=n&ticket_id=bad%2Fid')).toBeNull();
  });
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
