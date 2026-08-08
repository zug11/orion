import { describe, expect, it } from "vitest";
import {
  createNavigationEntry,
  moveNavigationHistory,
  pushNavigationHistory,
  readScrollPosition,
  resetScrollPosition,
  restoreScrollPosition,
} from "./navigation";

describe("resetScrollPosition", () => {
  it("returns direct navigation to the top-left of its scroll pane", () => {
    const pane = { scrollLeft: 18, scrollTop: 640 };

    resetScrollPosition(pane);

    expect(pane).toEqual({ scrollLeft: 0, scrollTop: 0 });
  });

  it("accepts a missing pane while the layout is changing", () => {
    expect(() => resetScrollPosition(null)).not.toThrow();
  });

  it("reads and restores an exact prior position", () => {
    const pane = { scrollLeft: 4, scrollTop: 1280 };
    const position = readScrollPosition(pane);
    resetScrollPosition(pane);
    restoreScrollPosition(pane, position);

    expect(pane).toEqual({ scrollLeft: 4, scrollTop: 1280 });
  });
});

describe("route history scroll restoration", () => {
  it("records the Notes list before opening a note at the top", () => {
    const result = pushNavigationHistory(
      [createNavigationEntry({ screen: "notes" })],
      0,
      { screen: "note", noteId: "note-character" },
      { scrollLeft: 0, scrollTop: 920 },
    );

    expect(result).toEqual({
      entries: [
        {
          route: { screen: "notes" },
          scrollLeft: 0,
          scrollTop: 920,
        },
        {
          route: { screen: "note", noteId: "note-character" },
          scrollLeft: 0,
          scrollTop: 0,
        },
      ],
      index: 1,
    });
  });

  it("restores list and note positions while recording the route being left", () => {
    const entries = [
      createNavigationEntry(
        { screen: "notes" },
        { scrollLeft: 0, scrollTop: 920 },
      ),
      createNavigationEntry({ screen: "note", noteId: "note-character" }),
    ];
    const back = moveNavigationHistory(entries, 1, -1, {
      scrollLeft: 0,
      scrollTop: 260,
    });
    const forward = moveNavigationHistory(
      back!.entries,
      back!.index,
      1,
      { scrollLeft: 0, scrollTop: 940 },
    );

    expect(back?.entries[1].scrollTop).toBe(260);
    expect(back?.entries[back.index].route).toEqual({ screen: "notes" });
    expect(back?.entries[back.index].scrollTop).toBe(920);
    expect(forward?.entries[0].scrollTop).toBe(940);
    expect(forward?.entries[forward.index].route).toEqual({
      screen: "note",
      noteId: "note-character",
    });
    expect(forward?.entries[forward.index].scrollTop).toBe(260);
  });

  it("restores note-to-note trails exactly", () => {
    const result = pushNavigationHistory(
      [
        createNavigationEntry(
          { screen: "note", noteId: "note-story" },
          { scrollLeft: 0, scrollTop: 600 },
        ),
      ],
      0,
      { screen: "note", noteId: "note-character" },
      { scrollLeft: 0, scrollTop: 640 },
    );

    expect(result.entries.map((entry) => entry.route)).toEqual([
      { screen: "note", noteId: "note-story" },
      { screen: "note", noteId: "note-character" },
    ]);
    expect(result.entries[0].scrollTop).toBe(640);
  });

  it("drops forward history after taking a different route from Back", () => {
    const result = pushNavigationHistory(
      [
        createNavigationEntry({ screen: "notes" }),
        createNavigationEntry({ screen: "note", noteId: "note-old-branch" }),
      ],
      0,
      { screen: "note", noteId: "note-new-branch" },
      { scrollLeft: 0, scrollTop: 640 },
    );

    expect(result.entries.map((entry) => entry.route)).toEqual([
      { screen: "notes" },
      { screen: "note", noteId: "note-new-branch" },
    ]);
    expect(result.entries[0].scrollTop).toBe(640);
  });

  it("does not duplicate the current route", () => {
    const result = pushNavigationHistory(
      [createNavigationEntry({ screen: "home" })],
      0,
      { screen: "home" },
      { scrollLeft: 0, scrollTop: 80 },
    );

    expect(result.index).toBe(0);
    expect(result.entries).toEqual([
      {
        route: { screen: "home" },
        scrollLeft: 0,
        scrollTop: 80,
      },
    ]);
  });
});
