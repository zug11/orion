// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { CommandPalette } from "./CommandPalette";
import { consumeNoteExcerptNavigation } from "../lib/noteExcerptNavigation";
import type { ChatResult } from "../types";

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
    const input = screen.getByPlaceholderText("Search or ask a question…");
    fireEvent.change(input, { target: { value: "unique body-only" } });
    expect(screen.getByRole("option", { name: /Notebook/ })).toHaveTextContent("A unique body-only observation");
    expect(screen.getByText("unique body-only", { selector: "mark" })).toBeVisible();
    expect(screen.queryByText("Unrelated summary")).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onOpenNote).toHaveBeenCalledWith("note-evidence");
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(consumeNoteExcerptNavigation("note-evidence")?.passages[0].text).toContain("unique body-only");
  });

  it("filters before limiting and uses the active Space name", () => {
    const snapshot = createEmptySnapshot("Research room");
    snapshot.sources = Array.from({ length: 45 }, (_, index) => ({ id: `source-${index}`, title: "Quartz", kind: "text" as const, importedAt: "2026-09-01T00:00:00.000Z", text: "Quartz found here.", noteIds: [] }));
    snapshot.concepts = [{ id: "quartz", label: "Quartz concept", description: "A crystal", aliases: [], noteIds: [], autoLink: true, color: "#ffffff" }];
    render(<CommandPalette open snapshot={snapshot} {...makeCallbacks()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Search Research room" }), { target: { value: "quartz" } });
    fireEvent.click(screen.getByRole("button", { name: "Concepts" }));
    expect(screen.getByRole("option", { name: /Quartz concept/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /Quartz found here/ })).not.toBeInTheDocument();
  });

  it("only calls AI after an explicit action and cancels/discards late answers on query edits", async () => {
    const snapshot = createEmptySnapshot();
    snapshot.settings.apiKeyConfigured = true;
    let finish!: (result: ChatResult) => void;
    const onAskSpace = vi.fn((_query: string, _signal: AbortSignal) => new Promise<ChatResult>((resolve) => { finish = resolve; }));
    render(<CommandPalette open snapshot={snapshot} {...makeCallbacks()} onAskSpace={onAskSpace} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "What is quartz?" } });
    expect(onAskSpace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(onAskSpace).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /Answer/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    const signal = onAskSpace.mock.calls[0][1];
    fireEvent.change(input, { target: { value: "What is glass?" } });
    expect(signal.aborted).toBe(true);
    expect(screen.getByRole("listbox", { name: "Search results" })).toBeVisible();
    expect(screen.queryByRole("group", { name: "Search view" })).not.toBeInTheDocument();
    await act(async () => finish({ reply: "Obsolete quartz answer" }));
    expect(screen.queryByText("Obsolete quartz answer")).not.toBeInTheDocument();
  });

  it("offers the selected-provider gate without disabling local results", () => {
    const snapshot = createEmptySnapshot();
    snapshot.settings.model = "claude-sonnet-5";
    snapshot.settings.apiKeyConfigured = true;
    snapshot.settings.anthropicApiKeyConfigured = false;
    render(<CommandPalette open snapshot={snapshot} {...makeCallbacks()} onAskSpace={vi.fn()} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "quartz" } });
    expect(screen.getByRole("button", { name: "Ask AI" })).toBeDisabled();
    expect(screen.getByText("No local matches")).toBeVisible();
  });

  it("cancels when the Space changes and renders a current answer without saving Chat", async () => {
    const snapshot = createEmptySnapshot("First");
    snapshot.settings.apiKeyConfigured = true;
    const onAskSpace = vi.fn(async () => ({ reply: "A supported answer" }));
    const callbacks = makeCallbacks();
    const { rerender } = render(<CommandPalette open snapshot={snapshot} {...callbacks} onAskSpace={onAskSpace} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "quartz" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("A supported answer")).toBeVisible());
    expect(snapshot.studio.messages).toHaveLength(0);
    rerender(<CommandPalette open snapshot={createEmptySnapshot("Second")} {...callbacks} onAskSpace={onAskSpace} />);
    expect(screen.queryByText("A supported answer")).not.toBeInTheDocument();
  });

  it("opens the precise source from a text match instead of the Sources index", () => {
    const snapshot = createEmptySnapshot();
    snapshot.sources = [
      { id: "unrelated", title: "Unrelated source", kind: "text", importedAt: "2026-09-01T00:00:00.000Z", text: "Other text", noteIds: [] },
      { id: "source-exact", title: "Preserved lecture", kind: "audio", importedAt: "2026-09-01T00:00:00.000Z", text: "The transcript contains a source-only phrase.", noteIds: [] },
    ];
    const callbacks = makeCallbacks();
    render(<CommandPalette open snapshot={snapshot} {...callbacks} />);
    fireEvent.change(screen.getByPlaceholderText("Search or ask a question…"), { target: { value: "source-only phrase" } });
    fireEvent.click(screen.getByRole("option", { name: /Preserved lecture/ }));
    expect(callbacks.onOpenSource).toHaveBeenCalledWith("source-exact");
    expect(callbacks.onOpenView).not.toHaveBeenCalled();
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it("preserves an answer while switching views and never repeats a completed AI request", async () => {
    const snapshot = createEmptySnapshot();
    snapshot.settings.apiKeyConfigured = true;
    snapshot.sources = [{ id: "quartz", title: "Quartz", kind: "text", importedAt: "2026-09-01T00:00:00.000Z", text: "Quartz is a crystal.", noteIds: [] }];
    const onAskSpace = vi.fn(async () => ({ reply: "A supported quartz answer" }));
    render(<CommandPalette open snapshot={snapshot} {...makeCallbacks()} onAskSpace={onAskSpace} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "quartz" } });
    expect(onAskSpace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    await waitFor(() => expect(screen.getByText("A supported quartz answer")).toBeVisible());
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Search result type" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Matches 1" }));
    expect(screen.getByRole("button", { name: "Matches 1" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("option", { name: /Quartz/ })).toBeVisible();
    expect(screen.queryByText("A supported quartz answer")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    expect(screen.getByText("A supported quartz answer")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(onAskSpace).toHaveBeenCalledOnce();
    expect(snapshot.studio.messages).toHaveLength(0);
  });

  it("does not open hidden local matches when Enter is pressed in the answer view", async () => {
    const snapshot = createEmptySnapshot();
    snapshot.settings.apiKeyConfigured = true;
    snapshot.sources = [{ id: "quartz", title: "Quartz", kind: "text", importedAt: "2026-09-01T00:00:00.000Z", text: "Quartz is a crystal.", noteIds: [] }];
    const callbacks = makeCallbacks();
    render(<CommandPalette open snapshot={snapshot} {...callbacks} onAskSpace={vi.fn(async () => ({ reply: "A supported quartz answer" }))} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "quartz" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    await waitFor(() => expect(screen.getByText("A supported quartz answer")).toBeVisible());
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(input).not.toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onOpenSource).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Matches 1" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onOpenSource).toHaveBeenCalledWith("quartz");
  });

  it("stops an AI request and retries explicitly without showing the cancelled response", async () => {
    const snapshot = createEmptySnapshot();
    snapshot.settings.apiKeyConfigured = true;
    const pending: Array<(result: ChatResult) => void> = [];
    const onAskSpace = vi.fn((_query: string, _signal: AbortSignal) => new Promise<ChatResult>((resolve) => pending.push(resolve)));
    render(<CommandPalette open snapshot={snapshot} {...makeCallbacks()} onAskSpace={onAskSpace} />);
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "quartz" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    fireEvent.click(screen.getByRole("button", { name: "Matches 0" }));
    fireEvent.click(screen.getByRole("button", { name: /Answer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(onAskSpace).toHaveBeenCalledOnce();
    const firstSignal = onAskSpace.mock.calls[0][1];
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(screen.getByRole("combobox")).toHaveFocus();
    expect(firstSignal.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Search stopped");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onAskSpace).toHaveBeenCalledTimes(2);
    expect(onAskSpace.mock.calls[1][1].aborted).toBe(false);
    await act(async () => pending[0]({ reply: "Cancelled quartz answer" }));
    expect(screen.queryByText("Cancelled quartz answer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    await act(async () => pending[1]({ reply: "Current quartz answer" }));
    expect(screen.getByText("Current quartz answer")).toBeVisible();
    expect(screen.queryByText("No local matches")).not.toBeInTheDocument();
  });

  it("exposes keyboard selection through the combobox and skips IME composition Enter", () => {
    const callbacks = makeCallbacks();
    render(<CommandPalette open snapshot={createEmptySnapshot()} {...callbacks} />);
    const input = screen.getByRole("combobox");
    expect(input).toHaveAttribute("aria-controls", screen.getByRole("listbox").id);
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option", { selected: true }).id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selected = screen.getByRole("option", { selected: true });
    expect(selected).toHaveTextContent("Open Import Studio");
    expect(input).toHaveAttribute("aria-activedescendant", selected.id);
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(callbacks.onImport).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(callbacks.onImport).toHaveBeenCalledOnce();
  });
});

function makeCallbacks() {
  return {
    onClose: vi.fn(), onOpenNote: vi.fn(), onOpenSource: vi.fn(), onOpenConcept: vi.fn(),
    onOpenView: vi.fn(), onNewNote: vi.fn(), onImport: vi.fn(),
  };
}
