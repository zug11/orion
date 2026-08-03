import { describe, expect, it } from "vitest";
import {
  createNoteHistoryEntry,
  moveNoteHistory,
  pushNoteHistory,
  readScrollPosition,
  resetScrollPosition,
  restoreScrollPosition,
} from "./navigation";

describe("resetScrollPosition", () => {
  it("returns note navigation to the top-left of its scroll pane", () => {
    const pane = { scrollLeft: 18, scrollTop: 640 };

    resetScrollPosition(pane);

    expect(pane).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it("accepts a missing pane while the layout is changing", () => {
    expect(() => resetScrollPosition(null)).not.toThrow();
  });

  it("reads and restores an exact prior reading position", () => {
    const pane = { scrollLeft: 4, scrollTop: 1280 };
    const position = readScrollPosition(pane);
    resetScrollPosition(pane);
    restoreScrollPosition(pane, position);

    expect(pane).toEqual({ scrollLeft: 4, scrollTop: 1280 });
  });
});

describe("note history scroll restoration", () => {
  it("records the origin before a link opens a new note at the top", () => {
    const result = pushNoteHistory(
      [createNoteHistoryEntry("note-story")],
      0,
      "note-character",
      { scrollLeft: 0, scrollTop: 920 },
    );

    expect(result).toEqual({
      entries: [
        { noteId: "note-story", scrollLeft: 0, scrollTop: 920 },
        { noteId: "note-character", scrollLeft: 0, scrollTop: 0 },
      ],
      index: 1,
    });
  });

  it("restores Back and Forward positions while recording the page being left", () => {
    const entries = [
      createNoteHistoryEntry("note-story", {
        scrollLeft: 0,
        scrollTop: 920,
      }),
      createNoteHistoryEntry("note-character"),
    ];
    const back = moveNoteHistory(entries, 1, -1, {
      scrollLeft: 0,
      scrollTop: 260,
    });
    const forward = moveNoteHistory(
      back!.entries,
      back!.index,
      1,
      { scrollLeft: 0, scrollTop: 940 },
    );

    expect(back?.entries[1].scrollTop).toBe(260);
    expect(back?.entries[back.index].scrollTop).toBe(920);
    expect(forward?.entries[0].scrollTop).toBe(940);
    expect(forward?.entries[forward.index].scrollTop).toBe(260);
  });

  it("drops forward history after following a different link from Back", () => {
    const result = pushNoteHistory(
      [
        createNoteHistoryEntry("note-story", { scrollLeft: 0, scrollTop: 600 }),
        createNoteHistoryEntry("note-old-branch", {
          scrollLeft: 0,
          scrollTop: 180,
        }),
      ],
      0,
      "note-new-branch",
      { scrollLeft: 0, scrollTop: 640 },
    );

    expect(result.entries.map((entry) => entry.noteId)).toEqual([
      "note-story",
      "note-new-branch",
    ]);
    expect(result.entries[0].scrollTop).toBe(640);
  });
});
