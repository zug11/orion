// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanUpDictation } from "./storage";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
beforeEach(() => Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} }));
afterEach(() => { Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); invoke.mockReset(); });

describe("native dictation cleanup transport", () => {
  it("sends only the transcript with the selected model and reasoning", async () => {
    invoke.mockResolvedValue({ blocks: [{ kind: "paragraph", text: "Maybe Thursday." }] });
    const result = await cleanUpDictation("Maybe um Thursday.", { model: "gpt-6-astra", reasoningEffort: "low" }, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith("cleanup_dictation", { request: {
      requestId: expect.stringMatching(/^dictation:/), transcript: "Maybe um Thursday.", model: "gpt-6-astra", effort: "low",
    } });
    expect(result).toEqual([{ kind: "paragraph", text: "Maybe Thursday." }]);
  });
  it("cancels the owned request and rejects a late provider answer", async () => {
    let finish!: (value: unknown) => void;
    invoke.mockImplementation((command: string) => command === "cleanup_dictation" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve());
    const controller = new AbortController();
    const request = cleanUpDictation("Raw dictation.", { model: "claude-sonnet-5", reasoningEffort: "low" }, controller.signal);
    const observed = request.catch(error => error);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cleanup_dictation", expect.any(Object)));
    const requestId = invoke.mock.calls[0][1].request.requestId;
    controller.abort(new Error("Use original"));
    expect(await observed).toEqual(new Error("Use original"));
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("cancel_knowledge_assignment", { requestId }));
    finish({ blocks: [{ kind: "paragraph", text: "Too late." }] });
    await Promise.resolve();
  });
  it("never starts a provider call after cancellation or in browser preview", async () => {
    const controller = new AbortController(); controller.abort(new Error("Stopped"));
    await expect(cleanUpDictation("Raw", { model: "gpt-6-sol", reasoningEffort: "none" }, controller.signal)).rejects.toThrow("Stopped");
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    await expect(cleanUpDictation("Raw", { model: "gpt-6-sol", reasoningEffort: "none" }, new AbortController().signal)).rejects.toThrow("installed Orion");
    expect(invoke).not.toHaveBeenCalled();
  });
});
