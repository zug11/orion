// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { ConceptLinkPopover } from "./ConceptLinkPopover";

const NOW = "2026-07-28T10:00:00.000Z";

describe("ConceptLinkPopover", () => {
  it("submits an empty destination list to create or reuse the named article", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit);

    fireEvent.click(
      screen.getByRole("button", { name: "Create article link" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", []);
  });

  it("round-trips explicit destinations for a legacy branched link", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit, ["note-current"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Create branched link" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", ["note-current"]);
  });
});

function renderPopover(
  onSubmit: (phrase: string, destinationIds: string[]) => void,
  initialDestinationIds: readonly string[] = [],
) {
  render(
    <ConceptLinkPopover
      initialPhrase="SQL"
      initialDestinationIds={initialDestinationIds}
      currentNoteId="note-current"
      notes={[makeNote("note-current", "Project notes")]}
      onCancel={vi.fn()}
      onSubmit={onSubmit}
    />,
  );
}

function makeNote(id: string, title: string): Note {
  return {
    id,
    title,
    slug: title.toLocaleLowerCase().replace(/\s+/g, "-"),
    summary: `${title} summary`,
    body: "",
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
