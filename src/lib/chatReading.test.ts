import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatReadRequest, ChatRequest, ChatResult, Note } from "../types";
import { applyChatResult, saveChatReplyAsNote } from "./chat";
import { runChatReading, MAX_CHAT_READING_TURNS } from "./chatReading";
import { MAX_CHAT_READING_CONTEXT_BYTES, parseChatReadRequests } from "./chatReadingProtocol";
import { prepareSpaceKnowledgeIndex } from "./spaceKnowledge";

const NOW = "2026-09-08T00:00:00.000Z";
function note(id: string, body: string, title = id): Note {
  return { id, title, body, summary: "", slug: id, kind: "article", status: "ready", aliases: [], tags: [],
    sourceIds: [], conceptIds: [], createdAt: NOW, updatedAt: NOW };
}
function fixture() {
  const snapshot = createEmptySnapshot("Research", NOW, "space-research");
  snapshot.notes = Array.from({ length: 120 }, (_, index) => note(`note-${index}`, "Unrelated material."));
  snapshot.notes[119] = note("renewal", "The contract deadline is 14 November.", "Contract renewal");
  snapshot.notes[119].sourceIds = ["agreement"];
  snapshot.sources = [{ id: "agreement", title: "Original agreement", kind: "text", importedAt: NOW,
    text: "The signed contract gives a deadline of 15 November.", noteIds: ["renewal"] }];
  return snapshot;
}
function read(kind: ChatReadRequest["kind"], id: string, query = "", start: number | null = null): ChatReadRequest {
  return { kind, id, query, start };
}
function packet(request: ChatRequest) {
  expect(request.mode).toBe("chat-reading");
  expect(request.notes).toEqual([]);
  expect(request.sources).toEqual([]);
  expect(new TextEncoder().encode(request.readingContext).length).toBeLessThanOrEqual(MAX_CHAT_READING_CONTEXT_BYTES);
  return JSON.parse(request.readingContext!);
}

