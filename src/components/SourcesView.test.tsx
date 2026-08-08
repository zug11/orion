// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Source } from "../types";
import { SourcesView } from "./SourcesView";

describe("SourcesView", () => {
  it("opens a preserved source from the source list", () => {
    const source: Source = {
      id: "source-lecture",
      title: "Lecture transcript",
      kind: "audio",
      importedAt: "2026-08-07T00:00:00.000Z",
      fileName: "lecture.mp3",
      text: "Preserved transcript",
      noteIds: ["note-lecture"],
    };
    const onOpenSource = vi.fn();

    render(
      <SourcesView
        sources={[source]}
        onOpenSource={onOpenSource}
        onDeleteSource={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open source Lecture transcript" }),
    );
    expect(onOpenSource).toHaveBeenCalledWith(source.id);
  });

  it("exposes a dedicated source deletion action", () => {
    const source: Source = {
      id: "source-notes",
      title: "Project notes",
      kind: "text",
      importedAt: "2026-08-07T00:00:00.000Z",
      text: "Preserved notes",
      noteIds: [],
    };
    const onDeleteSource = vi.fn();

    render(
      <SourcesView
        sources={[source]}
        onOpenSource={vi.fn()}
        onDeleteSource={onDeleteSource}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Delete source Project notes" }),
    );
    expect(onDeleteSource).toHaveBeenCalledWith(source.id);
  });

  it("lists image text as its own source format", () => {
    const source: Source = {
      id: "source-board",
      title: "Workshop board",
      kind: "image",
      importedAt: "2026-08-07T00:00:00.000Z",
      fileName: "board.png",
      text: "Recognized workshop plan",
      noteIds: [],
    };

    render(
      <SourcesView
        sources={[source]}
        onOpenSource={vi.fn()}
        onDeleteSource={vi.fn()}
      />,
    );

    expect(screen.getByText("IMAGE")).toBeVisible();
    expect(screen.getByText("board.png")).toBeVisible();
  });
});
