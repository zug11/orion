/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { SLIDE_DECK_TAG } from "./slideDeck";
import {
  buildGenerateWritingRequest,
  createGeneratePlaceholderNote,
  extractSlideHeadings,
  GENERATE_PENDING_TAG,
  insertImageForSlide,
  titleFromGenerateInstruction,
  truncateGenerateInstruction,
  writingPromptForGenerateKind,
} from "./generate";

describe("generate helpers", () => {
  it("takes the title from the first instruction line", () => {
    expect(
      titleFromGenerateInstruction("Phenomenology of Spirit\nGo slowly.", "note"),
    ).toBe("Phenomenology of Spirit");
    expect(titleFromGenerateInstruction("", "podcast")).toBe("Space briefing");
  });

  it("bounds custom instructions", () => {
    expect(truncateGenerateInstruction("  hello  ")).toBe("hello");
    expect(truncateGenerateInstruction("x".repeat(2_000)).length).toBe(1_250);
  });

  it("marks placeholders so they can be replaced later", () => {
    const note = createGeneratePlaceholderNote({
      id: "note-1",
      title: "SQL",
      kind: "slide-deck",
      now: "2026-08-29T00:00:00.000Z",
    });
    expect(note.tags).toContain(GENERATE_PENDING_TAG);
    expect(note.tags).toContain(SLIDE_DECK_TAG);
    expect(note.body).toMatch(/orion-generate-pending/);
  });

  it("extracts slide headings from generated markdown", () => {
    expect(
      extractSlideHeadings("# Title\n\n## Spirit\nHello.\n\n## Method\nMore."),
    ).toEqual(["Spirit", "Method"]);
  });

  it("builds a writing request from a snapshot that already contains the placeholder", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      "2026-08-30T00:00:00.000Z",
      "space-research",
    );
    const note = createGeneratePlaceholderNote({
      id: "note-new",
      title: "SQL",
      kind: "note",
      now: "2026-08-30T00:00:00.000Z",
    });
    const request = buildGenerateWritingRequest(
      { ...snapshot, notes: [note, ...snapshot.notes] },
      { originNoteId: "note-new", kind: "note", instruction: "Explain SQL." },
    );
    expect(request.mode).toBe("inline-writing");
    expect(request.prompt).toContain("Explain SQL.");
    expect(request.notes[0]?.title).toBe("SQL");
  });

  it("asks slide decks for bullets and image briefs, not illustrated notes", () => {
    const prompt = writingPromptForGenerateKind(
      "slide-deck",
      "Cover the import topology",
      "Research",
    );
    expect(prompt).toContain("PowerPoint-style");
    expect(prompt).toContain("3–6 Markdown bullets");
    expect(prompt).toContain("Image:");
    expect(prompt).toContain("letter the title and bullets in distinctive fonts");
    expect(prompt).toContain("Never write “no text”");
    expect(prompt).toContain("heard during Play");
    expect(prompt).toContain("Do not start notes with the slide title");
    expect(prompt).not.toContain("a few short paragraphs");
  });

  it("requires spoken notes on narrated decks", () => {
    const prompt = writingPromptForGenerateKind(
      "slide-deck-narrated",
      "Cover the import topology",
      "Research",
    );
    expect(prompt).toContain("Every slide must include speaker notes");
    expect(prompt).toContain("Do not start notes with the slide title");
  });

  it("inserts a generated plate after the matching slide heading", () => {
    const next = insertImageForSlide(
      "## One\n\n- A\n\n## Two\n\n- B\n",
      1,
      "![Two](orion-image://localhost/image_abc123456789)",
    );
    expect(next).toContain("## Two\n\n![Two](orion-image://localhost/image_abc123456789)");
    expect(next.indexOf("## One")).toBeLessThan(next.indexOf("![Two]"));
  });
});
