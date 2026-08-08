// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { NotesIndex } from "./NotesIndex";

describe("NotesIndex", () => {
  it("does not expose hidden note kind or status metadata", () => {
    const { container } = render(
      <NotesIndex
        notes={[makeNote()]}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    expect(screen.queryByText("Note", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Wiki", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Draft", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("Positivism")).toBeVisible();
    expect(container.querySelector(".note-index-color")).toBeNull();
  });

  it("opens and deletes through separate accessible controls", () => {
    const note = makeNote();
    const onOpenNote = vi.fn();
    const onDeleteNote = vi.fn();
    render(
      <NotesIndex
        notes={[note]}
        onOpenNote={onOpenNote}
        onDeleteNote={onDeleteNote}
      />,
    );

    fireEvent.click(screen.getByText("Positivism"));
    expect(onOpenNote).toHaveBeenCalledWith(note.id);

    fireEvent.click(
      screen.getByRole("button", { name: "Delete Positivism" }),
    );
    expect(onDeleteNote).toHaveBeenCalledWith(note.id);
    expect(onOpenNote).toHaveBeenCalledTimes(1);
  });

  it("retains title, alias, and tag filtering", () => {
    render(
      <NotesIndex
        notes={[
          makeNote(),
          makeNote({
            id: "note-sql",
            title: "SQL",
            aliases: ["Structured query language"],
          }),
        ]}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Filter notes" }), {
      target: { value: "structured query" },
    });
    expect(screen.getByText("SQL")).toBeVisible();
    expect(screen.queryByText("Positivism")).not.toBeInTheDocument();
  });
});

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: "note-positivism",
    title: "Positivism",
    slug: "positivism",
    summary: "A theory of knowledge.",
    body: "Positivism prioritizes observable regularities.",
    aliases: [],
    tags: [],
    kind: "wiki",
    status: "draft",
    conceptIds: [],
    sourceIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-29T01:00:00.000Z",
    ...overrides,
  };
}
