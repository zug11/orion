import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import type { VoiceTurn } from "./voiceConversation";
import { VoiceNoteEdits } from "./voiceNoteEdits";
import { spaceNoteVersion } from "./spaceKnowledge";

const original = "The sentence is long and awkward.";
const replacement = "The sentence now flows.";
const focused: ChatResult = { reply: "Review the proposed changes in your note.", readRequests: [], editIntent: "focused", noteEdits: [{ before: original, after: replacement }] };
const turn: VoiceTurn = { key: 1, prompt: "Rewrite this sentence", delegationId: null, delegated: false, focusNoteId: "draft" };
function fixture(driver = vi.fn(async (_request: ChatRequest, _signal?: AbortSignal): Promise<ChatResult> => focused)) {
  const snapshot = createEmptySnapshot("Writing", "2026-10-12", "space");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "draft", title: "Draft", slug: "draft", body: original, summary: "", tags: [], aliases: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-12", updatedAt: "2026-10-12" }];
  const options = { snapshot: () => snapshot, driver, progress: vi.fn(), proposal: vi.fn(), failed: vi.fn() };
  return { snapshot, options, lane: new VoiceNoteEdits(options), owner: {} };
}

describe("direct voice note edits", () => {
  it("reads the captured note and produces the ordinary unsaved diff without a planning request or note creation", async () => {
    const { snapshot, options, lane, owner } = fixture();
    await lane.run(turn, owner, "We were discussing the rhythm of this sentence.");
    expect(options.driver).toHaveBeenCalledTimes(1);
    const request = options.driver.mock.calls[0][0];
    expect(request).toMatchObject({ prompt: turn.prompt, mode: "chat-reading", editNoteId: "draft", allowNoteActions: false });
    expect(JSON.parse(request.readingContext!).evidence[0]).toMatchObject({ entityId: "draft", text: original });
    expect(options.proposal.mock.calls[0][0].editProposal).toMatchObject({ spaceId: "space", noteId: "draft", baseBody: original, edits: focused.noteEdits });
    expect(snapshot.notes[0].body).toBe(original);
    expect(options.failed).not.toHaveBeenCalled();
    expect(options.progress).toHaveBeenLastCalledWith("");
    await lane.run({ ...turn, delegated: true, delegationId: "late-delegation" }, owner, "");
    expect(options.driver).toHaveBeenCalledTimes(1);
  });

  it("does not settle for a chat-only draft when the current user requested an edit", async () => {
    const driver = vi.fn(async (_request: ChatRequest): Promise<ChatResult> => focused)
      .mockResolvedValueOnce({ reply: "Here is a rewritten sentence without a diff.", readRequests: [], editIntent: "none" });
    const { options, lane, owner } = fixture(driver);
    await lane.run(turn, owner, "");
    expect(driver).toHaveBeenCalledTimes(2);
    expect(options.proposal).toHaveBeenCalledOnce();
    expect(options.failed).not.toHaveBeenCalled();
  });

  it("uses the full-rewrite handshake while preserving review and the original body", async () => {
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => ({ reply: "Review the rewritten note.", readRequests: [], editIntent: "rewrite",
      noteEdits: [], noteRewrite: JSON.parse(request.readingContext!).editTarget?.body ? "A completely revised draft." : "" }));
    const { snapshot, options, lane, owner } = fixture(driver);
    await lane.run({ ...turn, prompt: "Rewrite the whole note" }, owner, "");
    expect(driver).toHaveBeenCalledTimes(2);
    expect(options.proposal.mock.calls[0][0].editProposal).toMatchObject({ mode: "rewrite", noteId: "draft", baseBody: original, rewrite: "A completely revised draft." });
    expect(snapshot.notes[0].body).toBe(original);
  });

  it("rejects missing, cross-Space and stale selected passages before calling the provider", async () => {
    for (const state of ["missing", "space", "stale"]) {
      const { snapshot, options, lane, owner } = fixture();
      const selection = { id: "selected", spaceId: state === "space" ? "other" : "space", noteId: "draft", noteTitle: "Draft",
        version: state === "stale" ? "old" : spaceNoteVersion(snapshot.notes[0]), range: { from: 0, to: original.length, unit: "dom-text-utf16" as const }, text: original, hiddenTaskRanges: [] };
      await lane.run({ ...turn, ...(state === "missing" ? { focusNoteId: undefined } : { selection }) }, owner, "");
      expect(options.driver).not.toHaveBeenCalled(); expect(options.proposal).not.toHaveBeenCalled(); expect(options.failed).toHaveBeenCalledOnce();
    }
  });

  it("keeps the original target during navigation and rejects edits to changed content", async () => {
    for (const modify of [false, true]) {
      let finish!: (result: ChatResult) => void;
      const driver = vi.fn((_request: ChatRequest) => new Promise<ChatResult>(resolve => { finish = resolve; }));
      const { snapshot, options, lane, owner } = fixture(driver);
      const running = lane.run(turn, owner, "");
      await vi.waitFor(() => expect(finish).toBeDefined());
      if (modify) snapshot.notes[0].body = "The author kept typing.";
      else snapshot.activeNoteId = "another-note";
      finish(focused); await running;
      expect(options.proposal).toHaveBeenCalledTimes(modify ? 0 : 1);
      expect(options.failed).toHaveBeenCalledTimes(modify ? 1 : 0);
    }
  });

  it("cancels only pending editing and ignores a late reply after cancellation or Space teardown", async () => {
    let finish!: (result: ChatResult) => void;
    const driver = vi.fn((_request: ChatRequest, _signal?: AbortSignal) => new Promise<ChatResult>(resolve => { finish = resolve; }));
    const { options, lane, owner } = fixture(driver);
    const running = lane.run(turn, owner, "");
    await vi.waitFor(() => expect(finish).toBeDefined());
    lane.dispose(); expect(driver.mock.calls[0][1]?.aborted).toBe(true);
    finish(focused); await running;
    expect(options.proposal).not.toHaveBeenCalled(); expect(options.failed).not.toHaveBeenCalled();
  });
});
