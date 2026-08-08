// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { Source } from "../types";
import { RichNoteEditor } from "./RichNoteEditor";

const NOW = "2026-08-07T00:00:00.000Z";

beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getClientRects: {
      configurable: true,
      value: () => [],
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({
        bottom: 0,
        height: 0,
        left: 0,
        right: 0,
        top: 0,
        width: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    },
  });
});

const attachedSource: Source = {
  id: "source-attached",
  title: "Attached lecture",
  kind: "audio",
  importedAt: NOW,
  text: "Existing provenance.",
  noteIds: ["note-citation"],
};

const spaceSource: Source = {
  id: "source-space",
  title: "Space report",
  kind: "pdf",
  importedAt: NOW,
  text: "A source from elsewhere in the Space.",
  noteIds: [],
};

describe("RichNoteEditor source citations", () => {
  it("lists attached sources first and writes a portable citation", async () => {
    const onChange = vi.fn();
    const onAttachSource = vi.fn();
    render(
      <RichNoteEditor
        noteId="note-citation"
        markdown="Claim."
        notes={[]}
        concepts={[]}
        sources={[spaceSource, attachedSource]}
        attachedSourceIds={[attachedSource.id]}
        onChange={onChange}
        onAttachSource={onAttachSource}
        onRegisterConcept={vi.fn()}
        onDisableConceptAutoLink={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cite a source" }));
    const dialog = screen.getByRole("dialog", { name: "Cite a source" });
    const sourceChoices = within(dialog)
      .getAllByRole("button")
      .filter(
        (button) =>
          button.getAttribute("aria-label") !==
          "Close source citation picker",
      );
    expect(sourceChoices[0]).toHaveTextContent("Attached lecture");
    expect(sourceChoices[0]).toHaveTextContent("Attached to this note");
    await waitFor(() => expect(sourceChoices[0]).toHaveFocus());

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(
      screen.queryByRole("dialog", { name: "Cite a source" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cite a source" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Cite a source" })).getByRole(
        "button",
        { name: /Space report/ },
      ),
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        "[1](orion-source://source-space) Claim.\n\n## References\n\n1. [Space report](orion-source://source-space)",
      ),
    );
    expect(screen.getByRole("heading", { name: "References" })).toBeVisible();
    expect(screen.getByText("Space report")).toBeVisible();
    expect(onAttachSource).toHaveBeenCalledOnce();
    expect(onAttachSource).toHaveBeenCalledWith(spaceSource.id);
  });
});
