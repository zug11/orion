// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { ChatView } from "./ChatView";
import { generateChatSuggestions } from "../lib/chatSuggestions";
import { CHAT_SUGGESTION_DELAY_MS } from "./useChatSuggestions";
import type { ChatPromptSuggestion, Note } from "../types";

vi.mock("../lib/chatSuggestions", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/chatSuggestions")>(),
  generateChatSuggestions: vi.fn(),
}));
const NOW = "2026-07-28T08:00:00.000Z";
let sequence = 0;
const note = (id: string, title: string, body: string): Note => ({ id, title, body, slug: id, summary: "", aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: NOW, updatedAt: NOW });
const handlers = () => ({ onSend: vi.fn().mockResolvedValue({ reply: "Done" }), onClear: vi.fn(), onOpenNote: vi.fn(), onSaveReply: vi.fn(), onOpenSettings: vi.fn() });
const generated = (prefix = "Wetland"): ChatPromptSuggestion[] => [
  { prompt: `How could ${prefix} reed beds affect the two sampling sites differently?`, intent: "discuss", evidenceIds: ["s1"] },
  { prompt: `Compare ${prefix} recovery with the sediment measurements.`, intent: "discuss", evidenceIds: ["s1"] },
  { prompt: `Which ${prefix} water-quality claims need stronger evidence?`, intent: "discuss", evidenceIds: ["s1"] },
  { prompt: `Create a note outlining a ${prefix} sampling experiment.`, intent: "create", evidenceIds: ["s1"] },
];
function fixture() {
  const snapshot = createEmptySnapshot("Field work", NOW, `chat-view-generated-${++sequence}`);
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [note("a", "Wetland recovery", "How do reed beds affect water quality? Compare the two sampling sites with different sediment levels.")];
  return snapshot;
}
async function generate() { await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_SUGGESTION_DELAY_MS); }); }
beforeEach(() => {
  vi.mocked(generateChatSuggestions).mockReset().mockResolvedValue(generated());
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("ChatView", () => {
  it.each([false, true])("shows a decorative idle orb without starting voice (compact=%s)", compact => {
    const callbacks = handlers(), toggle = vi.fn();
    const { container } = render(<ChatView {...callbacks} snapshot={fixture()} busy={false} compact={compact}
      voiceControl={{ active: false, toggle }} />);
    const visual = container.querySelector('.chat-welcome__voice .voice-constellation');
    expect(visual).toHaveAttribute("data-status", "idle");
    expect(visual?.querySelector("button")).toBeNull();
    expect(visual?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(toggle).not.toHaveBeenCalled();
    expect(callbacks.onSend).not.toHaveBeenCalled();
  });

  it("keeps stable scene and controls slots outside the composer and retains the thread during a call", () => {
    const snapshot = fixture(), callbacks = handlers(), toggle = vi.fn();
    const voiceSceneRef = vi.fn(), voiceControlsRef = vi.fn();
    const props = { ...callbacks, snapshot, busy: false, voiceSceneRef, voiceControlsRef };
    const { container, rerender } = render(<ChatView {...props} voiceControl={{ active: false, toggle }} />);
    const scene = container.querySelector('.chat-view__voice-scene');
    const controls = container.querySelector('.chat-view__voice-controls');
    expect(voiceSceneRef).toHaveBeenCalledWith(scene);
    expect(voiceControlsRef).toHaveBeenCalledWith(controls);
    expect(scene?.closest("form")).toBeNull(); expect(controls?.closest("form")).toBeNull();
    expect(controls?.nextElementSibling).toHaveClass("chat-composer");
    rerender(<ChatView {...props} voiceControl={{ active: true, toggle }} />);
    expect(container.querySelector('.chat-view__voice-scene')).toBe(scene);
    expect(container.querySelector('.chat-view__voice-controls')).toBe(controls);
    expect(container.querySelector('.chat-view')).toHaveAttribute("data-voice-active", "true");
    expect(container.querySelector('.chat-welcome')).toBeNull();
    expect(container.querySelector('.chat-view__thread')).toHaveAttribute("hidden");
    const withMessage = { ...snapshot, studio: { ...snapshot.studio, messages: [{ id: "spoken", role: "user" as const,
      content: "Keep this thought visible.", cardIds: [], contextCardIds: [], createdAt: NOW }] } };
    rerender(<ChatView {...props} snapshot={withMessage} voiceControl={{ active: true, toggle }} />);
    expect(screen.getByText("Keep this thought visible.")).toBeVisible();
    expect(container.querySelector('.chat-view__thread')).not.toHaveAttribute("hidden");
    expect(container.querySelector('.chat-view')).toHaveAttribute("data-voice-empty", "false");
    expect(container.querySelector('.chat-view__voice-scene')).toBe(scene);
    expect(container.querySelector('.chat-view__voice-controls')).toBe(controls);
  });

  it("keeps pending work and failure feedback accessible beside an active voice scene", async () => {
    let reject!: (error: Error) => void;
    const callbacks = handlers(); callbacks.onSend.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { container } = render(<ChatView {...callbacks} snapshot={fixture()} busy={false}
      voiceControl={{ active: true, toggle: vi.fn() }} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Read this draft" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(screen.getByText("Read this draft", { selector: "p" })).toBeVisible();
    expect(container.querySelector('.chat-view__thread')).not.toHaveAttribute("hidden");
    await act(async () => { reject(new Error("The research failed; please retry.")); });
    expect(screen.getByRole("alert")).toHaveTextContent("The research failed; please retry.");
    expect(screen.getByRole("textbox")).toHaveValue("Read this draft");
    expect(container.querySelector('.chat-view__thread')).not.toHaveAttribute("hidden");
    expect(container.querySelector('.chat-welcome')).toBeNull();
  });

  it("shows one Chat surface and directs an unconfigured user to Settings without generating suggestions", () => {
    const snapshot = fixture(); snapshot.settings.apiKeyConfigured = false;
    const callbacks = handlers();
    render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    expect(screen.getByRole("heading", { name: "Chat" })).toBeVisible();
    expect(screen.getByText(/Think with your whole Space/i)).toBeVisible();
    expect(screen.queryByText(/Concept Studio|Dialectic|thinking cards/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Configure OpenAI key" }));
    expect(callbacks.onOpenSettings).toHaveBeenCalledOnce();
    expect(generateChatSuggestions).not.toHaveBeenCalled();
  });

  it("fills the composer with the exact visible generated prompt and sends only after confirmation", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("Finding ideas in your Space");
    expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
    await generate();
    const prompt = generated()[0].prompt;
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    const composer = screen.getByRole("textbox", { name: "Message Orion" });
    expect(composer).toHaveValue(prompt); expect(composer).toHaveFocus();
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(composer, { key: "Enter" }); });
    expect(callbacks.onSend).toHaveBeenCalledWith(prompt);
  });

  it("refreshes with earlier generated prompts and keeps the user's own draft untouched", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    vi.mocked(generateChatSuggestions).mockResolvedValueOnce(generated()).mockResolvedValueOnce(generated("Estuary"));
    render(<ChatView {...callbacks} snapshot={snapshot} busy={false} compact />);
    await generate();
    expect(within(screen.getByRole("group", { name: "Suggested prompts" })).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Refresh suggested prompts" }));
    expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
    await generate();
    expect(screen.getByRole("button", { name: generated("Estuary")[0].prompt })).toBeVisible();
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][1].previousPrompts).toEqual(generated().map(item => item.prompt));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "My own question" } });
    expect(screen.queryByRole("button", { name: "Refresh suggested prompts" })).not.toBeInTheDocument();
    await generate(); expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("textbox")).toHaveValue("My own question");
    expect(callbacks.onSend).not.toHaveBeenCalled();
  });

  it("reuses the generated batch on reopening and expansion while preserving a composed draft", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} busy={false} compact />);
    await generate();
    const compact = within(screen.getByRole("group", { name: "Suggested prompts" })).getAllByRole("button").map(button => button.textContent);
    rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} compact visible={false} />);
    rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    const expanded = within(screen.getByRole("group", { name: "Suggested prompts" })).getAllByRole("button").map(button => button.textContent);
    expect(expanded).toHaveLength(4); expect(expanded.slice(0, 2)).toEqual(compact);
    await generate(); expect(generateChatSuggestions).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Keep my thought" } });
    rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} visible={false} />);
    rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    expect(screen.getByRole("textbox")).toHaveValue("Keep my thought");
  });

  it("shows an honest failure with no stock fallback and retries only after Refresh", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    vi.mocked(generateChatSuggestions).mockRejectedValueOnce(new Error("Provider unavailable"));
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    await generate();
    expect(screen.getByRole("status")).toHaveTextContent("Couldn’t find suggestions just now");
    expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
    expect(screen.queryByText("What connections am I missing?")).not.toBeInTheDocument();
    rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} visible={false} />);
    rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    await generate(); expect(generateChatSuggestions).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh suggested prompts" }));
    await generate(); expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: generated()[0].prompt })).toBeVisible();
  });

  it("does not invent generic suggestions when the Space has no substantive context", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); snapshot.notes = [];
    render(<ChatView {...handlers()} snapshot={snapshot} busy={false} />);
    await generate(); expect(generateChatSuggestions).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Refresh suggested prompts" })).not.toBeInTheDocument();
  });

  it("pauses when the selected provider lacks a key and resumes with that provider after configuration", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    let resolve!: (value: ChatPromptSuggestion[]) => void;
    vi.mocked(generateChatSuggestions).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    await generate(); const firstSignal = vi.mocked(generateChatSuggestions).mock.calls[0][2];
    const unavailable = { ...snapshot, settings: { ...snapshot.settings, model: "claude-sonnet-5", anthropicApiKeyConfigured: false } };
    rerender(<ChatView {...callbacks} snapshot={unavailable} busy={false} />);
    expect(firstSignal?.aborted).toBe(true);
    expect(screen.getByRole("button", { name: "Configure Anthropic key" })).toBeVisible();
    await act(async () => resolve(generated("Old provider"))); await generate();
    expect(generateChatSuggestions).toHaveBeenCalledOnce();
    expect(screen.queryByRole("group", { name: "Suggested prompts" })).not.toBeInTheDocument();
    const configured = { ...unavailable, settings: { ...unavailable.settings, anthropicApiKeyConfigured: true } };
    rerender(<ChatView {...callbacks} snapshot={configured} busy={false} />);
    await generate(); expect(generateChatSuggestions).toHaveBeenCalledTimes(2);
    expect(vi.mocked(generateChatSuggestions).mock.calls[1][0].settings.model).toBe("claude-sonnet-5");
    expect(screen.getByRole("button", { name: generated()[0].prompt })).toBeVisible();
  });

  it.each(["hidden", "draft", "busy"])("pauses generation while %s and resumes after the pause", async pause => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    if (pause === "draft") fireEvent.change(screen.getByRole("textbox"), { target: { value: "My thought" } });
    else rerender(<ChatView {...callbacks} snapshot={snapshot} busy={pause === "busy"} visible={pause !== "hidden"} />);
    await generate(); expect(generateChatSuggestions).not.toHaveBeenCalled();
    if (pause === "draft") fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    else rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    await generate(); expect(generateChatSuggestions).toHaveBeenCalledOnce();
  });

  it("keeps a selected edit bound to its original note across navigation and draft changes", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    snapshot.notes = [note("a", "Opening scene", "The car stalled at the river."), note("b", "Final scene", "She left before dawn.")];
    const edit: ChatPromptSuggestion = { prompt: "Revise the stalled-car opening to sharpen its sense of danger, preserving my voice.", intent: "edit", evidenceIds: ["s1"] };
    vi.mocked(generateChatSuggestions).mockResolvedValue([edit]);
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="a" busy={false} />);
    await generate(); fireEvent.click(screen.getByRole("button", { name: edit.prompt }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: edit.prompt + " Keep it brief." } });
    rerender(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="b" busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Opening scene" }));
    expect(callbacks.onOpenNote).toHaveBeenCalledWith("a");
    await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });
    expect(callbacks.onSend).toHaveBeenCalledWith(edit.prompt + " Keep it brief.", "a");
  });

  it("preserves the draft and blocks an edit if its captured note is deleted", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    const edit: ChatPromptSuggestion = { prompt: "Revise this note's description of reed-bed sampling.", intent: "edit", evidenceIds: ["s1"] };
    vi.mocked(generateChatSuggestions).mockResolvedValue([edit]);
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="a" busy={false} />);
    await generate(); fireEvent.click(screen.getByRole("button", { name: edit.prompt }));
    rerender(<ChatView {...callbacks} snapshot={{ ...snapshot, notes: [] }} busy={false} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue(edit.prompt);
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  });

  it("keeps an originally unattached discussion suggestion unattached after note navigation", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
    await generate(); const prompt = generated()[0].prompt;
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    rerender(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="a" busy={false} />);
    await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });
    expect(callbacks.onSend).toHaveBeenCalledWith(prompt);
  });

  it("retains the captured note for a discussion suggestion even if later draft text asks for edits", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    snapshot.notes.push(note("b", "Different draft", "New unrelated writing."));
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="a" busy={false} />);
    await generate(); const prompt = generated()[0].prompt;
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: prompt + " Then propose an edit." } });
    rerender(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="b" busy={false} />);
    expect(screen.getByRole("button", { name: "Wetland recovery" })).toBeVisible();
    await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });
    expect(callbacks.onSend).toHaveBeenCalledWith(prompt + " Then propose an edit.", "a");
  });

  it("never resolves a captured suggestion target by a matching ID in a different Space", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const other = fixture(); const callbacks = handlers();
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="a" busy={false} />);
    await generate(); const prompt = generated()[0].prompt;
    fireEvent.click(screen.getByRole("button", { name: prompt }));
    rerender(<ChatView {...callbacks} snapshot={other} focusNoteId="a" busy={false} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(callbacks.onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox")).toHaveValue(prompt);
    expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  });

  it("clears a captured edit target only when its draft is cleared", async () => {
    vi.useFakeTimers(); const snapshot = fixture(); const callbacks = handlers();
    snapshot.notes.push(note("b", "Different draft", "New unrelated writing."));
    const edit: ChatPromptSuggestion = { prompt: "Revise the reed-bed description.", intent: "edit", evidenceIds: ["s1"] };
    vi.mocked(generateChatSuggestions).mockResolvedValue([edit]);
    const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="a" busy={false} />);
    await generate(); fireEvent.click(screen.getByRole("button", { name: edit.prompt }));
    rerender(<ChatView {...callbacks} snapshot={snapshot} focusNoteId="b" busy={false} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Explain this note" } });
    await act(async () => { fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" }); });
    expect(callbacks.onSend).toHaveBeenCalledWith("Explain this note", "b");
  });

  it("renders the conversation and starts a new chat without card controls", () => {
    const snapshot = createEmptySnapshot(
      "Research Space",
      NOW,
      "space-research",
    );
    snapshot.settings.apiKeyConfigured = true;
    snapshot.studio.messages.push({
      id: "chat-assistant",
      role: "assistant",
      content: "The strongest connection is **orientation**.",
      cardIds: ["legacy-card"],
      contextCardIds: ["legacy-card"],
      createdAt: NOW,
    });
    const onClear = vi.fn();

    render(
      <ChatView
        snapshot={snapshot}
        busy={false}
        onSend={vi.fn()}
        onClear={onClear}
        onOpenNote={vi.fn()}
        onSaveReply={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByText("orientation")).toBeVisible();
    expect(screen.queryByText(/legacy-card/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it("opens notes created by Chat and offers a one-click save for ordinary replies", () => {
    const snapshot = createEmptySnapshot("Research Space", NOW, "space-research");
    snapshot.settings.apiKeyConfigured = true;
    snapshot.notes.push({
      id: "note-created",
      title: "Created from Chat",
      slug: "created-from-chat",
      summary: "A permanent note.",
      body: "Permanent prose.",
      aliases: [],
      tags: [],
      kind: "article",
      status: "ready",
      conceptIds: [],
      sourceIds: [],
      createdAt: NOW,
      updatedAt: NOW,
    });
    snapshot.studio.messages.push(
      {
        id: "chat-created",
        role: "assistant",
        content: "I created the requested note.",
        cardIds: [],
        contextCardIds: [],
        createdNoteIds: ["note-created"],
        createdAt: NOW,
      },
      {
        id: "chat-saveable",
        role: "assistant",
        content: "An ordinary useful reply.",
        cardIds: [],
        contextCardIds: [],
        createdAt: NOW,
      },
    );
    const onOpenNote = vi.fn();
    const onSaveReply = vi.fn();

    render(
      <ChatView
        snapshot={snapshot}
        busy={false}
        onSend={vi.fn()}
        onClear={vi.fn()}
        onOpenNote={onOpenNote}
        onSaveReply={onSaveReply}
        onOpenSettings={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open note: Created from Chat" }),
    );
    expect(onOpenNote).toHaveBeenCalledWith("note-created");
    fireEvent.click(screen.getByRole("button", { name: "Keep as note" }));
    expect(onSaveReply).toHaveBeenCalledWith("chat-saveable");
  });

  it("stops an active reading response and restores the question without leaving a duplicate pending message", async () => {
    const snapshot = createEmptySnapshot("Research", NOW, "space-research");
    snapshot.settings.apiKeyConfigured = true;
    let reject!: (error: Error) => void;
    const onSend = vi.fn(() => new Promise<never>((_resolve, failure) => { reject = failure; }));
    const onCancel = vi.fn(() => reject(new Error("Chat was stopped.")));
    render(<ChatView snapshot={snapshot} busy={false} progress="Reading supporting passages" onSend={onSend}
      onCancel={onCancel} onClear={vi.fn()} onOpenNote={vi.fn()} onSaveReply={vi.fn()} onOpenSettings={vi.fn()} />);
    const composer = screen.getByRole("textbox", { name: "Message Orion" });
    fireEvent.change(composer, { target: { value: "Find the agreement" } });
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(screen.getByText("Reading supporting passages")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Stop response" }));
    await waitFor(() => expect(composer).toHaveValue("Find the agreement"));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSend).toHaveBeenCalledOnce();
    expect(screen.queryByText("Find the agreement", { selector: "p" })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Chat was stopped.");
  });
});

it("captures highlighted text with the typed request and offers passage comments on the reply", async () => {
  const snapshot = fixture(), callbacks = handlers(), onCommentReply = vi.fn().mockResolvedValue(undefined);
  const selection = { id: "selection-1", spaceId: snapshot.workspace.id, noteId: "a", noteTitle: "Wetland recovery", version: "version", text: "reed beds", range: { from: 7, to: 16, unit: "dom-text-utf16" as const }, hiddenTaskRanges: [] };
  snapshot.studio.messages = [{ id: "answer", role: "assistant", content: "Consider the reed density.", cardIds: [], contextCardIds: [], createdAt: NOW, passage: { noteId: "a", anchor: { quote: "reed beds", text: "reed beds" } } }];
  render(<ChatView {...callbacks} snapshot={snapshot} busy={false} focusNoteId="a" selection={selection} onCommentReply={onCommentReply} />);
  expect(screen.getByText("Selected text")).toBeVisible();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "What do you think of this?" } });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await waitFor(() => expect(callbacks.onSend).toHaveBeenCalledWith("What do you think of this?", "a", selection));
  expect(callbacks.onSend.mock.calls[0][2]).not.toBe(selection);
  fireEvent.click(screen.getByRole("button", { name: "Comment on passage" }));
  await waitFor(() => expect(onCommentReply).toHaveBeenCalledWith("answer", selection));
});

it("uses the same passage conversation in Chat while preserving the ordinary composer", async () => {
  const snapshot = fixture(), callbacks = handlers();
  snapshot.studio.messages = [{ id: "ordinary", role: "assistant", content: "Ordinary Space answer", createdAt: NOW, cardIds: [], contextCardIds: [] }];
  const thread = { id: "thread", state: "open" as const, anchor: { quote: snapshot.notes[0].body, text: snapshot.notes[0].body }, createdAt: NOW, updatedAt: NOW,
    messages: [{ id: "comment", role: "assistant" as const, content: "An anchored observation", createdAt: NOW }] };
  const onAction = vi.fn().mockResolvedValue(undefined), onReturn = vi.fn(), onLeave = vi.fn();
  const { rerender } = render(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Message Orion" }), { target: { value: "My separate Space draft" } });
  const passageChat = { key: "open-thread", note: snapshot.notes[0], thread, draft: "Follow this comment", onAction, onReturn, onLeave };
  rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} passageChat={passageChat} />);
  expect(screen.queryByText("Ordinary Space answer")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Discuss this passage" })).toHaveValue("Follow this comment");
  expect(screen.queryByRole("button", { name: "Comment on passage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ kind: "reply", text: "Follow this comment" })));
  expect(callbacks.onSend).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole("button", { name: "Space chat" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Back to Wetland recovery" })); expect(onReturn).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Space chat" })); expect(onLeave).toHaveBeenCalledOnce();
  expect(callbacks.onClear).not.toHaveBeenCalled();
  rerender(<ChatView {...callbacks} snapshot={snapshot} busy={false} />);
  expect(screen.getByRole("textbox", { name: "Message Orion" })).toHaveValue("My separate Space draft");
});
