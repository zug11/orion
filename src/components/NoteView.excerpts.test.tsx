import { StrictMode } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import * as navigation from "../lib/noteExcerptNavigation";
import { createNoteExcerptSelection } from "../lib/noteExcerpts";
import { NoteView } from "./NoteView";

const source: Note = { id: "excerpt-source", title: "Source article", body: "Opening context.\n\nThe selected sentence.", slug: "source", summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };

afterEach(() => vi.restoreAllMocks());

describe("excerpt navigation in the reader", () => {
  it("preserves its one-shot request through StrictMode effect replay", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
    const reveal = vi.spyOn(navigation, "revealNoteExcerptPassage").mockReturnValue(true);
    const selection = createNoteExcerptSelection(source, [{ from: 18, to: source.body.length }]);
    navigation.requestNoteExcerptNavigation(source.id, selection.passages);
    const { container } = render(<StrictMode><NoteView note={source} notes={[source]} concepts={[]}
      onOpenNote={vi.fn()} onOpenConcept={vi.fn()} onUpdateNote={vi.fn()} onDeleteNote={vi.fn()}
      onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()}/></StrictMode>);

    for (let pass = 0; pass < 3; pass += 1) act(() => {
      const callbacks = [...frames.values()]; frames.clear();
      callbacks.forEach((callback) => callback(performance.now()));
    });

    expect(reveal).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith(container.querySelector(".note-prose"), source, expect.objectContaining({ noteId: source.id, passages: selection.passages }));
    expect(navigation.consumeNoteExcerptNavigation(source.id)).toBeUndefined();
  });
});
