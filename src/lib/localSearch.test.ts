import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, Source } from "../types";
import { searchLocalNotes, searchLocalSources, searchLocalSpace } from "./localSearch";
import { saveChatReplyAsNote } from "./chat";

describe("local full-text search", () => {
  it("searches saved Chat passages as readable prose without exposing link metadata", () => {
    const snapshot = createEmptySnapshot();
    const source = makeSource({ text: "The signed record places zirconium delivery in November. A & B < C." });
    snapshot.sources = [source];
    snapshot.studio.messages = [{
      id: "reply", role: "assistant", content: "The document supports the schedule [1](#orion-evidence-e1).",
      evidence: [{ id: "e1", kind: "source", entityId: source.id, title: source.title,
        version: "version-only-metadata", start: 0, end: source.text.length, text: source.text, offsetUnit: "utf16" }],
      cardIds: [], contextCardIds: [], createdAt: "2026-09-09T00:00:00.000Z",
    }];
    const saved = saveChatReplyAsNote(snapshot, "reply", "2026-09-09T00:00:00.000Z", "saved");
    const body = saved.notes[0].body;
    const payload = body.match(/orion-passage:v1:([A-Za-z0-9_-]+)/)?.[1];
    expect(payload).toBeTruthy();
    const [match] = searchLocalNotes(saved.notes, "zirconium");
    expect(match.snippet).toContain("The signed record places zirconium delivery in November. A & B < C.");
    expect(match.snippet).not.toContain("&#");
    expect(match.snippet).not.toContain("orion-passage:");
    expect(match.snippet).not.toContain(payload!.slice(-40));
    expect(searchLocalNotes(saved.notes, payload!.slice(-40))).toHaveLength(0);
    expect(searchLocalNotes(saved.notes, "orion-passage:v1:")).toHaveLength(0);
    expect(searchLocalNotes(saved.notes, "November. A & B < C.")).toHaveLength(1);
  });

  it("normalizes formatting and entities while retaining visible fenced code", () => {
    const note = makeNote({ body: '# Heading\n\n**Absolute** _knowing_ &amp; action &copy; 2026.\n\n[signed record](https://example.com/hidden-destination "hidden title")\n\n```txt\nfenced-body-probe &amp; literal\n```' });
    expect(searchLocalNotes([note], "absolute knowing & action © 2026")).toHaveLength(1);
    expect(searchLocalNotes([note], "signed record")[0].snippet).not.toContain("hidden title");
    expect(searchLocalNotes([note], "hidden-destination")).toHaveLength(0);
    expect(searchLocalNotes([note], "hidden title")).toHaveLength(0);
    expect(searchLocalNotes([note], "fenced-body-probe &amp; literal")).toHaveLength(1);
  });

  it("keeps source matching literal instead of interpreting its Markdown or character references", () => {
    const source = makeSource({ text: '**Preserved** &amp; [label](https://example.com/raw "original-metadata")' });
    expect(searchLocalSources([source], "**Preserved** &amp;")).toHaveLength(1);
    expect(searchLocalSources([source], "original-metadata")).toHaveLength(1);
    expect(searchLocalSources([source], "Preserved &")).toHaveLength(0);
  });

  it("finds body-only matches at the end of long notes and returns a bounded nearby excerpt", () => {
    const note = makeNote({ body: `${"Earlier material. ".repeat(10_000)}Late evidence: uniquebodyprobe resolves the question. ${"Later material. ".repeat(100)}` });
    const [match] = searchLocalNotes([note], "UNIQUEBODYPROBE");
    expect(match.item.id).toBe(note.id);
    expect(match.snippet).toContain("Late evidence: uniquebodyprobe resolves the question.");
    expect(Array.from(match.snippet).length).toBeLessThanOrEqual(200);
    expect(match.snippet.startsWith("…")).toBe(true);
  });

  it("finds phrases across extracted line breaks and retains source filename lookup", () => {
    const source = makeSource({ text: "An account of absolute\n\tknowing follows.", fileName: "hegel-lecture.pdf" });
    expect(searchLocalSources([source], "absolute knowing")[0].snippet)
      .toContain("absolute knowing");
    expect(searchLocalSources([source], "lecture.pdf")[0].item.id).toBe(source.id);
  });

  it("treats punctuation as literal query text", () => {
    const note = makeNote({ body: "Use C++ (17) and [a-z] here." });
    expect(searchLocalNotes([note], "C++ (17)")).toHaveLength(1);
    expect(searchLocalNotes([note], "[a-z]")).toHaveLength(1);
    expect(searchLocalNotes([note], ".*")).toHaveLength(0);
  });

  it("retains title, alias, tag, and summary discovery", () => {
    const note = makeNote({ aliases: ["Dialectical method"], tags: ["philosophy"] });
    for (const query of ["Research notebook", "Dialectical method", "philosophy", "Overview"]) {
      expect(searchLocalNotes([note], query)[0].item.id).toBe(note.id);
    }
  });

  it("ranks an exact source title ahead of many note body matches before limiting results", () => {
    const snapshot = createEmptySnapshot();
    snapshot.notes = Array.from({ length: 20 }, (_, index) => makeNote({ id: `note-${index}`, body: "About Hegel" }));
    snapshot.sources = [makeSource({ title: "Hegel" })];
    const matches = searchLocalSpace(snapshot, "hegel");
    expect(matches).toHaveLength(12);
    expect(matches[0].type).toBe("source");
    expect(matches[0].item.id).toBe(snapshot.sources[0].id);
  });

  it("includes concept aliases without reading any other Space", () => {
    const firstSpace = createEmptySnapshot();
    firstSpace.notes = [makeNote({ body: "First Space secret" })];
    firstSpace.sources = [makeSource({ text: "Source secret" })];
    const secondSpace = createEmptySnapshot();
    secondSpace.concepts = [{ id: "concept", label: "Knowing", aliases: ["epistemology"], description: "", noteIds: [], color: "#aaaaaa", autoLink: true }];
    expect(searchLocalSpace(firstSpace, "secret")).toHaveLength(2);
    expect(searchLocalSpace(secondSpace, "secret")).toHaveLength(0);
    expect(searchLocalSpace(secondSpace, "epistemology")[0].type).toBe("concept");
  });

  it("preserves stored order when clearing a query and observes current edits", () => {
    const notes = [makeNote({ id: "second", body: "Previous term" }), makeNote({ id: "first" })];
    expect(searchLocalNotes(notes, " ").map((match) => match.item.id)).toEqual(["second", "first"]);
    expect(searchLocalNotes(notes, "Previous term")).toHaveLength(1);
    notes[0] = { ...notes[0], body: "Replacement term" };
    expect(searchLocalNotes(notes, "Previous term")).toHaveLength(0);
    expect(searchLocalNotes(notes, "Replacement term")).toHaveLength(1);
  });
});

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note", title: "Research notebook", slug: "research-notebook", summary: "Overview", body: "Ordinary text",
    aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [],
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z", ...overrides,
  };
}

function makeSource(overrides: Partial<Source> = {}): Source {
  return { id: "source", title: "Preserved document", kind: "pdf", importedAt: "2026-09-01T00:00:00.000Z", text: "Original text", noteIds: [], ...overrides };
}
