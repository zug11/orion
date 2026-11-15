// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanUpDictation } from "./storage";
import { prepareDictation } from "./dictationCleanup";
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
    expect(result).toEqual({ blocks: [{ kind: "paragraph", text: "Maybe Thursday." }] });
  });
  it("carries the captured calendar date and inert ticket proposal without note or Space text", async () => {
    const transcript = "Make a ticket to call Jo, due Thursday.";
    const proposal = { blocks: [{ kind: "ticket", text: "Call Jo", evidence: transcript, boardName: "", dueDate: "2026-11-19", urgency: "" }] };
    invoke.mockResolvedValue({ blocks: [{ kind: "paragraph", text: transcript }], proposal });
    const result = await cleanUpDictation(transcript, { model: "gpt-6-sol", reasoningEffort: "none" }, new AbortController().signal, "2026-11-13");
    expect(result.proposal).toEqual(proposal);
    expect(invoke.mock.calls[0][1].request).toEqual({ requestId: expect.any(String), transcript, model: "gpt-6-sol", effort: "none", referenceDate: "2026-11-13" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("rejects an invalid reference date before making a provider request", async () => {
    await expect(cleanUpDictation("Make a ticket.", { model: "gpt-6-sol", reasoningEffort: "none" }, new AbortController().signal, "2026-02-30")).rejects.toThrow("date");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("retains all cleaned prose across IPC and preparation when an optional structure is invalid", async () => {
    const transcript = "Um, I'm still unsure. Make a ticket to call Jo on Thursday. Remember to buy milk.";
    const blocks = [
      { kind: "paragraph" as const, text: "I'm still unsure." },
      { kind: "paragraph" as const, text: "Make a ticket to call Jo on Thursday." },
      { kind: "todo" as const, text: "Buy milk." },
    ];
    invoke.mockResolvedValue({ blocks, proposal: { blocks: [{
      kind: "ticket", text: "Call Jo", evidence: "Make a ticket to call Jo on Thursday.",
      boardName: "", dueDate: "2026-02-30", urgency: "",
    }] } });
    const preserveOriginal = vi.fn().mockResolvedValue("source-original");
    const result = await prepareDictation({
      transcript, aiAvailable: true, preserveOriginal, signal: new AbortController().signal,
      onPhase: vi.fn(), clean: signal => cleanUpDictation(transcript, { model: "gpt-6-astra", reasoningEffort: "low" }, signal),
    });
    expect(result).toMatchObject({ original: transcript, sourceId: "source-original", blocks });
    expect(result.proposal).toBeUndefined();
    expect(invoke).toHaveBeenCalledOnce();
    expect(preserveOriginal).toHaveBeenCalledOnce();
  });
  it("does not accept invalid faithful text just because the provider also supplied a structure", async () => {
    invoke.mockResolvedValue({ blocks: [{ kind: "paragraph", text: "bad\u0085text" }], proposal: null });
    await expect(cleanUpDictation("Raw dictation.", { model: "gpt-6-astra", reasoningEffort: "low" }, new AbortController().signal)).rejects.toThrow();
    expect(invoke).toHaveBeenCalledOnce();
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
