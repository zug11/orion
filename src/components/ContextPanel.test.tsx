// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { ContextPanel } from "./ContextPanel";

const NOW = "2026-08-05T00:00:00.000Z";

describe("ContextPanel", () => {
  it("keeps connections and sources on demand while leaving the outline in the note", () => {
    const snapshot = createEmptySnapshot("Research", NOW);
    const note: Note = {
      id: "note-details",
      title: "Field notes",
      slug: "field-notes",
      summary: "A compact note.",
      body: "## Findings\n\nThe material is connected.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: ["source-field"],
      createdAt: NOW,
      updatedAt: NOW,
    };
    snapshot.notes = [note];
    snapshot.sources = [
      {
        id: "source-field",
        title: "Field transcript",
        kind: "text",
        importedAt: NOW,
        text: "The original material.",
        noteIds: [note.id],
      },
    ];
    const onClose = vi.fn();
    const onOpenSource = vi.fn();

    render(
      <ContextPanel
        note={note}
        snapshot={snapshot}
        onOpenNote={vi.fn()}
        onOpenSource={onOpenSource}
        onClose={onClose}
      />,
    );

    const panel = screen.getByRole("region", {
      name: "Connections and sources for Field notes",
    });
    expect(panel).toHaveAttribute("id", "note-details-panel");
    expect(screen.getByText("Connections")).toBeVisible();
    expect(screen.queryByText("On this page")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Field transcript" }));
    expect(onOpenSource).toHaveBeenCalledWith("source-field");

    fireEvent.click(
      screen.getByRole("button", { name: "Close connections and sources" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});
