// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note } from "../types";
import { ContextPanel } from "./ContextPanel";

const NOW = "2026-08-05T00:00:00.000Z";

describe("ContextPanel", () => {
  it("shows supporting, qualifying, and conflicting arguments even when they also mention this note", () => {
    const snapshot = createEmptySnapshot("Arguments", NOW);
    const note: Note = {
      id: "origin", title: "Recognition account", slug: "recognition", summary: "An account.",
      body: "Recognition has limits.", aliases: [], tags: [], kind: "article", status: "ready",
      conceptIds: ["recognition"], sourceIds: [], createdAt: NOW, updatedAt: NOW,
    };
    snapshot.notes = [note, ...["Supporting argument", "Qualifying argument", "Conflicting argument"].map((title, index) => ({
      ...note, id: `other-${index}`, title, body: "Recognition matters here.", conceptIds: [],
    }))];
    snapshot.concepts = [{
      id: "recognition", label: note.title, aliases: ["recognition"], description: "An account.",
      canonicalNoteId: note.id, noteIds: [note.id], autoLink: true, color: "#8ea4ff",
    }];
    snapshot.relationships = ["supports", "qualifies", "conflicts"].map((kind, index) => ({
      id: `relation-${index}`, fromNoteId: `other-${index}`, toNoteId: note.id,
      kind: kind as "supports" | "qualifies" | "conflicts", label: kind, strength: 0.8,
      context: `Reason ${index}.`,
    }));
    const onOpenNote = vi.fn();
    render(<ContextPanel note={note} snapshot={snapshot} onOpenNote={onOpenNote} onOpenSource={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByText("Supports this note — Reason 0.")).toBeVisible();
    expect(screen.getByText("Qualifies this note — Reason 1.")).toBeVisible();
    expect(screen.getByText("Conflicts with this note — Reason 2.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Qualifying argument/ }));
    expect(onOpenNote).toHaveBeenCalledWith("other-1");
  });

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
