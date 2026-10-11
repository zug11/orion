import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { AppSnapshot, ChatPromptSuggestion, Note, Source } from "../types";
import { chatWithOrion } from "./storage";
import { generateChatSuggestions, getChatSuggestionContext, getChatSuggestionContextKey } from "./chatSuggestions";
import { MAX_CHAT_SUGGESTION_CONTEXT_BYTES, parseChatSuggestionContext } from "./chatSuggestionsProtocol";

vi.mock("./storage", () => ({ chatWithOrion: vi.fn() }));
const transport = vi.mocked(chatWithOrion);
function note(id: string, title: string, body: string, extra: Partial<Note> = {}): Note {
  return { id, title, body, slug: id, summary: "", aliases: [], tags: [], conceptIds: [], sourceIds: [], kind: "article", status: "ready", createdAt: "2026-10-09", updatedAt: "2026-10-09", ...extra };
}
function source(id: string, title: string, extra: Partial<Source> = {}): Source {
  return { id, title, kind: "text", text: "Evidence from the source.", noteIds: [], importedAt: "2026-10-09", ...extra };
}
function fixture(): AppSnapshot {
  const snapshot = createEmptySnapshot("Story workshop", "2026-10-09", "space-story");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [
    note("maurice", "Maurice’s transformation", "## A changed mind\nMaurice survives a gunshot wound but cannot remember the promise he made to Elmore.\n\n- [ ] Decide whether he recognizes Elmore in the hospital", { conceptIds: ["promise"], sourceIds: ["research"] }),
    note("elmore", "Elmore’s prize", "Elmore wins his prize on December 2. He still expects Maurice to keep their promise.", { conceptIds: ["promise"] }),
  ];
  snapshot.sources = [source("research", "Memory and identity", { text: "Episodic memory and knowledge of one's own identity may change independently.", noteIds: ["maurice"] })];
  snapshot.concepts = [{ id: "promise", label: "Promise", aliases: [], description: "", noteIds: ["maurice", "elmore"], color: "blue", autoLink: true }];
  return snapshot;
}
function validSuggestions(evidenceIds: string[]): ChatPromptSuggestion[] {
  return [
    { prompt: "Does Maurice's missing memory change what he owes Elmore?", intent: "discuss", evidenceIds: evidenceIds.slice(0, 2) },
    { prompt: "Create a note tracing the promise from Maurice's hospital scene to Elmore's prize.", intent: "create", evidenceIds: evidenceIds.slice(0, 2) },
  ];
}

beforeEach(() => transport.mockReset());

