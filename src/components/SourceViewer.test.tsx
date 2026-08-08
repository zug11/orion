// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Note, Source } from "../types";
import { SourceViewer } from "./SourceViewer";

const NOW = "2026-08-07T00:00:00.000Z";

describe("SourceViewer", () => {
  it("shows preserved text and opens a note shaped by the source", () => {
    const note: Note = {
      id: "note-lecture",
      title: "Lecture notes",
      slug: "lecture-notes",
      summary: "The resulting note.",
      body: "Body",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: ["source-lecture"],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const source: Source = {
      id: "source-lecture",
      title: "Lecture transcript",
      kind: "youtube",
      importedAt: NOW,
      sourceUrl: "https://www.youtube.com/watch?v=example",
      text: "The complete preserved transcript.",
      noteIds: [note.id],
    };
    const onOpenNote = vi.fn();

    render(
      <SourceViewer
        source={source}
        notes={[note]}
        onOpenNote={onOpenNote}
        onDeleteSource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("The complete preserved transcript.")).toBeVisible();
    expect(screen.getByRole("link", { name: /Open original/i })).toHaveAttribute(
      "href",
      source.sourceUrl,
    );
    fireEvent.click(screen.getByRole("button", { name: /Lecture notes/ }));
    expect(onOpenNote).toHaveBeenCalledWith(note.id);
  });

  it("closes with Escape", () => {
    const source: Source = {
      id: "source-text",
      title: "Pasted source",
      kind: "text",
      importedAt: NOW,
      text: "Content",
      noteIds: [],
    };
    const onClose = vi.fn();

    render(
      <SourceViewer
        source={source}
        notes={[]}
        onOpenNote={vi.fn()}
        onDeleteSource={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("presents image imports as recognized text", () => {
    const source: Source = {
      id: "source-whiteboard",
      title: "Planning whiteboard",
      kind: "image",
      importedAt: NOW,
      fileName: "planning.heic",
      mimeType: "image/heic",
      text: "Recognized whiteboard notes",
      noteIds: [],
    };

    render(
      <SourceViewer
        source={source}
        notes={[]}
        onOpenNote={vi.fn()}
        onDeleteSource={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Recognized text")).toBeVisible();
    expect(screen.getByText("Recognized whiteboard notes")).toBeVisible();
  });

  it("exposes source deletion without closing first", () => {
    const source: Source = {
      id: "source-text",
      title: "Pasted source",
      kind: "text",
      importedAt: NOW,
      text: "Content",
      noteIds: [],
    };
    const onDeleteSource = vi.fn();

    render(
      <SourceViewer
        source={source}
        notes={[]}
        onOpenNote={vi.fn()}
        onDeleteSource={onDeleteSource}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete source Pasted source" }),
    );
    expect(onDeleteSource).toHaveBeenCalledWith(source.id);
  });
});
