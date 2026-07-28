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
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("orientation")).toBeVisible();
    expect(screen.queryByText(/legacy-card/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