describe("AI prompt suggestion context", () => {
  it("supplies current substance and real neighbors, not generic prompt templates", () => {
    const snapshot = fixture();
    const context = getChatSuggestionContext(snapshot, { focusNoteId: "maurice" })!;
    expect(context.attachedNoteId).toBe("maurice");
    expect(context.evidence[0].entityId).toBe("maurice");
    expect(context.evidence.find(item => item.entityId === "elmore")?.text).toContain("expects Maurice to keep their promise");
    expect(context.evidence.find(item => item.entityId === "research")?.text).toContain("Episodic memory");
    expect(JSON.stringify(context)).not.toContain("strengthen this note");
    expect(parseChatSuggestionContext(JSON.stringify(context))).toEqual(context);
  });

  it("prioritizes older actual neighbors over unrelated recent notes", () => {
    const snapshot = fixture();
    snapshot.notes[1].updatedAt = "2020-01-01";
    snapshot.notes.push(...Array.from({ length: 20 }, (_, index) => note(`recent-${index}`, `Recent ${index}`, "Unrelated recent prose.")));
    const context = getChatSuggestionContext(snapshot, { focusNoteId: "maurice" })!;
    expect(context.evidence.slice(0, 3).some(item => item.entityId === "elmore")).toBe(true);
    expect(context.evidence).toHaveLength(8);
  });

  it("looks past recent empty or fully completed notes within a bounded candidate budget", () => {
    const snapshot = fixture(); snapshot.sources = []; snapshot.concepts = [];
    snapshot.notes = Array.from({ length: 10 }, (_, index) => note(`empty-${index}`, `Empty ${index}`, index % 2 ? "" : "## Retired\n- [x] Finished work"));
    snapshot.notes.push(note("older", "Actual working draft", "Maurice recognizes Elmore but cannot remember their promise.", { updatedAt: "2025-01-01" }));
    const context = getChatSuggestionContext(snapshot)!;
    expect(context.evidence.map(item => item.entityId)).toEqual(["older"]);
    expect(context.directory).toEqual([{ id: "older", title: "Actual working draft" }]);
  });

  it("finds substantive matching material after the opening paragraph", () => {
    const snapshot = fixture();
    snapshot.notes[1].body = `${"A lengthy description of the landscape. ".repeat(100)}\n\nElmore knows the promise is unfair because Maurice no longer remembers making it.`;
    const context = getChatSuggestionContext(snapshot, { focusNoteId: "maurice" })!;
    const passage = context.evidence.find(item => item.entityId === "elmore")!.text;
    expect(passage).toContain("promise is unfair");
    expect([...passage].length).toBeLessThanOrEqual(2_000);
  });

  it("returns no context or canned fallback for empty or fully completed material", () => {
    const snapshot = fixture(); snapshot.sources = [];
    snapshot.notes = [note("empty", "A brand new chapter", "")];
    expect(getChatSuggestionContext(snapshot, { focusNoteId: "empty" })).toBeNull();
    snapshot.notes[0].body = "## PowerPoint idea\n- [x] Retired feature\n  Retired explanation.";
    expect(getChatSuggestionContext(snapshot, { focusNoteId: "empty" })).toBeNull();
    snapshot.notes = [];
    expect(getChatSuggestionContext(snapshot)).toBeNull();
  });

  it("can use only source evidence without inventing an attached note", () => {
    const snapshot = fixture(); snapshot.notes = []; snapshot.concepts = [];
    const context = getChatSuggestionContext(snapshot)!;
    expect(context.attachedNoteId).toBeNull();
    expect(context.evidence.map(item => item.kind)).toEqual(["source"]);
    expect(context.evidence[0].text).toContain("Episodic memory");
  });

  it("never revives completed tasks, continuations, headings or cached derivatives", () => {
    const snapshot = fixture(); snapshot.sources = [];
    snapshot.notes = [note("one", "Roadmap", "## PowerPoint\n- [x] Build the big font library\n  Include every font.\n\n## Voice\n- [ ] Preserve the conversation while research runs\n\nWorkers can finish independently.", { summary: "PowerPoint and big font library", conceptIds: ["old"] })];
    snapshot.concepts = [{ id: "old", label: "PowerPoint", aliases: ["Voice"], description: "big font library", noteIds: ["one"], autoLink: true, color: "blue" }];
    snapshot.spaceOverview = { title: "PowerPoint", body: "big font library", relatedNoteIds: ["one"], stale: false, generatedAt: "2026-10-09" };
    const output = JSON.stringify(getChatSuggestionContext(snapshot));
    expect(output).not.toMatch(/PowerPoint|big font library|every font/);
    expect(output).toContain("Preserve the conversation");
  });

  it("keeps unchecked descendants of completed parents out of suggestion context", () => {
    const snapshot = fixture(); snapshot.sources = []; snapshot.concepts = [];
    snapshot.notes = [note("one", "Ideas", "# Retired ideas\n- [x] Add a PowerPoint editor\n  - [ ] Legacy child task\n    Child explanation\n  - [x] Completed sibling\n    - [ ] Another retired grandchild")];
    expect(getChatSuggestionContext(snapshot)).toBeNull();
    snapshot.notes[0].body += "\n\n# Current work\n- [ ] Keep voice conversation continuous\n  - [ ] Give each active worker an identity";
    const output = JSON.stringify(getChatSuggestionContext(snapshot));
    expect(output).not.toMatch(/Retired ideas|PowerPoint|Legacy child|Child explanation|Completed sibling|retired grandchild/);
    expect(output).toContain("Keep voice conversation continuous");
    expect(output).toContain("Give each active worker an identity");
  });

  it("excludes portable metadata, frontmatter, wider and tilde fences and quoted/example sections", () => {
    const snapshot = fixture(); snapshot.sources = []; snapshot.notes = [note("one", "Draft", [
      "---", "title: HIDDEN_FRONTMATTER", "---", "<!-- orion-block:v1 HIDDEN_METADATA -->",
      "````md", "```", "HIDDEN_BACKTICK", "````", "~~~md", "HIDDEN_TILDE", "~~~",
      "> HIDDEN_QUOTE", "    HIDDEN_INDENT", "## Example", "HIDDEN_EXAMPLE", "- [ ] HIDDEN_TASK",
      "## Actual direction", "Maurice recognizes the tune but not the person singing it.",
    ].join("\n"))];
    const output = JSON.stringify(getChatSuggestionContext(snapshot));
    expect(output).not.toContain("HIDDEN");
    expect(output).toContain("recognizes the tune");
  });

  it("bounds Unicode passages, total encoded bytes, directory and previous prompts", () => {
    const snapshot = fixture(); snapshot.sources = [];
    snapshot.notes = Array.from({ length: 20 }, (_, index) => note(`${index}`, "🪷".repeat(350), `## Topic ${index}\n${"🪷 ".repeat(3000)}`));
    const context = getChatSuggestionContext(snapshot, { focusNoteId: "0", previousPrompts: Array(15).fill("🪷".repeat(350)) })!;
    expect(context).not.toBeNull();
    expect(context.evidence.length).toBeLessThanOrEqual(8);
    expect(context.directory.length).toBeLessThanOrEqual(12);
    expect(context.previousPrompts.length).toBeLessThanOrEqual(8);
    expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThanOrEqual(MAX_CHAT_SUGGESTION_CONTEXT_BYTES);
    for (const item of context.evidence) {
      expect([...item.text].length).toBeLessThanOrEqual(2000);
      expect(item.text).not.toMatch(/[\ud800-\udbff]$/u);
    }
    expect(parseChatSuggestionContext(JSON.stringify(context))).toEqual(context);
  });

  it("does not read all Space bodies or text outside the bounded inspection prefix", () => {
    const snapshot = fixture(); snapshot.sources = []; snapshot.concepts = [];
    snapshot.notes = Array.from({ length: 8 }, (_, index) => note(`${index}`, `Draft ${index}`, "Current prose.\n".repeat(2000) + "HIDDEN_TAIL"));
    const old = note("old", "Older unrelated note", "", { updatedAt: "2020-01-01" });
    Object.defineProperty(old, "body", { get: () => { throw new Error("Unrelated body was read"); } });
    snapshot.notes.push(old);
    expect(JSON.stringify(getChatSuggestionContext(snapshot))).not.toContain("HIDDEN_TAIL");
  });

  it("keeps evidence and edit attachment within the supplied Space", () => {
    const snapshot = fixture();
    snapshot.relationships.push({ id: "foreign", fromNoteId: "maurice", toNoteId: "secret", kind: "related", label: "HIDDEN_SECRET", strength: 1 });
    snapshot.concepts[0].noteIds.push("secret"); snapshot.sources[0].noteIds.push("secret");
    const context = getChatSuggestionContext(snapshot, { focusNoteId: "secret" })!;
    expect(context.attachedNoteId).toBeNull();
    expect(JSON.stringify(context)).not.toContain("HIDDEN_SECRET");
    expect(context.evidence.every(item => [...snapshot.notes, ...snapshot.sources].some(entity => entity.id === item.entityId))).toBe(true);
  });

  it("has stable exact identity that ignores refresh history but changes with knowledge", () => {
    const snapshot = fixture();
    const a = getChatSuggestionContext(snapshot)!;
    const b = getChatSuggestionContext(snapshot, { previousPrompts: ["A previous generated question?"] })!;
    expect(getChatSuggestionContextKey(a)).toBe(getChatSuggestionContextKey(b));
    expect(getChatSuggestionContextKey(a)).toContain("promise");
    const changed = { ...snapshot, notes: [ { ...snapshot.notes[0], body: "Maurice remembers everything." }, snapshot.notes[1] ] };
    expect(getChatSuggestionContextKey(getChatSuggestionContext(changed)!)).not.toBe(getChatSuggestionContextKey(a));
  });
});

