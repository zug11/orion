import { afterEach, describe, expect, it } from "vitest";
import type { Note } from "../types";
import { clearNoteExcerptHighlight, consumeNoteExcerptNavigation, requestNoteExcerptNavigation, revealNoteExcerptPassage } from "./noteExcerptNavigation";
import { createNoteExcerptSelection, parseNoteExcerptTitle } from "./noteExcerpts";

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

  it("locates an MCP text-only excerpt only when both current visible representations are unique", () => {
    const text = "Exact café 🪶 words.";
    const title = "orion-excerpt:v2:" + encodeURIComponent(JSON.stringify({ noteId: source.id, passages: [{ text }] }));
    const reference = parseNoteExcerptTitle(title, `orion-note://${source.id}`)!;
    requestNoteExcerptNavigation(reference.noteId, reference.passages);
    const request = consumeNoteExcerptNavigation(source.id)!;
    expect(request.passages[0]).not.toHaveProperty("from");
    const current = { ...source, body: `# Source\n\nA new opening.\n\nExact **café** 🪶 words.` };
    const root = document.createElement("div");
    root.innerHTML = "<p>A new opening.</p><p>Exact <strong>café</strong> 🪶 words.</p>";
    document.body.append(root);
    expect(revealNoteExcerptPassage(root, current, request)).toBe(true);
    expect(window.getSelection()?.toString()).toBe(text);
    expect(revealNoteExcerptPassage(root, { ...current, id: "other-space" }, request)).toBe(false);
    expect(revealNoteExcerptPassage(root, { ...current, body: `Changed. ${text.slice(6)}` }, request)).toBe(false);
    expect(revealNoteExcerptPassage(root, { ...current, body: `${text}\n\n${text}` }, request)).toBe(false);
    // Even when the canonical text has one exact match, collapsed whitespace in
    // the rendered prose must not let a text-only locator choose an occurrence.
    root.innerHTML = `<p>${text}</p><p>${text.replace("Exact ", "Exact   ")}</p>`;
    expect(revealNoteExcerptPassage(root, { ...current, body: `${text}\n\n${text.replace("Exact ", "Exact   ")}` }, request)).toBe(false);
  });

  it("refuses to highlight raw Markdown that differs from the source's visible words", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Exact <strong>words</strong>.</p>";
    document.body.append(root);
    const text = "Exact **words**.";
    const request = { noteId: source.id, passages: [{ text, locator: "unique-text" as const }], requestedAt: Date.now() };
    expect(revealNoteExcerptPassage(root, { ...source, body: text }, request)).toBe(false);
  });
});
