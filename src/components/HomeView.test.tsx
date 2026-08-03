// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { HomeView } from "./HomeView";

describe("HomeView atmosphere", () => {
  it("keeps the hero actions semantic while rendering the selected atmosphere and glow surfaces", () => {
    const onImport = vi.fn();
    const onNewNote = vi.fn();

    render(
      <HomeView
        snapshot={createEmptySnapshot(
          "New research",
          "2026-07-31T00:00:00.000Z",
        )}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onNewNote={onNewNote}
        onImport={onImport}
        onOpenNotes={vi.fn()}
        onToggleTask={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", {
        name: "Everything you know, in context.",
      }),
    ).toBeVisible();
    expect(
      screen.queryByText("Your living knowledge atlas"),
    ).not.toBeInTheDocument();
    expect(
      document.querySelector('[data-atmosphere="field"]'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Import documents/i }),
    ).toHaveClass("border-glow");

    fireEvent.click(
      screen.getByRole("button", { name: "Import knowledge" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start writing" }));

    expect(onImport).toHaveBeenCalledOnce();
    expect(onNewNote).toHaveBeenCalledOnce();
  });

  it("collects open note tasks with their note and concept in the fixed home card", () => {
    const snapshot = createEmptySnapshot(
      "Data",
      "2026-07-31T00:00:00.000Z",
    );
    snapshot.notes = [
      {
        id: "note-plan",
        title: "Migration plan",
        slug: "migration-plan",
        summary: "",
        body: "- [ ] Compare SQL migrations\n- [x] Archive old export",
        aliases: [],
        tags: [],
        kind: "project",
        status: "ready",
        conceptIds: [],
        sourceIds: [],
        createdAt: snapshot.updatedAt,
        updatedAt: snapshot.updatedAt,
      },
    ];
    snapshot.concepts = [
      {
        id: "concept-sql",
        label: "SQL",
        aliases: [],
        description: "",
        noteIds: ["note-sql"],
        canonicalNoteId: "note-sql",
        color: "#8798ff",
        autoLink: true,
      },
    ];
    const onToggleTask = vi.fn();

    render(
      <HomeView
        snapshot={snapshot}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onNewNote={vi.fn()}
        onImport={vi.fn()}
        onOpenNotes={vi.fn()}
        onToggleTask={onToggleTask}
      />,
    );

    expect(screen.getAllByText("Migration plan")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "SQL" })).toBeVisible();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Complete Compare SQL migrations",
      }),
    );
    expect(onToggleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        noteId: "note-plan",
        conceptLabel: "SQL",
      }),
      true,
    );
    expect(screen.queryByText("Archive old export")).not.toBeInTheDocument();
  });
});
