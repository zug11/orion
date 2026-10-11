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
  it.each(["chat", "search"] as const)("reads an 18,000-word note in one batch for %s, retaining beginning, middle and end", async purpose => {
    const snapshot = createEmptySnapshot("Stories", NOW, "stories");
    const body = "Opening revelation. " + "story ".repeat(9_000) + "Middle reversal. " + "story ".repeat(9_000) + "Final resolution.";
    snapshot.notes = [note("story", body)];
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const context = packet(request);
      if (!context.evidence.length) return { reply: "", readRequests: [read("note-full", "story")] };
      expect(context.evidence.map((item: { text: string }) => item.text).join("")).toBe(body);
      expect(context.documents).toEqual([expect.objectContaining({ id: "story", complete: true, firstUnread: null })]);
      const ids = ["Opening revelation", "Middle reversal", "Final resolution"].map(text => context.evidence.find((item: { text: string }) => item.text.includes(text)).id);
      return { reply: `The opening [[${ids[0]}]], reversal [[${ids[1]}]], and resolution [[${ids[2]}]] form an arc.`, readRequests: [] };
    });
    const result = await runChatReading(snapshot, "Read this entire story and analyze its arc", driver, { purpose, focusNoteId: "story" });
    expect(driver).toHaveBeenCalledTimes(2);
    expect(result.evidence).toHaveLength(3);
    expect(result.coverage?.limited).toBe(false);
    expect(snapshot.notes[0].body).toBe(body);
  });

  it("reports missing ranges when a Unicode document exceeds the whole-document budget", async () => {
    const snapshot = createEmptySnapshot("Stories", NOW, "stories");
    snapshot.notes = [note("story", "😀漢\\\"\n".repeat(30_000))];
    let turn = 0;
    await runChatReading(snapshot, "Read this story", async request => {
      const context = packet(request);
      if (turn++ === 0) return { reply: "", readRequests: [read("note-full", "story")] };
      expect(context.documents[0].complete).toBe(false);
      expect(context.documents[0].firstUnread).toBeGreaterThan(3_000);
      expect(context.documents[0].firstUnread).toBeLessThan(snapshot.notes[0].body.length);
      for (const item of context.evidence) {
        expect(item.text).toBe(snapshot.notes[0].body.slice(item.start, item.end));
        expect(item.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      }
      return { reply: `Only part of the document was read [[${context.evidence[0].id}]].`, readRequests: [] };
    }, { focusNoteId: "story" });
  });

  it("marks evicted documents incomplete and keeps final citations bounded independently of the reading workspace", async () => {
    const snapshot = createEmptySnapshot("Stories", NOW, "stories");
    snapshot.notes = [note("first", "First story. ".repeat(8_000)), note("second", "Second story. ".repeat(8_000)), note("third", "Third story. ".repeat(8_000))];
    let turn = 0;
    const result = await runChatReading(snapshot, "Compare stories", async request => {
      const context = packet(request);
      if (turn++ === 0) return { reply: "", readRequests: snapshot.notes.map(n => read("note-full", n.id)) };
      expect(context.documents.find((item: { id: string }) => item.id === "first").complete).toBe(false);
      if (turn === 2) return { reply: context.evidence.slice(0, 13).map((item: { id: string }) => `Finding [[${item.id}]]`).join(" "), readRequests: [] };
      expect(context.correction).toContain("twelve");
      return { reply: `Partial comparison [[${context.evidence.at(-1).id}]].`, readRequests: [] };
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.coverage?.limited).toBe(true);
  });

  it("keeps full reads Space-local, read-only and filtered while allowing explicit task history", async () => {
    const snapshot = createEmptySnapshot("Tasks", NOW, "tasks");
    snapshot.notes = [note("tasks", "Visible prose.\n\n- [x] hidden action\n- [ ] pending action")];
    for (const history of [false, true]) {
      let turn = 0;
      await runChatReading(snapshot, history ? "Read completed tasks history" : "Read the whole note", async request => {
        const context = packet(request);
        if (turn++ === 0) return { reply: "", readRequests: [read("note-full", "foreign-space-note"), read("note-full", "tasks")] };
        expect(context.results[0].error).toContain("not discovered in this Space");
        expect(JSON.stringify(context.evidence).includes("hidden action")).toBe(history);
        expect(context.documents[0].complete).toBe(true);
        return { reply: "Read the available text [[e1]].", readRequests: [], noteActions: [{ title: "Injected", body: "Forbidden", aliases: [], tags: [], summary: "" }] };
      }, { focusNoteId: "tasks" }).then(result => expect(result.noteActions).toBeUndefined());
    }
    expect(snapshot.notes).toHaveLength(1);
    expect(snapshot.notes[0].body).toContain("hidden action");
  });
  it("routes this-note questions to a validated current note without treating its summary as evidence", async () => {
    const snapshot = fixture();
    let turn = 0;
    const result = await runChatReading(snapshot, "What does this note say?", async request => {
      const context = packet(request);
      if (turn++ === 0) {
        expect(context.currentNote.id).toBe("renewal");
        expect(context.evidence).toEqual([]);
        expect(context.currentNote.body).toBeUndefined();
        return { reply: "", readRequests: [read("note", context.currentNote.id)] };
      }
      return { reply: "It says 14 November [[e1]].", readRequests: [] };
    }, { focusNoteId: "renewal" });
    expect(result.evidence?.[0].entityId).toBe("renewal");
    await runChatReading(snapshot, "Hello", async request => {
      expect(packet(request).currentNote).toBeUndefined();
      return { reply: "Hello." };
    }, { focusNoteId: "foreign-note" });
  });

  it("can research and create on the final step only, with authority from the user's prompt", async () => {
    const snapshot = fixture();
    const action = { title: "Contract finding", body: "The note gives 14 November [[e1]].", summary: "Finding", tags: [], aliases: [] };
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const context = packet(request);
      return context.evidence.length
        ? { reply: "Here is the finding [[e1]].", noteActions: [action] }
        : { reply: "Premature claim", readRequests: [read("note", "renewal")], noteActions: [action] };
    });
    const result = await runChatReading(snapshot, "Research the contract and create a note about the deadline.", driver);
    const applied = applyChatResult(snapshot, "Research the contract and create a note about the deadline.", result, NOW, () => "message", () => "created");
    expect(driver).toHaveBeenCalledTimes(2);
    expect(applied.notes).toHaveLength(snapshot.notes.length + 1);
    expect(applied.notes[applied.notes.length - 1]?.body).toContain("14 November");
    const replyOnly = await runChatReading(snapshot, "What is the contract deadline?", driver);
    expect(replyOnly.noteActions).toBeUndefined();
    expect(snapshot.notes).toHaveLength(120);
  });
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

  it.each(["chat", "search"] as const)("keeps read-only %s work across unrelated edits and reports exact read dependencies", async purpose => {
    const snapshot = fixture(); const dependencies = vi.fn();
    const result = await runChatReading(snapshot, "Contract deadline?", async request => {
      const context = packet(request);
      if (!context.evidence.length) return { reply: "", readRequests: [read("note", "renewal")] };
      snapshot.notes[0].body = "Changed unrelated work";
      return { reply: "The deadline is 14 November [[e1]]." };
    }, { purpose, freshness: "evidence", currentSnapshot: () => snapshot, onDependencies: dependencies });
    expect(result.evidence?.[0].entityId).toBe("renewal");
    expect(dependencies).toHaveBeenLastCalledWith([expect.objectContaining({ kind: "note", id: "renewal" })]);
  });

  it.each(["note", "source", "settings", "space"])("rejects changed %s dependencies in evidence freshness mode", async change => {
    const snapshot = fixture();
    await expect(runChatReading(snapshot, "Contract deadline?", async request => {
      const context = packet(request);
      if (!context.evidence.length) return { reply: "", readRequests: [read("note", "renewal"), read("source", "agreement")] };
      if (change === "note") snapshot.notes[119].body = "A different deadline";
      if (change === "source") snapshot.sources[0].text = "A different agreement";
      if (change === "settings") snapshot.settings.reasoningEffort = "high";
      if (change === "space") snapshot.workspace.id = "another-space";
      return { reply: "The deadline is 14 November [[e1]]." };
    }, { purpose: "search", freshness: "evidence", currentSnapshot: () => snapshot })).rejects.toThrow("Space changed");
  });

  it("never relaxes creation freshness when evidence mode is requested", async () => {
    const snapshot = fixture();
    await expect(runChatReading(snapshot, "Create a note", async () => {
      snapshot.notes[0].body = "Unrelated change";
      return { reply: "A note", noteActions: [{ title: "Title", body: "Body", summary: "", aliases: [], tags: [] }] };
    }, { freshness: "evidence", currentSnapshot: () => snapshot })).rejects.toThrow("Space changed");
  });

  it.each(["focused", "rewrite"] as const)("restores strict snapshot checks when a read becomes a %s edit", async editIntent => {
    const snapshot = fixture();
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const context = packet(request);
      if (!context.evidence.length) return { reply: "", readRequests: [read("note-full", "renewal")] };
      snapshot.notes[0].body = "An unrelated change after the read";
      return { reply: "Review this change", editIntent,
        ...(editIntent === "focused" ? { noteEdits: [{ before: "14 November", after: "15 November" }] }
          : { noteRewrite: "The contract deadline is 15 November." }) };
    });
    await expect(runChatReading(snapshot, "Improve this note", driver, {
      focusNoteId: "renewal", freshness: "evidence", currentSnapshot: () => snapshot,
    })).rejects.toThrow("Space changed");
    expect(driver).toHaveBeenCalledTimes(2);
    expect(snapshot.notes[119].body).toBe("The contract deadline is 14 November.");
  });

  it("retains current follow-up evidence and newest conversation without granting historical write authority", async () => {
    const snapshot = fixture();
    snapshot.notes[119].title = "A neutral title";
    snapshot.studio.messages = [{ id: "prior-answer", role: "assistant", content: "We were discussing this deadline.",
      evidence: [{ id: "e1", kind: "note", entityId: "renewal", title: "A neutral title", version: "old-version",
        start: 0, end: 3, text: "Old", offsetUnit: "utf16" }], cardIds: [], contextCardIds: [], createdAt: NOW }];
    const originalMessages = structuredClone(snapshot.studio.messages);
    await runChatReading(snapshot, "Explain that connection", async request => {
      expect(request.prompt).toBe("Explain that connection");
      expect(request.allowNoteActions).toBe(false);
      expect(request.history.slice(-1)[0]?.content).toContain("Latest correction: focus on the deadline.");
      expect(request.history.slice(-1)[0]?.content).not.toContain("Discarded early thought");
      expect(request.history.reduce((size, message) => size + [...message.content].length, 0)).toBeLessThanOrEqual(12_000);
      const context = packet(request);
      expect(context.directory.some((item: { id: string }) => item.id === "renewal")).toBe(true);
      expect(context.evidence).toEqual([]);
      return { reply: "Which aspect should we explore?" };
    }, { conversationContext: "Discarded early thought. " + "Earlier conversation. ".repeat(500) + "Previously: save this as a note. Latest correction: focus on the deadline." });
    expect(snapshot.studio.messages).toEqual(originalMessages);
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


describe("Chat current-note edit proposals", () => {
  it("reads the target before proposing edits and keeps the note unchanged", async () => {
    const snapshot = fixture();
    let turn = 0;
    const result = await runChatReading(snapshot, "Rewrite this note to say the deadline more clearly", async request => {
      expect(request.editNoteId).toBe("renewal");
      if (turn++ === 0) return { reply: "", readRequests: [read("note", "renewal")] };
      return { editIntent: "focused", reply: "The revision is ready to review.", readRequests: [], noteEdits: [{ before: "The contract deadline is 14 November.", after: "The contract is due on 14 November." }] };
    }, { focusNoteId: "renewal" });
    expect(result.editProposal?.noteId).toBe("renewal");
    expect(result.editProposal?.spaceId).toBe(snapshot.workspace.id);
    expect(snapshot.notes[119].body).toBe("The contract deadline is 14 November.");
    const next = applyChatResult(snapshot, "Rewrite this note", result, NOW, () => "message", () => "created");
    expect(next.notes.map(note => ({ id: note.id, body: note.body, updatedAt: note.updatedAt }))).toEqual(snapshot.notes.map(note => ({ id: note.id, body: note.body, updatedAt: note.updatedAt })));
  });
  it("ignores foreign targets and keeps conversational answers free of proposals", async () => {
    for (const [prompt, focusNoteId] of [["Rewrite this note", "foreign"], ["Summarize this note", "renewal"]]) {
      const result = await runChatReading(fixture(), prompt, async request => {
        expect(request.editNoteId).toBe(focusNoteId === "renewal" ? "renewal" : undefined);
        return { editIntent: "none", reply: "A response.", readRequests: [], noteEdits: [{ before: "The contract deadline is 14 November.", after: "Changed." }] };
      }, { focusNoteId });
      expect(result.editProposal).toBeUndefined();
    }
  });
});

it("corrects chat-only drafts for add-and-edit requests before returning a proposal", async () => {
  const snapshot = fixture(); let turn = 0;
  const result = await runChatReading(snapshot, "add a paragraph and edit the text", async request => {
    const context = packet(request);
    expect(request.editNoteId).toBe("renewal");
    if (turn++ === 0) return { editIntent: "focused", reply: "A chat-only draft.", readRequests: [] };
    if (turn === 2) {
      expect(context.correction).toContain("chat-only draft");
      return { reply: "", readRequests: [read("note", "renewal")] };
    }
    return { editIntent: "focused", reply: "Review in the note.", noteEdits: [{ before: snapshot.notes[119].body, after: "The deadline is 14 November.\n\nPrepare before then." }] };
  }, { focusNoteId: "renewal" });
  expect(result.editProposal?.edits[0].after).toContain("\n\nPrepare");
  expect(snapshot.notes[119].body).not.toContain("Prepare");
});
it("lazily reads only the captured note when the agent chooses a full revision", async () => {
  const snapshot = fixture(); const original = snapshot.notes[119].body; let turn = 0;
  const result = await runChatReading(snapshot, "Rework the entire note and add a closing paragraph", async request => {
    const context = packet(request);
    expect(request.editNoteId).toBe("renewal"); expect(request.allowNoteActions).toBe(false);
    if (turn++ === 0) {
      expect(context.editTarget).toBeUndefined();
      return { reply: "", editIntent: "rewrite", noteEdits: [], noteRewrite: "" };
    }
    expect(context.editTarget).toEqual({ body: original });
    return { editIntent: "rewrite", reply: "Review in the note.", noteRewrite: original + "\n\nAn added paragraph." };
  }, { focusNoteId: "renewal" });
  expect(turn).toBe(2);
  expect(result.editProposal).toMatchObject({ mode: "rewrite", noteId: "renewal", baseBody: original });
  expect(snapshot.notes[119].body).toBe(original);
});
it("offers precise edits when a complete revision exceeds the read limit without truncating the note", async () => {
  const snapshot = fixture(); snapshot.notes[119].body = "Opening sentence.\n\n" + "x".repeat(24001); let turn = 0;
  const result = await runChatReading(snapshot, "Improve this draft", async request => {
    const context = packet(request);
    if (turn++ === 0) return { reply: "", editIntent: "rewrite" };
    expect(context.editTarget.unavailable).toContain("exceeds");
    expect(context.editTarget.body).toBeUndefined();
    if (turn === 2) return { reply: "", editIntent: "focused", readRequests: [read("note", "renewal", "", 0)] };
    return { reply: "I revised the opening only; the full note exceeds one review.", editIntent: "focused", noteEdits: [{ before: "Opening sentence.", after: "A clearer opening." }] };
  }, { focusNoteId: "renewal" });
  expect(result.editProposal?.edits).toHaveLength(1);
  expect(result.editProposal?.baseBody).toBe(snapshot.notes[119].body);
  expect(result.reply).toContain("opening only");
});
it("can follow conversational intent without matching English editing keywords", async () => {
  const snapshot = fixture();
  snapshot.studio.messages.push({ id: "advice", role: "assistant", content: "I can clarify the opening deadline sentence.", cardIds: [], contextCardIds: [], createdAt: NOW });
  let turn = 0;
  const result = await runChatReading(snapshot, "yes, do that", async request => {
    expect(request.history.some(message => message.content.includes("clarify the opening"))).toBe(true);
    if (turn++ === 0) return { reply: "", editIntent: "focused", readRequests: [read("note", "renewal")] };
    return { reply: "Ready to review", editIntent: "focused", noteEdits: [{ before: snapshot.notes[119].body, after: "The contract is due on 14 November." }] };
  }, { focusNoteId: "renewal" });
  expect(result.editProposal?.noteId).toBe("renewal");
});
it.each(["What changes would you suggest?", "Don't edit this; explain it", "Should I rewrite it?", 'The quote says "rewrite the note". What does that mean?'])
  ("answers or clarifies %s in the ordinary conversation with no full-body read", async prompt => {
    const driver = vi.fn(async (request: ChatRequest) => {
      expect(packet(request).editTarget).toBeUndefined();
      return { reply: "A conversational response.", editIntent: "none" as const };
    });
    const result = await runChatReading(fixture(), prompt, driver, { focusNoteId: "renewal" });
    expect(result.editProposal).toBeUndefined();
    expect(driver).toHaveBeenCalledOnce();
  });
it("keeps explicit note creation separate even with an attached note", async () => {
  await runChatReading(fixture(), "Create a note about this contract", async request => {
    expect(request.allowNoteActions).toBe(true); expect(request.editNoteId).toBeUndefined();
    return { reply: "Ready" };
  }, { focusNoteId: "renewal" });
});
