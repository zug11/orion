// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeSpace, createEmptyVault } from "../data/defaults";
import type { ChatRequest } from "../types";
import { chatWithOrion, deleteApiKey, deleteAnthropicApiKey, loadSnapshot, parseChatResult, saveApiKey, saveAnthropicApiKey, saveSnapshot } from "./storage";
import { MAX_CHAT_READING_EVIDENCE, parseChatReadingContext } from "./chatReadingProtocol";

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  } });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await deleteApiKey();
  await deleteAnthropicApiKey();
  window.localStorage.clear();
});

describe("Chat reading transport and persistence", () => {
  it.each(["gpt-5.6-sol", "claude-sonnet-5"])("carries bounded public checkpoints through %s while discarding reading prose and writes", async model => {
    const checkpoint = { finding: "The note records three [[e1]].", decisions: ["Check the original next."], openQuestions: ["Does the source agree?"] };
    const payload = { reply: "Not an answer yet", readRequests: [{ kind: "source", id: "original", query: "", start: null }], checkpoint };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(model.startsWith("claude-")
      ? { content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn" }
      : { status: "completed", output_text: JSON.stringify(payload) }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await saveApiKey("synthetic-openai-key"); await saveAnthropicApiKey("synthetic-anthropic-key");
    const result = await chatWithOrion({ mode: "chat-reading", prompt: "Compare the accounts", model, workspaceName: "Research", history: [], notes: [], sources: [], concepts: [],
      readingContext: JSON.stringify({ finalizing: false, checkpointsEnabled: true, evidence: [] }) });
    expect(result).toEqual({ reply: "", readRequests: payload.readRequests, checkpoint });
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    const schema = body.text?.format.schema ?? body.output_config.format.schema;
    expect(schema.required).toContain("checkpoint");
    expect(schema.properties.checkpoint.anyOf[1].properties.finding.type).toBe("string");
    // Anthropic's schema adaptation omits unsupported length keywords; both
    // transports still enforce the shared bound before exposing a checkpoint.
    if (!model.startsWith("claude-")) expect(schema.properties.checkpoint.anyOf[1].properties.finding.maxLength).toBe(1_200);
    expect(body.instructions ?? body.system).toContain("not hidden reasoning");
    expect(() => parseChatResult({ ...payload, checkpoint: { ...checkpoint, finding: "x".repeat(1_201) } }, true)).toThrow(/checkpoint/);
    expect(() => parseChatResult({ ...payload, checkpoint: { ...checkpoint, hiddenReasoning: "not permitted" } }, true)).toThrow(/checkpoint/);
    expect(() => parseChatResult({ reply: "Hello", checkpoint })).toThrow();
  });
  it.each(["gpt-5.6-sol", "claude-sonnet-5"])("uses the typed reading contract through %s without a fixed library packet", async (model) => {
    const payload = { reply: "", readRequests: [{ kind: "search", id: "", query: "contract", start: 0 }] };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(model.startsWith("claude-")
      ? { content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn" }
      : { status: "completed", output_text: JSON.stringify(payload) }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await saveApiKey("synthetic-openai-key");
    await saveAnthropicApiKey("synthetic-anthropic-key");
    const request: ChatRequest = { mode: "chat-reading", prompt: "Find the contract.", workspaceName: "Research", model,
      allowNoteActions: true, history: [], notes: [{ title: "Must not be sent", body: "Unused fixed context", summary: "" }], sources: [], concepts: [],
      readingContext: JSON.stringify({ finalizing: false, evidence: [], directory: [] }) };
    const result = await chatWithOrion(request);
    expect(result).toEqual(payload);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    const context = JSON.parse(body.input ?? body.messages[0].content);
    expect(context).not.toHaveProperty("notes");
    expect(context.readingContext.evidence).toEqual([]);
    const schema = body.text?.format.schema ?? body.output_config.format.schema;
    expect(schema.properties).toHaveProperty("readRequests");
    expect(schema.properties).not.toHaveProperty("noteActions");
    expect(body.instructions ?? body.system).toContain("search beyond it");
    expect(body.instructions ?? body.system).toContain("No note write is authorized");
  });

  it.each(["gpt-5.6-sol", "claude-sonnet-5"])("carries authorized edit proposals separately through %s", async model => {
    const payload = { editIntent: "focused", noteRewrite: "", reply: "Review the edit", readRequests: [], noteEdits: [{ before: "Old text", after: "Clear text" }] };
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(model.startsWith("claude-")
      ? { content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn" }
      : { status: "completed", output_text: JSON.stringify(payload) }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await saveApiKey("synthetic-openai-key"); await saveAnthropicApiKey("synthetic-anthropic-key");
    const request: ChatRequest = { mode: "chat-reading", prompt: "Rewrite this paragraph", editNoteId: "current", workspaceName: "Research", model,
      history: [], notes: [], sources: [], concepts: [], readingContext: JSON.stringify({ finalizing: false, evidence: [], directory: [] }) };
    expect((await chatWithOrion(request)).noteEdits).toEqual(payload.noteEdits);
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    const schema = body.text?.format.schema ?? body.output_config.format.schema;
    expect(schema.properties).toHaveProperty("noteEdits"); expect(schema.properties).not.toHaveProperty("noteActions");
    expect(body.max_output_tokens ?? body.max_tokens).toBe(12000);
    expect(body.instructions ?? body.system).toContain("No changes are saved automatically");
  });

  it("rejects provider-supplied evidence and only accepts read requests in the reading mode", () => {
    expect(() => parseChatResult({ reply: "Answer", evidence: [] }, true)).toThrow();
    expect(() => parseChatResult({ reply: "Answer", readRequests: [] })).toThrow();
    expect(() => parseChatResult({ reply: "Answer" }, true)).toThrow();
    expect(() => parseChatResult({ reply: "Answer", readRequests: [{ kind: "write", id: "a", query: "", start: 0 }] }, true)).toThrow();
    expect(() => parseChatReadingContext(JSON.stringify({ finalizing: false, evidence: Array(MAX_CHAT_READING_EVIDENCE + 1).fill({}) }))).toThrow();
  });

  it("round-trips old conversations and optional exact evidence without another Chat store", async () => {
    const vault = createEmptyVault("Research", "2026-09-08T00:00:00.000Z");
    const space = activeSpace(vault);
    const message = { id: "reply", role: "assistant" as const, content: "Supported answer", cardIds: [], contextCardIds: [], createdAt: vault.updatedAt };
    space.studio.messages = [message];
    await saveSnapshot(vault);
    expect(activeSpace((await loadSnapshot())!).studio.messages[0]).toEqual(message);
    const evidence = [{ id: "e1", kind: "note" as const, entityId: "note-a", title: "Evidence", version: "v1", start: 0, end: 7, text: "Support", offsetUnit: "utf16" as const }];
    space.studio.messages = [{ ...message, evidence }];
    await saveSnapshot(vault);
    expect(activeSpace((await loadSnapshot())!).studio.messages[0].evidence).toEqual(evidence);
    space.studio.messages[0].evidence![0].end = 999;
    await saveSnapshot(vault);
    await expect(loadSnapshot()).rejects.toThrow();
  });
});
it.each(["gpt-5.6-sol", "claude-sonnet-5"])("transports agent-chosen full revisions through %s using the shared review schema", async model => {
  const payload = { editIntent: "rewrite", noteEdits: [], reply: "Review in your note.", readRequests: [], noteRewrite: "A complete revised paragraph.\n\nAn addition." };
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(model.startsWith("claude-")
    ? { content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn" }
    : { status: "completed", output_text: JSON.stringify(payload) }), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  await saveApiKey("synthetic-openai-key"); await saveAnthropicApiKey("synthetic-anthropic-key");
  const request: ChatRequest = { mode: "chat-reading", prompt: "Please do this", editNoteId: "current", workspaceName: "Research", model,
    history: [], notes: [], sources: [], concepts: [], readingContext: JSON.stringify({ finalizing: false, evidence: [], directory: [], editTarget: { body: "The complete original." } }) };
  expect((await chatWithOrion(request)).noteRewrite).toBe(payload.noteRewrite);
  const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
  const schema = body.text?.format.schema ?? body.output_config.format.schema;
  expect(schema.properties).toHaveProperty("noteRewrite");
  expect(schema.required).toContain("noteRewrite");
  expect(schema.properties).toHaveProperty("noteEdits");
  expect(schema.required).toContain("editIntent");
  expect(schema.properties).not.toHaveProperty("noteActions");
  expect(body.instructions ?? body.system).toContain("Infer the response scope");
  const context = JSON.parse(body.input ?? body.messages[0].content);
  expect(context.readingContext.editTarget.body).toBe("The complete original.");
});

it("retains an automatic read plan but never edit payloads during reading", () => {
  const result = parseChatResult({ reply: "Not final", readRequests: [{ kind: "note", id: "target", query: "", start: null }], editIntent: "rewrite", noteEdits: "invalid", noteRewrite: 1 }, true, true);
  expect(result.editIntent).toBe("rewrite");
  expect(result.reply).toBe("");
  expect(result.noteEdits).toBeUndefined();
  expect(result.noteRewrite).toBeUndefined();
  expect(() => parseChatResult({ reply: "Ready", readRequests: [], editIntent: "apply" }, true, true)).toThrow(/intent/);
});
