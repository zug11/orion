import { describe, expect, it } from "vitest";
import type { Note, Source } from "../types";
import { manualSummary, visibleNoteSummary } from "./importSummary";
const text = '---\ntitle: "POEMS"\ntags: []\n---\n# POEMS\n\n&nbsp;\n\nThe dancing does not mellow out.';
const source = { id: "md", kind: "markdown", text } as Source;
const note = { sourceIds: ["md"], summary: manualSummary(text) } as Note;
describe("Markdown import subtitles", () => {
  it("hides the previous generated excerpt without changing stored text", () => {
    expect(visibleNoteSummary(note, [source])).toBe("");
    expect(note.summary).toContain('title:');
    expect(source.text).toBe(text);
  });
  it("keeps authored summaries and unrelated or non-Markdown excerpts", () => {
    expect(visibleNoteSummary({ ...note, summary: "My poems" }, [source])).toBe("My poems");
    expect(visibleNoteSummary({ ...note, sourceIds: ["other"] }, [source])).toBe(note.summary);
    expect(visibleNoteSummary(note, [{ ...source, kind: "text" }])).toBe(note.summary);
  });
});
