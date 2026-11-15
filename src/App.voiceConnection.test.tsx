// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { ComponentProps } from "react";
import { createEmptySnapshot, createEmptyVault } from "./data/defaults";
import type { OrionVault } from "./types";
import type { ChatViewProps } from "./components/ChatView";
import type { Sidebar } from "./components/Sidebar";
import type { SettingsView } from "./components/SettingsView";
import type { VoiceConnectionRequest } from "./lib/liveVoice";

const runtime = vi.hoisted(() => ({ disk: null as OrionVault | null, chat: null as ChatViewProps | null,
  settings: null as ComponentProps<typeof SettingsView> | null, sidebar: null as ComponentProps<typeof Sidebar> | null,
  load: vi.fn(), save: vi.fn(), invoke: vi.fn(), saveElevenLabsKey: vi.fn() }));
vi.mock("./lib/storage", async original => ({ ...await original<typeof import("./lib/storage")>(),
  isTauriRuntime: () => true, loadSnapshot: runtime.load, saveSnapshot: runtime.save, saveElevenLabsApiKey: runtime.saveElevenLabsKey }));
vi.mock("./lib/useResolvedTheme", async () => {
  const { resolveThemePalette } = await import("./lib/theme");
  const { defaultSettings } = await import("./data/defaults");
  const palette = resolveThemePalette(defaultSettings, "dark");
  return { useResolvedTheme: () => ({ palette, glassStatus: null }) };
});
vi.mock("./lib/useThemeIcon", () => ({ useThemeIcon: () => ({ mark: "", message: null }) }));
vi.mock("./lib/assistant/executor", () => ({ startAssistantExecutor: () => () => undefined }));
vi.mock("./components/Sidebar", () => ({ Sidebar: (props: ComponentProps<typeof Sidebar>) => { runtime.sidebar = props; return null; } }));
vi.mock("./components/SettingsView", () => ({ SettingsView: (props: ComponentProps<typeof SettingsView>) => { runtime.settings = props; return null; } }));
vi.mock("./components/HomeView", () => ({ HomeView: () => null }));
vi.mock("./components/NoteView", () => ({ NoteView: () => null }));
vi.mock("./components/ImportStudio", () => ({ ImportStudio: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/ExportDialog", () => ({ ExportDialog: () => null }));
vi.mock("./components/ChatDock", () => ({ ChatDock: (props: ChatViewProps) => { runtime.chat = props; return null; } }));
import App from "./App";

const voiceId = "ABCDEFGHIJKLMNO123456";
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const saveToDisk = async (next: OrionVault, expected: string | null) => {
  if (runtime.disk?.updatedAt !== expected) throw new Error("ORION_VAULT_CONFLICT");
  runtime.disk = structuredClone(next);
};
beforeEach(() => {
  runtime.chat = null; runtime.settings = null; runtime.sidebar = null;
  runtime.load.mockReset(); runtime.save.mockReset(); runtime.invoke.mockReset().mockResolvedValue(undefined);
  runtime.saveElevenLabsKey.mockReset().mockResolvedValue(undefined);
  mockIPC((command, payload) => runtime.invoke(command, payload), { shouldMockEvents: true }); mockWindows("main");
  runtime.disk = createEmptyVault("Voice settings");
  runtime.disk.spaces.push(createEmptySnapshot("Other Space", runtime.disk.updatedAt, "other-space"));
  runtime.load.mockImplementation(async () => structuredClone(runtime.disk)); runtime.save.mockImplementation(saveToDisk);
});
afterEach(async () => {
  await act(async () => { cleanup(); await vi.dynamicImportSettled(); });
  clearMocks(); window.history.replaceState(null, "", "/");
});
async function launch() {
  render(<App />);
  await waitFor(() => expect(runtime.chat?.snapshot.workspace.id).toBe(runtime.disk!.activeSpaceId));
  act(() => runtime.chat!.onOpenSettings());
  await waitFor(() => expect(runtime.settings).not.toBeNull());
}
function selectVoice() {
  runtime.settings!.onChange({ ...runtime.settings!.settings, liveVoiceProvider: "elevenlabs", elevenLabsVoiceId: voiceId });
}
function request(): VoiceConnectionRequest { return { spaceId: runtime.disk!.spaces[0].workspace.id, provider: "elevenlabs", voiceId }; }
function heldSave() {
  const held = deferred();
  runtime.save.mockImplementationOnce(async (next: OrionVault, expected: string | null) => { await held.promise; await saveToDisk(next, expected); });
  return held;
}

describe("App voice connection save barrier", () => {
  it.each(["system", "openai"] as const)("saving a conversation key preserves %s note narration", async narration => {
    runtime.disk!.spaces[0].settings.liveVoiceProvider = "elevenlabs";
    runtime.disk!.spaces[0].settings.speechVoice = narration;
    await launch();
    await act(async () => { await runtime.settings!.onSaveElevenLabsApiKey("synthetic-test-key"); });
    expect(runtime.saveElevenLabsKey).toHaveBeenCalledExactlyOnceWith("synthetic-test-key");
    expect(runtime.chat!.snapshot.settings).toMatchObject({ liveVoiceProvider: "elevenlabs", speechVoice: narration, elevenLabsApiKeyConfigured: true });
  });

  it("a late key save preserves provider, custom voice and model choices changed while Keychain was pending", async () => {
    await launch(); const pending = deferred(); runtime.saveElevenLabsKey.mockReturnValue(pending.promise);
    let keySave!: Promise<void>;
    act(() => { keySave = runtime.settings!.onSaveElevenLabsApiKey("synthetic-delayed-key"); });
    act(() => runtime.settings!.onChange({ ...runtime.settings!.settings, liveVoiceProvider: "elevenlabs",
      elevenLabsVoiceId: voiceId, model: "claude-sonnet-5", speechVoice: "openai" }));
    await act(async () => { pending.resolve(); await keySave; });
    expect(runtime.chat!.snapshot.settings).toMatchObject({ liveVoiceProvider: "elevenlabs", elevenLabsVoiceId: voiceId,
      model: "claude-sonnet-5", speechVoice: "openai", elevenLabsApiKeyConfigured: true });
    await act(async () => { await runtime.chat!.onPrepareVoiceConnection!(request(), new AbortController().signal); });
    expect(runtime.disk!.spaces[0].settings).toMatchObject({ liveVoiceProvider: "elevenlabs", elevenLabsVoiceId: voiceId,
      model: "claude-sonnet-5", speechVoice: "openai", elevenLabsApiKeyConfigured: true });
  });

  it("prepares the pinned writing Space even when the saved global navigation names another Space", async () => {
    const pinned = runtime.disk!.spaces[0];
    pinned.settings.liveVoiceProvider = "elevenlabs"; pinned.settings.elevenLabsVoiceId = voiceId;
    pinned.notes = [{ id: "pinned-note", title: "Pinned draft", slug: "pinned", body: "Draft", summary: "", kind: "article", status: "ready",
      aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: runtime.disk!.updatedAt, updatedAt: runtime.disk!.updatedAt }];
    runtime.disk!.activeSpaceId = "other-space";
    window.history.replaceState(null, "", `/?space=${pinned.workspace.id}&note=pinned-note&view=writing`);
    render(<App />);
    await waitFor(() => expect(runtime.chat?.snapshot.workspace.id).toBe(pinned.workspace.id));
    expect(runtime.disk!.activeSpaceId).toBe("other-space");
    await act(async () => { await runtime.chat!.onPrepareVoiceConnection!({ spaceId: pinned.workspace.id, provider: "elevenlabs", voiceId }, new AbortController().signal); });
    expect(runtime.chat!.snapshot.workspace.id).toBe(pinned.workspace.id);
    await expect(runtime.chat!.onPrepareVoiceConnection!({ spaceId: "other-space", provider: "elevenlabs", voiceId }, new AbortController().signal)).rejects.toThrow("Space changed");
  });

  it("flushes a just-selected voice from the same React batch and waits for actual disk acknowledgement", async () => {
    await launch(); const held = heldSave(); const controller = new AbortController();
    let prepared = false, completion!: Promise<void>;
    act(() => { selectVoice(); completion = runtime.chat!.onPrepareVoiceConnection!(request(), controller.signal).then(() => { prepared = true; }); });
    await waitFor(() => expect(runtime.save).toHaveBeenCalled());
    expect(runtime.disk!.spaces[0].settings.liveVoiceProvider).toBe("openai");
    expect(prepared).toBe(false);
    expect(runtime.save.mock.calls[0][0].spaces[0].settings).toMatchObject({ liveVoiceProvider: "elevenlabs", elevenLabsVoiceId: voiceId });
    await act(async () => { held.resolve(); await completion; });
    expect(prepared).toBe(true);
    expect(runtime.disk!.spaces[0].settings).toMatchObject({ liveVoiceProvider: "elevenlabs", elevenLabsVoiceId: voiceId });
  });

  it("propagates a real save failure instead of treating the swallowed queue tail as saved", async () => {
    await launch(); const failure = new Error("Disk is unavailable"); runtime.save.mockRejectedValueOnce(failure);
    let completion!: Promise<unknown>;
    act(() => { selectVoice(); completion = runtime.chat!.onPrepareVoiceConnection!(request(), new AbortController().signal).catch(error => error); });
    let result: unknown; await act(async () => { result = await completion; });
    expect(result).toBe(failure);
    expect(screen.queryByText("Couldn’t save")).not.toBeInTheDocument();
    expect(runtime.disk!.spaces[0].settings.liveVoiceProvider).toBe("openai");
    // The ordinary queue remains usable after failure, and a fresh start can save.
    await act(async () => { await runtime.chat!.onPrepareVoiceConnection!(request(), new AbortController().signal); });
    expect(runtime.disk!.spaces[0].settings.liveVoiceProvider).toBe("elevenlabs");
  });

  it("keeps the authorized save but rejects a stopped call when persistence finishes late", async () => {
    await launch(); const held = heldSave(); const controller = new AbortController();
    let completion!: Promise<unknown>;
    act(() => { selectVoice(); completion = runtime.chat!.onPrepareVoiceConnection!(request(), controller.signal).catch(error => error); });
    await waitFor(() => expect(runtime.save).toHaveBeenCalled());
    controller.abort();
    let result: unknown; await act(async () => { held.resolve(); result = await completion; });
    expect(result).toMatchObject({ name: "AbortError" });
    expect(runtime.disk!.spaces[0].settings.liveVoiceProvider).toBe("elevenlabs");
  });

  it("keeps a save failure visible globally after Stop suppresses stale call errors", async () => {
    await launch(); const held = heldSave(); const controller = new AbortController();
    let completion!: Promise<unknown>;
    act(() => { selectVoice(); completion = runtime.chat!.onPrepareVoiceConnection!(request(), controller.signal).catch(error => error); });
    await waitFor(() => expect(runtime.save).toHaveBeenCalled());
    controller.abort(); const failure = new Error("Disk unavailable after stopping");
    let result: unknown; await act(async () => { held.reject(failure); result = await completion; });
    expect(result).toBe(failure);
    expect(screen.getByText("Couldn’t save")).toBeInTheDocument();
    expect(screen.getByText("Disk unavailable after stopping")).toBeInTheDocument();
    expect(runtime.disk!.spaces[0].settings.liveVoiceProvider).toBe("openai");
  });

  it.each(["provider", "voice", "Space"] as const)("rejects the captured request when %s changes during its save", async changed => {
    await launch(); const held = heldSave(); let completion!: Promise<unknown>;
    act(() => { selectVoice(); completion = runtime.chat!.onPrepareVoiceConnection!(request(), new AbortController().signal).catch(error => error); });
    await waitFor(() => expect(runtime.save).toHaveBeenCalled());
    act(() => {
      if (changed === "Space") runtime.sidebar!.onSwitchSpace("other-space");
      else runtime.settings!.onChange({ ...runtime.settings!.settings, ...(changed === "provider" ? { liveVoiceProvider: "openai" as const } : { elevenLabsVoiceId: "ZYXWVUTSRQPONML654321" }) });
    });
    let result: unknown; await act(async () => { held.resolve(); result = await completion; });
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/changed/);
  });
});
