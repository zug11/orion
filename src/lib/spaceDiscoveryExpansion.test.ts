import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { expandSpaceSearchQuery } from "./spaceDiscoveryExpansion";

const settings = { ...createEmptySnapshot("Private library name").settings, apiKeyConfigured: true };
const query = "the mic kept cutting out";
const result = (terms: unknown) => ({ reply: JSON.stringify({ terms }) });
const signal = () => new AbortController().signal;

afterEach(() => vi.useRealTimers());

describe("meaning search query expansion", () => {
  it("sends a single query-only read-only request and returns distinct alternatives", async () => {
    const driver = vi.fn(async (_request: ChatRequest, _signal: AbortSignal) =>
      result([query.toUpperCase(), " audio   dropout ", "Audio dropout", "interrupted recording"]));
    expect(await expandSpaceSearchQuery(query, settings, signal(), driver)).toEqual(["audio dropout", "interrupted recording"]);
    expect(driver).toHaveBeenCalledTimes(1);
    const [request, requestSignal] = driver.mock.calls[0];
    expect(request).toEqual({
      mode: "chat", prompt: expect.stringContaining(JSON.stringify(query)), workspaceName: "", notes: [], sources: [],
      concepts: [], history: [], allowNoteActions: false, model: settings.model, effort: "low",
    });
    expect(requestSignal.aborted).toBe(false);
  });

  it("supports a ChatGPT plan without a separate API key and accepts a fenced JSON reply", async () => {
    const plan = { ...settings, apiKeyConfigured: false, model: "chatgpt:gpt-6.2-astra", chatgptConfigured: true };
    const driver = vi.fn(async () => ({ reply: '```json\n{"terms":["transcription interruption"]}\n```' }));
    expect(await expandSpaceSearchQuery(query, plan, signal(), driver)).toEqual(["transcription interruption"]);
    expect(driver).toHaveBeenCalledWith(expect.objectContaining({ model: plan.model }), expect.anything());
  });

  it("makes no calls for an unavailable selected connection, blank query, or oversized query", async () => {
    const driver = vi.fn();
    await expect(expandSpaceSearchQuery(query, { ...settings, model: "claude-sonnet-5", anthropicApiKeyConfigured: false }, signal(), driver))
      .rejects.toThrow("Connect your selected AI provider");
    for (const text of ["  ", "a".repeat(601)]) {
      await expect(expandSpaceSearchQuery(text, settings, signal(), driver)).rejects.toThrow("600");
    }
    expect(driver).not.toHaveBeenCalled();
  });

  it.each([
    "Please check your notes.", '{"terms":[],"spaceId":"invented"}', JSON.stringify({ terms: Array(7).fill("x") }),
    result(["x".repeat(81)]).reply, result([42]).reply, result(["<script>"]).reply, result(["one\ntwo"]).reply,
  ])("rejects invalid or oversized output without retrying (%s)", async reply => {
    const driver = vi.fn(async () => ({ reply }));
    await expect(expandSpaceSearchQuery(query, settings, signal(), driver)).rejects.toThrow("search terms");
    expect(driver).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch a search cancelled before transport starts", async () => {
    const controller = new AbortController();
    const driver = vi.fn();
    const request = expandSpaceSearchQuery(query, settings, controller.signal, driver);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(driver).not.toHaveBeenCalled();
  });

  it.each(["close", "deadline"])("stops waiting on %s even when the transport ignores the signal", async reason => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let rejectLate!: (error: Error) => void;
    const hung = new Promise<ChatResult>((_, reject) => { rejectLate = reject; });
    const driver = vi.fn((_request: ChatRequest, _signal: AbortSignal) => hung);
    const request = expandSpaceSearchQuery(query, settings, controller.signal, driver);
    const rejected = reason === "close"
      ? expect(request).rejects.toMatchObject({ name: "AbortError" })
      : expect(request).rejects.toThrow("timed out");
    await Promise.resolve();
    if (reason === "close") controller.abort();
    else await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(driver.mock.calls[0][1].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    rejectLate(new Error("Late provider failure"));
    await Promise.resolve();
  });
});
