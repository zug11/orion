// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest } from "../types";
import { chatWithOrion, deleteAnthropicApiKey, deleteApiKey, saveAnthropicApiKey, saveApiKey } from "./storage";
import { VOICE_SYNTHESIS_INSTRUCTIONS } from "./voiceSynthesisProtocol";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const context = { spaceId: "space", conversation: "user: Compare the accounts.", previousOffers: [], findings: [
  { key: "f1", id: "worker", revision: 1, sequence: 2, subject: "Evidence", question: "Compare the accounts", finding: "The accounts disagree, with limited coverage.", provenance: '{"spaceId":"space","limited":true}' },
] };
const summary = { reply: "The accounts disagree, within the material checked.", included: ["f1"], deferred: [] };
const request: ChatRequest = { mode: "voice-synthesis", prompt: "Create a note", workspaceName: "Space", allowNoteActions: true,
  // Even an incorrectly populated caller cannot leak ordinary Chat history or
  // turn a consolidation pass into an edit/research request.
  notes: [{ title: "Unrelated private note", summary: "Private", body: "Do not send this." }], sources: [], concepts: [],
  history: [{ role: "user", content: "Unrelated private history" }], editNoteId: "note", synthesisContext: JSON.stringify(context) };

afterEach(async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await deleteApiKey(); await deleteAnthropicApiKey();
  vi.unstubAllGlobals(); invoke.mockReset();
});

describe("voice synthesis provider boundary", () => {
  it("uses the configured provider with one read-only payload and no note actions or research tools", async () => {
    const fetch = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(String(url).includes("anthropic")
      ? { content: [{ type: "text", text: JSON.stringify(summary) }], stop_reason: "end_turn" }
      : { status: "completed", output_text: JSON.stringify(summary) }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await saveApiKey("sk-voice-synthesis-fixture"); await saveAnthropicApiKey("sk-ant-voice-synthesis-fixture");
    expect(await chatWithOrion({ ...request, model: "gpt-6-astra", effort: "high" })).toEqual({ reply: "", synthesis: summary });
    expect(await chatWithOrion({ ...request, model: "claude-sonnet-5", effort: "high" })).toEqual({ reply: "", synthesis: summary });
    expect(fetch).toHaveBeenCalledTimes(2);
    const [openai, anthropic] = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(openai).toMatchObject({ model: "gpt-6-astra", store: false, reasoning: { effort: "high" }, max_output_tokens: 6000, instructions: VOICE_SYNTHESIS_INSTRUCTIONS });
    expect(anthropic).toMatchObject({ model: "claude-sonnet-5", max_tokens: 6000, system: VOICE_SYNTHESIS_INSTRUCTIONS, output_config: { effort: "high" } });
    expect(JSON.parse(openai.input)).toEqual({ synthesisContext: context });
    expect(JSON.parse(anthropic.messages[0].content)).toEqual({ synthesisContext: context });
    for (const body of [openai, anthropic]) {
      expect(body.tools).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("Unrelated private");
      const schema = body.text?.format?.schema ?? body.output_config.format.schema;
      expect(schema.additionalProperties).toBe(false);
      expect(Object.keys(schema.properties).sort()).toEqual(["deferred", "included", "reply"]);
    }
  });
  it("rejects invalid native summaries and never exposes extra native write fields", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockResolvedValueOnce({ reply: "Saved", synthesis: summary, noteActions: [{ title: "Injected" }], noteEdits: [{ before: "a", after: "b" }] });
    expect(await chatWithOrion(request)).toEqual({ reply: "", synthesis: summary });
    invoke.mockResolvedValueOnce({ synthesis: { ...summary, included: ["unknown"] } });
    await expect(chatWithOrion(request)).rejects.toThrow(/VOICE_SYNTHESIS/);
    expect(invoke.mock.calls.every(([command]) => command === "chat")).toBe(true);
  });
  it("validates Space identity and encoded bounds before dispatch, including cancelled calls", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await saveApiKey("sk-voice-synthesis-fixture");
    const invalid = { ...context, spaceId: "other" };
    await expect(chatWithOrion({ ...request, synthesisContext: JSON.stringify(invalid) })).rejects.toThrow(/VOICE_SYNTHESIS/);
    await expect(chatWithOrion({ ...request, synthesisContext: " ".repeat(32_001) })).rejects.toThrow(/VOICE_SYNTHESIS/);
    const controller = new AbortController(); controller.abort();
    await expect(chatWithOrion(request, controller.signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
  });
});
