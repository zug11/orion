// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { generateChatSuggestions } from "../lib/chatSuggestions";
import type { AppSnapshot, ChatPromptSuggestion } from "../types";
import { CHAT_SUGGESTION_DELAY_MS, invalidateChatSuggestionConnection, useChatSuggestions } from "./useChatSuggestions";

vi.mock("../lib/chatSuggestions", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/chatSuggestions")>(),
  generateChatSuggestions: vi.fn(),
}));
let sequence = 0;
function fixture(): AppSnapshot {
  const snapshot = createEmptySnapshot("Field notes", "2026-10-09", `suggestion-hook-${++sequence}`);
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "water", title: "Wetland recovery", body: "Reed beds may affect water quality. How should two sampling sites with different sediment levels be compared?", slug: "water", summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-10-09", updatedAt: "2026-10-09" }];
  return snapshot;
}
function generated(prefix = "Reed beds"): ChatPromptSuggestion[] {
  return [
    { prompt: `${prefix}: how do sediment levels change the comparison?`, intent: "discuss", evidenceIds: ["s1"] },
    { prompt: `${prefix}: what would make sampling more reliable?`, intent: "discuss", evidenceIds: ["s1"] },
  ];
}
function deferred() {
  let resolve!: (value: ChatPromptSuggestion[]) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ChatPromptSuggestion[]>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function tick(milliseconds = CHAT_SUGGESTION_DELAY_MS) {
  await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
}
beforeEach(() => { vi.useFakeTimers(); vi.mocked(generateChatSuggestions).mockReset().mockResolvedValue(generated()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("generated Chat suggestions lifecycle", () => {
  it("debounces the first generation for 700 ms and supplies current working context", async () => {
    const snapshot = fixture();
    snapshot.notes[0].body += "\n\n- [x] Retired PowerPoint idea\n- [ ] Compare sampling sites";
    const { result } = renderHook(() => useChatSuggestions(snapshot, { enabled: true, focusNoteId: "water" }));
    expect(result.current.status).toBe("loading"); expect(result.current.suggestions).toEqual([]);
    await tick(699); expect(generateChatSuggestions).not.toHaveBeenCalled();
    await tick(1); expect(generateChatSuggestions).toHaveBeenCalledOnce();
    const [, context, signal] = vi.mocked(generateChatSuggestions).mock.calls[0];
    expect(context.attachedNoteId).toBe("water");
    expect(JSON.stringify(context)).toContain("Compare sampling sites");
    expect(JSON.stringify(context)).not.toContain("Retired PowerPoint");
    expect(signal?.aborted).toBe(false);
    expect(result.current).toMatchObject({ status: "ready", suggestions: generated(), targetNoteId: "water" });
  });

  it("reuses a successful window-local batch across hiding and remounting", async () => {
    const snapshot = fixture();
    const first = renderHook(({ enabled }) => useChatSuggestions(snapshot, { enabled }), { initialProps: { enabled: true } });
    await tick();
    first.rerender({ enabled: false }); expect(first.result.current.status).toBe("idle");
    first.rerender({ enabled: true }); expect(first.result.current.suggestions).toEqual(generated());
    first.unmount();
    const reopened = renderHook(() => useChatSuggestions(snapshot, { enabled: true }));
    expect(reopened.result.current.status).toBe("ready");
    await tick(2_000); expect(generateChatSuggestions).toHaveBeenCalledOnce();
  });

  it("refreshes explicitly with previous prompts and clears stale visible ideas during loading", async () => {
    const snapshot = fixture();
    vi.mocked(generateChatSuggestions).mockResolvedValueOnce(generated()).mockResolvedValueOnce(generated("Sediment"));
    const { result } = renderHook(() => useChatSuggestions(snapshot, { enabled: true }));
    await tick();
    act(() => result.current.refresh());
    expect(result.current).toMatchObject({ status: "loading", suggestions: [] });
    await tick();
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][1].previousPrompts).toEqual(generated().map(item => item.prompt));
    expect(result.current.suggestions).toEqual(generated("Sediment"));
  });

  it("remembers failures without a fallback, automatic retry, or reopening retry", async () => {
    const snapshot = fixture();
    vi.mocked(generateChatSuggestions).mockRejectedValueOnce(new Error("Rate limited"));
    const initial = renderHook(({ enabled }) => useChatSuggestions(snapshot, { enabled }), { initialProps: { enabled: true } });
    await tick(); expect(initial.result.current).toMatchObject({ status: "error", suggestions: [] });
    initial.rerender({ enabled: false }); initial.rerender({ enabled: true });
    await tick(10_000); expect(generateChatSuggestions).toHaveBeenCalledOnce();
    initial.unmount();
    const reopened = renderHook(() => useChatSuggestions(snapshot, { enabled: true }));
    expect(reopened.result.current.status).toBe("error");
    await tick(); expect(generateChatSuggestions).toHaveBeenCalledOnce();
    act(() => reopened.result.current.refresh()); await tick();
    expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(reopened.result.current.status).toBe("ready");
  });

  it("cancels an unopened debounce and pauses an in-flight request when disabled", async () => {
    const snapshot = fixture(); const response = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValue(response.promise);
    const { result, rerender } = renderHook(({ enabled }) => useChatSuggestions(snapshot, { enabled }), { initialProps: { enabled: true } });
    await tick(300); rerender({ enabled: false }); await tick();
    expect(generateChatSuggestions).not.toHaveBeenCalled();
    rerender({ enabled: true }); await tick();
    const signal = vi.mocked(generateChatSuggestions).mock.calls[0][2];
    rerender({ enabled: false }); expect(signal?.aborted).toBe(true);
    await act(async () => response.resolve(generated("Late")));
    expect(result.current).toMatchObject({ status: "idle", suggestions: [] });
    vi.mocked(generateChatSuggestions).mockResolvedValue(generated("Current"));
    rerender({ enabled: true }); await tick();
    expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(result.current.suggestions).toEqual(generated("Current"));
  });

  it("ignores a stale response from a previous Space even if the transport ignores abort", async () => {
    const first = fixture(), second = fixture(); const old = deferred(), current = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const { result, rerender } = renderHook(({ snapshot }) => useChatSuggestions(snapshot, { enabled: true }), { initialProps: { snapshot: first } });
    await tick(); rerender({ snapshot: second });
    expect(vi.mocked(generateChatSuggestions).mock.calls[0][2]?.aborted).toBe(true);
    expect(result.current.suggestions).toEqual([]); await tick();
    await act(async () => current.resolve(generated("Second Space")));
    await act(async () => old.resolve(generated("Private first Space")));
    expect(result.current.suggestions).toEqual(generated("Second Space"));
  });

  it("ignores out-of-order context responses when the attached note or its prose changes", async () => {
    const snapshot = fixture();
    snapshot.notes.push({ ...snapshot.notes[0], id: "other", title: "Estuary currents", body: "Tides carry sediment past the reeds. How does tidal flow affect sampling?" });
    const old = deferred(), next = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(({ current, focus }) => useChatSuggestions(current, { enabled: true, focusNoteId: focus }), { initialProps: { current: snapshot, focus: "water" } });
    await tick(); rerender({ current: snapshot, focus: "other" }); await tick();
    await act(async () => next.resolve(generated("Tidal flow")));
    await act(async () => old.reject(new Error("Old request failed")));
    expect(result.current).toMatchObject({ status: "ready", suggestions: generated("Tidal flow"), targetNoteId: "other" });
    const changed = { ...snapshot, notes: snapshot.notes.map(note => note.id === "other" ? { ...note, body: "New measurements show that the sediment settles upstream." } : note) };
    vi.mocked(generateChatSuggestions).mockResolvedValue(generated("New measurements"));
    rerender({ current: changed, focus: "other" }); expect(result.current.suggestions).toEqual([]);
    await tick(); expect(generateChatSuggestions).toHaveBeenCalledTimes(3);
    expect(result.current.suggestions).toEqual(generated("New measurements"));
  });

  it("does not repurchase suggestions for unrelated appearance or navigation metadata", async () => {
    const snapshot = fixture(); const response = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValue(response.promise);
    const { result, rerender } = renderHook(({ current }) => useChatSuggestions(current, { enabled: true }), { initialProps: { current: snapshot } });
    await tick();
    const changed = { ...snapshot, settings: { ...snapshot.settings, themeIcon: !snapshot.settings.themeIcon }, notes: snapshot.notes.map(note => ({ ...note, lastOpenedAt: "2026-10-10" })) };
    rerender({ current: changed });
    expect(vi.mocked(generateChatSuggestions).mock.calls[0][2]?.aborted).toBe(false);
    await act(async () => response.resolve(generated())); await tick();
    expect(generateChatSuggestions).toHaveBeenCalledOnce(); expect(result.current.status).toBe("ready");
  });

  it("starts a new provider request for model and reasoning changes, with old responses suppressed", async () => {
    const snapshot = fixture(); const old = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValueOnce(old.promise).mockResolvedValue(generated("Claude"));
    const { result, rerender } = renderHook(({ current }) => useChatSuggestions(current, { enabled: true }), { initialProps: { current: snapshot } });
    await tick();
    const anthropic = { ...snapshot, settings: { ...snapshot.settings, model: "claude-sonnet-5", anthropicApiKeyConfigured: true } };
    rerender({ current: anthropic }); await tick();
    expect(vi.mocked(generateChatSuggestions).mock.calls[0][2]?.aborted).toBe(true);
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][0].settings.model).toBe("claude-sonnet-5");
    await act(async () => old.resolve(generated("OpenAI stale")));
    expect(result.current.suggestions).toEqual(generated("Claude"));
    rerender({ current: { ...anthropic, settings: { ...anthropic.settings, reasoningEffort: anthropic.settings.reasoningEffort === "high" ? "low" : "high" } } });
    await tick(); expect(generateChatSuggestions).toHaveBeenCalledTimes(3);
  });

  it("stays paused when the caller disables generation after a selected key is removed", async () => {
    const snapshot = fixture(); const response = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValueOnce(response.promise).mockResolvedValue(generated("Configured again"));
    const { result, rerender } = renderHook(({ current }) => useChatSuggestions(current, { enabled: current.settings.apiKeyConfigured }), { initialProps: { current: snapshot } });
    await tick();
    rerender({ current: { ...snapshot, settings: { ...snapshot.settings, apiKeyConfigured: false } } });
    expect(vi.mocked(generateChatSuggestions).mock.calls[0][2]?.aborted).toBe(true);
    await act(async () => response.resolve(generated("Unavailable key"))); await tick();
    expect(result.current).toMatchObject({ status: "idle", suggestions: [] });
    expect(generateChatSuggestions).toHaveBeenCalledOnce();
    rerender({ current: snapshot }); await tick();
    expect(result.current.suggestions).toEqual(generated("Configured again"));
  });

  it("skips generation without the selected connection even if the caller enables it, then starts after sign-in", async () => {
    const snapshot = fixture(); snapshot.settings.model = "chatgpt:gpt-6.1-sol";
    snapshot.settings.chatgptConfigured = false;
    const { result, rerender } = renderHook(({ current }) => useChatSuggestions(current, { enabled: true }), { initialProps: { current: snapshot } });
    await tick(10_000); expect(generateChatSuggestions).not.toHaveBeenCalled(); expect(result.current.status).toBe("idle");
    rerender({ current: { ...snapshot, settings: { ...snapshot.settings, chatgptConfigured: true, chatgptAccountId: "account-a" } } });
    await tick(); expect(generateChatSuggestions).toHaveBeenCalledOnce(); expect(result.current.status).toBe("ready");
  });

  it("recovers a cached failure after disconnecting and reconnecting the same ChatGPT account", async () => {
    const snapshot = fixture(); Object.assign(snapshot.settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
    vi.mocked(generateChatSuggestions).mockRejectedValueOnce(new Error("Expired connection"));
    const { result, rerender } = renderHook(({ current, enabled }) => useChatSuggestions(current, { enabled }), { initialProps: { current: snapshot, enabled: true } });
    await tick(); expect(result.current.status).toBe("error");
    rerender({ current: snapshot, enabled: false }); rerender({ current: snapshot, enabled: true });
    await tick(10_000); expect(generateChatSuggestions).toHaveBeenCalledOnce();
    rerender({ current: { ...snapshot, settings: { ...snapshot.settings, chatgptConfigured: false } }, enabled: false });
    rerender({ current: snapshot, enabled: true }); await tick();
    expect(generateChatSuggestions).toHaveBeenCalledTimes(2); expect(result.current.status).toBe("ready");
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][0].settings.chatgptAccountId).toBe("account-a");
  });

  it("switches accounts without reusing old failure history or publishing an old in-flight response", async () => {
    const snapshot = fixture(); Object.assign(snapshot.settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
    const old = deferred();
    vi.mocked(generateChatSuggestions).mockReturnValueOnce(old.promise).mockResolvedValue(generated("Second account"));
    const { result, rerender } = renderHook(({ current }) => useChatSuggestions(current, { enabled: true }), { initialProps: { current: snapshot } });
    await tick();
    rerender({ current: { ...snapshot, settings: { ...snapshot.settings, chatgptAccountId: "account-b" } } });
    expect(result.current.suggestions).toEqual([]); expect(vi.mocked(generateChatSuggestions).mock.calls[0][2]?.aborted).toBe(true);
    await tick(); await act(async () => old.resolve(generated("Old account")));
    expect(result.current.suggestions).toEqual(generated("Second account"));
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][0].settings.chatgptAccountId).toBe("account-b");
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][1].previousPrompts).toEqual([]);
  });

  it("invalidates cached failure on an explicit same-account connection event while Chat is unmounted", async () => {
    const snapshot = fixture(); Object.assign(snapshot.settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
    vi.mocked(generateChatSuggestions).mockRejectedValueOnce(new Error("Non-SSE stream"));
    const first = renderHook(() => useChatSuggestions(snapshot, { enabled: true }));
    await tick(); expect(first.result.current.status).toBe("error"); first.unmount();
    invalidateChatSuggestionConnection("chatgpt");
    const second = renderHook(() => useChatSuggestions(snapshot, { enabled: true }));
    expect(second.result.current.status).toBe("loading"); await tick();
    expect(second.result.current.status).toBe("ready"); expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
  });

  it("rejects a late response immediately after a connection event even before new account status arrives", async () => {
    const snapshot = fixture(); Object.assign(snapshot.settings, { model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, chatgptAccountId: "account-a" });
    const old = deferred(); vi.mocked(generateChatSuggestions).mockReturnValueOnce(old.promise).mockResolvedValue(generated("Reconnected"));
    const { result } = renderHook(() => useChatSuggestions(snapshot, { enabled: true }));
    await tick();
    await act(async () => { invalidateChatSuggestionConnection("chatgpt"); old.resolve(generated("Obsolete credential")); });
    expect(result.current.suggestions).toEqual([]); await tick();
    expect(result.current.suggestions).toEqual(generated("Reconnected")); expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    await tick(10_000); expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
  });

  it("keeps successful suggestions when another provider's connection changes", async () => {
    const snapshot = fixture(); const { result, rerender } = renderHook(({ current }) => useChatSuggestions(current, { enabled: true }), { initialProps: { current: snapshot } });
    await tick();
    act(() => invalidateChatSuggestionConnection("chatgpt"));
    rerender({ current: { ...snapshot, settings: { ...snapshot.settings, chatgptConfigured: true, chatgptAccountId: "other-account" } } });
    await tick(); expect(result.current.suggestions).toEqual(generated()); expect(generateChatSuggestions).toHaveBeenCalledOnce();
  });

  it("creates a fresh batch for an explicit New chat seed", async () => {
    const snapshot = fixture();
    const { rerender } = renderHook(({ seed }) => useChatSuggestions(snapshot, { enabled: true, seed }), { initialProps: { seed: 0 } });
    await tick(); rerender({ seed: 1 }); await tick();
    expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][1].previousPrompts).toEqual(generated().map(item => item.prompt));
  });

  it("has no provider calls or fallback for empty and entirely completed content", async () => {
    const snapshot = fixture(); snapshot.notes[0].body = "# Retired ideas\n- [x] Add a PowerPoint editor\n  - [ ] Legacy child task";
    const { result } = renderHook(() => useChatSuggestions(snapshot, { enabled: true, focusNoteId: "water" }));
    await tick(); expect(generateChatSuggestions).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({ status: "empty", suggestions: [], targetNoteId: undefined });
  });

  it("bounds window-local successful batch reuse to twelve entries", async () => {
    const snapshots = Array.from({ length: 13 }, fixture);
    const { rerender } = renderHook(({ snapshot }) => useChatSuggestions(snapshot, { enabled: true }), { initialProps: { snapshot: snapshots[0] } });
    await tick();
    for (const snapshot of snapshots.slice(1)) { rerender({ snapshot }); await tick(); }
    expect(generateChatSuggestions).toHaveBeenCalledTimes(13);
    rerender({ snapshot: snapshots[0] }); await tick();
    expect(generateChatSuggestions).toHaveBeenCalledTimes(14);
  });
});
