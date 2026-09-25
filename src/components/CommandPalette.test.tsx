// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { CommandPalette } from "./CommandPalette";

describe("CommandPalette search", () => {
  it("finds a body-only note match and opens the exact note with Enter", () => {
    const snapshot = createEmptySnapshot();
    snapshot.notes = [{
      id: "note-evidence", title: "Notebook", slug: "notebook", summary: "Unrelated summary", body: `${"Earlier content. ".repeat(50)}A unique body-only observation.`,
      aliases: [], tags: [], conceptIds: [], sourceIds: [], kind: "article", status: "ready",
      createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
    }];
    const callbacks = makeCallbacks();
    render(<CommandPalette open snapshot={snapshot} {...callbacks} />);
    const input = screen.getByPlaceholderText("Find a note, concept, source, or action…");
    fireEvent.change(input, { target: { value: "unique body-only" } });
    expect(screen.getByText(/A unique body-only observation/)).toBeVisible();
    expect(screen.queryByText("Unrelated summary")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onOpenNote).toHaveBeenCalledWith("note-evidence");
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it("opens the precise source from a text match instead of the Sources index", () => {
    const snapshot = createEmptySnapshot();
    snapshot.sources = [
      { id: "unrelated", title: "Unrelated source", kind: "text", importedAt: "2026-09-01T00:00:00.000Z", text: "Other text", noteIds: [] },
      { id: "source-exact", title: "Preserved lecture", kind: "audio", importedAt: "2026-09-01T00:00:00.000Z", text: "The transcript contains a source-only phrase.", noteIds: [] },
    ];
    const callbacks = makeCallbacks();
    render(<CommandPalette open snapshot={snapshot} {...callbacks} />);
    fireEvent.change(screen.getByPlaceholderText("Find a note, concept, source, or action…"), { target: { value: "source-only phrase" } });
    fireEvent.click(screen.getByRole("button", { name: /Preserved lecture/ }));
    expect(callbacks.onOpenSource).toHaveBeenCalledWith("source-exact");
    expect(callbacks.onOpenView).not.toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });
});

function makeCallbacks() {
  return {
    onClose: vi.fn(), onOpenNote: vi.fn(), onOpenSource: vi.fn(), onOpenConcept: vi.fn(),
    onOpenView: vi.fn(), onNewNote: vi.fn(), onImport: vi.fn(),
  };
}
