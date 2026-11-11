import { describe, expect, it } from "vitest";
import { displayNoteTitle, editableNoteSubtitle, editableNoteTitle, noteHeadingLayout, noteHeadingVisibility } from "./noteMetadata";

describe("optional document headings", () => {
  it("keeps both heading rows for older notes without a layout choice", () => {
    expect(noteHeadingVisibility({ title: "", summary: "" })).toEqual({ title: true, subtitle: true });
  });

  it.each([
    ["both", true, true], ["title", true, false], ["subtitle", false, true], ["none", false, false],
  ] as const)("resolves and round-trips the %s layout", (layout, title, subtitle) => {
    const visibility = noteHeadingVisibility({ title: "", summary: "", headingLayout: layout });
    expect(visibility).toEqual({ title, subtitle });
    expect(noteHeadingLayout(visibility)).toBe(layout);
  });

  it("keeps incoming authored headings visible without restoring old starter copy", () => {
    expect(noteHeadingVisibility({ title: "A newer title", summary: "A newer subtitle", headingLayout: "none" }))
      .toEqual({ title: true, subtitle: true });
    expect(noteHeadingVisibility({ title: "Untitled note", summary: "A new thread in your atlas.", headingLayout: "none" }))
      .toEqual({ title: false, subtitle: false });
  });

  it("keeps an empty title empty with a separate navigation label", () => {
    const note = { title: "", summary: "" };
    expect(editableNoteTitle(note)).toBe("");
    expect(editableNoteSubtitle(note)).toBe("");
    expect(displayNoteTitle(note)).toBe("New note");
    expect(note).toEqual({ title: "", summary: "" });
  });

  it("hides the exact old starter copy without rewriting stored data", () => {
    const note = { title: "Untitled note", summary: "A new thread in your atlas." };
    expect(editableNoteTitle(note)).toBe("");
    expect(editableNoteSubtitle(note)).toBe("");
    expect(displayNoteTitle(note)).toBe("New note");
    expect(note.title).toBe("Untitled note");
    expect(note.summary).toBe("A new thread in your atlas.");
  });

  it("preserves authored text, including similar wording and multiline subtitles", () => {
    const note = { title: "An untitled note about rivers", summary: "A new thread in your atlas.\nA thought to follow." };
    expect(editableNoteTitle(note)).toBe(note.title);
    expect(displayNoteTitle(note)).toBe(note.title);
    expect(editableNoteSubtitle(note)).toBe(note.summary);
  });
});
