import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { VoiceWorkOrder } from "./voiceResearch";
import { VoiceContextUpdates } from "./voiceContextUpdates";

function fixture() {
  const snapshot = createEmptySnapshot("Space", "2026-10-09", "space");
  snapshot.notes = ["one", "two"].map(id => ({ id, title: id, slug: id, body: `Exact ${id} passage.`,
    summary: "", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [],
    createdAt: "2026-10-09", updatedAt: "2026-10-09" }));
  return { snapshot, focusNoteId: "one", jobs: [] as VoiceWorkOrder[], conversation: "user: Read this" };
}
const job = (id = "a", changes: Partial<VoiceWorkOrder> = {}): VoiceWorkOrder => ({ id, revision: 1,
  subject: "Research alpha", prompt: "Research alpha", state: "running", progress: "Researching", ...changes });
const packets = (send: ReturnType<typeof vi.fn<(text: string) => boolean>>) => send.mock.calls.map(([text]) => JSON.parse(text));

describe("incremental voice context", () => {
  it("sends a quiet capability delta when the Perplexity key changes without repeating the note", () => {
    const input = fixture(), updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    input.snapshot.settings.perplexityApiKeyConfigured = true;
    expect(updates.update(input, send)).toBe(1);
    expect(packets(send)[0]).toMatchObject({ type: "capability_update", webResearchAvailable: true, referenceOnly: true });
    expect(JSON.stringify(packets(send)[0])).not.toContain("Exact one passage");
    expect(updates.update(input, send)).toBe(0);
    input.snapshot.settings.perplexityApiKeyConfigured = false;
    expect(updates.update(input, send)).toBe(1);
  });
  it("does not repeat initial context for body edits, renamed notes, directory or conversation changes", () => {
    const input = fixture(); input.jobs = [job()];
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    expect(updates.update(input, send)).toBe(0);
    input.snapshot.notes[0].body += " New writing.";
    input.snapshot.notes[0].title = "Renamed";
    input.snapshot.notes.push({ ...input.snapshot.notes[1], id: "three" });
    input.conversation += "\nassistant: Good point";
    expect(updates.update(input, send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends only the changed note context, then clears it when that note is deleted", () => {
    const input = fixture(); const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    input.focusNoteId = "two"; updates.update(input, send);
    const change = packets(send)[0];
    expect(change).toMatchObject({ type: "navigation_update", currentNote: { id: "two" } });
    expect(JSON.stringify(change)).toContain("Exact two passage.");
    expect(change).not.toHaveProperty("noteDirectory");
    expect(change).not.toHaveProperty("recentChat");
    input.snapshot.notes = input.snapshot.notes.filter(note => note.id !== "two");
    updates.update(input, send);
    expect(packets(send)[1].currentNote).toBeNull();
    updates.update(input, send); expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends metadata during pressure and never backfills excerpts on a ratio drop", () => {
    const input = fixture(); const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    input.focusNoteId = "two";
    updates.update({ ...input, usageRatio: 0.8 }, send);
    expect(packets(send)[0].currentNote).toMatchObject({ id: "two", passages: [], excerptsOmitted: true });
    expect(JSON.stringify(packets(send))).not.toContain("Exact two passage.");
    updates.update({ ...input, usageRatio: 0.2 }, send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("retains the last valid pressure ratio across ordinary updates and resets it for a new connection", () => {
    const input = fixture(); input.jobs = [job()];
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    updates.update({ ...input, usageRatio: 0.82 }, send);
    input.focusNoteId = "two"; input.jobs[0].progress = "Checking another passage";
    updates.update(input, send);
    expect(packets(send)).toHaveLength(1);
    expect(packets(send)[0].currentNote).toMatchObject({ id: "two", passages: [], excerptsOmitted: true });
    updates.update({ ...input, usageRatio: NaN }, send); expect(send).toHaveBeenCalledOnce();
    updates.reset(input); input.focusNoteId = "one"; updates.update(input, send);
    expect(packets(send)[1].currentNote.passages[0].text).toContain("Exact one passage.");
  });

  it("retries failed appends and records only fields that were successfully sent", () => {
    const input = fixture(); const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => false);
    input.focusNoteId = "two"; input.jobs = [job()];
    updates.update(input, send); expect(send).toHaveBeenCalledTimes(2);
    send.mockReturnValue(true); updates.update(input, send);
    expect(packets(send)[2]).toEqual(packets(send)[0]);
    expect(packets(send)[3]).toEqual(packets(send)[1]);
    updates.update(input, send); expect(send).toHaveBeenCalledTimes(4);
  });

  it("sends first-job metadata and only changed fields thereafter, with no finding bodies", () => {
    const input = fixture(); const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    input.jobs = [job("a", { focusNoteId: "one" })]; updates.update(input, send);
    expect(packets(send)[0].jobs[0]).toMatchObject({ id: "a", revision: 1, subject: "Research alpha",
      prompt: "Research alpha", focusNoteId: "one" });
    updates.update(input, send); expect(send).toHaveBeenCalledOnce();
    input.jobs[0].progress = "Checking exact passages"; updates.update(input, send);
    expect(packets(send)[1].jobs).toEqual([{ id: "a", revision: 1, progress: "Checking exact passages" }]);
    input.jobs[0].state = "completed"; input.jobs[0].result = { reply: "Private completed finding" };
    updates.update(input, send);
    expect(packets(send)[2].jobs).toEqual([{ id: "a", revision: 1, state: "completed" }]);
    expect(JSON.stringify(packets(send))).not.toContain("Private completed finding");
  });

  it("suppresses progress under pressure while preserving revisions, cancellation and receipts", () => {
    const input = fixture(); input.jobs = [job()];
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    input.jobs[0].progress = "Still reading";
    updates.update({ ...input, usageRatio: 0.82 }, send); expect(send).not.toHaveBeenCalled();
    input.jobs[0].revision = 2; input.jobs[0].state = "cancelled";
    input.jobs[0].receipt = { savedNoteIds: ["saved"], savedTitles: ["Alpha"] };
    updates.update({ ...input, usageRatio: 0.82 }, send);
    expect(packets(send)[0].jobs).toEqual([{ id: "a", revision: 2, state: "cancelled",
      receipt: { savedNoteIds: ["saved"], savedTitles: ["Alpha"] } }]);
    updates.update({ ...input, usageRatio: 0.82 }, send); expect(send).toHaveBeenCalledOnce();
    updates.update({ ...input, usageRatio: 0.7 }, send);
    expect(packets(send)[1].jobs).toEqual([{ id: "a", revision: 2, progress: "Still reading" }]);
  });

  it("sends one bounded checkpoint per pressure episode and rearms only below .75", () => {
    const input = fixture();
    input.jobs = [job("active"), job("finished", { state: "completed", result: { reply: "Confirmed finding" },
      receipt: { savedNoteIds: ["saved"], savedTitles: ["Saved finding"] } })];
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true);
    updates.update({ ...input, usageRatio: 0.85 }, send);
    expect(packets(send)[0]).toMatchObject({ type: "conversation_checkpoint", spaceId: "space", currentNoteId: "one",
      activeJobs: [{ id: "active", revision: 1, prompt: "Research alpha" }],
      recentJobs: [{ id: "finished", finding: "Confirmed finding" }],
      confirmedReceipts: [{ id: "finished", savedNoteIds: ["saved"] }] });
    expect(JSON.stringify(packets(send))).not.toContain("Exact one passage.");
    for (const usageRatio of [0.9, 0.75, 0.84, 0.86]) updates.update({ ...input, usageRatio }, send);
    expect(send).toHaveBeenCalledOnce();
    updates.update({ ...input, usageRatio: 0.74 }, send);
    updates.update({ ...input, usageRatio: 0.85 }, send); expect(send).toHaveBeenCalledTimes(2);
  });

  it("does not consume a checkpoint episode on failed delivery and ignores invalid ratio values", () => {
    const input = fixture(); const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => false);
    for (const usageRatio of [NaN, Infinity, -1, 1.1]) updates.update({ ...input, usageRatio }, send);
    expect(send).not.toHaveBeenCalled();
    updates.update({ ...input, usageRatio: 0.85 }, send);
    send.mockReturnValue(true); updates.update({ ...input, usageRatio: 0.85 }, send);
    updates.update({ ...input, usageRatio: 0.9 }, send); expect(send).toHaveBeenCalledTimes(2);
    updates.reset(input); updates.update({ ...input, usageRatio: 0.85 }, send); expect(send).toHaveBeenCalledTimes(3);
  });

  it("keeps quoted decisions in the checkpoint even after a long conversation tail", () => {
    const input = fixture(); input.conversation = "Recorded user decisions/corrections (quoted context):\nI prefer the 2024 figures.\nUse the climate findings.\nuser: " + "Later discussion. ".repeat(400);
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true); updates.update({ ...input, usageRatio: 0.85 }, send);
    const checkpoint = packets(send)[0];
    expect(checkpoint.quotedDecisions).toBe("I prefer the 2024 figures.\nUse the climate findings.");
    expect(checkpoint.quotedConversation).toContain("Later discussion.");
    expect(checkpoint.quotedDecisions.length + checkpoint.quotedConversation.length).toBeLessThanOrEqual(1_600);
  });

  it("publishes a confirmed superseded receipt once and carries it into the checkpoint", () => {
    const input = fixture(); input.jobs = [job("a", { revision: 2, state: "failed" })];
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const receipts = [{ id: "a", revision: 1, prompt: "Save alpha as a note", receipt: { savedNoteIds: ["saved"], savedTitles: ["Alpha"] } }];
    const send = vi.fn((_text: string) => false);
    updates.update({ ...input, receipts }, send);
    send.mockReturnValue(true); updates.update({ ...input, receipts }, send);
    expect(packets(send)[1]).toMatchObject({ type: "confirmed_receipt_update", receipts: [{ id: "a", revision: 1, savedNoteIds: ["saved"] }] });
    updates.update({ ...input, receipts }, send); expect(send).toHaveBeenCalledTimes(2);
    updates.update({ ...input, receipts, usageRatio: 0.85 }, send);
    expect(packets(send)[2].confirmedReceipts).toEqual([{ id: "a", revision: 1, savedNoteIds: ["saved"], savedTitles: ["Alpha"] }]);
    updates.reset({ ...input, receipts }); updates.update({ ...input, receipts }, send);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("bounds escaped multilingual checkpoint text to 6000 UTF-8 bytes without rewriting IDs", () => {
    const input = fixture(); input.conversation = '漢🧭\\"'.repeat(2_000);
    input.jobs = Array.from({ length: 24 }, (_, i) => job(`original-job-${i}`, {
      prompt: '漢🧭\\"'.repeat(300), state: i < 6 ? "running" : "completed",
      result: { reply: '漢🧭\\"'.repeat(300) }, receipt: { savedNoteIds: [`saved-${i}`], savedTitles: ["漢".repeat(500)] },
    }));
    const updates = new VoiceContextUpdates(); updates.reset(input);
    const send = vi.fn((_text: string) => true); updates.update({ ...input, usageRatio: 0.9 }, send);
    expect(new TextEncoder().encode(send.mock.calls[0][0]).length).toBeLessThanOrEqual(6_000);
    const checkpoint = packets(send)[0];
    expect(checkpoint.quotedConversation.length).toBeLessThanOrEqual(1_600);
    expect(checkpoint.activeJobs.map((item: { id: string }) => item.id)).toEqual(input.jobs.slice(0, 6).map(item => item.id));
    expect(JSON.stringify(checkpoint)).not.toContain("Exact one passage.");
  });
});
