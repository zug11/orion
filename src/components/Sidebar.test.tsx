// @vitest-environment jsdom

import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { LinkedArticleJob } from "../lib/linkedArticle";
import type { Note } from "../types";
import { Sidebar } from "./Sidebar";

const NOW = "2026-07-29T01:00:00.000Z";

describe("Sidebar generate composer", () => {
  it("keeps New note blank and opens Generate from the chevron", () => {
    const onNewNote = vi.fn();
    const onGenerate = vi.fn();
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");

    render(
      <Sidebar
        view="home"
        notes={[]}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[]}
        generateEnabled
        onGenerate={onGenerate}
        onViewChange={vi.fn()}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onNewNote={onNewNote}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onNewNote).toHaveBeenCalledTimes(1);
    expect(onGenerate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Generate options" }));
    fireEvent.click(screen.getByRole("radio", { name: "Podcast" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    expect(onGenerate).toHaveBeenCalledWith({
      kind: "podcast",
      instruction: "",
    });
  });

  it("collapses to an icon rail without text labels", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const onToggleCollapsed = vi.fn();
    render(
      <Sidebar
        view="home"
        notes={[]}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[]}
        collapsed
        onToggleCollapsed={onToggleCollapsed}
        onViewChange={vi.fn()}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    expect(document.querySelector(".sidebar")).toHaveClass("is-collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(onToggleCollapsed).toHaveBeenCalled();
  });
});

describe("Sidebar linked article progress", () => {
  it("keeps settings as the only footer control", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const onViewChange = vi.fn();

    render(
      <Sidebar
        view="home"
        notes={[]}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[]}
        onViewChange={onViewChange}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    expect(screen.queryByText("AI organiser")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });

  it("shows a phase-based progress card that opens the article", () => {
    const snapshot = createEmptySnapshot(
      "Data systems",
      NOW,
      "space-data",
    );
    const onOpenNote = vi.fn();
    const job: LinkedArticleJob = {
      id: "job-sql",
      workspaceId: snapshot.workspace.id,
      noteId: "note-sql",
      originNoteId: "note-lecture",
      title: "SQL",
      originTitle: "Database lecture",
      progress: 68,
      stage: "writing",
    };

    render(
      <Sidebar
        view="notes"
        notes={[]}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[job]}
        onViewChange={vi.fn()}
        onOpenNote={onOpenNote}
        onDeleteNote={vi.fn()}
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/Writing wiki article · from Database lecture/i),
    ).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Creating SQL" }),
    ).toHaveAttribute("aria-valuenow", "68");

    fireEvent.click(
      screen.getByRole("button", {
        name: /SQL\. Writing wiki article from Database lecture/i,
      }),
    );
    expect(onOpenNote).toHaveBeenCalledWith("note-sql");
  });

  it("offers restart and delete actions for paused generation", () => {
    const snapshot = createEmptySnapshot(
      "Data systems",
      NOW,
      "space-data",
    );
    const onRestartLinkedArticle = vi.fn();
    const onDeleteLinkedArticle = vi.fn();
    const job: LinkedArticleJob = {
      id: "job-sql",
      workspaceId: snapshot.workspace.id,
      noteId: "note-sql",
      originNoteId: "note-lecture",
      title: "SQL",
      originTitle: "Database lecture",
      progress: 71,
      stage: "error",
      error: "OpenAI did not respond.",
    };

    render(
      <Sidebar
        view="notes"
        notes={[]}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[job]}
        onViewChange={vi.fn()}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={onRestartLinkedArticle}
        onDeleteLinkedArticle={onDeleteLinkedArticle}
      />,
    );

    expect(
      screen.getByText(/Generation paused · from Database lecture/i),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onRestartLinkedArticle).toHaveBeenCalledWith(job);
    expect(onDeleteLinkedArticle).toHaveBeenCalledWith(job);
  });

  it("keeps favorites above a complete note list without moving opened notes", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const notes = [
      makeNote("never-new", "Never new", "2026-07-29T00:59:00.000Z"),
      makeNote(
        "opened-old",
        "Opened old",
        "2026-07-20T00:00:00.000Z",
        "2026-07-28T09:00:00.000Z",
      ),
      makeNote("never-old", "Never old", "2026-07-01T00:00:00.000Z"),
      makeNote(
        "opened-new",
        "Opened new",
        "2026-07-02T00:00:00.000Z",
        "2026-07-29T00:30:00.000Z",
      ),
      makeNote("never-mid", "Never mid", "2026-07-15T00:00:00.000Z"),
      makeNote("six", "Six", "2026-07-14T00:00:00.000Z"),
      makeNote(
        "seven",
        "Seven",
        "2026-07-13T00:00:00.000Z",
        undefined,
        true,
      ),
    ];

    const { container } = render(
      <Sidebar
        view="notes"
        notes={notes}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[]}
        onViewChange={vi.fn()}
        onOpenNote={vi.fn()}
        onDeleteNote={vi.fn()}
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    expect(screen.queryByText("Recently opened")).not.toBeInTheDocument();
    const favorites = screen.getByRole("region", { name: "Favorites" });
    const allNotes = screen.getByRole("region", { name: "All notes" });
    expect(favorites).toBeVisible();
    expect(allNotes).toBeVisible();
    expect(
      within(favorites).getAllByRole("button", { name: /^Open / }),
    ).toHaveLength(1);
    expect(
      within(favorites).getByRole("button", { name: "Open Seven" }),
    ).toBeVisible();
    expect(
      within(allNotes)
        .getAllByRole("button", { name: /^Open / })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Open Never new",
      "Open Opened old",
      "Open Never old",
      "Open Opened new",
      "Open Never mid",
      "Open Six",
      "Open Seven",
    ]);
    expect(
      within(allNotes).getAllByRole("button", { name: /^Open / }),
    ).toHaveLength(7);
    expect(
      screen.getAllByRole("button", { name: /^Open Seven$/ }),
    ).toHaveLength(2);
    expect(
      container.querySelectorAll('[data-orion-icon="favorite"]'),
    ).toHaveLength(3);
    expect(container.querySelector(".note-nav-dot")).toBeNull();
  });

  it("deletes a sidebar note without opening it", () => {
    const snapshot = createEmptySnapshot("Data systems", NOW, "space-data");
    const note = makeNote("note-sql", "SQL", NOW);
    const onOpenNote = vi.fn();
    const onDeleteNote = vi.fn();

    render(
      <Sidebar
        view="notes"
        notes={[note]}
        spaces={[snapshot]}
        activeSpaceId={snapshot.workspace.id}
        activeNoteId={null}
        linkedArticleJobs={[]}
        onViewChange={vi.fn()}
        onOpenNote={onOpenNote}
        onDeleteNote={onDeleteNote}
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete SQL" }));
    expect(onDeleteNote).toHaveBeenCalledWith(note.id);
    expect(onOpenNote).not.toHaveBeenCalled();
  });
});

function makeNote(
  id: string,
  title: string,
  updatedAt: string,
  lastOpenedAt?: string,
  pinned = false,
): Note {
  return {
    id,
    title,
    slug: id,
    summary: `${title} summary`,
    body: `${title} body`,
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt,
    lastOpenedAt,
    pinned,
  };
}
