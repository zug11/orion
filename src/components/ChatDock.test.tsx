// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { ChatDock } from "./ChatDock";
import { generateChatSuggestions } from "../lib/chatSuggestions";
import { CHAT_SUGGESTION_DELAY_MS } from "./useChatSuggestions";
import type { ChatPromptSuggestion } from "../types";
import { createVoicePresence } from "../lib/voicePresence";
import { SidebarVoiceIndicator } from "./SidebarVoiceIndicator";
const voiceCalls = vi.hoisted(() => ({ start: vi.fn(), close: vi.fn(), dispose: vi.fn(), mute: vi.fn() }));
vi.mock("../lib/chatSuggestions", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/chatSuggestions")>(),
  generateChatSuggestions: vi.fn(),
}));
vi.mock("./useNativeChatGlass", () => ({ useNativeChatGlass: () => false }));
vi.mock("./VoiceConstellation", () => ({ VoiceConstellation: ({ status, size }: { status: string; size?: string }) => <span data-testid={`voice-${size}`} data-status={status} /> }));
vi.mock("../lib/liveVoice", () => ({ LiveVoiceConnection: class {
  constructor(private options: { onStatus: (status: string) => void }) {}
  start() { voiceCalls.start(); this.options.onStatus("listening"); return Promise.resolve(); }
  close() { voiceCalls.close(); this.options.onStatus("idle"); }
  dispose() { voiceCalls.dispose(); } append() {} mute = voiceCalls.mute;
} }));
const generated = (topic = "Reed beds"): ChatPromptSuggestion[] => [
  { prompt: `How do ${topic} affect the two sampling sites?`, intent: "discuss", evidenceIds: ["s1"] },
  { prompt: `Compare ${topic} with the sediment measurements.`, intent: "discuss", evidenceIds: ["s1"] },
];
beforeEach(() => { vi.mocked(generateChatSuggestions).mockReset().mockResolvedValue(generated()); Object.values(voiceCalls).forEach(call => call.mockClear()); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
let sequence = 0;
function props() {
  const snapshot = createEmptySnapshot("Research", "2026-10-08T00:00:00Z", `chat-dock-${++sequence}`);
  snapshot.settings.apiKeyConfigured = true;
  return { snapshot, busy: false, fullPage: false, flowActive: false,
    onExpand: vi.fn(), onSend: vi.fn().mockResolvedValue({ reply: "Done." }),
    onClear: vi.fn(), onOpenNote: vi.fn(), onSaveReply: vi.fn(), onOpenSettings: vi.fn() };
}
describe("Space chat dock", () => {
  it("gates the circle by selected provider and Flow, and keeps full Chat available for setup", () => {
    const p = props();
    const { rerender } = render(<ChatDock {...p} />);
    expect(screen.getByRole("button", { name: "Open chat" })).toBeVisible();
    rerender(<ChatDock {...p} flowActive />);
    expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument();
    const noKey = { ...p.snapshot, settings: { ...p.snapshot.settings, apiKeyConfigured: false } };
    rerender(<ChatDock {...p} snapshot={noKey} />);
    expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument();
    rerender(<ChatDock {...p} snapshot={noKey} fullPage />);
    expect(screen.getByRole("button", { name: "Configure OpenAI key" })).toBeVisible();
  });
  it("preserves one draft through collapse and expansion without sending it", () => {
    const p = props(); const { rerender } = render(<ChatDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    const composer = screen.getByRole("textbox", { name: "Message Orion" });
    fireEvent.change(composer, { target: { value: "Connect these ideas" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse chat" }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByRole("textbox")).toHaveValue("Connect these ideas");
    fireEvent.click(screen.getByRole("button", { name: "Expand chat" }));
    expect(p.onExpand).toHaveBeenCalledOnce();
    rerender(<ChatDock {...p} fullPage />);
    expect(screen.getByRole("textbox")).toBe(composer);
    expect(composer).toHaveValue("Connect these ideas");
    expect(screen.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument();
    expect(p.onSend).not.toHaveBeenCalled();
  });
  it("generates a new batch after starting a new compact conversation", async () => {
    vi.useFakeTimers();
    const p = props();
    p.snapshot.notes.push({ id: "water", title: "Wetland recovery", body: "How do reed beds affect the two sampling sites? Compare sediment levels.", summary: "", slug: "water", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" });
    vi.mocked(generateChatSuggestions).mockResolvedValueOnce(generated()).mockResolvedValueOnce(generated("Tidal flow"));
    const { rerender } = render(<ChatDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_SUGGESTION_DELAY_MS); });
    const first = screen.getByRole("group", { name: "Suggested prompts" }).textContent;
    const withMessage = { ...p.snapshot, studio: { ...p.snapshot.studio, messages: [{ id: "reply", role: "assistant" as const, content: "An earlier idea.", cardIds: [], contextCardIds: [], createdAt: "2026-10-09" }] } };
    rerender(<ChatDock {...p} snapshot={withMessage} />);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Chat controls" })).getByRole("button", { name: "New chat" }));
    rerender(<ChatDock {...p} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_SUGGESTION_DELAY_MS); });
    expect(p.onClear).toHaveBeenCalledOnce();
    expect(screen.getByRole("group", { name: "Suggested prompts" }).textContent).not.toBe(first);
    expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][1].previousPrompts).toEqual(generated().map(item => item.prompt));
    expect(p.onSend).not.toHaveBeenCalled();
  });
  it("keeps a pending prompt and Stop action across expansion, restoring cancelled text", async () => {
    const p = props(); let reject!: (error: Error) => void;
    p.onSend.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
    const onCancel = vi.fn(() => reject(new Error("Stopped")));
    const { rerender } = render(<ChatDock {...p} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read the sources" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    rerender(<ChatDock {...p} onCancel={onCancel} fullPage busy progress="Following connections" />);
    expect(screen.getByText("Read the sources")).toBeVisible();
    expect(screen.getByText("Following connections")).toBeVisible();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop response" })));
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue("Read the sources"));
    expect(p.onSend).toHaveBeenCalledOnce();
  });
  it("retains current-note context when a drafted question expands into full Chat", async () => {
    const p = props();
    p.snapshot.notes.push({ id: "current", title: "Current draft", body: "A thought", summary: "", slug: "current", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" });
    const { rerender } = render(<ChatDock {...p} focusNoteId="current" onReviewEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Explain this note" } });
    rerender(<ChatDock {...p} fullPage />);
    expect(screen.queryByRole("combobox", { name: "Attached note" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(p.onSend).toHaveBeenCalledWith("Explain this note", "current"));
  });
  it("discards transient UI on a Space switch and hides the panel immediately during Flow", () => {
    const p = props(); const { rerender } = render(<ChatDock key="one" {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Private draft" } });
    rerender(<ChatDock key="one" {...p} flowActive />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    rerender(<ChatDock key="two" {...p} snapshot={{ ...p.snapshot, workspace: { ...p.snapshot.workspace, id: "two", name: "Other" } }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(screen.getByRole("textbox")).toHaveValue("");
  });
  it("returns focus on Escape and does not submit an IME confirmation", () => {
    const p = props(); render(<><button>Document</button><ChatDock {...p} /></>);
    const documentButton = screen.getByRole("button", { name: "Document" }); documentButton.focus();
    const toggle = screen.getByRole("button", { name: "Open chat" });
    fireEvent.pointerDown(toggle); fireEvent.click(toggle);
    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "書く" } });
    fireEvent.keyDown(composer, { key: "Enter", isComposing: true });
    expect(p.onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(composer, { key: "Escape" });
    expect(documentButton).toHaveFocus();
  });
});

it("aborts suggestion generation when voice starts and never substitutes canned prompts", async () => {
  vi.useFakeTimers(); const p = props();
  p.snapshot.notes.push({ id: "water", title: "Wetland recovery", body: "How do reed beds affect the two sampling sites? Compare sediment levels.", summary: "", slug: "water", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" });
  let resolve!: (value: ChatPromptSuggestion[]) => void;
  vi.mocked(generateChatSuggestions).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  render(<ChatDock {...p} onVoiceCommit={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_SUGGESTION_DELAY_MS); });
  const signal = vi.mocked(generateChatSuggestions).mock.calls[0][2];
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Talk to Space" })); });
  expect(screen.getByRole("button", { name: "Stop voice" })).toBeVisible();
  expect(signal?.aborted).toBe(true);
  await act(async () => resolve(generated("Late research")));
  expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
  expect(screen.queryByText("What connections am I missing?")).not.toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
  expect(generateChatSuggestions).toHaveBeenCalledOnce();
});
it("uses one composer with an attached note and collapses the panel to review without reporting acceptance early", async () => {
  const p = props();
  p.snapshot.notes.push({ id: "current", title: "Current draft", body: "Old.", summary: "", slug: "current", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" });
  const proposal = { spaceId: p.snapshot.workspace.id, noteId: "current", title: "Current draft", baseBody: "Old.", mode: "rewrite" as const, rewrite: "New.", edits: [] };
  p.onSend.mockResolvedValue({ reply: "Review in note", editProposal: proposal });
  let resolve!: (value: boolean) => void;
  const review = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  render(<ChatDock {...p} focusNoteId="current" onReviewEdit={review} />);
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.queryByRole("combobox", { name: "Chat action" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Please do this" } });
  expect(screen.queryByRole("combobox", { name: "Attached note" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByRole("button", { name: "Review in note" });
  expect(p.onSend).toHaveBeenCalledWith("Please do this", "current");
  fireEvent.click(screen.getByRole("button", { name: "Review in note" }));
  expect(review).toHaveBeenCalledWith(proposal);
  expect(screen.queryByRole("region", { name: /Chat in/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.getByRole("button", { name: "Reviewing in note…" })).toBeDisabled();
  await act(async () => resolve(false));
  expect(screen.queryByRole("region", { name: /Proposed edits/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Changes accepted/)).not.toBeInTheDocument();
});

it("uses an existing reply in the attached note without asking for an editing mode", async () => {
  const p = props();
  p.snapshot.notes.push({ id: "current", title: "Current draft", body: "Old.", summary: "", slug: "current", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" });
  p.snapshot.studio.messages.push({ id: "reply", role: "assistant", content: "A suggested paragraph.", cardIds: [], contextCardIds: [], createdAt: "2026-10-08" });
  const onUseReply = vi.fn().mockResolvedValue({ spaceId: p.snapshot.workspace.id, noteId: "current", title: "Current draft", baseBody: "Old.", edits: [{ before: "Old.", after: "A suggested paragraph." }] });
  render(<ChatDock {...p} focusNoteId="current" onReviewEdit={vi.fn()} onUseReply={onUseReply} />);
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.queryByRole("combobox", { name: "Chat action" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Use in note" }));
  await waitFor(() => expect(onUseReply).toHaveBeenCalledWith("reply", "current", expect.any(Function)));
  expect(p.onSend).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Review in note" })).toBeVisible();
});


it("shows voice in the send position only while the composer is empty, with automatic note context", async () => {
  const p = props(); render(<ChatDock {...p} onVoiceCommit={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  const input = screen.getByRole("textbox", { name: "Message Orion" });
  expect(screen.getByRole("button", { name: "Talk to Space" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox", { name: "Attached note" })).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "A question" } });
  expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Talk to Space" })).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Talk to Space" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Talk to Space" }));
  expect(screen.getByRole("button", { name: "Stop voice" })).toBeVisible();
  expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Talk to Space" })).not.toBeInTheDocument();
  expect(screen.queryByText(/Online · OpenAI voice/)).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  expect(screen.getByRole("button", { name: "Stop voice" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Stop voice" }));
  expect(screen.getByRole("button", { name: "Send message" })).toBeVisible();
  expect(input).toHaveValue("Keep this draft");
  expect(p.onSend).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByRole("button", { name: "Talk to Space" })).toBeVisible();
});

it("a sidebar voice request keeps the note and call alive through Chat collapse and note navigation", async () => {
  const p = props(), presence = createVoicePresence();
  const initial = { ...p, onVoiceCommit: vi.fn(), voicePresence: presence, voiceToggleRequest: 0, focusNoteId: "first" };
  const { rerender } = render(<><button>Continue writing</button><SidebarVoiceIndicator presence={presence} /><ChatDock {...initial} /></>);
  const writing = screen.getByRole("button", { name: "Continue writing" }); writing.focus();
  rerender(<><button>Continue writing</button><SidebarVoiceIndicator presence={presence} /><ChatDock {...initial} voiceToggleRequest={1} /></>);
  expect(voiceCalls.start).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region", { name: /Chat in/ })).not.toBeInTheDocument();
  expect(writing).toHaveFocus(); expect(screen.getByLabelText("Voice active")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.getByRole("region", { name: /Chat in/ })).toBeVisible();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "A thought while talking" } });
  fireEvent.click(screen.getByRole("button", { name: /Talk to Space\s*0 working/ }));
  expect(screen.getByRole("region", { name: /Chat in/ })).toBeVisible();
  expect(screen.getByTestId("voice-expanded")).toBeVisible();
  expect(screen.getByRole("region", { name: /Chat in/ })).toContainElement(screen.getByRole("region", { name: "Space voice conversation" }));
  fireEvent.keyDown(screen.getByRole("button", { name: "Mute microphone" }), { key: "Escape" });
  expect(screen.getByRole("region", { name: /Chat in/ })).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveValue("A thought while talking");
  fireEvent.click(screen.getByRole("button", { name: "Collapse chat" }));
  rerender(<><button>Continue writing</button><SidebarVoiceIndicator presence={presence} /><ChatDock {...initial} voiceToggleRequest={1} focusNoteId="second" /></>);
  expect(voiceCalls.start).toHaveBeenCalledOnce(); expect(voiceCalls.close).not.toHaveBeenCalled(); expect(voiceCalls.dispose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "End voice call" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
  expect(voiceCalls.mute).toHaveBeenLastCalledWith(true); expect(screen.getByLabelText("Voice active, microphone muted")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.getByRole("textbox")).toHaveValue("A thought while talking");
  fireEvent.click(screen.getByRole("button", { name: "End voice call" }));
  expect(voiceCalls.close).toHaveBeenCalledOnce(); expect(screen.queryByLabelText("Voice active, microphone muted")).not.toBeInTheDocument();
});

it("docks the same call inside compact and full Chat and reattaches controls after clearing Chat", () => {
  const p = { ...props(), onVoiceCommit: vi.fn(), voiceToggleRequest: 0 };
  p.snapshot.studio.messages.push({ id: "earlier", role: "assistant", content: "An earlier thought.", cardIds: [], contextCardIds: [], createdAt: "2026-10-11" });
  const { rerender } = render(<ChatDock {...p} fullPage />);
  fireEvent.click(screen.getByRole("button", { name: "Talk to Space" }));
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Preserve this draft" } });
  const scene = screen.getByTestId("voice-expanded");
  expect(scene.closest(".chat-view__voice-scene")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Mute microphone" }).closest(".chat-view__voice-controls")).not.toBeNull();
  expect(document.querySelector(".space-voice-call:not(.space-voice-call--embedded)")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "New chat" }));
  expect(p.onClear).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Mute microphone" }).closest(".chat-view__voice-controls")?.isConnected).toBe(true);
  expect(voiceCalls.start).toHaveBeenCalledOnce(); expect(voiceCalls.dispose).not.toHaveBeenCalled();
  rerender(<ChatDock {...p} fullPage={false} />);
  expect(screen.getByRole("button", { name: "Open chat" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.getByTestId("voice-expanded").closest(".chat-view__voice-scene")).not.toBeNull();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep this thought" } });
  fireEvent.keyDown(screen.getByRole("button", { name: "Mute microphone" }), { key: "Escape" });
  expect(screen.queryByRole("region", { name: /Chat in/ })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open chat" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(screen.getByRole("textbox")).toHaveValue("Keep this thought");
  expect(voiceCalls.start).toHaveBeenCalledOnce(); expect(voiceCalls.close).not.toHaveBeenCalled();
  expect(voiceCalls.dispose).not.toHaveBeenCalled(); expect(p.onSend).not.toHaveBeenCalled();
});

it("switching Space disposes the call and never replays an earlier sidebar microphone click", () => {
  const first = props(), second = props();
  const { rerender } = render(<ChatDock key={first.snapshot.workspace.id} {...first} onVoiceCommit={vi.fn()} voiceToggleRequest={0} />);
  rerender(<ChatDock key={first.snapshot.workspace.id} {...first} onVoiceCommit={vi.fn()} voiceToggleRequest={1} />);
  expect(voiceCalls.start).toHaveBeenCalledOnce();
  rerender(<ChatDock key={second.snapshot.workspace.id} {...second} onVoiceCommit={vi.fn()} voiceToggleRequest={1} />);
  expect(voiceCalls.dispose).toHaveBeenCalledOnce(); expect(voiceCalls.start).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "End voice call" })).not.toBeInTheDocument();
  rerender(<ChatDock key={second.snapshot.workspace.id} {...second} onVoiceCommit={vi.fn()} voiceToggleRequest={2} />);
  expect(voiceCalls.start).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "End voice call" })).toBeVisible();
});
