import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { VoiceResearch, type VoiceResearchAssignment } from "./voiceResearch";

const scope: VoiceResearchAssignment = { subject: "Connection", focus: "Understand the connection in the note." };
function fixture() {
  const snapshot = createEmptySnapshot("Worker conversations", "2026-10-11", "space");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "n", title: "Connection", slug: "n", body: "Alpha relates to beta. " + "Supporting prose. ".repeat(100) + "\n\n- [x] PRIVATE HISTORY",
    summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-11", updatedAt: "2026-10-11" }];
  return snapshot;
}
const previousAnswer = (request: ChatRequest) => request.history.find(item => item.content.startsWith('{"type":"completed_worker_reference"'))?.content;
function reader(request: ChatRequest, reply: string): ChatResult {
  const context = JSON.parse(request.readingContext!);
  return context.evidence.length ? { reply: `${reply} [[${context.evidence[0].id}]].` }
    : { reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] };
}
function setup(driver: (request: ChatRequest) => Promise<ChatResult>) {
  const snapshot = fixture(), commit = vi.fn(async () => ({ savedNoteIds: ["saved"], savedTitles: ["Retained finding"] })), deliver = vi.fn();
  const engine = new VoiceResearch({ snapshot: () => snapshot, driver, commit, deliver, onProgress: vi.fn(), onResult: vi.fn() });
  return { snapshot, engine, commit, deliver };
}

