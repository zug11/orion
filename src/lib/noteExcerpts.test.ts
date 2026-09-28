import { describe, expect, it } from "vitest";
import type { Note } from "../types";
import { buildNoteExcerptContent, createNoteExcerptSelection, encodeNoteExcerptTitle, excerptRangeFromSelection, getNoteExcerptDocument, getNoteExcerptText, normalizeExcerptRanges, parseNoteExcerptTitle, searchExcerptNotes } from "./noteExcerpts";

export function excerptNote(id: string, title: string, body: string): Note {
  return { id, title, body, slug: id, summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
}

describe("note excerpts", () => {
  it("searches complete active-Space bodies and points to the exact late match", () => {
    const origin = excerptNote("origin", "Origin", "deeper question");
    const long = excerptNote("long", "The essay", `${"Earlier material. ".repeat(2000)}\n\nThe deeper\nquestion remains open.`);
    const outside = excerptNote("other-space", "Secret", "deeper question");
    const results = searchExcerptNotes([origin, long], "deeper question", "origin");
    expect(results.map((result) => result.note.id)).toEqual(["long"]);
    expect(results[0].snippet).toContain("deeper question");
    const range = results[0].bodyMatch!;
    expect(getNoteExcerptText(long).slice(range.from, range.to)).toBe("deeper question");
    expect(results.some((result) => result.note.id === outside.id)).toBe(false);
  });

  it("gives search and the reader identical inert visible text without hidden link payloads", () => {
    const note = excerptNote("n", "A note", '---\nprivate: yes\n---\n\n# A note\n\n## A heading\n\nA **bold** word &amp; a [link](orion-note://target "private-payload").\n\n- First item\n- Second `item`\n\n<img src=x onerror=alert(1)>');
    const document = getNoteExcerptDocument(note);
    expect(document.text).toBe("A heading\n\nA bold word & a link.\n\nFirst item\n\nSecond item");
    expect(searchExcerptNotes([note], "private")).toHaveLength(0);
    for (const block of document.blocks) expect(document.text.slice(block.from, block.to)).toBe(block.text);
    expect(document.blocks[0]).toMatchObject({ kind: "heading", level: 2 });
  });

  it("excludes table layout metadata from picking and search while preserving literal code examples", () => {
    const metadata = '<!-- orion-table:v1 {"width":65,"header":true,"banded":false} -->';
    const note = excerptNote("table", "A table", `${metadata}\n| Material | Finding |\n| --- | --- |\n| Glass | Clear |`);
    expect(getNoteExcerptText(note)).toBe("Material\tFinding\n\nGlass\tClear");
    expect(searchExcerptNotes([note], "orion-table")).toHaveLength(0);
    expect(searchExcerptNotes([note], "Glass")[0].snippet).not.toContain("width");
    const examples = excerptNote("examples", "Code", `\`${metadata}\`\n\n\`\`\`md\n${metadata}\n\`\`\``);
    expect(getNoteExcerptText(examples).match(/orion-table:v1/g)).toHaveLength(2);
  });

  it("keeps exact selected wording, merges overlapping ranges and orders separate passages", () => {
    const note = excerptNote("n", "Source", "One exact sentence. Another thought. A final sentence.");
    const text = getNoteExcerptText(note);
    const final = text.indexOf("A final");
    const selection = createNoteExcerptSelection(note, [{ from: final, to: text.length }, { from: 0, to: 10 }, { from: 5, to: 19 }]);
    expect(selection.text).toBe("One exact sentence. … A final sentence.");
    expect(selection.passages).toEqual([{ from: 0, to: 19, text: "One exact sentence." }, { from: final, to: text.length, text: "A final sentence." }]);
    expect(normalizeExcerptRanges(" a 🪶 b ", [{ from: -3, to: 6 }])).toEqual([{ from: 1, to: 5 }]);
  });

  it("bounds and validates portable passage metadata and verifies its source link", () => {
    const note = excerptNote("source", "A source", "A sentence with café and 🪶.");
    const selection = createNoteExcerptSelection(note, [{ from: 0, to: getNoteExcerptText(note).length }]);
    const title = encodeNoteExcerptTitle(selection);
    expect(parseNoteExcerptTitle(title, "orion-note://source")).toEqual({ noteId: "source", passages: selection.passages });
    expect(parseNoteExcerptTitle(title, "orion-note://another-space-note")).toBeUndefined();
    expect(parseNoteExcerptTitle("orion-excerpt:v1:" + "A".repeat(80001))).toBeUndefined();
    expect(parseNoteExcerptTitle("orion-excerpt:v1:bad-payload")).toBeUndefined();
    expect(buildNoteExcerptContent(selection)[0].type).toBe("blockquote");
    expect(() => createNoteExcerptSelection(excerptNote("n", "Huge", "a".repeat(13000)), [{ from: 0, to: 13000 }])).toThrow("shorter");
  });

  it("captures an exact browser selection across formatted spans and rejects outside selections", () => {
    const root = document.createElement("div");
    root.innerHTML = '<span>The exact <mark>sentence</mark>.</span>\n\n<span>Next paragraph.</span>';
    document.body.append(root);
    const range = document.createRange();
    range.setStart(root.querySelector("span")!.firstChild!, 4);
    range.setEnd(root.querySelector("mark")!.firstChild!, 8);
    const selection = window.getSelection()!;
    selection.removeAllRanges(); selection.addRange(range);
    const offsets = excerptRangeFromSelection(root, selection)!;
    expect(root.textContent!.slice(offsets.from, offsets.to)).toBe("exact sentence");
    expect(excerptRangeFromSelection(document.createElement("div"), selection)).toBeNull();
    selection.removeAllRanges(); root.remove();
  });
});
