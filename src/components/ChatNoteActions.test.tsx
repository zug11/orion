// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { ChatView } from "./ChatView";
import type { ChatEditProposal, Note } from "../types";
import type { ChatNoteReceipt } from "../lib/chatNoteActions";

vi.mock("./SpaceVoice", () => ({ SpaceVoice: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const now = "2026-10-11T00:00:00Z";
function props() {
  const snapshot = createEmptySnapshot("Drafts", now, "drafts");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "draft", title: "The river", body: "It was dark.", summary: "", slug: "draft", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: now, updatedAt: now }];
  snapshot.studio.messages = [
    { id: "question", role: "user", content: "Can you develop this?", cardIds: [], contextCardIds: [], createdAt: now },
    { id: "reply", role: "assistant", content: "The river swallowed the last of the light.", cardIds: [], contextCardIds: [], createdAt: now },
  ];
  return { snapshot, busy: false, focusNoteId: "draft", onSend: vi.fn(), onClear: vi.fn(), onOpenNote: vi.fn(), onOpenSettings: vi.fn(), onReviewEdit: vi.fn(), onUseReply: vi.fn(), onSaveReply: vi.fn() };
}
function proposal(): ChatEditProposal { return { spaceId: "drafts", noteId: "draft", title: "The river", baseBody: "It was dark.", edits: [{ before: "It was dark.", after: "The river swallowed the last of the light." }] }; }

it("prepares a reply locally, keeping the conversation, composer cursor, and scroll position until explicit review", async () => {
  const p = props(); let resolve!: (value: ChatEditProposal) => void;
  p.onUseReply.mockImplementation((_message, _note, progress) => { progress("Reading the original passage"); return new Promise(done => { resolve = done; }); });
  p.onReviewEdit.mockResolvedValue(false);
  const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
  const { container } = render(<ChatView {...p} />);
  const composer = screen.getByRole("textbox", { name: "Message Orion" }) as HTMLTextAreaElement;
  fireEvent.change(composer, { target: { value: "My next question" } }); composer.focus(); composer.setSelectionRange(3, 7);
  const thread = container.querySelector(".chat-view__thread")!; thread.scrollTop = 67; scroll.mockClear();
  const use = screen.getByRole("button", { name: "Use in note" });
  expect(fireEvent.pointerDown(use, { button: 0 })).toBe(false);
  fireEvent.click(use); fireEvent.click(use);
  expect(p.onUseReply).toHaveBeenCalledOnce(); expect(p.onUseReply).toHaveBeenCalledWith("reply", "draft", expect.any(Function));
  expect(screen.getByRole("status")).toHaveTextContent("Reading the original passage");
  expect(screen.queryByLabelText("Orion is thinking")).not.toBeInTheDocument();
  expect(composer).toHaveValue("My next question"); expect(composer).toHaveFocus(); expect(composer.selectionStart).toBe(3); expect(composer.selectionEnd).toBe(7);
  expect(p.onSend).not.toHaveBeenCalled(); expect(p.onReviewEdit).not.toHaveBeenCalled();
  expect(thread.scrollTop).toBe(67); expect(scroll).not.toHaveBeenCalled();
  await act(async () => resolve(proposal()));
  expect(container.querySelectorAll("article.chat-message")).toHaveLength(2);
  expect(screen.getByText("Can you develop this?")).toBeVisible(); expect(screen.getByText("The river swallowed the last of the light.")).toBeVisible();
  expect(composer).toHaveFocus(); expect(scroll).not.toHaveBeenCalled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Review in note" })));
  expect(p.onReviewEdit).toHaveBeenCalledWith(proposal());
  expect(p.snapshot.notes[0].body).toBe("It was dark.");
  expect(screen.queryByText(/Changes accepted/)).not.toBeInTheDocument();
});

it("retains failures beside the reply and retries the captured note after navigation", async () => {
  const p = props(); p.onUseReply.mockRejectedValueOnce(new Error("Provider timed out")).mockResolvedValueOnce(proposal());
  const { rerender } = render(<ChatView {...p} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Use in note" })));
  expect(screen.getByRole("alert")).toHaveTextContent("Provider timed out");
  const other: Note = { ...p.snapshot.notes[0], id: "another", title: "Another draft" };
  rerender(<ChatView {...p} snapshot={{ ...p.snapshot, notes: [...p.snapshot.notes, other] }} focusNoteId="another" />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry changes" })));
  expect(p.onUseReply).toHaveBeenLastCalledWith("reply", "draft", expect.any(Function));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Review in note" })).toBeVisible();
  expect(p.onSend).not.toHaveBeenCalled();
});

it("shows saving until persistence resolves, then a quiet Saved receipt, with no duplicated activation", async () => {
  const p = props(); let resolve!: (value: ChatNoteReceipt) => void;
  p.onSaveReply.mockImplementation(() => new Promise(done => { resolve = done; }));
  const { rerender } = render(<ChatView {...p} />);
  const keep = screen.getByRole("button", { name: "Keep as note" }); fireEvent.click(keep); fireEvent.click(keep);
  expect(p.onSaveReply).toHaveBeenCalledOnce();
  const optimistic = { ...p.snapshot, notes: [...p.snapshot.notes, { ...p.snapshot.notes[0], id: "kept", title: "Saved answer" }], studio: { ...p.snapshot.studio, messages: p.snapshot.studio.messages.map(message => message.id === "reply" ? { ...message, createdNoteIds: ["kept"] } : message) } };
  rerender(<ChatView {...p} snapshot={optimistic} />);
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Open note: Saved answer" })).not.toBeInTheDocument();
  expect(screen.queryByText("Saved", { exact: true })).not.toBeInTheDocument();
  await act(async () => resolve({ noteId: "kept", title: "Saved answer" }));
  expect(screen.getByRole("status")).toHaveTextContent("Saved");
  expect(screen.getByRole("button", { name: "Open note: Saved answer" })).toBeVisible();
  expect(p.onOpenNote).not.toHaveBeenCalled(); expect(p.onSend).not.toHaveBeenCalled();
});

it("keeps a persistence failure actionable even after the note appears optimistically", async () => {
  const p = props(); p.onSaveReply.mockRejectedValueOnce(new Error("Disk is full")).mockResolvedValueOnce({ noteId: "kept", title: "Saved answer" });
  const { rerender } = render(<ChatView {...p} />);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Keep as note" })));
  rerender(<ChatView {...p} snapshot={{ ...p.snapshot, notes: [...p.snapshot.notes, { ...p.snapshot.notes[0], id: "kept", title: "Saved answer" }], studio: { ...p.snapshot.studio, messages: p.snapshot.studio.messages.map(message => message.id === "reply" ? { ...message, createdNoteIds: ["kept"] } : message) } }} />);
  expect(screen.getByRole("alert")).toHaveTextContent("Disk is full");
  expect(screen.queryByRole("button", { name: "Open note: Saved answer" })).not.toBeInTheDocument();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry save" })));
  expect(p.onSaveReply).toHaveBeenCalledTimes(2); expect(p.onSaveReply).toHaveBeenLastCalledWith("reply");
  expect(screen.getByRole("status")).toHaveTextContent("Saved");
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
