// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { ChatView } from "./ChatView";

const NOW = "2026-07-28T08:00:00.000Z";

describe("ChatView", () => {
  it("shows one Chat surface and directs an unconfigured user to Settings", () => {
    const snapshot = createEmptySnapshot("Moon archive", NOW, "space-moon");
    const onOpenSettings = vi.fn();

    render(
      <ChatView
        snapshot={snapshot}
        busy={false}
        onSend={vi.fn()}
        onClear={vi.fn()}
        onOpenNote={vi.fn()}
        onSaveReply={vi.fn()}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByRole("heading", { name: "Chat" })).toBeVisible();
    expect(screen.getByText(/Think with your whole Space/i)).toBeVisible();
    expect(screen.queryByText(/Concept Studio/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Dialectic/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/thinking cards/i)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Configure OpenAI key" }),
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("sends a suggested prompt through the Space-scoped Chat", async () => {
    const snapshot = createEmptySnapshot(
      "Research Space",
      NOW,
      "space-research",
    );
    snapshot.settings.apiKeyConfigured = true;
    const onSend = vi.fn().mockResolvedValue({
      reply: "The Space points to one unresolved assumption.",
    });

    render(
      <ChatView
        snapshot={snapshot}
        busy={false}
        onSend={onSend}
        onClear={vi.fn()}
        onOpenNote={vi.fn()}
        onSaveReply={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "What connections am I missing?",
      }),
    );

    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        "What connections am I missing?",
      ),
    );
  });

  it("renders the conversation and starts a new chat without card controls", () => {
    const snapshot = createEmptySnapshot(
      "Research Space",
      NOW,
      "space-research",
    );
    snapshot.settings.apiKeyConfigured = true;
    snapshot.studio.messages.push({
      id: "chat-assistant",
      role: "assistant",
      content: "The strongest connection is **orientation**.",
      cardIds: ["legacy-card"],
      contextCardIds: ["legacy-card"],
      createdAt: NOW,
    });
    const onClear = vi.fn();

    render(
      <ChatView
        snapshot={snapshot}
        busy={false}
        onSend={vi.fn()}
        onClear={onClear}
        onOpenNote={vi.fn()}
        onSaveReply={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("orientation")).toBeVisible();
    expect(screen.queryByText(/legacy-card/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("opens notes created by Chat and offers a one-click save for ordinary replies", () => {
    const snapshot = createEmptySnapshot("Research Space", NOW, "space-research");
    snapshot.settings.apiKeyConfigured = true;
    snapshot.notes.push({
      id: "note-created",
      title: "Created from Chat",
      slug: "created-from-chat",
      summary: "A permanent note.",
      body: "Permanent prose.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    snapshot.studio.messages.push(
      {
        id: "chat-created",
        role: "assistant",
        content: "I created the requested note.",
        cardIds: [],
        contextCardIds: [],
        createdNoteIds: ["note-created"],
        createdAt: NOW,
      },
      {
        id: "chat-saveable",
        role: "assistant",
        content: "An ordinary useful reply.",
        cardIds: [],
        contextCardIds: [],
        createdAt: NOW,
      },
    );
    const onOpenNote = vi.fn();
    const onSaveReply = vi.fn();

    render(
      <ChatView
        snapshot={snapshot}
        busy={false}
        onSend={vi.fn()}
        onClear={vi.fn()}
        onOpenNote={onOpenNote}
        onSaveReply={onSaveReply}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open note: Created from Chat" }),
    );
    expect(onOpenNote).toHaveBeenCalledWith("note-created");
    fireEvent.click(screen.getByRole("button", { name: "Keep as note" }));
    expect(onSaveReply).toHaveBeenCalledWith("chat-saveable");
  });
});
