import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatResult, StudioCard } from "../types";
import {
  applyChatResult,
  buildChatRequest,
  chatPromptAllowsNoteCreation,
  ChatRequestRegistry,
  normalizeChatNoteActions,
  saveChatReplyAsNote,
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
    expect(request.allowNoteActions).toBe(false);
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

  it("creates bounded permanent notes from explicit Chat actions", () => {
    const snapshot = createStudioSnapshot();
    let messageIndex = 0;
    const applied = applyChatResult(
      snapshot,
      "Create a note about orientation.",
      {
        reply: "I created the note.",
        noteActions: [
          {
            title: "Orientation through Orion",
            summary: "How Orion functions as an orientation marker.",
            body: "# Orientation through Orion\n\nA grounded permanent note.",
            tags: ["navigation"],
            aliases: ["Orion orientation"],
          },
        ],
      },
      NOW,
      () => `message-${messageIndex++}`,
      () => "note-chat",
    );

    expect(applied.notes[0]).toMatchObject({
      id: "note-chat",
      title: "Orientation through Orion",
      body: expect.stringContaining("grounded permanent note"),
      tags: ["navigation"],
      status: "ready",
    });
    expect(
      applied.studio.messages[applied.studio.messages.length - 1]
        ?.createdNoteIds,
    ).toEqual(["note-chat"]);
    expect(
      applied.concepts.some(
        (concept) => concept.canonicalNoteId === "note-chat",
      ),
    ).toBe(true);
  });

  it("drops malformed Chat actions and can save an ordinary reply manually", () => {
    expect(
      normalizeChatNoteActions([
        {
          title: "Valid note",
          summary: "A summary.",
          body: "Useful prose.",
          tags: [],
          aliases: [],
        },
        {
          title: "Oversized",
          summary: "",
          body: "x".repeat(6_001),
          tags: [],
          aliases: [],
        },
      ]),
    ).toHaveLength(1);

    const snapshot = createStudioSnapshot();
    snapshot.studio.messages.push({
      id: "assistant-reply",
      role: "assistant",
      content: "## A useful synthesis\n\nThis can become a note.",
      cardIds: [],
      contextCardIds: [],
      createdAt: NOW,
    });
    const applied = saveChatReplyAsNote(
      snapshot,
      "assistant-reply",
      NOW,
      "note-saved",
    );

    expect(applied.notes[0]).toMatchObject({
      id: "note-saved",
      title: "A useful synthesis",
      body: expect.stringContaining("This can become a note"),
    });
    expect(applied.studio.messages[0].createdNoteIds).toEqual([
      "note-saved",
    ]);
    const repeated = saveChatReplyAsNote(
      applied,
      "assistant-reply",
      NOW,
      "note-duplicate",
    );
    expect(repeated).toBe(applied);
    expect(repeated.notes.some((note) => note.id === "note-duplicate")).toBe(
      false,
    );
  });

  it("authorizes note creation only from an explicit user request", () => {
    expect(chatPromptAllowsNoteCreation("Please create a note about Orion.")).toBe(
      true,
    );
    expect(chatPromptAllowsNoteCreation("Save this answer as a note.")).toBe(true);
    expect(chatPromptAllowsNoteCreation("Can you create a note about Orion?")).toBe(
      true,
    );
    expect(chatPromptAllowsNoteCreation("Could you make me a note about this?")).toBe(
      true,
    );
    expect(chatPromptAllowsNoteCreation("Summarize this Space.")).toBe(false);
    expect(
      chatPromptAllowsNoteCreation("Do not create a note; just summarize it."),
    ).toBe(false);
    expect(
      chatPromptAllowsNoteCreation("Don’t create a note; just summarize it."),
    ).toBe(false);
    expect(
      chatPromptAllowsNoteCreation("Can you show me how to create a note?"),
    ).toBe(false);
    expect(chatPromptAllowsNoteCreation("How should I create a note?")).toBe(
      false,
    );

    const snapshot = createStudioSnapshot();
    const request = buildChatRequest(snapshot, "Create a note about Orion.");
    expect(request.allowNoteActions).toBe(true);
    const applied = applyChatResult(
      snapshot,
      "Summarize this Space.",
      {
        reply: "A conversational answer.",
        noteActions: [
          {
            title: "Injected write",
            summary: "Should never land.",
            body: "Untrusted context requested this write.",
            tags: [],
            aliases: [],
          },
        ],
      },
      NOW,
      () => "message-safe",
      () => "note-unsafe",
    );
    expect(applied.notes.some((note) => note.id === "note-unsafe")).toBe(false);
    expect(applied.studio.messages[1]).not.toHaveProperty("createdNoteIds");
  });

  it("rejects internal metadata, controls, and reserved tags from Chat notes", () => {
    const base = {
      title: "Safe title",
      summary: "Safe summary.",
      body: "Safe prose.",
      tags: [] as string[],
      aliases: [] as string[],
    };
    expect(
      normalizeChatNoteActions([
        { ...base, tags: ["orion-link-draft"] },
        { ...base, body: "<!-- orion-link-draft -->Unsafe" },
        { ...base, title: "Unsafe\u0000title" },
      ]),
    ).toEqual([]);
    expect(
      normalizeChatNoteActions([
        { ...base, body: "🙂".repeat(6_000) },
      ]),
    ).toHaveLength(1);
    expect(
      normalizeChatNoteActions([
        { ...base, body: "🙂".repeat(6_001) },
      ]),
    ).toEqual([]);
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
