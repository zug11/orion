import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { searchSpaceContents } from "./spaceDiscovery";

function note(id: string, title: string, body = "", extra: Partial<Note> = {}): Note {
  return { id, title, body, slug: id, summary: "", kind: "article", status: "ready", aliases: [],
    tags: [], conceptIds: [], sourceIds: [], createdAt: "", updatedAt: "", ...extra };
}

function space(id: string, ...notes: Note[]) {
  const snapshot = createEmptySnapshot();
  return { ...snapshot, workspace: { ...snapshot.workspace, id }, notes };
}
const signal = () => new AbortController().signal;

describe("finding a Space by a matching note", () => {
  it("supports remembered wording and returns the strongest actual note from each Space", async () => {
    const drafts = space("drafts", note("passing", "Notes", "Audio dropout at 4pm."),
      note("recording", "Audio dropout", "The microphone cut out."));
    const other = space("other", note("recording", "Takes", "Check for interrupted recording after pausing."));
    const results = await searchSpaceContents([other, drafts, space("empty")], "the mic kept cutting out",
      ["audio dropout", "interrupted recording", "  Audio Dropout  "], signal());
    expect(results).toMatchObject([
      { spaceId: "drafts", noteId: "recording", noteTitle: "Audio dropout", snippet: "Audio dropout" },
      { spaceId: "other", noteId: "recording", noteTitle: "Takes", snippet: "Check for interrupted recording after pausing." },
    ]);
  });

  it("returns readable late evidence and excludes internal metadata and provider-only guesses", async () => {
    const library = [space("writing", note("essay", "", "---\nprivate: secret-header\n---\n\n" +
      "Earlier prose. ".repeat(10_000) + "\n\nWe discussed **Foucault** as our fifth candidate. " +
      "[A source](https://private.invalid/secret-destination) <!-- orion-secret -->"))];
    const matches = await searchSpaceContents(library, "Where was Foucault?", [], signal());
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ spaceId: "writing", noteTitle: "New note", noteId: "essay" });
    expect(matches[0].snippet).toContain("We discussed Foucault as our fifth candidate.");
    expect(matches[0].snippet.length).toBeLessThanOrEqual(202);
    const missing = await searchSpaceContents(library, "elsewhere", ["secret-header", "secret-destination", "orion-secret", "Moon crater"], signal());
    expect(missing).toEqual([]);
  });

  it("shows matching prose when the note title also matches", async () => {
    const library = [space("production", note("technical", "Dropouts", "Two dropouts appeared during the take."))];
    expect(await searchSpaceContents(library, "dropouts", [], signal()))
      .toMatchObject([{noteTitle:"Dropouts", snippet:"Two dropouts appeared during the take."}]);
  });

  it("matches words in one excerpt while avoiding partial words and unrelated distant mentions", async () => {
    const library = [
      space("near", note("main", "Discussion", "Microphone problems include recording dropouts.")),
      space("unrelated", note("aside", "Elsewhere", "Microphone " + "unrelated prose ".repeat(40) + "dropouts.")),
      space("partial", note("partial", "Microphones", "The dropoutsicle is here.")),
    ];
    expect(await searchSpaceContents(library, "microphone dropouts", [], signal()))
      .toMatchObject([{ spaceId: "near", snippet: "Microphone problems include recording dropouts." }]);
    expect(await searchSpaceContents(library, '"microphone dropouts"', [], signal())).toEqual([]);
  });

  it("reports literal metadata evidence and excludes hidden starter fields and reserved tags", async () => {
    const entry = note("n", "Untitled note", "", { summary: "A new thread in your atlas.",
      aliases: ["Boom tests"], tags: ["Location audio", "orion-link-pending"] });
    const library = [space("production", entry)];
    for (const text of ["Boom tests", "Location audio"]) {
      expect(await searchSpaceContents(library, text, [], signal())).toMatchObject([{ noteId: "n", snippet: text }]);
    }
    expect(await searchSpaceContents(library, "where", ["Untitled note", "orion-link-pending", "thread in your atlas"], signal())).toEqual([]);
    entry.summary = "Gate adjustments";
    expect(await searchSpaceContents(library, "gate adjustments", [], signal())).toMatchObject([{ snippet: "Gate adjustments" }]);
  });

  it("ignores blank queries and connections that have no matching note", async () => {
    const library = [space("technical", note("a", "Compiler", "The C++ front end handles this."))];
    expect(await searchSpaceContents(library, " ", ["Compiler"], signal())).toEqual([]);
    expect(await searchSpaceContents(library, "C++", [], signal())).toMatchObject([{ noteId: "a" }]);
    expect(await searchSpaceContents(library, "a", [], signal())).toEqual([]);
    expect(await searchSpaceContents([space("empty")], "C++", [], signal())).toEqual([]);
  });

  it("yields before scanning and honours cancellation", async () => {
    const controller = new AbortController(), probe = vi.fn(() => "Work in progress");
    const n = note("n", "Notes");
    Object.defineProperty(n, "body", { get: probe });
    const pending = searchSpaceContents([space("studio", n)], "work", [], controller.signal);
    expect(probe).not.toHaveBeenCalled();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not retain stale matches after notes are edited, removed or shared by ID between Spaces", async () => {
    const library = [space("one", note("shared", "Updated", "rain")),
      space("two", note("shared", "Old version", "wind"))];
    expect(await searchSpaceContents(library, "rain", [], signal())).toMatchObject([{ spaceId: "one" }]);
    library[0].notes[0] = { ...library[0].notes[0], body: "wind" };
    library[1].notes = [];
    expect(await searchSpaceContents(library, "rain", [], signal())).toEqual([]);
    expect(await searchSpaceContents(library, "wind", [], signal())).toMatchObject([{ spaceId: "one" }]);
  });
});
