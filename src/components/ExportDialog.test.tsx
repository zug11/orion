// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Concept, Note } from "../types";
import { ExportDialog } from "./ExportDialog";

const NOW = "2026-08-07T05:00:00.000Z";

function note(id: string, title: string, body: string): Note {
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary: "",
    body,
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture() {
  const snapshot = createEmptySnapshot("Research", NOW);
  snapshot.notes = [
    note("origin", "Origin", "Sociology and [Comte](orion-note://comte)."),
    note("comte", "Comte", "A life."),
    note("sociology", "Sociology", "A discipline."),
    note("other", "Other", "Unrelated."),
  ];
  const concept: Concept = {
    id: "sociology-concept",
    label: "Sociology",
    aliases: [],
    description: "A discipline.",
    noteIds: ["sociology"],
    canonicalNoteId: "sociology",
    color: "#8fa2ff",
    autoLink: true,
  };
  snapshot.concepts = [concept];
  return snapshot;
}

describe("ExportDialog", () => {
  it("defaults to a web export of the open note and previews linked scope", async () => {
    const snapshot = fixture();
    const onExport = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(
      <ExportDialog
        open
        snapshot={snapshot}
        activeNote={snapshot.notes[0]}
        onClose={onClose}
        onExport={onExport}
      />,
    );

    expect(screen.getByRole("radio", { name: /Interactive web article/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("1 note selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /This note and linked pages/i }));
    expect(screen.getByText("3 notes selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Export web article" }));

    expect(onExport).toHaveBeenCalledWith({ format: "web", scope: "linked" });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("uses the whole Space when there is no open note", () => {
    const snapshot = fixture();
    render(
      <ExportDialog
        open
        snapshot={snapshot}
        activeNote={null}
        onClose={vi.fn()}
        onExport={vi.fn().mockResolvedValue(true)}
      />,
    );

    expect(screen.getByRole("radio", { name: /^This note$/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /This note and linked pages/i })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Entire Space/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByText("4 notes selected")).toBeInTheDocument();
  });
});
