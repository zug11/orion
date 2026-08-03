// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { LinkedArticleJob } from "../lib/linkedArticle";
import { Sidebar } from "./Sidebar";

const NOW = "2026-07-29T01:00:00.000Z";

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
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    expect(screen.queryByText("AI organiser")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onViewChange).toHaveBeenCalledWith("settings");
  });

  it("shows a phase-based progress card that opens the draft", () => {
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
      stage: "drafting",
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
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={vi.fn()}
        onDeleteLinkedArticle={vi.fn()}
      />,
    );

    expect(screen.getByText(/Writing wiki article · from Database lecture/i)).toBeVisible();
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

  it("offers restart and delete actions for a paused draft", () => {
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
        onNewNote={vi.fn()}
        onCreateSpace={vi.fn()}
        onSwitchSpace={vi.fn()}
        onRestartLinkedArticle={onRestartLinkedArticle}
        onDeleteLinkedArticle={onDeleteLinkedArticle}
      />,
    );

    expect(
      screen.getByText(/Draft paused · from Database lecture/i),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onRestartLinkedArticle).toHaveBeenCalledWith(job);
    expect(onDeleteLinkedArticle).toHaveBeenCalledWith(job);
  });
});
