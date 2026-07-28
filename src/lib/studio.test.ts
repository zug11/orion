import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatResult, StudioCard } from "../types";
import {
  applyChatResult,
  buildChatRequest,
  ChatRequestRegistry,
} from "./chat";
import {
  normalizeStudio,
} from "./studio";

const NOW = "2026-07-28T04:00:00.000Z";

describe("Chat and legacy Studio state", () => {
  it("normalizes unsafe layout state and removes missing selections", () => {
    const snapshot = createStudioSnapshot();
    snapshot.studio.selectedCardIds = ["card-existing", "card-missing"];
    snapshot.studio.zoom = 9;
    snapshot.studio.chatCollapsed = true;
    snapshot.studio.canvasCollapsed = true;

    expect(normalizeStudio(snapshot.studio)).toMatchObject({
      selectedCardIds: ["card-existing"],
      zoom: 1.3,
      chatCollapsed: true,
      canvasCollapsed: false,
    });
  });

  it("builds a bounded request from only the active Space", () => {
    const snapshot = createStudioSnapshot();
    snapshot.studio.activeConceptId = "concept-orion";
    snapshot.studio.selectedCardIds = ["card-existing"];
    snapshot.studio.messages = Array.from({ length: 15 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Message ${index}`,
      cardIds: [],
      contextCardIds: [],
      createdAt: NOW,
    }));

    const request = buildChatRequest(
      snapshot,
      `  ${"question ".repeat(2_000)}  `,
    );

    expect(request.prompt.length).toBe(8_000);
    expect(request.workspaceName).toBe("Research Space");
    expect(request).not.toHaveProperty("focusConcept");
    expect(request).not.toHaveProperty("selectedCards");
    expect(request.history).toHaveLength(12);
    expect(request.history[0].content).toBe("Message 3");
    expect(request.notes).toEqual([
      expect.objectContaining({ title: "Northern sky" }),
    ]);
  });

  it("appends a reply without surfacing or mutating legacy cards", () => {
    const snapshot = createStudioSnapshot();
    snapshot.studio.selectedCardIds = ["card-existing"];
    snapshot.studio.view = "dialectic";
    snapshot.studio.zoom = 1.2;
    snapshot.studio.canvasCollapsed = true;
    const legacyState = {
      cards: structuredClone(snapshot.studio.cards),
      selectedCardIds: [...snapshot.studio.selectedCardIds],
      activeConceptId: snapshot.studio.activeConceptId,
      view: snapshot.studio.view,
      zoom: snapshot.studio.zoom,
      chatCollapsed: snapshot.studio.chatCollapsed,
      canvasCollapsed: snapshot.studio.canvasCollapsed,
    };
    const result: ChatResult = {
      reply: "The strongest tension is between navigation and narration.",
    };
    let nextId = 0;

    const applied = applyChatResult(
      snapshot,
      "Find a synthesis.",
      result,
      NOW,
      () => `generated-${nextId++}`,
    );

    expect(snapshot.studio.messages).toHaveLength(0);
    expect(applied.studio.messages).toHaveLength(2);
    expect(applied.studio.messages).toEqual([
      expect.objectContaining({
        id: "generated-0",
        role: "user",
        cardIds: [],
        contextCardIds: [],
      }),
      expect.objectContaining({
        id: "generated-1",
        role: "assistant",
        cardIds: [],
        contextCardIds: [],
      }),
    ]);
    expect(applied.studio).toMatchObject({
      ...legacyState,
      messages: expect.any(Array),
    });
    expect(applied.studio.cards).toEqual(snapshot.studio.cards);
    expect(nextId).toBe(2);
  });

  it("rejects concurrent and stale requests independently per Space", () => {
    const registry = new ChatRequestRegistry();
    const first = registry.start("space-a", "request-a");
    const otherSpace = registry.start("space-b", "request-b");

    expect(first).not.toBeNull();
    expect(otherSpace).not.toBeNull();
    expect(registry.start("space-a", "request-a-duplicate")).toBeNull();
    expect(registry.isCurrent(first!)).toBe(true);

    registry.invalidate("space-a");

    expect(registry.isCurrent(first!)).toBe(false);
    expect(registry.isCurrent(otherSpace!)).toBe(true);
    expect(registry.finish(first!)).toBe(true);
    expect(registry.start("space-a", "request-a-next")).not.toBeNull();
  });
});

function createStudioSnapshot() {
  const snapshot = createEmptySnapshot(
    "Research Space",
    NOW,
    "space-research",
  );
  snapshot.notes.push({
    id: "note-north",
    title: "Northern sky",
    slug: "northern-sky",
    summary: "A note about orientation.",
    body: "Orion is used to find north.",
    aliases: [],
    tags: [],
    kind: "article",
    status: "ready",
    conceptIds: ["concept-orion"],
    sourceIds: ["source-log"],
    createdAt: NOW,
    updatedAt: NOW,
  });
  snapshot.sources.push({
    id: "source-log",
    title: "Observatory log",
    kind: "text",
    importedAt: NOW,
    text: "A record of the northern sky.",
    noteIds: ["note-north"],
  });
  snapshot.concepts.push({
    id: "concept-orion",
    label: "Orion",
    aliases: [],
    description: "A constellation and orientation marker.",
    noteIds: ["note-north"],
    color: "#9baaff",
    autoLink: true,
  });
  const existingCard: StudioCard = {
    id: "card-existing",
    kind: "claim",
    title: "Existing thought",
    body: "Orientation changes interpretation.",
    epistemicStatus: "inferred",
    origin: "user",
    stage: "accepted",
    dialecticRole: "thesis",
    conceptIds: ["concept-orion"],
    noteIds: ["note-north"],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
  snapshot.studio.cards.push(existingCard);
  return snapshot;
}
