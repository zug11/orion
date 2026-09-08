// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { StudioMessage } from "../types";
import { stableKnowledgeHash } from "../lib/spaceKnowledge";
import { ChatReply } from "./ChatReply";

const NOW = "2026-09-08T00:00:00.000Z";
function fixture() {
  const snapshot = createEmptySnapshot("Research", NOW, "space-research");
  const source = { id: "agreement", title: "Agreement", kind: "text" as const, text: "The deadline is 15 November.", importedAt: NOW, noteIds: [] };
  snapshot.sources = [source];
  const message: StudioMessage = { id: "reply", role: "assistant", content: "The deadline is 15 November. [1](#orion-evidence-e1)", cardIds: [], contextCardIds: [], createdAt: NOW,
    evidence: [{ id: "e1", kind: "source", entityId: source.id, title: source.title, version: stableKnowledgeHash(JSON.stringify(source)), start: 0, end: source.text.length, text: source.text, offsetUnit: "utf16" }],
    coverage: { availableNotes: 0, availableSources: 2, openedNotes: 0, openedSources: 1, searches: 1, limited: true } };
  return { snapshot, message };
}

describe("Chat evidence", () => {
  it("opens exact support on demand, preserves button focus, and navigates to the local source", () => {
    const { snapshot, message } = fixture();
    const onOpenSource = vi.fn();
    render(<ChatReply snapshot={snapshot} message={message} onOpenNote={vi.fn()} onOpenSource={onOpenSource} />);
    expect(screen.queryByRole("complementary", { name: "Cited passage" })).not.toBeInTheDocument();
    const citation = screen.getByRole("button", { name: "Read citation: Agreement" });
    citation.focus();
    fireEvent.click(citation);
    expect(citation).toHaveFocus();
    expect(citation).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Exact passage read for this reply.")).toBeVisible();
    expect(screen.getByText(/Partial Space coverage/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(onOpenSource).toHaveBeenCalledWith("agreement");
    fireEvent.click(screen.getByRole("button", { name: "Close cited passage" }));
    expect(citation).toHaveFocus();
    expect(citation).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the historical quote and labels changed or removed supporting material", () => {
    const { snapshot, message } = fixture();
    snapshot.sources[0].text = "The deadline has changed.";
    const { rerender } = render(<ChatReply snapshot={snapshot} message={message} onOpenNote={vi.fn()} onOpenSource={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Read citation: Agreement" }));
    expect(screen.getByText(/has changed since the reply/)).toBeVisible();
    expect(screen.getByRole("complementary")).toHaveTextContent("The deadline is 15 November.");
    rerender(<ChatReply snapshot={{ ...snapshot, sources: [] }} message={message} onOpenNote={vi.fn()} onOpenSource={vi.fn()} />);
    expect(screen.getByText(/no longer in this Space/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open source" })).toBeDisabled();
  });

  it("does not make an unknown citation or cross-Space item into a navigation action", () => {
    const { snapshot, message } = fixture();
    message.evidence = [];
    render(<ChatReply snapshot={snapshot} message={message} onOpenNote={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Read citation/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
