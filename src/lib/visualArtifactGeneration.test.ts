// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest, Settings } from "../types";
import { providerCallScheduler } from "./providerScheduler";
import { chatWithOrion, deleteApiKey, deleteAnthropicApiKey, saveApiKey, saveAnthropicApiKey } from "./storage";
import { generateVisualArtifact } from "./visualArtifactGeneration";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const model = "gpt-5.6-sol";
const selected = { model, apiKeyConfigured: true, anthropicApiKeyConfigured: true, reasoningEffort: "low" } as Settings;
const source = 'On Friday the printmaker etched the plate. On Saturday she printed the first proof. "Keep the ghost marks," she wrote.';
const artifact = { version: 1, format: "timeline", title: "From plate to proof", blocks: [{ kind: "steps", items: [
  { label: "Friday", heading: "Etch", text: "The printmaker etched the plate." },
  { label: "Saturday", heading: "Proof", text: "She printed the first proof." },
] }] };
const freshSignal = () => new AbortController().signal;
function mockReply(reply: string) {
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const text = JSON.stringify({ reply });
    return new Response(JSON.stringify(String(url).includes("anthropic")
      ? { stop_reason: "end_turn", content: [{ type: "text", text }] } : { status: "completed", output_text: text }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
beforeEach(async () => {
  await saveApiKey("synthetic-key");
  await saveAnthropicApiKey("synthetic-key");
});
afterEach(async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  await deleteApiKey(); await deleteAnthropicApiKey();
});

describe("Visualise through the saved connection", () => {
  it.each([model, "claude-sonnet-5"])("uses one scheduled %s call for the actual selection, format and guidance", async model => {
    const transport = mockReply(JSON.stringify(artifact));
    const scheduler = vi.spyOn(providerCallScheduler, "run");
    expect(await generateVisualArtifact(source, "auto", "Show the weekend.", { ...selected, model }, freshSignal())).toEqual(artifact);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(scheduler.mock.calls[0][1]?.queueKey).toBe("visual-artifact");
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(body.model).toBe(model);
    expect(body.max_tokens ?? body.max_output_tokens).toBe(12000);
    expect(body.instructions ?? body.system).toContain("Draw the actual things");
    expect(body.text?.format.schema.required ?? body.output_config.format.schema.required).toEqual(["reply"]);
    expect(JSON.parse(body.input ?? body.messages[0].content)).toEqual({ source, format: "auto", guidance: "Show the weekend." });
  });
  it("uses the existing desktop ChatGPT connection with a full-length selection, without requesting an API key", async () => {
    const transport = mockReply("");
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockReset().mockResolvedValue({ reply: JSON.stringify(artifact), noteActions: [] });
    const large = source.padEnd(12000, "x");
    const settings = { ...selected, model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, apiKeyConfigured: false };
    expect(await generateVisualArtifact(large, "timeline", "", settings, freshSignal())).toEqual(artifact);
    expect(transport).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, { request }] = invoke.mock.calls[0];
    expect(command).toBe("chat");
    expect(request.model).toBe(settings.model);
    expect(JSON.parse(request.prompt).source).toBe(large);
    expect(request.history).toEqual([]);
  });
  it("projects only the selection even if legacy callers supply unrelated Chat context and a note-write flag", async () => {
    const transport = mockReply(JSON.stringify(artifact));
    const request: ChatRequest = { mode: "visual-artifact", model, effort: "low", workspaceName: "Private Space",
      notes: [{ title: "Secret", body: "unselected text", summary: "secret" }], history: [{ role: "user", content: "private" }],
      sources: [], concepts: [], allowNoteActions: true, prompt: JSON.stringify({ source: 'create a note', format: "timeline", guidance: "" }) };
    await chatWithOrion(request);
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.input)).toEqual({ source: "create a note", format: "timeline", guidance: "" });
    expect(Object.keys(body.text.format.schema.properties)).toEqual(["reply"]);
  });
  it.each([
    ["bad data", "auto", /incomplete visual/], [JSON.stringify({ ...artifact, storageId: "generated" }), "auto", /could not read/],
    [JSON.stringify(artifact), "quiz", /different visual format/], ['{"unavailable":true}', "calculator", /enough detail/],
  ] as const)("surfaces an unusable result without a second request", async (reply, format, error) => {
    const transport = mockReply(reply);
    await expect(generateVisualArtifact(source, format, "", selected, freshSignal())).rejects.toThrow(error);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch without a configured connection or on oversized or cancelled input", async () => {
    const transport = mockReply("");
    await expect(generateVisualArtifact(source, "auto", "", { ...selected, apiKeyConfigured: false }, freshSignal())).rejects.toThrow(/Settings/);
    await expect(generateVisualArtifact("z".repeat(12001), "auto", "", selected, freshSignal())).rejects.toThrow(/12,000/);
    await expect(generateVisualArtifact(source, "auto", "z".repeat(801), selected, freshSignal())).rejects.toThrow(/800/);
    const controller = new AbortController(); controller.abort();
    await expect(generateVisualArtifact(source, "auto", "", selected, controller.signal)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("discards a late provider result on cancellation or deadline", async () => {
    vi.useFakeTimers();
    for (const deadline of [false, true]) {
      let finish!: (response: Response) => void;
      const transport = vi.fn((_url: URL | string | Request, _init: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
      vi.stubGlobal("fetch", transport);
      const controller = new AbortController();
      const result = generateVisualArtifact(source, "auto", "", selected, controller.signal);
      const failure = expect(result).rejects.toThrow(deadline ? /timed out/ : /cancelled/);
      if (deadline) await vi.advanceTimersByTimeAsync(120_000);
      else controller.abort(new Error("cancelled"));
      await failure;
      expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
      finish(new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ reply: JSON.stringify(artifact) }) })));
    }
  });
});