describe("finished worker conversation references", () => {
  it("retains the older worker's final conclusion for a continuation beyond the recent-job summary window", async () => {
    const original = "Beginning of the interpretation. " + "Middle qualification. ".repeat(130) + "FINAL DISTINCT CONCLUSION.";
    const calls: ChatRequest[] = [];
    const f = setup(async request => { calls.push(request); return reader(request, request.prompt === "Research alpha" ? original : "A later answer"); });
    await f.engine.run("original", "Research alpha", "", "n", null, false, undefined, scope);
    const finalReply = f.engine.getJobs()[0].result!.reply;
    for (let i = 0; i < 4; i++) await f.engine.run(`sibling-${i}`, `Research sibling ${i}`, "", "n", null, false, undefined, scope);
    expect(f.engine.context()).not.toContain("FINAL DISTINCT CONCLUSION");
    const before = calls.length;
    await f.engine.run("original", "Follow that distinction", f.engine.context(), "n");
    expect(calls).toHaveLength(before + 1); // The exact read checkpoint is reused.
    const reference = JSON.parse(previousAnswer(calls[before])!);
    expect(reference).toMatchObject({ id: "original", revision: 1, referenceOnly: true, answer: { complete: false } });
    expect(reference.answer.omittedChars).toBeGreaterThan(0);
    expect(reference.answer.fragments.map((part: { text: string }) => part.text).join(" ")).toContain("FINAL DISTINCT CONCLUSION");
    for (const part of reference.answer.fragments) expect(finalReply.slice(part.from, part.to)).toBe(part.text);
    expect(reference.sources[0]).toMatchObject({ entityId: "n", kind: "note", title: "Connection" });
    expect(calls[before]).toMatchObject({ prompt: "Follow that distinction", allowNoteActions: false });
    expect(calls[before].editNoteId).toBeUndefined();
    expect(f.commit).not.toHaveBeenCalled();
  });

  it("keeps the same final answer across a failed continuation and explicit retry without borrowing another worker's result", async () => {
    let fail = true;
    const calls: ChatRequest[] = [];
    const f = setup(async request => {
      calls.push(request);
      if (request.prompt === "Follow that distinction" && fail) throw new Error("Temporary failure");
      return reader(request, request.prompt === "Research alpha" ? "Original completed conclusion" : "Independent sibling conclusion");
    });
    await f.engine.run("original", "Research alpha", "", "n", null, false, undefined, scope);
    await f.engine.run("sibling", "Research beta", "", "n", null, false, undefined, scope);
    await f.engine.run("original", "Follow that distinction", "", "n");
    expect(f.engine.getJobs()[0]).toMatchObject({ state: "failed", revision: 2 });
    const failedPacket = previousAnswer(calls[calls.length - 1]);
    expect(failedPacket).toContain("Original completed conclusion");
    expect(failedPacket).not.toContain("Independent sibling conclusion");
    fail = false;
    await f.engine.retry("original", "Other ongoing conversation");
    expect(previousAnswer(calls[calls.length - 1])).toBe(failedPacket);
    expect(f.engine.getJobs().map(job => [job.id, job.state, job.revision])).toEqual([["original", "completed", 3], ["sibling", "completed", 1]]);
  });

  it("admits a fresh continuation after Keep while preserving its earlier receipt and rejecting old turn replay", async () => {
    const driver = vi.fn(async (request: ChatRequest) => reader(request, "A current finding"));
    const f = setup(driver);
    await f.engine.run("original", "Research alpha", "", "n", null, false, undefined, scope);
    await f.engine.run("original", "Follow that distinction", "", "n");
    await f.engine.keep("original");
    expect(f.commit).toHaveBeenCalledOnce();
    const admission = { expectedRevision: 2 }, before = driver.mock.calls.length;
    await f.engine.run("original", "Follow that distinction", "New user turn", "n", null, false, undefined, undefined, admission);
    expect(driver).toHaveBeenCalledTimes(before + 1);
    expect(f.engine.getJobs()[0]).toMatchObject({ revision: 3, state: "completed" });
    expect(f.engine.getReceipts()[0]).toMatchObject({ id: "original", revision: 2, receipt: { savedNoteIds: ["saved"] } });
    await f.engine.run("original", "Follow that distinction", "Late old turn", "n", null, false, undefined, undefined, admission);
    expect(driver).toHaveBeenCalledTimes(before + 1);
    await expect(f.engine.keep("original")).rejects.toThrow("earlier revision");
    expect(f.commit).toHaveBeenCalledOnce();
  });

  it.each(["evidence", "settings", "scope", "history", "selection"] as const)("drops an obsolete completed answer when %s changes", async change => {
    const calls: ChatRequest[] = [];
    const f = setup(async request => { calls.push(request); return reader(request, "Old completed answer"); });
    const initial = change === "history" ? "Research completed task history" : "Research alpha";
    await f.engine.run("original", initial, "", "n", null, false, undefined, scope);
    if (change === "evidence") f.snapshot.notes[0].body += " New evidence.";
    if (change === "settings") f.snapshot.settings.model = "another-model";
    const before = calls.length;
    await f.engine.run("original", "Follow that distinction", "", "n", null, false,
      change === "selection" ? { id: "new-selection", noteId: "n", spaceId: "space", noteTitle: "Connection", version: "stale",
        text: "New selected text", range: { from: 0, to: 17, unit: "dom-text-utf16" }, hiddenTaskRanges: [] } : undefined,
      change === "scope" ? { ...scope, focus: "Investigate a different direction." } : undefined);
    for (const request of calls.slice(before)) {
      expect(previousAnswer(request)).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain("PRIVATE HISTORY");
    }
    if (change === "selection") expect(f.engine.getJobs()[0].state).toBe("failed");
  });

  it("labels incomplete conversation handoff evidence and preserves the exact paired commentary reference", async () => {
    const calls: ChatRequest[] = [];
    const f = setup(async request => { calls.push(request); return reader(request, "😀".repeat(2_000) + " Ending caveat"); });
    await f.engine.run("original", "Research alpha", "", "n", null, false, undefined, scope);
    const contextText = f.engine.conversationContext("original")!;
    const context = JSON.parse(contextText);
    expect(new TextEncoder().encode(contextText).length).toBeLessThanOrEqual(9_000);
    expect(context).toMatchObject({ resultComplete: false, evidenceComplete: false, coverage: expect.any(Object) });
    expect(context.resultOmittedChars).toBeGreaterThan(0);
    expect(context.evidence[0]).toMatchObject({ complete: false, originalEnd: expect.any(Number) });
    expect(context.evidence[0].end).toBe(context.evidence[0].start + context.evidence[0].text.length);
    const commentary = f.deliver.mock.calls.filter(call => call[0] === "commentary").pop()!;
    const paired = JSON.parse(commentary[3].reference);
    expect(paired).toMatchObject({ id: "original", revision: 1, sequence: commentary[3].sequence, stage: "complete" });
    await f.engine.run("original", "Follow that distinction", "", "n");
    const reference = previousAnswer(calls[calls.length - 1])!;
    expect(new TextEncoder().encode(reference).length).toBeLessThanOrEqual(3_000);
    const retained = JSON.parse(reference);
    expect(retained.answer.fragments.map((part: { text: string }) => part.text).join(" ")).toContain("Ending caveat");
    expect(reference).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});
