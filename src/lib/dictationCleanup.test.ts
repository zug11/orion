// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot, createEmptyVault } from "../data/defaults";
import { loadSnapshot, saveSnapshot } from "./storage";
import { attachDictationOriginal, dictationOriginalSource, parseDictationCleanup, prepareDictation, DICTATION_CLEANUP_TIMEOUT_MS, MAX_DICTATION_CLEANUP_CHARS } from "./dictationCleanup";
import type { Note } from "../types";

const raw = "Let's have a meeting on Friday—oh no, actually Thursday. Maybe we could invite Sam.";
const blocks = [{ kind: "paragraph" as const, text: "Let's have a meeting on Thursday. Maybe we could invite Sam." }];
const now = "2026-11-11T07:00:00.000Z";
const note: Note = { id: "note-one", title: "Planning", slug: "planning", summary: "", body: "Existing writing.", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: now, updatedAt: now };

beforeEach(() => {
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  } });
});
afterEach(() => { vi.useRealTimers(); window.localStorage.clear(); });

function options() {
  return { transcript: raw, aiAvailable: true, preserveOriginal: vi.fn().mockResolvedValue("source-original"),
    clean: vi.fn().mockResolvedValue(blocks), signal: new AbortController().signal, onPhase: vi.fn() };
}

describe("dictation cleanup and recovery", () => {
  it("saves the exact original before sending the finished transcript for cleanup", async () => {
    const input = options();
    let resolveSave!: (value: string) => void;
    input.preserveOriginal.mockReturnValue(new Promise<string>(resolve => { resolveSave = resolve; }));
    const pending = prepareDictation(input);
    expect(input.clean).not.toHaveBeenCalled();
    resolveSave("source-original");
    expect(await pending).toMatchObject({ original: raw, sourceId: "source-original", blocks });
    expect(input.clean).toHaveBeenCalledTimes(1);
    expect(input.onPhase.mock.calls.map(call => call[0])).toEqual(["saving", "cleaning"]);
  });

  it.each(["missing-key", "too-long", "save-failed", "provider-failed", "malformed-result"])("keeps complete local text when %s", async reason => {
    const input = options();
    if (reason === "missing-key") input.aiAvailable = false;
    if (reason === "too-long") input.transcript = "語".repeat(MAX_DICTATION_CLEANUP_CHARS + 1);
    if (reason === "save-failed") input.preserveOriginal.mockRejectedValue(new Error("Disk full"));
    if (reason === "provider-failed") input.clean.mockRejectedValue(new Error("Offline"));
    if (reason === "malformed-result") input.clean.mockResolvedValue([{ kind: "heading", text: "Wrong" }]);
    const result = await prepareDictation(input);
    expect(result.original).toBe(input.transcript);
    expect(result.blocks).toBeUndefined();
    if (["missing-key", "too-long", "save-failed"].includes(reason)) expect(input.clean).not.toHaveBeenCalled();
    if (reason === "missing-key") expect(input.onPhase.mock.calls.map(call => call[0])).toEqual(["saving"]);
  });

  it.each(["skip", "timeout"])("stops waiting on %s and ignores a late cleanup response", async reason => {
    vi.useFakeTimers();
    const input = options(), controller = new AbortController();
    input.signal = controller.signal;
    let nativeSignal: AbortSignal | undefined, resolveClean!: (value: typeof blocks) => void;
    input.clean.mockImplementation((signal: AbortSignal) => { nativeSignal = signal; return new Promise(resolve => { resolveClean = resolve; }); });
    const pending = prepareDictation(input);
    await Promise.resolve();
    if (reason === "skip") controller.abort();
    else await vi.advanceTimersByTimeAsync(DICTATION_CLEANUP_TIMEOUT_MS);
    expect(await pending).toMatchObject({ original: raw, sourceId: "source-original" });
    expect((await pending).blocks).toBeUndefined();
    expect(nativeSignal?.aborted).toBe(true);
    resolveClean(blocks);
    await Promise.resolve();
    expect((await pending).blocks).toBeUndefined();
  });

  it("persists recovery with the originating note through the existing vault format", async () => {
    const source = dictationOriginalSource(note.id, "session-one", raw, now);
    const snapshot = { ...createEmptySnapshot(), notes: [note] };
    const updated = attachDictationOriginal(snapshot, note.id, source);
    expect(updated.notes[0].body).toBe(note.body);
    expect(snapshot.notes[0].sourceIds).toEqual([]);
    expect(updated.notes[0].sourceIds).toEqual([source.id]);
    expect(attachDictationOriginal(updated, note.id, source)).toBe(updated);
    expect(() => attachDictationOriginal(createEmptySnapshot(), note.id, source)).toThrow();
    expect(() => attachDictationOriginal(updated, note.id, { ...source, text: "Replacement" })).toThrow();
    const vault = { ...createEmptyVault(), activeSpaceId: updated.workspace.id, spaces: [updated] };
    await saveSnapshot(vault);
    const recovered = (await loadSnapshot())!.spaces[0];
    expect(recovered.sources[0].text).toBe(raw);
    expect(recovered.notes[0].sourceIds).toContain(source.id);
  });

  it("rejects new actions, invalid blocks, severe loss and inflated output while retaining literal symbols", () => {
    expect(parseDictationCleanup({ blocks }, raw)).toEqual(blocks);
    expect(parseDictationCleanup({ blocks: [{ kind: "paragraph", text: "Literal <tag> & [word](url)." }] }, raw)[0].text).toContain("<tag>");
    for (const invalid of [
      { blocks, noteActions: [] }, { blocks: [] }, { blocks: [{ kind: "todo", text: "Email Sam", checked: true }] },
      { blocks: [{ kind: "paragraph", text: "\u0000" }] }, { blocks: [{ kind: "paragraph", text: "A\nB" }] },
      { blocks: Array.from({ length: 257 }, () => blocks[0]) },
    ]) expect(() => parseDictationCleanup(invalid, raw)).toThrow();
    expect(() => parseDictationCleanup({ blocks }, "x".repeat(1_000))).toThrow();
    expect(() => parseDictationCleanup({ blocks: [{ kind: "paragraph", text: "x".repeat(200) }] }, "x")).toThrow();
  });
});
