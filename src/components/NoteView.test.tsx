// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Concept, Note } from "../types";
import { NoteView } from "./NoteView";

const NOW = "2026-07-29T01:00:00.000Z";

describe("NoteView", () => {
  it("exposes first-class note deletion from the note header", () => {
    const onDeleteNote = vi.fn();
    const note: Note = {
      id: "note-comte",
      title: "Auguste Comte",
      slug: "auguste-comte",
      summary: "A French philosopher.",
      body: "Comte developed positivism.",
      aliases: [],
      tags: [],
      kind: "wiki",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={vi.fn()}
        onDeleteNote={onDeleteNote}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete note" }));
    expect(onDeleteNote).toHaveBeenCalledWith(note.id);
  });

  it("checks a task directly while reading without entering edit mode", () => {
    const onUpdateNote = vi.fn();
    const note: Note = {
      id: "note-plan",
      title: "Launch plan",
      slug: "launch-plan",
      summary: "Things to finish.",
      body: "## Today\n\n- [ ] Review the release",
      aliases: [],
      tags: [],
      kind: "project",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    render(
      <NoteView
        note={note}
        notes={[note]}
        concepts={[]}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onUpdateNote={onUpdateNote}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Complete Review the release",
      }),
    );

    expect(onUpdateNote).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "## Today\n\n- [x] Review the release",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Edit" }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("renders known concepts as links in the reading surface", () => {
    const sourceNote: Note = {
      id: "note-lecture",
      title: "Lecture notes",
      slug: "lecture-notes",
      summary: "A short reading note.",
      body: "The lecture introduces positivism as a theory of knowledge.",
      aliases: [],
      tags: [],
      kind: "project",
      status: "ready",
      conceptIds: ["concept-positivism"],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const article: Note = {
      ...sourceNote,
      id: "note-positivism",
      title: "Positivism",
      slug: "positivism",
      summary: "A wiki article.",
      body: "Positivism prioritizes observable knowledge.",
      kind: "wiki",
      conceptIds: ["concept-positivism"],
    };
    const concept: Concept = {
      id: "concept-positivism",
      label: "Positivism",
      aliases: [],
      description: "A theory of knowledge.",
      noteIds: [article.id],
      canonicalNoteId: article.id,
      color: "#8798ff",
      autoLink: true,
    };
    const onOpenConcept = vi.fn();

    render(
      <NoteView
        note={sourceNote}
        notes={[sourceNote, article]}
        concepts={[concept]}
        onOpenNote={vi.fn()}
        onOpenConcept={onOpenConcept}
        onUpdateNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "positivism, open wiki article",
      }),
    );
    expect(onOpenConcept).toHaveBeenCalledWith(concept.id);
  });
});