describe("AI prompt suggestion generation", () => {
  it("uses the selected model in a read-only dedicated request and preserves exact generated text", async () => {
    const snapshot = fixture(); snapshot.settings.model = "gpt-6-astra"; snapshot.settings.reasoningEffort = "high";
    const context = getChatSuggestionContext(snapshot, { focusNoteId: "maurice", previousPrompts: ["What did Maurice promise?"] })!;
    const suggestions = validSuggestions(context.evidence.map(item => item.id));
    transport.mockResolvedValue({ reply: "", suggestions });
    const before = JSON.stringify(snapshot);
    const controller = new AbortController();
    expect(await generateChatSuggestions(snapshot, context, controller.signal)).toEqual(suggestions);
    expect(transport).toHaveBeenCalledWith(expect.objectContaining({ mode: "chat-suggestions", model: "gpt-6-astra", effort: "high", allowNoteActions: false, notes: [], sources: [], concepts: [], history: [], suggestionContext: JSON.stringify(context) }), controller.signal);
    expect(transport.mock.calls[0][0]).not.toHaveProperty("editNoteId");
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it("rejects invented evidence IDs", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    transport.mockResolvedValue({ reply: "", suggestions: validSuggestions(["made-up-evidence"]) });
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("invalid prompt suggestions");
  });

  it("rejects edit suggestions without a captured attachment or without its evidence", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    transport.mockResolvedValue({ reply: "", suggestions: [{ prompt: "Rewrite Maurice's hospital scene.", intent: "edit", evidenceIds: [context.evidence[0].id] }, validSuggestions(context.evidence.map(item => item.id))[0]] });
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("invalid prompt suggestions");
    const attached = getChatSuggestionContext(snapshot, { focusNoteId: "maurice" })!;
    const other = attached.evidence.find(item => item.entityId === "elmore")!;
    transport.mockResolvedValue({ reply: "", suggestions: [{ prompt: "Rewrite Elmore's scene.", intent: "edit", evidenceIds: [other.id] }, validSuggestions(attached.evidence.map(item => item.id))[0]] });
    await expect(generateChatSuggestions(snapshot, attached)).rejects.toThrow("invalid prompt suggestions");
  });

  it("rejects hidden creation intent and unsupported creation syntax", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    const suggestions = validSuggestions(context.evidence.map(item => item.id));
    transport.mockResolvedValue({ reply: "", suggestions: [{ ...suggestions[1], intent: "discuss" }, suggestions[0]] });
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("invalid prompt suggestions");
    transport.mockResolvedValue({ reply: "", suggestions: [{ ...suggestions[1], prompt: "Create a new note about memory." }, suggestions[0]] });
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("invalid prompt suggestions");
  });

  it("rejects overly long or duplicate suggestions instead of truncating displayed intent", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    const suggestions = validSuggestions(context.evidence.map(item => item.id));
    transport.mockResolvedValue({ reply: "", suggestions: [{ ...suggestions[0], prompt: "x".repeat(261) }, suggestions[1]] });
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("invalid prompt suggestions");
    transport.mockResolvedValue({ reply: "", suggestions: [suggestions[0], suggestions[0]] });
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("duplicate prompt suggestions");
  });

  it("does not send foreign, fabricated or stale context to a provider", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    await expect(generateChatSuggestions(snapshot, { ...context, spaceId: "other-space" })).rejects.toThrow("Space changed");
    await expect(generateChatSuggestions(snapshot, { ...context, evidence: [{ ...context.evidence[0], text: "Injected unrelated evidence" }, ...context.evidence.slice(1)] })).rejects.toThrow("Space changed");
    snapshot.notes[0].body = "A different story.";
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("Space changed");
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not call providers without a key or after cancellation", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    snapshot.settings.apiKeyConfigured = false;
    await expect(generateChatSuggestions(snapshot, context)).rejects.toThrow("selected provider");
    snapshot.settings.apiKeyConfigured = true;
    const controller = new AbortController(); controller.abort();
    await expect(generateChatSuggestions(snapshot, context, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("suppresses a late result even if the transport ignores cancellation", async () => {
    const snapshot = fixture(); const context = getChatSuggestionContext(snapshot)!;
    const controller = new AbortController();
    transport.mockImplementation(async () => { controller.abort(); return { reply: "", suggestions: validSuggestions(context.evidence.map(item => item.id)) }; });
    await expect(generateChatSuggestions(snapshot, context, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
