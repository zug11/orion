// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Note } from "../types";
import { ConceptLinkPopover } from "./ConceptLinkPopover";

const NOW = "2026-07-28T10:00:00.000Z";

describe("ConceptLinkPopover", () => {
  it("creates a blank named article without invoking AI", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit);

    fireEvent.click(
      screen.getByRole("button", { name: "Create blank article" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", [], {
      articleMode: "blank",
    });
  });

  it("round-trips explicit destinations for a legacy branched link", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit, ["note-current"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Create branched link" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", ["note-current"], {
      articleMode: "blank",
    });
  });

  it("makes source-aware AI writing explicit before article creation", () => {
    const onSubmit = vi.fn();
    renderPopover(onSubmit, [], true);

    fireEvent.change(
      screen.getByPlaceholderText(
        "What should this page explain or emphasize?",
      ),
      { target: { value: "Focus on joins and relational algebra." } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Generate article" }),
    );

    expect(onSubmit).toHaveBeenCalledWith("SQL", [], {
      articleMode: "ai",
      articleInstructions: "Focus on joins and relational algebra.",
    });
  });
});

function renderPopover(
  onSubmit: (
    phrase: string,
    destinationIds: string[],
    options: {
      articleMode: "ai" | "blank";
      articleInstructions?: string;
    },
  ) => void,
  initialDestinationIds: readonly string[] = [],
  aiArticleWritingEnabled = false,
) {
  render(
    <ConceptLinkPopover
      initialPhrase="SQL"
      initialDestinationIds={initialDestinationIds}
      currentNoteId="note-current"
      notes={[makeNote("note-current", "Project notes")]}
      aiArticleWritingEnabled={aiArticleWritingEnabled}
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
