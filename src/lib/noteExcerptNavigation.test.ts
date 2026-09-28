import { afterEach, describe, expect, it } from "vitest";
import type { Note } from "../types";
import { clearNoteExcerptHighlight, consumeNoteExcerptNavigation, requestNoteExcerptNavigation, revealNoteExcerptPassage } from "./noteExcerptNavigation";
import { createNoteExcerptSelection } from "./noteExcerpts";

const source: Note = { id: "source", title: "Source", body: "First paragraph.\n\nAn exact sentence with bold words.", slug: "source", summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
afterEach(() => { document.body.replaceChildren(); clearNoteExcerptHighlight(); window.getSelection()?.removeAllRanges(); });

describe("excerpt source navigation", () => {
  it("consumes only one exact-note navigation and drops an unrelated navigation", () => {
    const selection = createNoteExcerptSelection(source, [{ from: 18, to: source.body.length }]);
    requestNoteExcerptNavigation(source.id, selection.passages);
    expect(consumeNoteExcerptNavigation("unrelated")).toBeUndefined();
    expect(consumeNoteExcerptNavigation(source.id)).toBeUndefined();
    requestNoteExcerptNavigation(source.id, selection.passages);
    expect(consumeNoteExcerptNavigation(source.id)?.passages).toEqual(selection.passages);
    expect(consumeNoteExcerptNavigation(source.id)).toBeUndefined();
  });

  it("reveals exact current text across inline markup and safely follows a shifted unique passage", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>First paragraph.</p><p>An exact sentence with <strong>bold</strong> words.</p>";
    document.body.append(root);
    const selection = createNoteExcerptSelection(source, [{ from: 18, to: source.body.length }]);
    const request = { noteId: source.id, passages: selection.passages, requestedAt: Date.now() };
    expect(revealNoteExcerptPassage(root, source, request)).toBe(true);
    expect(window.getSelection()?.toString()).toBe("An exact sentence with bold words.");
    const updated = { ...source, body: "An added opening.\n\n" + source.body };
    root.insertAdjacentHTML("afterbegin", "<p>An added opening.</p>");
    expect(revealNoteExcerptPassage(root, updated, request)).toBe(true);
    expect(window.getSelection()?.toString()).toBe("An exact sentence with bold words.");
  });

  it("does not highlight changed, missing or ambiguous stale passages", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>A different sentence.</p>";
    document.body.append(root);
    const selection = createNoteExcerptSelection(source, [{ from: 18, to: source.body.length }]);
    const request = { noteId: source.id, passages: selection.passages, requestedAt: Date.now() };
    expect(revealNoteExcerptPassage(root, { ...source, body: "A different sentence." }, request)).toBe(false);
    expect(revealNoteExcerptPassage(root, { ...source, id: "other-space" }, request)).toBe(false);
    const repeated = "Opening.\n\n" + selection.text + "\n\n" + selection.text;
    root.textContent = repeated;
    expect(revealNoteExcerptPassage(root, { ...source, body: repeated }, request)).toBe(false);
  });
});
