import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatReadRequest, ChatRequest, ChatResult, Note } from "../types";
import { runChatReading } from "./chatReading";
import type { ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import { MAX_CHAT_READING_CONTEXT_BYTES, parseChatReadingFinding } from "./chatReadingProtocol";
import { VoiceResearch, type VoiceResearchOptions } from "./voiceResearch";

function fixture() {
  const snapshot = createEmptySnapshot("Investigation", "2026-10-11", "investigation");
  const note = (id: string, body: string): Note => ({ id, title: id, slug: id, body, summary: "", aliases: [], tags: [],
    sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-11", updatedAt: "2026-10-11" });
  snapshot.notes = [note("alpha", "Alpha has a cost of three."), note("beta", "Beta has a cost of four.")];
  snapshot.settings.apiKeyConfigured = true;
  return snapshot;
}
const read = (id: string): ChatReadRequest => ({ kind: "note-full", id, query: "", start: null });
const update = { finding: "The draft puts Alpha's cost at three [[e1]].", decisions: ["Compare the stated costs, rather than assume they are equal."], openQuestions: ["What is Beta's cost?"] };
const result = { reply: "Alpha costs three; Beta costs four [[e1]] [[e2]].", readRequests: [] };
const packet = (request: ChatRequest) => JSON.parse(request.readingContext!);

function config(driver: VoiceResearchOptions["driver"]) {
  const snapshot = fixture();
  return { snapshot: () => snapshot, driver, commit: vi.fn(async () => ({ savedNoteIds: ["saved"], savedTitles: ["Comparison"] })),
    deliver: vi.fn(), onResult: vi.fn(), onProgress: vi.fn(), onJobs: vi.fn() };
}

describe("incremental reader checkpoints", () => {
  it("publishes a supported finding while another model invocation is pending, without committing the reading payload", async () => {
    let finish!: (value: ChatResult) => void;
    const settings = config(async request => {
      const context = packet(request);
      if (!context.evidence.length) return { reply: "", readRequests: [read("alpha")] };
      if (context.evidence.length === 1) return { reply: "Premature answer must never publish", checkpoint: update, readRequests: [read("beta")],
        noteActions: [{ title: "Do not save", body: "Premature write", summary: "", aliases: [], tags: [] }] };
      expect(context.workerContinuity.decisions).toEqual(update.decisions);
      expect(context.workerContinuity.openQuestions).toEqual(update.openQuestions);
      expect(context.workerContinuity.completedOperations.map((step: { request: ChatReadRequest }) => step.request.kind)).toEqual(["search", "note-full", "note-full"]);
      expect(context.workerContinuity.pendingReads).toEqual([]);
      return new Promise(resolve => { finish = resolve; });
    });
    const engine = new VoiceResearch(settings);
    const pending = engine.run("comparison", "Compare alpha and beta", "", "alpha");
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(engine.getJobs()[0]).toMatchObject({ state: "running", updates: [{ reply: expect.stringContaining("Alpha's cost"), evidence: [{ entityId: "alpha", text: "Alpha has a cost of three." }] }] });
    expect(settings.onResult).not.toHaveBeenCalled(); expect(settings.commit).not.toHaveBeenCalled();
    expect(settings.deliver.mock.calls.filter(call => call[0] === "commentary")).toHaveLength(1);
    expect(settings.deliver.mock.calls[settings.deliver.mock.calls.length - 1]?.[1]).toContain("The draft puts Alpha's cost at three");
    expect(settings.deliver.mock.calls[settings.deliver.mock.calls.length - 1]?.[1]).not.toContain("research is still running");
    const quiet = settings.deliver.mock.calls.find(call => call[0] === "thinking" && call[1].includes('"type":"worker_finding"'));
    expect(JSON.parse(quiet![1])).toMatchObject({ id: "comparison", revision: 1, sequence: 1, state: "running", referenceOnly: true });
    expect(settings.deliver.mock.calls.filter(call => call[0] === "commentary")[0][3]).toEqual({ id: "comparison", revision: 1, sequence: 1, reference: quiet![1] });
    engine.announceFinding("comparison");
    expect(settings.deliver).toHaveBeenLastCalledWith("commentary", expect.stringContaining("The draft puts Alpha's cost at three"), null, { id: "comparison", revision: 1, sequence: 2, reference: expect.any(String) });
    const repeated = settings.deliver.mock.calls.filter(call => call[0] === "thinking" && call[1].startsWith('{"type":"worker_finding"')).slice(-1)[0];
    expect(JSON.parse(repeated![1])).toMatchObject({ id: "comparison", revision: 1, sequence: 2, stage: "intermediate", state: "running" });
    expect(engine.conversationContext("comparison")).toBeUndefined();
    finish(result); await pending;
    expect(engine.getJobs()[0].state).toBe("completed");
    const completed = JSON.parse(engine.conversationContext("comparison")!);
    expect(completed.evidence).toHaveLength(2);
    expect(completed.decisions).toEqual(update.decisions);
    expect(settings.onResult).toHaveBeenCalledOnce(); expect(settings.commit).not.toHaveBeenCalled();
  });

  it("corrects a work order from its exact completed read boundary, and ignores a late obsolete checkpoint and save", async () => {
    let obsolete!: (value: ChatResult) => void;
    let resumed: ChatRequest | undefined;
    const settings = config(async request => {
      const context = packet(request);
      if (request.prompt.startsWith("Actually")) { resumed = request; return result; }
      if (!context.evidence.length) return { reply: "", readRequests: [read("alpha")] };
      if (context.evidence.length === 1) return { reply: "", checkpoint: update, readRequests: [read("beta")] };
      return new Promise(resolve => { obsolete = resolve; });
    });
    const engine = new VoiceResearch(settings);
    const first = engine.run("same-worker", "Save a note comparing alpha and beta", "", "alpha");
    await vi.waitFor(() => expect(obsolete).toBeDefined());
    await engine.run("same-worker", "Actually compare the costs without saving", "", "alpha");
    expect(resumed).toBeDefined();
    expect(resumed!.allowNoteActions).toBe(false);
    expect(packet(resumed!).evidence.map((item: { entityId: string }) => item.entityId)).toEqual(["alpha", "beta"]);
    expect(packet(resumed!).workerContinuity.decisions).toEqual(update.decisions);
    expect(packet(resumed!).workerContinuity.findings).toHaveLength(1);
    expect(packet(resumed!).workerContinuity.completedOperations.filter((step: { request: ChatReadRequest }) => step.request.kind === "note-full")).toHaveLength(2);
    obsolete({ reply: "", checkpoint: { ...update, finding: "Late old finding [[e1]]." }, readRequests: [read("alpha")],
      noteActions: [{ title: "Obsolete", body: "Do not save", summary: "", aliases: [], tags: [] }] });
    await first;
    expect(settings.commit).not.toHaveBeenCalled();
    expect(settings.onResult).toHaveBeenCalledOnce();
    expect(settings.deliver.mock.calls.every(call => !call[1].includes("Late old finding"))).toBe(true);
    expect(engine.getJobs()[0]).toMatchObject({ revision: 2, state: "completed" });
  });

  it("suppresses duplicate findings across continued reads and a corrected revision", async () => {
    let old!: (result: ChatResult) => void;
    let count = 0;
    const settings = config(async request => {
      const context = packet(request);
      if (request.prompt === "Continue with more detail") {
        if (count++ === 0) return { reply: "", checkpoint: update, readRequests: [{ kind: "related", id: "alpha", query: "", start: 0 }] };
        return result;
      }
      if (!context.evidence.length) return { reply: "", readRequests: [read("alpha")] };
      if (context.evidence.length === 1) return { reply: "", checkpoint: update, readRequests: [read("beta")] };
      return new Promise(resolve => { old = resolve; });
    });
    const engine = new VoiceResearch(settings);
    const first = engine.run("worker", "Compare alpha and beta", "");
    await vi.waitFor(() => expect(old).toBeDefined());
    await engine.run("worker", "Continue with more detail", "");
    old(result); await first;
    const updates = settings.deliver.mock.calls.filter(call => call[0] === "thinking" && call[1].startsWith('{"type":"worker_finding"'))
      .map(call => JSON.parse(call[1])).filter(item => item.stage === "intermediate");
    expect(updates).toHaveLength(1);
  });

  it("rejects unsupported checkpoint prose and unknown citations while preserving the ordinary final response path", async () => {
    for (const finding of ["Reading some more material.", "A fabricated finding [[e99]]."]) {
      let turn = 0;
      const checkpoint = vi.fn();
      await runChatReading(fixture(), "Compare alpha", async request => {
        const context = packet(request);
        if (turn++ === 0) return { reply: "", readRequests: [read("alpha")] };
        if (turn === 2) return { reply: "", checkpoint: { ...update, finding }, readRequests: [read("beta")] };
        expect(context.correction).toMatch(/supporting citations|outside the current evidence/);
        return { reply: "The cost is three [[e1]]." };
      }, { onCheckpoint: checkpoint });
      expect(checkpoint.mock.calls.every(call => !call[1])).toBe(true);
    }
  });

  it("drops changed evidence and its public decisions on resume, then allows a fresh exact read", async () => {
    const snapshot = fixture();
    let saved!: ChatReadingCheckpoint;
    let turn = 0;
    await runChatReading(snapshot, "Compare alpha", async () => {
      if (turn++ === 0) return { reply: "", readRequests: [read("alpha")] };
      if (turn === 2) return { reply: "", checkpoint: update, readRequests: [read("beta")] };
      return result;
    }, { onCheckpoint: checkpoint => { saved = checkpoint; } });
    snapshot.notes[0].body = "Alpha now costs ten.";
    let calls = 0;
    await runChatReading(snapshot, "Recheck alpha", async request => {
      const context = packet(request);
      if (calls++ === 0) {
        expect(context.evidence.map((item: { entityId: string }) => item.entityId)).toEqual(["beta"]);
        expect(context.workerContinuity.findings).toEqual([]);
        expect(context.workerContinuity.decisions).toEqual([]);
        return { reply: "", readRequests: [read("alpha")] };
      }
      const fresh = context.evidence.find((item: { entityId: string }) => item.entityId === "alpha");
      expect(fresh.text).toBe("Alpha now costs ten.");
      return { reply: `The cost changed [[${fresh.id}]].` };
    }, { resume: saved, onCheckpoint: () => undefined });
    expect(calls).toBe(2);
  });

  it("bounds public checkpoint fields and never carries another Space's worker state", async () => {
    expect(() => parseChatReadingFinding({ ...update, finding: "x".repeat(1_201) })).toThrow();
    expect(() => parseChatReadingFinding({ ...update, privateReasoning: "Do not accept" })).toThrow();
    let saved!: ChatReadingCheckpoint;
    await runChatReading(fixture(), "Read alpha", async request => packet(request).evidence.length
      ? { reply: "The cost is three [[e1]]." } : { reply: "", readRequests: [read("alpha")] }, { onCheckpoint: checkpoint => { saved = checkpoint; } });
    const other = fixture(); other.workspace.id = "other";
    await runChatReading(other, "Hello", async request => {
      expect(packet(request).evidence).toEqual([]);
      expect(packet(request).workerContinuity.findings).toEqual([]);
      expect(new TextEncoder().encode(request.readingContext).length).toBeLessThanOrEqual(MAX_CHAT_READING_CONTEXT_BYTES);
      return { reply: "Hello." };
    }, { resume: saved, onCheckpoint: () => undefined });
  });

  it("retries a failed invocation explicitly from retained evidence without allowing duplicate delegation replay", async () => {
    let fail = true;
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      if (!packet(request).evidence.length) return { reply: "", readRequests: [read("alpha")] };
      if (fail) throw new Error("Temporary provider failure");
      return { reply: "The draft says three [[e1]]." };
    });
    const settings = config(driver); const engine = new VoiceResearch(settings);
    await engine.run("retry", "Read alpha", "");
    expect(engine.getJobs()[0].state).toBe("failed");
    await engine.run("retry", "Read alpha", "A replay is not an explicit retry");
    expect(driver).toHaveBeenCalledTimes(2);
    fail = false;
    await engine.retry("retry", "");
    expect(driver).toHaveBeenCalledTimes(3);
    expect(packet(driver.mock.calls[2][0]).evidence[0].text).toBe("Alpha has a cost of three.");
    expect(engine.getJobs()[0]).toMatchObject({ state: "completed", revision: 2 });
    expect(settings.commit).not.toHaveBeenCalled();
  });
  it("keeps cancelled research inert until explicit retry, then resumes its completed checkpoint without repeating reads", async () => {
    let finishOld!: (value: ChatResult) => void, retrying = false;
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const context = packet(request);
      if (retrying) {
        expect(context.evidence.map((item: { entityId: string }) => item.entityId)).toEqual(["alpha", "beta"]);
        expect(context.workerContinuity.decisions).toEqual(update.decisions);
        expect(context.workerContinuity.findings).toHaveLength(1);
        return result;
      }
      if (!context.evidence.length) return { reply: "", readRequests: [read("alpha")] };
      if (context.evidence.length === 1) return { reply: "", checkpoint: update, readRequests: [read("beta")] };
      return new Promise(resolve => { finishOld = resolve; });
    });
    const settings = config(driver), engine = new VoiceResearch(settings);
    const pending = engine.run("cancel-retry", "Compare alpha and beta", "");
    await vi.waitFor(() => expect(finishOld).toBeDefined());
    engine.cancel("cancel-retry"); finishOld(result); await pending;
    expect(engine.getJobs()[0]).toMatchObject({ state: "cancelled", revision: 1 });
    expect(settings.onResult).not.toHaveBeenCalled(); const calls = driver.mock.calls.length;
    await engine.run("cancel-retry", "Compare alpha and beta", "Unchanged replay");
    expect(driver).toHaveBeenCalledTimes(calls); expect(engine.getJobs()[0].state).toBe("cancelled");
    retrying = true; await engine.retry("cancel-retry", "Explicitly continue the cancelled investigation");
    expect(driver).toHaveBeenCalledTimes(calls + 1);
    expect(engine.getJobs()[0]).toMatchObject({ state: "completed", revision: 2 });
    expect(settings.onResult).toHaveBeenCalledOnce(); expect(settings.commit).not.toHaveBeenCalled();
  });
});