describe("adaptive Chat reading", () => {
  it("finds evidence beyond the former first-80-note limit and reads original support before citing", async () => {
    const snapshot = fixture();
    const before = structuredClone(snapshot);
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const context = packet(request);
      if (!context.evidence.length) {
        expect(context.directory.some((item: { id: string }) => item.id === "renewal")).toBe(true);
        return { reply: "", readRequests: [read("note", "renewal")] };
      }
      if (context.evidence.length === 1) return { reply: "", readRequests: [read("source", "agreement")] };
      return { reply: "The note says 14 November [[e1]], while the agreement says 15 November [[e2]].", readRequests: [] };
    });
    const result = await runChatReading(snapshot, "What is the contract deadline?", driver);
    expect(driver).toHaveBeenCalledTimes(3);
    expect(result.reply).toContain("[1](#orion-evidence-e1)");
    expect(result.evidence?.map((item) => item.text)).toEqual([snapshot.notes[119].body, snapshot.sources[0].text]);
    expect(result.coverage).toMatchObject({ openedNotes: 1, openedSources: 1, limited: true });
    expect(snapshot).toEqual(before);
  });

  it("searches entire source bodies independently of the hierarchy and opens late passages", async () => {
    const snapshot = fixture();
    snapshot.sources.push({ id: "appendix", title: "Appendix", kind: "text", importedAt: NOW, noteIds: [],
      text: "Background. ".repeat(900) + "Zirconium exception: the new deadline is December." });
    let turn = 0;
    const driver = vi.fn(async (request: ChatRequest) => {
      const context = packet(request);
      if (turn++ === 0) return { reply: "", readRequests: [read("search", "", "zirconium")] };
      if (turn === 2) {
        expect(context.directory.some((entry: { id: string }) => entry.id === "appendix")).toBe(true);
        return { reply: "", readRequests: [read("source", "appendix", "zirconium")] };
      }
      const evidence = context.evidence.find((item: { text: string }) => item.text.includes("Zirconium"));
      expect(evidence.start).toBeGreaterThan(6_000);
      return { reply: `The appendix gives a December deadline [[${evidence.id}]].`, readRequests: [] };
    });
    const result = await runChatReading(snapshot, "Check the exception.", driver);
    expect(result.evidence?.[0].entityId).toBe("appendix");
    expect(result.evidence?.[0].text).toContain("new deadline is December");
  });

  it("uses the maintained cluster directory without uploading its note bodies", async () => {
    const snapshot = fixture();
    snapshot.spaceKnowledge = prepareSpaceKnowledgeIndex(snapshot, NOW);
    let turn = 0;
    await runChatReading(snapshot, "What ideas are here?", async (request) => {
      const context = packet(request);
      if (turn++ === 0) {
        expect(context.orientation.root).toBeDefined();
        expect(context.evidence).toEqual([]);
        return { reply: "", readRequests: [read("cluster", context.orientation.root.id)] };
      }
      expect(context.results[0].operation).toBe("cluster");
      return { reply: "I have a directory, but have not inspected the supporting notes.", readRequests: [] };
    });
  });

  it("contains cross-Space or invented IDs and repairs a fabricated citation", async () => {
    const snapshot = fixture();
    let turn = 0;
    const result = await runChatReading(snapshot, "Contract?", async (request) => {
      const context = packet(request);
      if (turn++ === 0) return { reply: "", readRequests: [read("note", "another-space-note")] };
      if (turn === 2) {
        expect(context.evidence).toEqual([]);
        expect(context.results[0].error).toContain("not discovered");
        return { reply: "Unsupported answer [[e999]].", readRequests: [] };
      }
      expect(context.correction).toContain("outside the current evidence");
      return { reply: "I could not establish that from the material read.", readRequests: [] };
    });
    expect(result.evidence).toEqual([]);
    expect(result.reply).not.toContain("e999");
  });

  it("stops repeated reads and gives the model one bounded final-answer opportunity", async () => {
    let calls = 0;
    const result = await runChatReading(fixture(), "Contract?", async (request) => {
      calls += 1;
      return packet(request).finalizing ? { reply: "The note gives 14 November [[e1]].", readRequests: [] }
        : { reply: "", readRequests: [read("note", "renewal")] };
    });
    expect(calls).toBeLessThanOrEqual(MAX_CHAT_READING_TURNS);
    expect(result.coverage?.limited).toBe(true);
  });

  it("rejects changed knowledge before another read or a late note creation", async () => {
    const snapshot = fixture();
    const driver = vi.fn(async () => {
      snapshot.notes[119].body = "Updated by the user during reading.";
      return { reply: "An obsolete answer", noteActions: [{ title: "Old note", summary: "", body: "Old", tags: [], aliases: [] }] };
    });
    await expect(runChatReading(snapshot, "Create a note about the contract", driver, { currentSnapshot: () => snapshot }))
      .rejects.toThrow("Space changed");
    expect(driver).toHaveBeenCalledTimes(1);
    expect(snapshot.notes).toHaveLength(120);
  });

  it("stops before dispatch when cancelled and never starts another reading turn after cancellation", async () => {
    const stopped = new AbortController();
    stopped.abort(new Error("Stopped"));
    const unused = vi.fn();
    await expect(runChatReading(fixture(), "Contract?", unused, { signal: stopped.signal })).rejects.toThrow("Stopped");
    expect(unused).not.toHaveBeenCalled();
    const controller = new AbortController();
    const driver = vi.fn(async () => {
      controller.abort(new Error("Stopped"));
      return { reply: "", readRequests: [read("note", "renewal")] };
    });
    await expect(runChatReading(fixture(), "Contract?", driver, { signal: controller.signal })).rejects.toThrow("Stopped");
    expect(driver).toHaveBeenCalledTimes(1);
  });

  it("preserves exact Unicode ranges and bounds a growing reading packet in bytes", async () => {
    const snapshot = fixture();
    snapshot.sources = Array.from({ length: 12 }, (_, index) => ({ id: `source-${index}`, title: `Unicode contract ${index}`,
      text: "😀證據".repeat(2_000), kind: "text" as const, importedAt: NOW, noteIds: [] }));
    snapshot.notes = [];
    let turn = 0;
    const result = await runChatReading(snapshot, "Unicode contract", async (request) => {
      const context = packet(request);
      for (const item of context.evidence) {
        const source = snapshot.sources.find((source) => source.id === item.entityId)!;
        expect(item.text).toBe(source.text.slice(item.start, item.end));
        expect(item.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
      if (turn++ < 3) return { reply: "", readRequests: snapshot.sources.slice((turn - 1) * 4, turn * 4).map((source) => read("source", source.id, "", 1)) };
      return { reply: `The preserved passage is available [[${context.evidence[0].id}]].`, readRequests: [] };
    });
    expect(result.evidence?.[0].offsetUnit).toBe("utf16");
  });

  it("keeps cited replies as portable notes with bidirectional source provenance", async () => {
    const snapshot = fixture();
    let turn = 0;
    const result = await runChatReading(snapshot, "What does the agreement say?", async (request) => {
      const context = packet(request);
      if (turn++ === 0) return { reply: "", readRequests: [read("source", "agreement")] };
      return { reply: `The agreement says 15 November [[${context.evidence[0].id}]].`, readRequests: [] };
    });
    let id = 0;
    const applied = applyChatResult(snapshot, "What does the agreement say?", result, NOW, () => `message-${id++}`);
    const saved = saveChatReplyAsNote(applied, "message-1", NOW, "saved-note");
    expect(saved.notes[0].body).toContain("orion-source://agreement");
    expect(saved.notes[0].body).not.toContain("#orion-evidence");
    expect(saved.notes[0].title).toBe("The agreement says 15 November.");
    expect(saved.notes[0].summary).toBe("The agreement says 15 November.");
    expect(saved.notes[0].sourceIds).toEqual(["agreement"]);
    expect(saved.sources[0].noteIds).toContain("saved-note");
    expect(saved.studio.messages[1].evidence?.[0].text).toBe(snapshot.sources[0].text);
  });

  it("rejects malformed tools and cannot turn a reading operation into write authority", async () => {
    expect(() => parseChatReadRequests([{ kind: "delete", id: "renewal", query: "", start: null }])).toThrow();
    expect(() => parseChatReadRequests([{ kind: "note", id: "renewal", query: "", start: -1 }])).toThrow();
    expect(() => parseChatReadRequests([{ kind: "note", id: "renewal", query: "" }])).toThrow();
    const snapshot = fixture();
    let turn = 0;
    const injected = [{ title: "Unrequested", summary: "", body: "Should not be created", tags: [], aliases: [] }];
    const result = await runChatReading(snapshot, "Contract?", async (request) => {
      expect(request.allowNoteActions).toBe(false);
      return turn++ === 0 ? { reply: "I created a note", readRequests: [read("note", "renewal")], noteActions: injected }
        : { reply: "The note gives 14 November [[e1]].", readRequests: [], noteActions: injected };
    });
    const applied = applyChatResult(snapshot, "Contract?", result, NOW, () => "message");
    expect(applied.notes).toHaveLength(snapshot.notes.length);
    expect(result.noteActions).toBeUndefined();
  });
});
