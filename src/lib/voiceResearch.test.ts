import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { VoiceResearch, voiceContext, type VoiceCommit, type VoiceResearchAssignment } from "./voiceResearch";
import { runChatReading } from "./chatReading";
import { stableSnapshotVersion } from "./knowledgeOrchestration/context";
import { spaceNoteVersion } from "./spaceKnowledge";
import type { VoiceSelection } from "./voiceSelection";
function fixture() {
  const snapshot = createEmptySnapshot("Private Space", "2026-10-09", "a");
  snapshot.settings.apiKeyConfigured = true;
  snapshot.notes = [{ id: "n", title: "Connection", slug: "n", body: "Alpha relates to beta.\n\n- [x] hidden finished action\n- [ ] Verify connection", summary: "", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-09", updatedAt: "2026-10-09" }];
  return snapshot;
}
function options(driver: (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>) {
  const snapshot = fixture();
  return { snapshot: () => snapshot, driver, onProgress: vi.fn(), onResult: vi.fn(), deliver: vi.fn(), commit: vi.fn(async (_: VoiceCommit) => ({ savedNoteIds: ["saved"], savedTitles: ["Connection"] })) };
}
function findingMetadata(config: ReturnType<typeof options>) {
  return config.deliver.mock.calls.filter(call => call[0] === "thinking" && call[1].startsWith('{"type":"worker_finding"')).map(call => JSON.parse(call[1]));
}
function exactAnswer(request: ChatRequest): ChatResult {
  const packet = JSON.parse(request.readingContext!);
  return packet.evidence.length ? { reply: `Alpha relates to beta [[${packet.evidence[0].id}]].`, readRequests: [] }
    : { reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] };
}
const writeResult = { reply: "The note is ready.", noteActions: [{ title: "Connection", body: "Alpha relates to beta.", summary: "", tags: [], aliases: [] }] };

function childScope(request: ChatRequest): VoiceResearchAssignment {
  const line = request.history[0].content.split("\n")[0];
  return JSON.parse(line.slice("Read-only child research scope: ".length));
}

describe("parallel voice research scopes", () => {
  it("lets the reading model name its assignment without changing its identity, scope or user authority", async () => {
    const config = options(async request => {
      const result = exactAnswer(request);
      return { ...result, voice: { label: "The alpha and beta connection", summary: result.readRequests?.length ? "" : "Alpha relates to beta [[e1]]." } };
    });
    const engine = new VoiceResearch(config), prompt = "Um, could you investigate that relationship";
    await engine.run("stable-worker", prompt, "", "n");
    expect(engine.getJobs()[0]).toMatchObject({ id: "stable-worker", revision: 1, prompt,
      subject: "The alpha and beta connection", state: "completed" });
    expect(config.commit).not.toHaveBeenCalled();
    expect(config.deliver).toHaveBeenLastCalledWith("commentary", expect.stringContaining("Alpha relates to beta"), null,
      expect.objectContaining({ id: "stable-worker", revision: 1, completion: true }));
  });
  it("runs ten exact note partitions simultaneously through the shared reader", async () => {
    const config = options(async request => {
      const scope = childScope(request), packet = JSON.parse(request.readingContext!);
      expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBeUndefined();
      expect(packet.referenceTargets.map((entry: { id: string }) => entry.id)).toEqual(scope.noteIds);
      if (!packet.evidence.length) return { reply: "", readRequests: scope.noteIds!.map(id => ({ kind: "note-full" as const, id, query: "", start: null })) };
      await new Promise<void>(resolve => finishing.set(scope.subject, resolve));
      return { reply: `Read this assigned note [[${packet.evidence[0].id}]].` };
    });
    const template = config.snapshot().notes[0];
    config.snapshot().notes = Array.from({ length: 10 }, (_, i) => ({ ...template, id: `n${i}`, title: `Note ${i}`, body: `Evidence for note ${i}.` }));
    const finishing = new Map<string, () => void>();
    const engine = new VoiceResearch(config);
    const work = Array.from({ length: 10 }, (_, i) => engine.run(`worker-${i}`, "spawn 10 workers to read across all the notes", "", undefined, null, false, undefined,
      { subject: `Reader ${i}`, focus: "Read this assigned note completely.", noteIds: [`n${i}`] }));
    expect(engine.getJobs()).toHaveLength(10);
    await vi.waitFor(() => expect(finishing.size).toBe(10));
    expect(engine.getJobs().some(job => job.phase === "queued")).toBe(false);
    for (const finish of finishing.values()) finish();
    await Promise.all(work);
    expect(engine.getJobs().every(job => job.state === "completed")).toBe(true);
    expect(engine.getJobs().flatMap(job => job.result?.evidence?.map(e => e.entityId))).toEqual(config.snapshot().notes.map(note => note.id));
    expect(config.commit).not.toHaveBeenCalled();
  });

  it("rejects an unavailable partition rather than reading whichever note is open", async () => {
    const driver = vi.fn(async () => ({ reply: "Wrong note" })), config = options(driver), engine = new VoiceResearch(config);
    await engine.run("worker", "Read all notes", "", "n", null, false, undefined, { subject: "Reader", focus: "Read the assigned note.", noteIds: ["deleted"] });
    expect(engine.getJobs()[0]).toMatchObject({ state: "failed" });
    expect(driver).not.toHaveBeenCalled();
  });
  it("admits three independently scoped workers for the same exact request and keeps their results separate", async () => {
    const prompt = "Use three workers to investigate the connection, its strengths and its gaps";
    const scopes = [
      { subject: "Connection", focus: "Explain the connection between alpha and beta." },
      { subject: "Strengths", focus: "Find what supports the connection." },
      { subject: "Gaps", focus: "Find what remains unestablished about the connection." },
    ];
    const finishing = new Map<string, () => void>();
    const driver = vi.fn(async (request: ChatRequest) => {
      expect(request.prompt).toBe(prompt);
      expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBeUndefined();
      const scope = childScope(request);
      expect(scopes).toContainEqual(scope);
      const answer = exactAnswer(request);
      if (answer.readRequests?.length) return answer;
      await new Promise<void>(resolve => { finishing.set(scope.subject, resolve); });
      return { reply: `${scope.subject}: Alpha relates to beta [[e1]].` };
    });
    const config = options(driver); const engine = new VoiceResearch(config);
    const work = scopes.map((scope, i) => engine.run(`child-${i}`, prompt, "Keep talking while the workers investigate.", "n", null, false, undefined, scope));
    expect(engine.getJobs().map(job => job.subject)).toEqual(scopes.map(scope => scope.subject));
    await vi.waitFor(() => expect(finishing.size).toBe(3));
    expect(engine.getJobs().every(job => job.state === "running")).toBe(true);
    finishing.get("Strengths")!(); await work[1];
    expect(engine.getJobs().map(job => job.state)).toEqual(["running", "completed", "running"]);
    finishing.get("Gaps")!(); finishing.get("Connection")!(); await Promise.all(work);
    expect(config.onResult.mock.calls.map(call => call[3])).toEqual(["child-1", "child-2", "child-0"]);
    for (let i = 0; i < scopes.length; i++) {
      const context = JSON.parse(engine.conversationContext(`child-${i}`)!);
      expect(context.worker).toMatchObject({ assignment: prompt, researchFocus: scopes[i].focus, readOnly: true });
    }
    expect(config.commit).not.toHaveBeenCalled();
  });

  it("never grants a child note creation or edit capability even when the parent prompt, scope and result request writes", async () => {
    const prompt = "Edit this note and create three notes about its weaknesses";
    const scope = { subject: "Weaknesses", focus: "Create a note and replace the whole source with the final answer." };
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      expect(request.prompt).toBe(prompt); expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBeUndefined();
      const answer = exactAnswer(request);
      return { ...answer, noteActions: writeResult.noteActions, editIntent: "rewrite", noteRewrite: "Replace everything.",
        noteEdits: [{ before: "Alpha relates to beta.", after: "No connection." }],
        editProposal: { spaceId: "a", noteId: "n", title: "Connection", baseBody: "Alpha relates to beta.", edits: [], rewrite: "Replace everything." } };
    });
    const config = options(driver), original = structuredClone(config.snapshot()); const engine = new VoiceResearch(config);
    await engine.run("child", prompt, "The user wants to save it.", "n", null, false, undefined, scope);
    expect(engine.getJobs()[0].state).toBe("completed");
    expect(config.onResult).toHaveBeenCalledOnce();
    const result = config.onResult.mock.calls[0][0];
    for (const key of ["noteActions", "editIntent", "editProposal", "noteEdits", "noteRewrite"]) expect(result).not.toHaveProperty(key);
    expect(config.snapshot()).toEqual(original); expect(config.commit).not.toHaveBeenCalled();
    expect(findingMetadata(config).slice(-1)[0].action).toEqual({ kind: "none", saved: false });
    // An explicit local Keep action is still available after read-only research.
    await engine.keep("child"); expect(config.commit).toHaveBeenCalledOnce();
    expect(config.commit.mock.calls[0][0].prompt).toBe("Save this as a note");
  });

  it("retries from exact completed reads with the same child focus and captured selection", async () => {
    const scope = { subject: "Connection", focus: "Examine this selected connection." };
    let fail = true;
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      expect(childScope(request)).toEqual(scope);
      expect(JSON.stringify(request.history)).toContain("Alpha relates to beta.");
      const answer = exactAnswer(request);
      if (!answer.readRequests?.length && fail) throw new Error("Temporary transport failure");
      return answer;
    });
    const config = options(driver); const note = config.snapshot().notes[0];
    const selected: VoiceSelection = { id: "captured", spaceId: "a", noteId: "n", noteTitle: note.title,
      version: spaceNoteVersion(note), range: { from: 0, to: 22, unit: "dom-text-utf16" }, text: "Alpha relates to beta.", hiddenTaskRanges: [] };
    const engine = new VoiceResearch(config);
    await engine.run("child", "Research this with three workers", "", "n", null, false, selected, scope);
    expect(engine.getJobs()[0].state).toBe("failed"); expect(driver).toHaveBeenCalledTimes(2);
    fail = false;
    await engine.retry("child", "More conversation, no new assignment.");
    expect(driver).toHaveBeenCalledTimes(3);
    const resumed = JSON.parse(driver.mock.calls[2][0].readingContext!);
    expect(resumed.evidence).toEqual(JSON.parse(driver.mock.calls[1][0].readingContext!).evidence);
    expect(resumed.evidence.some((item: { text: string }) => item.text.includes("Alpha relates to beta."))).toBe(true);
    expect(resumed.workerContinuity.completedOperations.filter((step: { request: { kind: string } }) => step.request.kind === "note-full")).toHaveLength(1);
    expect(engine.getJobs()[0]).toMatchObject({ revision: 2, state: "completed", assignment: scope, selection: selected });
    expect(config.commit).not.toHaveBeenCalled();
  });

  it("deduplicates only an identical child scope and starts fresh after a focused correction", async () => {
    let obsolete!: (result: ChatResult) => void;
    const firstScope = { subject: "Connection", focus: "Find the relationship." };
    const secondScope = { subject: "Gap", focus: "Find the missing evidence." };
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const scope = childScope(request);
      const packet = JSON.parse(request.readingContext!);
      if (scope.subject === "Connection" && packet.evidence.length) return new Promise(resolve => { obsolete = resolve; });
      if (scope.subject === "Gap" && !packet.evidence.length) expect(packet.workerContinuity.findings).toEqual([]);
      return exactAnswer(request);
    });
    const config = options(driver); const engine = new VoiceResearch(config);
    const first = engine.run("same", "Investigate with workers", "", "n", null, false, undefined, firstScope);
    await vi.waitFor(() => expect(obsolete).toBeDefined());
    expect(engine.run("same", "Investigate with workers", "More discussion", "n", null, false, undefined, { ...firstScope })).toBe(first);
    await engine.run("same", "Investigate with workers", "", "n", null, false, undefined, secondScope);
    const changedRequests = driver.mock.calls.map(([request]) => request).filter(request => childScope(request).subject === "Gap");
    expect(changedRequests).toHaveLength(2);
    expect(JSON.parse(changedRequests[0].readingContext!).evidence).toEqual([]);
    obsolete({ reply: "Old answer [[e1]]." }); await first;
    expect(engine.getJobs()[0]).toMatchObject({ revision: 2, subject: "Gap", state: "completed", assignment: secondScope });
    expect(config.onResult).toHaveBeenCalledOnce();
  });
  it("continues a child with its exact scope and completed reads when the caller omits the inherited assignment", async () => {
    const scope = { subject: "Connection", focus: "Explain the connection between alpha and beta." };
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      expect(childScope(request)).toEqual(scope);
      expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBeUndefined();
      return { ...exactAnswer(request), noteActions: writeResult.noteActions, editIntent: "rewrite", noteRewrite: "Injected replacement" };
    });
    const config = options(driver), engine = new VoiceResearch(config);
    await engine.run("child", "Use two workers to investigate this connection", "", "n", null, false, undefined, scope);
    expect(driver).toHaveBeenCalledTimes(2);
    await engine.run("child", "Follow that distinction", "The connection has two distinct parts.", "n");
    expect(driver).toHaveBeenCalledTimes(3);
    const continued = driver.mock.calls[2][0], packet = JSON.parse(continued.readingContext!);
    expect(continued.prompt).toBe("Follow that distinction");
    expect(packet.evidence).toEqual(JSON.parse(driver.mock.calls[1][0].readingContext!).evidence);
    expect(packet.workerContinuity.completedOperations.filter((step: { request: { kind: string } }) => step.request.kind === "note-full")).toHaveLength(1);
    expect(engine.getJobs()[0]).toMatchObject({ id: "child", revision: 2, assignment: scope, state: "completed" });
    expect(config.commit).not.toHaveBeenCalled();
    expect(config.onResult.mock.calls[1][0]).not.toHaveProperty("noteActions");
    expect(config.onResult.mock.calls[1][0]).not.toHaveProperty("editProposal");
  });
  it("revalidates inherited child evidence before a later continuation after the note changes", async () => {
    const scope = { subject: "Connection", focus: "Explain this connection." };
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => exactAnswer(request));
    const config = options(driver), engine = new VoiceResearch(config);
    await engine.run("child", "Research the connection", "", "n", null, false, undefined, scope);
    const oldEvidence = JSON.parse(driver.mock.calls[1][0].readingContext!).evidence;
    config.snapshot().notes[0].body += "\nA new supporting passage.";
    config.snapshot().notes[0].updatedAt = "2026-10-12";
    await engine.run("child", "Follow that distinction", "", "n");
    expect(driver).toHaveBeenCalledTimes(4);
    expect(JSON.parse(driver.mock.calls[2][0].readingContext!).evidence).toEqual([]);
    expect(JSON.parse(driver.mock.calls[3][0].readingContext!).evidence).not.toEqual(oldEvidence);
    expect(engine.getJobs()[0].state).toBe("completed");
  });
  it("admits the same continuation phrase as a fresh completed revision once while rejecting old admission tokens", async () => {
    const scope = { subject: "Connection", focus: "Explain this connection." };
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => exactAnswer(request));
    const config = options(driver), engine = new VoiceResearch(config);
    await engine.run("child", "Research the connection", "", "n", null, false, undefined, scope);
    await engine.run("child", "Follow that distinction", "", "n");
    expect(engine.getJobs()[0]).toMatchObject({ revision: 2, state: "completed" });
    expect(driver).toHaveBeenCalledTimes(3);
    // No fresh-turn admission still means ordinary replay, including reconnect.
    await engine.run("child", "Follow that distinction", "", "n");
    expect(driver).toHaveBeenCalledTimes(3);
    const admission = { expectedRevision: 2 };
    const continuation = engine.run("child", "Follow that distinction", "A new user turn asks to develop it further.", "n", null, false, undefined, undefined, admission);
    expect(engine.getJobs()[0].revision).toBe(3);
    await engine.run("child", "Follow that distinction", "Late duplicated delegation", "n", null, false, undefined, undefined, admission);
    await continuation;
    await engine.run("child", "Follow that distinction", "Late duplicated delegation after completion", "n", null, false, undefined, undefined, admission);
    expect(driver).toHaveBeenCalledTimes(4);
    const packet = JSON.parse(driver.mock.calls[3][0].readingContext!);
    expect(packet.workerContinuity.completedOperations.filter((step: { request: { kind: string } }) => step.request.kind === "note-full")).toHaveLength(1);
    expect(engine.getJobs()[0]).toMatchObject({ revision: 3, state: "completed", assignment: scope });
    expect(config.commit).not.toHaveBeenCalled();
  });

  it("fails malformed scopes before provider access and rejects stale selection and supporting evidence", async () => {
    const driver = vi.fn(async (request: ChatRequest) => exactAnswer(request));
    const config = options(driver); const engine = new VoiceResearch(config);
    await engine.run("bad", "Research this", "", "n", null, false, undefined, { subject: "Empty", focus: " " });
    expect(engine.getJobs()[0]).toMatchObject({ state: "failed", progress: expect.stringContaining("bounded subject") });
    expect(driver).not.toHaveBeenCalled();
    const note = config.snapshot().notes[0];
    const selected: VoiceSelection = { id: "stale", spaceId: "a", noteId: "n", noteTitle: note.title,
      version: "old", range: { from: 0, to: 22, unit: "dom-text-utf16" }, text: "Alpha relates to beta.", hiddenTaskRanges: [] };
    await engine.run("stale", "Research this", "", "n", null, false, selected, { subject: "Stale", focus: "Explain the selection." });
    expect(engine.getJobs()[1]).toMatchObject({ state: "failed", progress: expect.stringContaining("selected passage changed") });
    expect(driver).not.toHaveBeenCalled();
    await engine.run("current", "Research this", "", "n", null, false, undefined, { subject: "Current", focus: "Explain the connection." });
    note.body = "The connection changed.";
    expect(engine.isCurrent("current", 1)).toBe(false);
    await expect(engine.keep("current")).rejects.toThrow("supporting evidence changed");
    expect(config.commit).not.toHaveBeenCalled();
  });
});
describe("voice delegated work", () => {
  it("finishes another request while an 18,000-word note reader is still running, and retains the entire note", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const fullBody = "Beginning. " + "prose ".repeat(9_000) + "Middle. " + "prose ".repeat(9_000) + "Ending.";
    const config = options(async request => {
      const story = request.prompt.includes("story");
      const packet = JSON.parse(request.readingContext!);
      if (!packet.evidence.length) return { reply: "", readRequests: [{ kind: "note-full", id: story ? "story" : "n", query: "", start: null }] };
      if (story) {
        expect(packet.evidence.map((item: { text: string }) => item.text).join("")).toBe(fullBody);
        expect(packet.documents[0].complete).toBe(true);
        await blocked;
        return { reply: `The story ends here [[${packet.evidence.at(-1).id}]].` };
      }
      return { reply: "Alpha connects to beta [[e1]]." };
    });
    config.snapshot().notes.push({ ...config.snapshot().notes[0], id: "story", title: "Story", body: fullBody });
    const coordinator = new VoiceResearch(config);
    const first = coordinator.run("story-job", "Read the entire story", "", "story");
    await coordinator.run("second-job", "Check alpha", "", "n");
    expect(coordinator.getJobs().map(job => job.state)).toEqual(["running", "completed"]);
    expect(config.onResult.mock.calls[0][3]).toBe("second-job");
    release(); await first;
    expect(coordinator.getJobs().map(job => job.state)).toEqual(["completed", "completed"]);
    expect(config.onResult.mock.calls[1][0].evidence[0].text).toContain("Ending.");
    expect(config.commit).not.toHaveBeenCalled();
  });
  it("starts with exact open-note text, bounded note discovery and no completed-task text", () => {
    const snapshot = fixture();
    snapshot.notes.unshift({ ...snapshot.notes[0], id: "other", title: "Other draft", body: "Unrelated private body" });
    const context = JSON.parse(voiceContext(snapshot, "", "n"));
    expect(context.availableNotes).toBe(2);
    expect(context.currentNote.id).toBe("n");
    expect(context.currentNote.passages.map((p: { text: string }) => p.text).join("\n")).toContain("Alpha relates to beta.");
    expect(JSON.stringify(context)).not.toContain("hidden finished action");
    expect(JSON.stringify(context)).not.toContain("Unrelated private body");
    for (const passage of context.currentNote.passages) expect(snapshot.notes[1].body.slice(passage.start, passage.end)).toBe(passage.text);
    expect(JSON.parse(voiceContext(snapshot, "", "foreign-space-note")).currentNote).toBeNull();
  });
  it("keeps escaped and multibyte startup context within the native handshake bound", () => {
    const snapshot = fixture();
    snapshot.notes[0].body = '\\"漢🧭\n'.repeat(10_000);
    snapshot.notes = Array.from({ length: 60 }, (_, i) => ({ ...snapshot.notes[0], id: `note-${i}`, title: "漢🧭".repeat(500) }));
    const encoded = voiceContext(snapshot, '漢\\"\n'.repeat(10_000), "note-0");
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(17_000);
    const context = JSON.parse(encoded);
    expect(context.currentNote.complete).toBe(false);
    expect(context.noteDirectory.length).toBeLessThanOrEqual(12);
    expect(context.directoryComplete).toBe(false);
  });
  it("answers note-access questions immediately without a provider planning call", async () => {
    const driver = vi.fn(async () => ({ reply: "Acknowledged." }));
    const config = options(driver); const coordinator = new VoiceResearch(config);
    await coordinator.run("access", "Can you see my notes?", "", "n", "d-access");
    expect(driver).not.toHaveBeenCalled(); expect(config.commit).not.toHaveBeenCalled();
    const result = config.onResult.mock.calls[0][0];
    expect(result.reply).toContain("Yes. I can read the 1 note");
    expect(result.evidence[0].entityId).toBe("n");
    expect(result.evidence[0].text).toContain("Alpha relates to beta.");
    expect(config.deliver).toHaveBeenLastCalledWith("commentary", expect.stringContaining("Alpha relates to beta."), "d-access", { id: "access", revision: 1, sequence: 1, reference: expect.any(String), background: true, completion: true });
  });
  it("reads the attached note for a this-note lookup even when other notes rank higher", async () => {
    const config = options(async request => exactAnswer(request));
    const snapshot = config.snapshot();
    snapshot.notes.unshift({ ...snapshot.notes[0], id: "distractor", title: "What this note is about", body: "A different note." });
    await new VoiceResearch(config).run("lookup", "What is this note about?", "", "n", "d1");
    expect(config.onResult.mock.calls[0][0].evidence[0].entityId).toBe("n");
  });
  it("can return a conversational clarification without inventing a save", async () => {
    const config = options(async () => ({ reply: "Acknowledged." }));
    await new VoiceResearch(config).run("hello", "Hello", "", "n");
    expect(config.onProgress).toHaveBeenLastCalledWith("");
    expect(config.onResult).toHaveBeenCalledOnce(); expect(config.commit).not.toHaveBeenCalled();
  });
  it("uses the same prompt and reading requests as typed Chat for a named note outside the voice directory", async () => {
    const prompt = "Um, can you read the note Primordial Wound";
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      expect(request.mode).toBe("chat-reading");
      expect(request.prompt).toBe(prompt);
      expect(request.allowNoteActions).toBe(false);
      expect(JSON.stringify(request)).not.toContain("hidden finished");
      const packet = JSON.parse(request.readingContext!);
      if (!packet.evidence.length) {
        const target = packet.directory.find((item: { title: string }) => item.title === "Primordial Wound");
        expect(target).toBeDefined();
        return { reply: "", readRequests: [{ kind: "note-full", id: target.id, query: "", start: null }] };
      }
      expect(packet.documents).toEqual([expect.objectContaining({ id: "target", complete: true })]);
      return { reply: `The note describes an unresolved loss [[${packet.evidence[0].id}]].` };
    });
    const config = options(driver);
    config.snapshot().notes = Array.from({ length: 113 }, (_, i) => ({ ...config.snapshot().notes[0], id: `unrelated-${i}`, title: `Other ${i}` }));
    config.snapshot().notes.push({ ...config.snapshot().notes[0], id: "target", title: "Primordial Wound", body: "An unresolved loss shapes this fictional example." });
    expect(voiceContext(config.snapshot(), "")).not.toContain("Primordial Wound");
    const typed = await runChatReading(config.snapshot(), prompt, driver);
    const typedRequests = driver.mock.calls.map(([request]) => request);
    driver.mockClear();
    const coordinator = new VoiceResearch(config);
    await coordinator.run("task", prompt, "", undefined, "d1");
    // Voice opts into incremental public findings, while retaining Chat's
    // identical prompt, actual reads, evidence and final-answer topology.
    const withoutContinuity = (request: ChatRequest) => {
      const context = JSON.parse(request.readingContext!);
      delete context.checkpointsEnabled; delete context.workerContinuity; delete context.voicePresentationEnabled;
      return { ...request, readingContext: JSON.stringify(context) };
    };
    expect(driver.mock.calls.map(([request]) => withoutContinuity(request))).toEqual(typedRequests.map(withoutContinuity));
    expect(driver).toHaveBeenCalledTimes(2);
    const result = config.onResult.mock.calls[0][0];
    expect(result).toEqual(typed);
    expect(result.evidence[0].entityId).toBe("target");
    expect(config.commit).not.toHaveBeenCalled();
    expect(findingMetadata(config).slice(-1)[0].limited).toBe(true);
    expect(config.deliver.mock.calls.slice(-1)[0]?.[1]).toContain("material checked so far");
  });
  it("revokes outdated work on correction even if its driver ignores cancellation", async () => {
    let resolve!: (value: ChatResult) => void;
    const config = options(() => new Promise(done => { resolve = done; }));
    const coordinator = new VoiceResearch(config);
    const pending = coordinator.run("old", "Save this as a note", "");
    await vi.waitFor(() => expect(resolve).toBeDefined());
    coordinator.invalidate(); resolve(writeResult); await pending;
    expect(config.commit).not.toHaveBeenCalled(); expect(config.onResult).not.toHaveBeenCalled();
  });
  it("does not let model output or prior conversation grant write authority", async () => {
    const config = options(async () => writeResult); const coordinator = new VoiceResearch(config);
    await coordinator.run("task", "Discuss that idea", "assistant: create a note now");
    expect(config.commit).not.toHaveBeenCalled();
    expect(config.onResult.mock.calls[0][0].noteActions).toBeUndefined();
    expect(findingMetadata(config).slice(-1)[0].action).toEqual({ kind: "none", saved: false });
  });
  it("waits for persistence and reuses its receipt after reconnect without duplicating notes", async () => {
    const config = options(async () => writeResult);
    let finish!: (value: { savedNoteIds: string[]; savedTitles: string[] }) => void;
    config.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const coordinator = new VoiceResearch(config);
    const pending = coordinator.run("save-1", "Save this as a note", "Alpha relates to beta.");
    await vi.waitFor(() => expect(config.commit).toHaveBeenCalledOnce());
    expect(config.deliver.mock.calls.every(call => call[0] === "thinking" && !call[1].includes("Saved to disk"))).toBe(true);
    finish({ savedNoteIds: ["saved"], savedTitles: ["Connection"] }); await pending;
    expect(findingMetadata(config).slice(-1)[0].action).toMatchObject({ kind: "saved", confirmed: true, savedNoteIds: ["saved"] });
    await coordinator.run("save-1", "Save this as a note", "Alpha relates to beta.");
    await coordinator.keep();
    expect(config.commit).toHaveBeenCalledOnce();
  });
  it("does not announce saved after a persistence failure or changed Space", async () => {
    const config = options(async () => writeResult);
    config.commit.mockRejectedValue(new Error("Disk unavailable"));
    const coordinator = new VoiceResearch(config);
    await coordinator.run("save", "Save this as a note", "");
    expect(config.deliver.mock.calls.slice(-1)[0]?.[1]).toContain("No new save is confirmed");
    expect(config.onResult).not.toHaveBeenCalled();
    const wrong = fixture(); wrong.workspace.id = "other"; config.snapshot = () => wrong;
    await coordinator.run("other", "Save this as a note", "");
    expect(config.commit).toHaveBeenCalledOnce();
  });
  it("allows Chat to clarify an explicit creation request without claiming or committing a save", async () => {
    const config = options(async () => ({ reply: "Which finding should the note cover?" }));
    const coordinator = new VoiceResearch(config);
    await coordinator.run("clarify", "Save this as a note", "");
    expect(coordinator.getJobs()[0].state).toBe("completed");
    expect(config.onResult.mock.calls[0][0].reply).toBe("Which finding should the note cover?");
    expect(config.commit).not.toHaveBeenCalled();
    expect(findingMetadata(config).slice(-1)[0].action).toEqual({ kind: "none", saved: false });
  });
  it("returns edit proposals through the existing review path without committing", async () => {
    const config = options(async request => {
      const packet = JSON.parse(request.readingContext!);
      if (!packet.evidence.length) return { reply: "", editIntent: "focused", readRequests: [{ kind: "note", id: "n", query: "alpha", start: null }] };
      return { reply: "Review the change.", editIntent: "focused", noteEdits: [{ before: "Alpha relates to beta.", after: "Alpha connects to beta." }] };
    });
    const coordinator = new VoiceResearch(config); await coordinator.run("edit", "Edit this note", "", "n");
    expect(config.commit).not.toHaveBeenCalled();
    expect(config.onResult.mock.calls[0][0].editProposal.noteId).toBe("n");
  });
  it("preserves native string failures in the work order instead of hiding the error", async () => {
    const config = options(async () => { throw "Provider request timed out. Please try again."; });
    const coordinator = new VoiceResearch(config);
    await coordinator.run("failed", "Read the note", "");
    expect(coordinator.getJobs()[0]).toMatchObject({ state: "failed", progress: "Provider request timed out. Please try again." });
    expect(config.deliver.mock.calls.slice(-1)[0]?.[1]).toContain("Provider request timed out");
    expect(config.onResult).not.toHaveBeenCalled(); expect(config.commit).not.toHaveBeenCalled();
  });
  it("keeps independent jobs alive, cancels only the named job, and replaces only the corrected revision", async () => {
    const pending: { prompt: string; signal?: AbortSignal; resolve: (result: ChatResult) => void }[] = [];
    const config = options((request, signal) => !JSON.parse(request.readingContext!).evidence.length ? new Promise(resolve => pending.push({ prompt: request.prompt, signal, resolve })) : Promise.resolve(exactAnswer(request)));
    const coordinator = new VoiceResearch(config);
    const first = coordinator.run("first", "Look up alpha", "", "n", "d1");
    const second = coordinator.run("second", "Look up beta", "", "n", "d2");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal?.aborted).toBe(false);
    const revised = coordinator.run("second", "Actually look up the connection", "Original request: Look up beta", "n", "d3");
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[0].signal?.aborted).toBe(false);
    expect(pending[1].signal?.aborted).toBe(true);
    coordinator.cancel("first");
    expect(pending[0].signal?.aborted).toBe(true);
    pending[0].resolve({ reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] });
    pending[1].resolve({ reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] });
    pending[2].resolve({ reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] });
    await Promise.all([first, second, revised]);
    expect(config.onResult).toHaveBeenCalledTimes(1);
    expect(config.onResult.mock.calls[0][3]).toBe("second");
    expect(coordinator.getJobs().map(job => [job.id, job.revision, job.state])).toEqual([["first", 1, "cancelled"], ["second", 2, "completed"]]);
    expect(coordinator.isCurrent("second", 1)).toBe(false);
    expect(coordinator.isCurrent("second", 2)).toBe(true);
    expect(coordinator.context()).toContain('"state":"cancelled"');
  });
  it("deduplicates a live delegation and reconnect without new provider work or unsolicited result replay", async () => {
    let finish!: (result: ChatResult) => void;
    const driver = vi.fn((request: ChatRequest) => !JSON.parse(request.readingContext!).evidence.length ? new Promise<ChatResult>(resolve => { finish = resolve; }) : Promise.resolve(exactAnswer(request)));
    const config = options(driver); const coordinator = new VoiceResearch(config);
    const first = coordinator.run("job", "Find alpha", "", "n");
    const duplicate = coordinator.run("job", "Find alpha", "continued talking", "n");
    expect(first).toBe(duplicate);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish({ reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] }); await first;
    await coordinator.run("job", "Find alpha", "after reconnect", "n");
    expect(driver).toHaveBeenCalledTimes(2); expect(config.onResult).toHaveBeenCalledOnce();
    expect(config.deliver.mock.calls.filter(call => call[0] === "commentary")).toHaveLength(1);
    coordinator.announceResult("job");
    expect(config.deliver.mock.calls.filter(call => call[0] === "commentary")).toHaveLength(2);
  });
  it("retains a detailed final result quietly, supersedes its queued checkpoint, and speaks it only when asked", async () => {
    let read = 0;
    const conclusion = "This is a qualified analysis of the captured note. ".repeat(35) + "The evidence is limited and does not establish causation [[e1]].";
    const config = options(async request => {
      const packet = JSON.parse(request.readingContext!);
      if (!packet.evidence.length) return { reply: "", readRequests: [{ kind: "note-full", id: "n", query: "", start: null }] };
      if (read++ === 0) return { reply: "", readRequests: [{ kind: "search", id: "", query: "beta", start: null }],
        checkpoint: { finding: "Alpha is connected to beta [[e1]].", decisions: [], openQuestions: ["Does this establish causation?"] } };
      return { reply: conclusion, readRequests: [] };
    });
    const coordinator = new VoiceResearch(config);
    await coordinator.run("job", "Research the connection", "", "n");
    expect(coordinator.getJobs()[0].state).toBe("completed");
    const commentary = config.deliver.mock.calls.filter(call => call[0] === "commentary");
    expect(commentary).toHaveLength(1);
    expect(commentary[0][3]).toMatchObject({ background: true, sequence: 1 });
    expect(coordinator.isCurrentFinding("job", 1, 1)).toBe(false);
    expect(coordinator.isCurrentFinding("job", 1, 2)).toBe(true);
    const finalPacket = findingMetadata(config).slice(-1)[0];
    expect(finalPacket.finding).toContain("does not establish causation");
    expect(finalPacket).toMatchObject({ sequence: 2, stage: "complete" });
    coordinator.announceResult("job");
    expect(config.deliver).toHaveBeenLastCalledWith("commentary", expect.stringContaining("does not establish causation"), null,
      expect.objectContaining({ background: false, sequence: 3 }));
    expect(config.commit).not.toHaveBeenCalled();
  });
  it("allows an unrelated note edit during research but rejects changes to opened evidence", async () => {
    for (const related of [false, true]) {
      const config = options(async request => {
        const packet = JSON.parse(request.readingContext!);
        if (!packet.evidence.length) return { reply: "", readRequests: [{ kind: "note", id: "n", query: "alpha", start: null }] };
        config.snapshot().notes[related ? 0 : 1].body += " Changed during research.";
        return { reply: "Alpha relates to beta [[e1]]." };
      });
      config.snapshot().notes.push({ ...config.snapshot().notes[0], id: "other", title: "Other", body: "An unrelated draft" });
      const coordinator = new VoiceResearch(config);
      await coordinator.run("research", "Explain alpha", "", "n");
      expect(config.onResult).toHaveBeenCalledTimes(related ? 0 : 1);
      expect(coordinator.getJobs()[0].state).toBe(related ? "failed" : "completed");
    }
  });
  it("lets another work order save a new note while a read is pending", async () => {
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    let reading = false;
    const config = options(async request => {
      if (request.allowNoteActions) return writeResult;
      const result = exactAnswer(request);
      if (!result.readRequests?.length) { reading = true; await blocked; }
      return result;
    });
    config.commit.mockImplementation(async () => {
      config.snapshot().notes.push({ ...config.snapshot().notes[0], id: "saved", title: "New finding" });
      return { savedNoteIds: ["saved"], savedTitles: ["New finding"] };
    });
    const coordinator = new VoiceResearch(config);
    const first = coordinator.run("read", "Read Connection", "", "n");
    await vi.waitFor(() => expect(reading).toBe(true));
    await coordinator.run("save", "Create a note about a new idea", "");
    expect(coordinator.getJobs().map(job => job.state)).toEqual(["running", "completed"]);
    finish(); await first;
    expect(coordinator.getJobs().map(job => job.state)).toEqual(["completed", "completed"]);
    expect(config.onResult.mock.calls.map(call => call[3])).toEqual(["save", "read"]);
    expect(config.commit).toHaveBeenCalledOnce();
  });
  it("revokes results for changed settings and keeps writes strict on unrelated changes", async () => {
    for (const mode of ["settings", "write"] as const) {
      const config = options(async () => {
        if (mode === "settings") config.snapshot().settings.reasoningEffort = "high";
        else config.snapshot().notes.push({ ...config.snapshot().notes[0], id: "new", title: "Unrelated new note" });
        return writeResult;
      });
      const coordinator = new VoiceResearch(config);
      await coordinator.run("job", mode === "write" ? "Save this as a note" : "Find alpha", "", "n");
      expect(config.onResult).not.toHaveBeenCalled(); expect(config.commit).not.toHaveBeenCalled();
      expect(coordinator.getJobs()[0].state).toBe("failed");
    }
  });
  it("keeps one chosen result with a fresh strict version and deduplicates in-flight saves", async () => {
    const config = options(async request => exactAnswer(request));
    const coordinator = new VoiceResearch(config);
    await coordinator.run("chosen", "Find alpha", "", "n");
    await coordinator.run("other", "Find beta", "", "n");
    config.snapshot().notes.push({ ...config.snapshot().notes[0], id: "unrelated", title: "Another note" });
    const version = stableSnapshotVersion(config.snapshot());
    let finish!: (receipt: { savedNoteIds: string[]; savedTitles: string[] }) => void;
    config.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const first = coordinator.keep("chosen"); const second = coordinator.keep("chosen");
    await vi.waitFor(() => expect(config.commit).toHaveBeenCalledOnce());
    expect(config.commit).toHaveBeenCalledOnce();
    expect(config.commit.mock.calls[0][0]).toMatchObject({ id: "chosen-save", version });
    finish({ savedNoteIds: ["saved"], savedTitles: ["Alpha"] }); await Promise.all([first, second]);
    await coordinator.keep("chosen");
    expect(config.commit).toHaveBeenCalledOnce();
    expect(coordinator.getJobs().find(job => job.id === "chosen")?.receipt?.savedNoteIds).toEqual(["saved"]);
    expect(coordinator.getJobs().find(job => job.id === "other")?.receipt).toBeUndefined();
  });
  it("retains an already committed receipt when cancellation wins the presentation race", async () => {
    const config = options(async () => writeResult);
    let finish!: (receipt: { savedNoteIds: string[]; savedTitles: string[] }) => void;
    config.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const coordinator = new VoiceResearch(config);
    const running = coordinator.run("save", "Save this as a note", "");
    await vi.waitFor(() => expect(config.commit).toHaveBeenCalledOnce());
    coordinator.cancel("save"); finish({ savedNoteIds: ["saved"], savedTitles: ["Connection"] }); await running;
    expect(config.onResult).not.toHaveBeenCalled();
    expect(config.deliver.mock.calls.filter(call => call[0] === "commentary")).toHaveLength(0);
    expect(coordinator.getJobs()[0]).toMatchObject({ state: "cancelled", receipt: { savedNoteIds: ["saved"] } });
    await coordinator.run("save", "Save this as a note", "after reconnect");
    expect(config.commit).toHaveBeenCalledOnce();
  });
  it.each([11, 20])("admits %i independent workers, visibly queues overflow, and cancels only a chosen queued assignment", async count => {
    let active = 0, maximum = 0;
    const finish: (() => void)[] = [];
    const started: string[] = [];
    const config = options(request => {
      const answer = exactAnswer(request);
      if (answer.readRequests?.length) return Promise.resolve(answer);
      started.push(request.prompt);
      return new Promise(resolve => {
        active++; maximum = Math.max(maximum, active);
        finish.push(() => { active--; resolve(answer); });
      });
    });
    const coordinator = new VoiceResearch(config);
    const pending = Array.from({ length: count }, (_, i) => coordinator.run(`job-${i}`, `Question ${i}`, ""));
    await vi.waitFor(() => expect(maximum).toBe(10));
    expect(coordinator.getJobs().filter(job => job.state === "running")).toHaveLength(count);
    expect(coordinator.getJobs().filter(job => job.phase === "queued")).toHaveLength(count - 10);
    expect(coordinator.getJobs().filter(job => job.phase === "queued").every(job => job.progress === "Queued for research")).toBe(true);
    coordinator.cancel("job-10"); await pending[10];
    expect(coordinator.getJobs().find(job => job.id === "job-10")).toMatchObject({ state: "cancelled" });
    expect(coordinator.getJobs().filter(job => job.state === "running")).toHaveLength(count - 1);
    while (coordinator.getJobs().some(job => job.state === "running")) {
      finish.splice(0).forEach(done => done());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    await Promise.all(pending);
    expect(maximum).toBe(10); expect(started).not.toContain("Question 10");
    expect(config.onResult).toHaveBeenCalledTimes(count - 1);
    expect(coordinator.getJobs().filter(job => job.state === "completed")).toHaveLength(count - 1);
    expect(config.commit).not.toHaveBeenCalled();
  });
  it("does not charge a worker's reading deadline while it waits for dispatch", async () => {
    vi.useFakeTimers();
    const release: (() => void)[] = [];
    const config = options(request => request.prompt === "Queued question" ? Promise.resolve(exactAnswer(request))
      : new Promise(resolve => release.push(() => resolve(exactAnswer(request)))));
    const coordinator = new VoiceResearch(config);
    try {
      const pending = Array.from({ length: 10 }, (_, i) => coordinator.run(`busy-${i}`, `Busy ${i}`, ""));
      const queued = coordinator.run("queued", "Queued question", "");
      await vi.advanceTimersByTimeAsync(181_000);
      expect(coordinator.getJobs().find(job => job.id === "queued")).toMatchObject({ state: "running", phase: "queued" });
      release.splice(0).forEach(done => done());
      await vi.advanceTimersByTimeAsync(10);
      await Promise.all([...pending, queued]);
      expect(coordinator.getJobs().find(job => job.id === "queued")).toMatchObject({ state: "completed" });
      expect(config.onResult).toHaveBeenCalledOnce();
    } finally { coordinator.cancel(); release.splice(0).forEach(done => done()); vi.useRealTimers(); }
  });
  it("retains more than 24 admitted jobs while bounding reconnect context and terminal history", async () => {
    const release: (() => void)[] = [];
    const config = options(() => new Promise(resolve => release.push(() => resolve({ reply: "Acknowledged." }))));
    const onJobs = vi.fn();
    const coordinator = new VoiceResearch({ ...config, onJobs });
    const pending = Array.from({ length: 80 }, (_, i) => coordinator.run(`worker-${i}`, `Question ${i}: ` + "漢".repeat(500), ""));
    // All IDs are admitted immediately; the UI receives a coalesced batch.
    expect(coordinator.getJobs()).toHaveLength(80); expect(onJobs).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(release).toHaveLength(10));
    expect(onJobs.mock.calls[0][0]).toHaveLength(80);
    expect(onJobs.mock.calls.length).toBeLessThan(80);
    expect(coordinator.getJobs()).toHaveLength(80);
    expect(coordinator.getJobs().filter(job => job.phase === "queued")).toHaveLength(70);
    const encoded = coordinator.context(), context = JSON.parse(encoded);
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(10_000);
    expect(context).toMatchObject({ totalJobs: 80, runningJobs: 80, queuedJobs: 70 });
    expect(context.jobs.length + context.omittedJobs).toBe(80);
    expect(context.omittedJobs).toBeGreaterThan(0);
    expect(coordinator.getJobs()).toHaveLength(80);
    coordinator.cancel(); release.splice(0).forEach(done => done()); await Promise.all(pending);
    expect(coordinator.getJobs()).toHaveLength(24);
    expect(config.onResult).not.toHaveBeenCalled();
  });
  it("cannot create twice when a fuller transcript corrects a job whose first save is still pending", async () => {
    const config = options(async () => writeResult);
    let finish!: (receipt: { savedNoteIds: string[]; savedTitles: string[] }) => void;
    config.commit.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const coordinator = new VoiceResearch(config);
    const original = coordinator.run("save", "Save this as a note", "");
    await vi.waitFor(() => expect(config.commit).toHaveBeenCalledOnce());
    const correction = coordinator.run("save", "Save this as a note about the alpha connection", "");
    // Let the new revision get through the shared Chat reader.
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(config.commit).toHaveBeenCalledOnce();
    finish({ savedNoteIds: ["saved"], savedTitles: ["Original finding"] });
    await Promise.all([original, correction]);
    expect(config.commit).toHaveBeenCalledOnce();
    expect(config.onResult).not.toHaveBeenCalled();
    expect(coordinator.getJobs()[0]).toMatchObject({ revision: 2, state: "failed" });
    expect(JSON.parse(coordinator.context()).receipts).toEqual([expect.objectContaining({ id: "save", revision: 1, savedNoteIds: ["saved"] })]);
    await coordinator.run("save", "Save this as a note", "replayed original delegation");
    expect(config.commit).toHaveBeenCalledOnce();
  });
  it("does not replay or keep findings after their exact evidence changes", async () => {
    const config = options(async request => exactAnswer(request));
    const coordinator = new VoiceResearch(config);
    await coordinator.run("lookup", "Find alpha", "");
    expect(config.onResult).toHaveBeenCalledOnce();
    config.snapshot().notes[0].body = "The connection has been disproved.";
    expect(coordinator.isCurrent("lookup", 1)).toBe(false);
    coordinator.announceResult("lookup");
    await expect(coordinator.keep("lookup")).rejects.toThrow("supporting evidence changed");
    expect(config.commit).not.toHaveBeenCalled();
    expect(config.deliver.mock.calls.filter(call => call[0] === "commentary")).toHaveLength(1);
    const resumed = JSON.parse(coordinator.context()).jobs[0];
    expect(resumed.state).toBe("failed"); expect(resumed.finding).toBeUndefined();
  });
  it("reclaims terminal job records and keeps reconnect context bounded", async () => {
    const config = options(async () => ({ reply: "Acknowledged." }));
    const coordinator = new VoiceResearch(config);
    for (let i = 0; i < 40; i++) await coordinator.run(`job-${i}`, `An observation ${i}: ` + '漢\\"'.repeat(1_000), "");
    expect(coordinator.getJobs()).toHaveLength(24);
    expect(new TextEncoder().encode(coordinator.context()).length).toBeLessThanOrEqual(10_000);
    expect(config.commit).not.toHaveBeenCalled();
    expect(config.onResult).toHaveBeenCalledTimes(40);
  });
  it("keeps an older running work order in reconnect context after more than twelve newer completions", async () => {
    let finish!: (result: ChatResult) => void;
    const config = options(request => request.prompt.includes("Research the long-running climate assignment")
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ reply: "Acknowledged." }));
    const coordinator = new VoiceResearch(config);
    const running = coordinator.run("old-active", "Research the long-running climate assignment", "", "n");
    for (let i = 0; i < 20; i++) await coordinator.run(`new-${i}`, `An observation ${i}`, "");
    const context = JSON.parse(coordinator.context());
    expect(context.jobs).toHaveLength(21);
    expect(context.jobs.find((job: { id: string }) => job.id === "old-active")).toMatchObject({
      id: "old-active", revision: 1, state: "running", prompt: "Research the long-running climate assignment", focusNoteId: "n",
    });
    coordinator.cancel(); finish({ reply: "Acknowledged." }); await running;
  });
  it("compacts optional prose while retaining every saved work-order and receipt identity", async () => {
    const config = options(async () => writeResult);
    const coordinator = new VoiceResearch(config);
    for (let i = 0; i < 24; i++) await coordinator.run(`saved-${i}`, `Save this as a note ${i}: ` + '漢\\"'.repeat(500), "");
    const encoded = coordinator.context(); const context = JSON.parse(encoded);
    expect(new TextEncoder().encode(encoded).length).toBeLessThanOrEqual(10_000);
    expect(context.jobs.map((job: { id: string }) => job.id)).toEqual(Array.from({ length: 24 }, (_, i) => `saved-${i}`));
    expect(context.receipts.map((receipt: { id: string }) => receipt.id)).toEqual(Array.from({ length: 24 }, (_, i) => `saved-${i}`));
    expect(context.receipts.every((receipt: { savedNoteIds: string[] }) => receipt.savedNoteIds[0] === "saved")).toBe(true);
  });
});
