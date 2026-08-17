// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { resolveThemePalette } from "../lib/theme";
import { HomeView } from "./HomeView";

describe("HomeView atmosphere", () => {
  it("keeps the hero actions semantic while rendering the selected atmosphere and glow surfaces", () => {
    const onImport = vi.fn();
    const onNewNote = vi.fn();
    const snapshot = createEmptySnapshot(
      "New research",
      "2026-07-31T00:00:00.000Z",
    );
    snapshot.settings.themeAccentCustom = "#B16BDA";
    snapshot.settings.themeCanvasCustom = "#111B24";
    snapshot.settings.themeSurfaceCustom = "#162B34";
    const themePalette = resolveThemePalette(snapshot.settings, "dark");

    render(
      <HomeView
        snapshot={snapshot}
        themePalette={themePalette}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onNewNote={onNewNote}
        onImport={onImport}
        onOpenNotes={vi.fn()}
        onToggleTask={vi.fn()}
        onRefreshOverview={vi.fn()}
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
      document.querySelector<HTMLElement>('[data-atmosphere="field"]')?.style
        .getPropertyValue("--atmosphere-background"),
    ).toBe(themePalette.canvasDeep);
    expect(
      document.querySelector<HTMLElement>('[data-atmosphere="field"]')?.style
        .getPropertyValue("--atmosphere-background-secondary"),
    ).toBe(themePalette.surface0);
    expect(
      document.querySelector<HTMLElement>('[data-atmosphere="field"]')?.style
        .getPropertyValue("--atmosphere-primary"),
    ).toBe(themePalette.accentStrong);
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
        noteIds: ["note-sql", "note-plan"],
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
        onRefreshOverview={vi.fn()}
      />,
    );

    expect(document.querySelector(".recent-note-card strong")).toHaveTextContent(
      "Migration plan",
    );
    expect(screen.queryByText("Note", { exact: true })).not.toBeInTheDocument();
    expect(
      screen.queryByText("Project", { exact: true }),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".home-task-copy strong")).toHaveTextContent(
      "Compare SQL migrations",
    );
    expect(document.querySelector(".home-task-concept")).toHaveTextContent(
      "SQL",
    );
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
    expect(screen.queryByText("Concepts with gravity")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Around SQL" })).toBeVisible();
  });

  it("keeps an existing overview visible while it is being refreshed", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      "2026-07-31T00:00:00.000Z",
    );
    snapshot.notes = [
      {
        id: "note-one",
        title: "Living systems",
        slug: "living-systems",
        summary: "",
        body: "Knowledge changes as context arrives.",
        aliases: [],
        tags: [],
        kind: "article",
        status: "ready",
        conceptIds: [],
        sourceIds: [],
        createdAt: snapshot.updatedAt,
        updatedAt: snapshot.updatedAt,
      },
    ];
    snapshot.spaceOverview = {
      title: "Knowledge in motion",
      body: "The existing orientation remains readable while Orion revises it.",
      relatedNoteIds: ["note-one"],
      generatedAt: snapshot.updatedAt,
      stale: true,
    };
    snapshot.settings.apiKeyConfigured = true;

    render(
      <HomeView
        snapshot={snapshot}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onNewNote={vi.fn()}
        onImport={vi.fn()}
        onOpenNotes={vi.fn()}
        onToggleTask={vi.fn()}
        onRefreshOverview={vi.fn()}
        overviewBusy
      />,
    );

    expect(screen.getByRole("heading", { name: "Knowledge in motion" })).toBeVisible();
    expect(
      screen.getByText(
        "The existing orientation remains readable while Orion revises it.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Revising with the latest context…")).toBeVisible();
  });

  it("keeps a stale cached overview visible when no API key is configured", () => {
    const snapshot = createEmptySnapshot(
      "Research",
      "2026-07-31T00:00:00.000Z",
    );
    snapshot.notes = [
      {
        id: "note-one",
        title: "Living systems",
        slug: "living-systems",
        summary: "A note about knowledge changing over time.",
        body: "Knowledge changes as context arrives.",
        aliases: [],
        tags: [],
        kind: "article",
        status: "ready",
        conceptIds: [],
        sourceIds: [],
        createdAt: snapshot.updatedAt,
        updatedAt: snapshot.updatedAt,
      },
    ];
    snapshot.spaceOverview = {
      title: "Knowledge in motion",
      body: "The last generated orientation remains useful.",
      relatedNoteIds: ["note-one"],
      generatedAt: snapshot.updatedAt,
      stale: true,
    };

    render(
      <HomeView
        snapshot={snapshot}
        onOpenNote={vi.fn()}
        onOpenConcept={vi.fn()}
        onNewNote={vi.fn()}
        onImport={vi.fn()}
        onOpenNotes={vi.fn()}
        onToggleTask={vi.fn()}
        onRefreshOverview={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Knowledge in motion" })).toBeVisible();
    expect(screen.getByText("The last generated orientation remains useful.")).toBeVisible();
    expect(screen.getByText("New context awaits an OpenAI key")).toBeVisible();
  });
});
