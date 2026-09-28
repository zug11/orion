// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import type { SpeechPlaybackOptions, SpeechPlaybackProgress } from "../lib/speech";
import { NoteView } from "./NoteView";

const note: Note = { id: "narration-note", title: "A quiet atlas", slug: "atlas", summary: "", body: "First paragraph.\n\nSecond **important** paragraph.", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup() {
  const calls: { text: string; signal?: AbortSignal; progress?: (progress: SpeechPlaybackProgress) => void; options?: SpeechPlaybackOptions }[] = [];
  const speak = vi.fn((text: string, signal?: AbortSignal, progress?: (progress: SpeechPlaybackProgress) => void, options?: SpeechPlaybackOptions) => {
    calls.push({ text, signal, progress, options });
    return new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const highlights = new Map<string, { ranges: Range[] }>();
  vi.stubGlobal("CSS", { highlights });
  vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
  const props = { note, notes: [note], concepts: [], onOpenNote: vi.fn(), onOpenConcept: vi.fn(), onUpdateNote: vi.fn(), onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn(), onSpeakNote: speak };
  const view = render(<NoteView {...props}/>);
  return { ...view, calls, props, highlights };
}

describe("written-note playback tracking", () => {
  it("tracks displayed words without remounting prose and makes dimming optional", () => {
    const { container, calls, highlights } = setup();
    const paragraph = container.querySelector(".note-prose p");
    fireEvent.click(screen.getByRole("button", { name: "Play note" }));
    expect(calls[0].text).toBe("A quiet atlas. First paragraph. Second important paragraph.");
    expect(calls[0].options).toMatchObject({ startCharIndex: 0, trackWords: true });
    const index = calls[0].text.indexOf("important");
    act(() => calls[0].progress?.({ elapsedSeconds: 3, durationSeconds: 6, ratio: .5, loading: false, charIndex: index, charLength: 9, timingGranularity: "word" }));
    expect(container.querySelector(".note-prose p")).toBe(paragraph);
    expect(highlights.get("orion-narration-current")?.ranges.map((range) => range.toString()).join("")).toBe("important");
    fireEvent.click(screen.getByRole("checkbox", { name: "Follow text" }));
    expect(highlights.size).toBe(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "Follow text" }));
    expect(highlights.size).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Stop narration" }));
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[0].options?.preparationSignal?.aborted).toBe(true);
    expect(highlights.size).toBe(0);
    expect(screen.queryByTestId("note-listen-playhead")).not.toBeInTheDocument();
  });

  it("resumes at the last measured word and ignores callbacks from the stopped voice", () => {
    const { calls, highlights } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Play note" }));
    const index = calls[0].text.indexOf("Second");
    act(() => calls[0].progress?.({ elapsedSeconds: 2, durationSeconds: 6, ratio: .4, loading: false, charIndex: index, charLength: 6 }));
    fireEvent.click(within(screen.getByTestId("note-listen-playhead")).getByRole("button", { name: "Pause" }));
    expect(calls[0].signal?.aborted).toBe(true);
    fireEvent.click(within(screen.getByTestId("note-listen-playhead")).getByRole("button", { name: "Play" }));
    expect(calls[1].options?.startCharIndex).toBe(index);
    expect(calls[0].options?.preparationSignal).toBe(calls[1].options?.preparationSignal);
    expect(calls[1].options?.preparationSignal?.aborted).toBe(false);
    act(() => calls[0].progress?.({ elapsedSeconds: 0, durationSeconds: 6, ratio: 0, loading: false, charIndex: 0, charLength: 1 }));
    expect(highlights.get("orion-narration-unread")?.ranges.map((range) => range.toString()).join("")).toContain("Second");
    fireEvent.keyDown(screen.getByRole("slider", { name: "Playback progress" }), { key: "End" });
    expect(calls[2].options?.startCharIndex).toBe(calls[2].text.lastIndexOf("paragraph."));
  });

  it("stops before edited words or another note can inherit stale timing ranges", () => {
    const { calls, highlights, rerender, props } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Play note" }));
    rerender(<NoteView {...props} note={{ ...note, body: "Changed wording." }}/>);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(calls[0].options?.preparationSignal?.aborted).toBe(true);
    expect(highlights.size).toBe(0);
    expect(screen.queryByTestId("note-listen-playhead")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play note" }));
    rerender(<NoteView {...props} note={{ ...note, id: "another-note" }}/>);
    expect(calls[1].signal?.aborted).toBe(true);
    expect(highlights.size).toBe(0);
  });
});
