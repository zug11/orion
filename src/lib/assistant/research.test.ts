import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { ChatRequest, ChatResult, Note } from "../../types";
import { executeAssistantWorkflow } from "./workflows";
import { researchSpace } from "./research";
import { MAX_RESEARCH_CHECKPOINT_BYTES, retainResearchCheckpoint, validatedResearchCheckpoint } from "./researchCheckpoint";
import type { WorkflowDependencies } from "./types";

function fixture() {
  const snapshot = createEmptySnapshot("Research", "2026-10-11", "research");
  const note = (id: string, body: string): Note => ({ id, title: id, slug: id, body, summary: "", aliases: [], tags: [],
    sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-11", updatedAt: "2026-10-11" });
  snapshot.notes = [note("alpha", `Alpha draft.\n${"Background. ".repeat(2_000)}\nThe later qualifier: observations exclude winter.`), note("beta", "Beta records the original measurements.")];
  snapshot.sources = [{ id: "original", title: "Unrelated archive title", kind: "text", text: "Original measurements use 40 observations.", importedAt: "2026-10-11", noteIds: ["beta"], sourceUrl: "https://example.com/original" }];
  snapshot.settings.apiKeyConfigured = true;
  snapshot.settings.assistantAccess = { enabled: true, allowAI: true, allowWrites: false, spaceIds: [snapshot.workspace.id] };
  snapshot.studio.messages = [{ id: "private", role: "user", content: "PRIVATE_CHAT_HISTORY", createdAt: "2026-10-11", cardIds: [], contextCardIds: [] }];
  return snapshot;
}
const packet = (request: ChatRequest) => JSON.parse(request.readingContext!);
const read = (id: string, kind: "note" | "note-full" | "source-full" = "note-full", start = 0) => ({ kind, id, query: "", start });
const synthesis = (evidenceIds = ["e1"]) => ({ reply: JSON.stringify({ answer: "The notes describe a limited observation.",
  findings: [{ claim: "The text reports an observation.", kind: "fact", evidenceIds }], gaps: ["No independent verification."], followUpQuestions: ["Compare the seasons?"] }) });
function deps(driver?: WorkflowDependencies["chat"], controller = new AbortController()): WorkflowDependencies {
  return { signal: controller.signal, assertCurrent: vi.fn(async () => {}), progress: vi.fn(async () => {}),
    chat: vi.fn(driver ?? (async request => {
      if (request.mode !== "chat-reading") return synthesis();
      if (!packet(request).evidence.length) return { reply: "", readRequests: [read("alpha")] };
      return { reply: "The draft contains an observation [[e1]]." };
    })), previousResult: vi.fn(async () => ({})),
  } as unknown as WorkflowDependencies;
}

describe("adaptive MCP research", () => {
  it("reads selected sources and further long-note offsets through the shared reader, then returns exact citations without writes", async () => {
    const snapshot = fixture(), original = structuredClone(snapshot);
    let turn = 0;
    const dependencies = deps(async request => {
      expect(request.history).toEqual([]); expect(request.allowNoteActions).toBe(false); expect(request.editNoteId).toBeUndefined();
      expect(JSON.stringify(request)).not.toContain("PRIVATE_CHAT_HISTORY");
      if (request.mode !== "chat-reading") {
        expect(request.notes.filter(note => note.summary.startsWith("Evidence ID"))).toHaveLength(2);
        return { ...synthesis(["e2", "e3"]), noteActions: [{ title: "Forbidden", body: "Do not save", summary: "", tags: [], aliases: [] }] };
      }
      const context = packet(request);
      if (turn++ === 0) return { reply: "", readRequests: [read("alpha", "note"), read("original", "source-full")] };
      if (turn === 2) return { reply: "", checkpoint: { finding: "The source reports 40 observations [[e2]].", decisions: ["Read the later qualifier before comparing."], openQuestions: ["Are seasons excluded?"] },
        readRequests: [read("alpha", "note-full", snapshot.notes[0].body.length - 80)], noteActions: [{ title: "Forbidden", body: "Do not save", summary: "", tags: [], aliases: [] }] };
      expect(context.workerContinuity.decisions).toEqual(["Read the later qualifier before comparing."]);
      expect(context.evidence[2].text).toContain("exclude winter");
      return { reply: "There are 40 observations [[e2]], excluding winter [[e3]].", evidence: [],
        noteActions: [{ title: "Forbidden", body: "Do not save", summary: "", tags: [], aliases: [] }] };
    });
    const outcome = await executeAssistantWorkflow(snapshot, { space_id: snapshot.workspace.id, request_id: "adaptive", operation: "research",
      input: { question: "Compare these selected records", note_ids: ["alpha"], source_ids: ["original"], depth: "deep" } }, dependencies);
    const result = outcome.result as Awaited<ReturnType<typeof researchSpace>>;
    expect(result.evidence).toHaveLength(2); // Only cited reader passages enter structured synthesis.
    expect(result.evidence.find(item => item.kind === "source")).toMatchObject({ entityId: "original", sourceUrl: "https://example.com/original", notes: [{ id: "beta", orionUrl: expect.stringContaining("note_id=beta") }] });
    for (const item of result.evidence) {
      const body = item.kind === "note" ? snapshot.notes.find(note => note.id === item.entityId)!.body : snapshot.sources.find(source => source.id === item.entityId)!.text;
      for (const range of item.passages) expect(body.slice(range.start, range.end)).toBe(range.text);
    }
    expect(result.readerCheckpoint?.findings).toHaveLength(1);
    expect(result.findings[0].citations.map(item => item.id)).toEqual(["beta", "alpha"]);
    expect(outcome.snapshot).toBeUndefined(); expect(snapshot).toEqual(original);
    expect(result).not.toHaveProperty("noteActions"); expect(dependencies.chat).toHaveBeenCalledTimes(4);
    expect(new TextEncoder().encode(JSON.stringify(result)).length).toBeLessThan(2 * 1024 * 1024);
  });

  it("preserves an entire maximum Unicode question and comparison, without overflowing the native prompt or context-record limits", async () => {
    const snapshot = fixture();
    const question = `${"🌔".repeat(7_980)} final qualifier`, material = `${"文".repeat(23_980)} final limitation`;
    const dependencies = deps(async request => {
      expect([...request.prompt].length).toBeLessThan(8_000);
      expect(request.notes.every(note => [...note.body].length <= 8_000)).toBe(true);
      const references = request.mode === "chat-reading" ? packet(request).referenceRecords as ChatRequest["notes"] : request.notes;
      expect(references.filter(note => note.title.startsWith("Research question")).map(note => note.body).join("")).toBe(question);
      expect(references.filter(note => note.title.startsWith("Comparison material")).map(note => note.body).join("")).toBe(material);
      if (request.mode !== "chat-reading") return synthesis();
      if (!packet(request).evidence.length) return { reply: "", readRequests: [read("alpha")] };
      return { reply: "The draft observation [[e1]]." };
    });
    const result = await researchSpace(snapshot, { question, material, note_ids: ["alpha"] }, dependencies);
    expect(result.readerCheckpoint?.prompt).toBe(question);
    await expect(researchSpace(snapshot, { question: `${"文".repeat(8_000)}x` }, deps())).rejects.toThrow("8,000");
  });

  it("retains existing exact-ID and depth semantics before any provider call", async () => {
    const snapshot = fixture(), dependencies = deps();
    for (const input of [{ note_ids: ["foreign"] }, { source_ids: ["foreign"] }, { note_ids: ["alpha", "alpha"] }, { note_ids: Array(9).fill("alpha") }]) {
      await expect(researchSpace(snapshot, { question: "Check these", ...input }, dependencies)).rejects.toThrow(/exact Space|Duplicate|deep context/);
    }
    expect(dependencies.chat).not.toHaveBeenCalled();
  });

  it("keeps all deep priority references visible when the initial search adds unrelated hits", async () => {
    const snapshot = fixture();
    const notes = Array.from({ length: 16 }, (_, index) => ({ ...snapshot.notes[1], id: `selected-${index}`, title: `Selected ${index}`, body: "Reference text." }));
    const sources = Array.from({ length: 8 }, (_, index) => ({ ...snapshot.sources[0], id: `source-${index}`, title: `Source ${index}`, text: "Reference source.", noteIds: [] }));
    snapshot.notes = [...notes, ...Array.from({ length: 12 }, (_, index) => ({ ...snapshot.notes[1], id: `lexical-${index}`, title: `Needle ${index}` }))];
    snapshot.sources = sources;
    const dependencies = deps(async request => {
      if (request.mode !== "chat-reading") return synthesis();
      const context = packet(request);
      expect(context.referenceTargets).toHaveLength(24);
      expect(context.referenceTargets.map((item: { id: string }) => item.id)).toEqual([...notes, ...sources].map(item => item.id));
      expect(context.referenceTargets.every((item: { title?: string; version?: string }) => item.title && item.version)).toBe(true);
      if (!context.evidence.length) return { reply: "", readRequests: [read("selected-0")] };
      return { reply: "Reference [[e1]]." };
    });
    await researchSpace(snapshot, { question: "Needle", depth: "deep", note_ids: notes.map(note => note.id), source_ids: sources.map(source => source.id) }, dependencies);
  });

  it("keeps completed tasks blind in default reads and preserves original source positions", async () => {
    const snapshot = fixture();
    snapshot.notes[0].body = "Opening.\n\n- [x] PRIVATE_COMPLETED_TASK\n- [ ] Remaining observation\n\nEnding.";
    const dependencies = deps(async request => {
      expect(JSON.stringify(request)).not.toContain("PRIVATE_COMPLETED_TASK");
      if (request.mode !== "chat-reading") return synthesis();
      const context = packet(request);
      if (!context.evidence.length) return { reply: "", readRequests: [read("alpha")] };
      return { reply: `The remaining observation [[${context.evidence[0].id}]].` };
    });
    const result = await researchSpace(snapshot, { question: "Read alpha", note_ids: ["alpha"] }, dependencies);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_COMPLETED_TASK");
    for (const item of result.readerCheckpoint!.evidence) expect(snapshot.notes[0].body.slice(item.start, item.end)).toBe(item.text);
  });

  it("resumes a same-version previous job with its exact evidence and read steps", async () => {
    const snapshot = fixture();
    const previous = await researchSpace(snapshot, { question: "Read alpha", note_ids: ["alpha"] }, deps());
    let readingCalls = 0;
    const dependencies = deps(async request => {
      if (request.mode !== "chat-reading") return synthesis();
      readingCalls++;
      const context = packet(request);
      expect(context.evidence[0]).toMatchObject({ entityId: "alpha", text: previous.readerCheckpoint!.evidence[0].text });
      expect(context.workerContinuity.completedOperations.some((step: { request: { kind: string } }) => step.request.kind === "note-full")).toBe(true);
      return { reply: "Using that same exact observation [[e1]]." };
    });
    dependencies.previousResult = vi.fn(async () => previous);
    const result = await researchSpace(snapshot, { question: "What are the implications?", previous_job_id: "prior" }, dependencies);
    expect(readingCalls).toBe(1); expect(result.evidence[0].version).toBe(previous.evidence[0].version);
    expect(dependencies.previousResult).toHaveBeenCalledWith("prior");
  });

  it("rejects stale, foreign, differently filtered and forged previous-job evidence before dispatch", async () => {
    const snapshot = fixture(), previous = await researchSpace(snapshot, { question: "Read alpha" }, deps());
    const invalid = [ { ...previous, spaceId: "another" }, { ...previous, snapshotVersion: "old" }, { ...previous, taskView: "history" },
      { ...previous, readerCheckpoint: { ...previous.readerCheckpoint, evidence: [{ ...previous.readerCheckpoint!.evidence[0], text: "Forged text" }] } } ];
    for (const value of invalid) {
      const dependencies = deps(); dependencies.previousResult = vi.fn(async () => value);
      await expect(researchSpace(snapshot, { question: "Follow up", previous_job_id: "prior" }, dependencies)).rejects.toThrow(/older Space|checkpoint/);
      expect(dependencies.chat).not.toHaveBeenCalled();
    }
  });

  it("does not accept a synthesized invented evidence ID", async () => {
    const dependencies = deps(async request => request.mode !== "chat-reading" ? synthesis(["e999"]) :
      !packet(request).evidence.length ? { reply: "", readRequests: [read("alpha")] } : { reply: "Observation [[e1]]." });
    await expect(researchSpace(fixture(), { question: "Read alpha" }, dependencies)).rejects.toThrow("outside its exact context");
  });

  it("stops before further reads or synthesis when freshness is revoked", async () => {
    let stale = false;
    const dependencies = deps(async () => { stale = true; return { reply: "", readRequests: [read("alpha")] }; });
    dependencies.assertCurrent = vi.fn(async () => { if (stale) throw new Error("Space changed"); });
    await expect(researchSpace(fixture(), { question: "Read alpha" }, dependencies)).rejects.toThrow("Space changed");
    expect(dependencies.chat).toHaveBeenCalledOnce();
  });

  it("rejects a late structured answer after cancellation, even if the provider ignores its signal", async () => {
    const controller = new AbortController();
    let finish!: (result: ChatResult) => void;
    const dependencies = deps(async request => {
      if (request.mode !== "chat-reading") return new Promise(resolve => { finish = resolve; });
      return !packet(request).evidence.length ? { reply: "", readRequests: [read("alpha")] } : { reply: "Observation [[e1]]." };
    }, controller);
    const pending = researchSpace(fixture(), { question: "Read alpha" }, dependencies);
    await vi.waitFor(() => expect(finish).toBeDefined());
    controller.abort(new Error("Cancelled by caller")); finish(synthesis());
    await expect(pending).rejects.toThrow("Cancelled by caller");
  });

  it("bounds retained host checkpoint bytes and declares omitted memory without altering the original", async () => {
    const snapshot = fixture(), result = await researchSpace(snapshot, { question: "Read alpha" }, deps());
    const checkpoint = structuredClone(result.readerCheckpoint!);
    checkpoint.completedOperations = Array.from({ length: 32 }, () => ({ request: read("alpha"), result: { evidenceIds: ["e1"], routing: "文".repeat(20_000) } }));
    const retained = retainResearchCheckpoint(checkpoint);
    expect(new TextEncoder().encode(JSON.stringify(retained.checkpoint)).length).toBeLessThanOrEqual(MAX_RESEARCH_CHECKPOINT_BYTES);
    expect(retained.omitted.completedOperations).toBeGreaterThan(0); expect(checkpoint.completedOperations).toHaveLength(32);
    expect(validatedResearchCheckpoint(retained.checkpoint, snapshot, "working")?.evidence).toEqual(checkpoint.evidence);
  });
});
