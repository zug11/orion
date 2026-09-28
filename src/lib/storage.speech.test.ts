// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteApiKey, deleteElevenLabsApiKey, generateSpeech, saveApiKey, saveElevenLabsApiKey } from "./storage";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  await deleteApiKey();
  await deleteElevenLabsApiKey();
  vi.unstubAllGlobals();
  invoke.mockReset();
});

function alignedResponse(text: string) {
  return {
    audio_base64: "AQID",
    alignment: {
      characters: [...text],
      character_start_times_seconds: [...text].map((_, index) => index / 10),
      character_end_times_seconds: [...text].map((_, index) => (index + 1) / 10),
    },
  };
}

describe("optional speech alignment transport", () => {
  it("uses one ElevenLabs synthesis request with original-text timing", async () => {
    await saveElevenLabsApiKey("isolated-test-key");
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(alignedResponse("Hello again."))));
    vi.stubGlobal("fetch", fetcher);
    const speech = await generateSpeech("elevenlabs", " Hello  again. ", undefined, { trackWords: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain("/with-timestamps");
    expect(speech).toMatchObject({ byteSize: 3, timingText: "Hello again.", timingSource: "elevenlabs" });
    expect(speech.wordTimings).toHaveLength(2);
    expect(speech.wordTimings![1]).toMatchObject({ startChar: 6, endChar: 12 });
  });

  it("preserves playable audio without fabricated timing for malformed alignment", async () => {
    await saveElevenLabsApiKey("isolated-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(alignedResponse("Different.")))));
    const speech = await generateSpeech("elevenlabs", "Hello.", undefined, { trackWords: true });
    expect(speech).toEqual({ mimeType: "audio/mpeg", byteSize: 3, base64Data: "AQID" });
  });

  it("keeps untracked decks on the original audio-only endpoint", async () => {
    await saveElevenLabsApiKey("isolated-test-key");
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetcher);
    expect(await generateSpeech("elevenlabs", "Hello")).toMatchObject({ byteSize: 3 });
    expect(String(fetcher.mock.calls[0][0])).not.toContain("with-timestamps");
  });

  it("makes no extra paid transcription request for OpenAI browser preview", async () => {
    await saveApiKey("isolated-test-key");
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", fetcher);
    const speech = await generateSpeech("openai", "Hello", undefined, { trackWords: true });
    expect(speech.wordTimings).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toBe("https://api.openai.com/v1/audio/speech");
  });

  it("bounds timestamp response bytes before parsing", async () => {
    await saveElevenLabsApiKey("isolated-test-key");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { headers: { "Content-Length": String(18 * 1024 * 1024 + 1) } })));
    await expect(generateSpeech("elevenlabs", "Hello", undefined, { trackWords: true })).rejects.toThrow("too large");
  });

  it("opts into local timing only when requested through native IPC", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockResolvedValue({ mimeType: "audio/mpeg", byteSize: 3, base64Data: "AQID" });
    await generateSpeech("openai", " Hello  again. ", undefined, { trackWords: true });
    expect(invoke).toHaveBeenLastCalledWith("generate_speech", { request: { engine: "openai", text: "Hello again.", voiceId: undefined, trackWords: true, requestId: expect.stringMatching(/^speech-align:/) } });
    await generateSpeech("openai", "Hello");
    expect(invoke).toHaveBeenLastCalledWith("generate_speech", { request: { engine: "openai", text: "Hello", voiceId: undefined, trackWords: false } });
  });

  it("cancels local preparation but keeps the paid audio result reusable", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    let finish!: (value: unknown) => void;
    invoke.mockImplementation(async (command: string) => command === "generate_speech"
      ? new Promise((resolve) => { finish = resolve; }) : undefined);
    const controller = new AbortController();
    const pending = generateSpeech("openai", "Hello", undefined, { trackWords: true, signal: controller.signal });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const requestId = invoke.mock.calls.find(([command]) => command === "generate_speech")![1].request.requestId;
    controller.abort();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cancel_media_import", { requestId }));
    finish({ mimeType: "audio/mpeg", byteSize: 3, base64Data: "AQID" });
    await expect(pending).resolves.toEqual({ mimeType: "audio/mpeg", byteSize: 3, base64Data: "AQID" });
  });

  it("never starts local alignment for an already stopped preparation session", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockResolvedValue({ mimeType: "audio/mpeg", byteSize: 3, base64Data: "AQID" });
    const controller = new AbortController(); controller.abort();
    await generateSpeech("openai", "Hello", undefined, { trackWords: true, signal: controller.signal });
    expect(invoke).toHaveBeenCalledWith("generate_speech", { request: expect.objectContaining({ trackWords: false }) });
  });
});
