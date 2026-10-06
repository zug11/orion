// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, Source } from "../types";
import { buildAIImagePrompt, generateContextualNoteImage, ImageGenerationSession, type ImageGenerationProgress } from "./aiImages";
import { parseImagePlanningContext, parseImagePlanningResult, type ImagePlanningRequest, type ImagePlanningResult } from "./aiImagePlanning";

const NOW = "2026-09-29T00:00:00.000Z";
function note(id: string, title: string, body: string): Note {
  return { id, title, slug: id, summary: "An obsolete generic summary.", body, aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: NOW, updatedAt: NOW };
}
function source(id: string, text: string): Source {
  return { id, title: "Original observation", kind: "text", fileName: "observation.txt", mimeType: "text/plain", byteSize: text.length, importedAt: NOW, text, noteIds: [] };
}
function fixture() {
  const snapshot = createEmptySnapshot("Observatory", NOW);
  snapshot.settings.includeExistingNotesInAIContext = true;
  snapshot.notes = [note("origin", "The network", "The network has no centre. Here network refers to mycelium, not computers."),
    note("related", "Mycelium", "Hyphae connect roots without a central controller.")];
  snapshot.notes[0].sourceIds = ["original"];
  snapshot.sources = [source("original", "The observed mycelium formed branching hyphae between tree roots.")];
  return snapshot;
}
const brief = { visualBrief: "An underground mycelium network connecting tree roots, no computer imagery.", alt: "Branching mycelium between tree roots", evidenceIds: [] as string[] };
const image = { fileName: "image.jpg", mimeType: "image/jpeg" as const, byteSize: 4, base64Data: "/9j/2Q==" };
const input = { originNoteId: "origin", selectedText: "The network has no centre.", instruction: "Use a cutaway view." };
type Context = { evidence: Array<{ id: string; entityId: string; kind: string; passages: Array<{ start: number; end: number; text: string }> }>; question?: string; findings?: Array<{ summary: string }> };
function response(request: ImagePlanningRequest): ImagePlanningResult {
  const context = JSON.parse(request.context) as Context;
  if (request.stage === "search") return { queries: ["mycelium hyphae roots"], focus: "Explain the biological network." };
  if (request.stage === "read" || request.stage === "merge") return {
    summary: context.evidence.map((item) => item.passages.map((part) => part.text).join(" ")).join(" ").slice(0, 3000),
    evidenceIds: context.evidence.map((item) => item.id), queries: [], complete: true,
  };
  return { ...brief, evidenceIds: context.evidence.map((item) => item.id) };
}
function drivers() {
  return { plan: vi.fn(async (request: ImagePlanningRequest) => response(request)), render: vi.fn().mockResolvedValue(image) };
}

describe("adaptive image research", () => {
  it("searches from the selection, reads exact evidence and passes a compressed handoff to composition", async () => {
    const snapshot = fixture(); snapshot.settings.model = "gpt-6-astra"; snapshot.settings.reasoningEffort = "xhigh";
    const calls = drivers(); const progress: ImageGenerationProgress[] = [];
    const result = await generateContextualNoteImage(snapshot, input, calls, { onProgress: (value) => progress.push(value) });
    expect(calls.plan.mock.calls.map(([request]) => request.stage)).toEqual(["search", "read", "compose"]);
    const first = calls.plan.mock.calls[0][0];
    expect(first).toMatchObject({ model: "gpt-6-astra", effort: "low" });
    expect(JSON.parse(first.context)).not.toHaveProperty("directory");
    expect(JSON.parse(first.context).evidence).toEqual([]);
    expect(first.context).not.toContain("An obsolete generic summary");
    const compose = calls.plan.mock.calls[2][0];
    expect(compose).toMatchObject({ effort: "xhigh", timeoutMs: 240_000 });
    const context = JSON.parse(compose.context) as Context;
    expect(context.evidence.some((item) => item.entityId === "related")).toBe(true);
    expect(context.evidence.some((item) => item.entityId === "original")).toBe(true);
    for (const evidence of context.evidence) {
      const body = evidence.kind === "note" ? snapshot.notes.find((item) => item.id === evidence.entityId)!.body : snapshot.sources.find((item) => item.id === evidence.entityId)!.text;
      for (const passage of evidence.passages) expect(body.slice(passage.start, passage.end)).toBe(passage.text);
    }
    expect(context.findings?.[0].summary).toContain("hyphae");
    expect(calls.render).toHaveBeenCalledWith(expect.stringContaining(brief.visualBrief), expect.any(AbortSignal), "detailed");
    expect(result.alt).toBe(brief.alt);
    expect(progress.map((value) => value.stage)).toContain("read");
  });

  it("finds a relevant note after hundreds of unrelated notes without reading a quota", async () => {
    const snapshot = fixture();
    snapshot.notes = [snapshot.notes[0], ...Array.from({ length: 150 }, (_, i) => note(`filler-${i}`, `Chores ${i}`, `Shopping and washing ${i}.`)), note("hidden", "Fungal branching", "Hyphae connect distant tree roots.")];
    const calls = drivers(); await generateContextualNoteImage(snapshot, input, calls);
    const read = calls.plan.mock.calls.find(([request]) => request.stage === "read")![0];
    const evidence = (JSON.parse(read.context) as Context).evidence;
    expect(evidence.some((item) => item.entityId === "hidden")).toBe(true);
    expect(evidence.some((item) => item.entityId.startsWith("filler"))).toBe(false);
  });

  it("fans out over independent questions, deepens unresolved branches, then merges", async () => {
    const snapshot = fixture();
    snapshot.notes.push(note("cost", "Compliance", "Compliance costs create a fixed burden."), note("entry", "Competition", "Competition changes when entry requirements grow."), note("contracts", "Procurement", "Procurement contracts can intensify the fixed burden."));
    const calls = drivers(); let active = 0; let maximum = 0;
    calls.plan.mockImplementation(async (request) => {
      if (request.stage === "search") return { queries: ["compliance", "competition"], focus: "Understand entry barriers." };
      if (request.stage === "read") {
        active += 1; maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1;
        const result = response(request);
        return JSON.parse(request.context).question === "compliance" ? { ...result, complete: false, queries: ["procurement"] } as ImagePlanningResult : result;
      }
      return response(request);
    });
    await generateContextualNoteImage(snapshot, input, calls);
    expect(maximum).toBeGreaterThan(1); expect(maximum).toBeLessThanOrEqual(3);
    expect(calls.plan.mock.calls.filter(([request]) => request.stage === "read").map(([request]) => JSON.parse(request.context).question)).toEqual(expect.arrayContaining(["compliance", "competition", "procurement"]));
    expect(calls.plan.mock.calls.some(([request]) => request.stage === "merge")).toBe(true);
  });

  it("uses live surroundings to disambiguate searches and live origin text as evidence", async () => {
    const calls = drivers();
    await generateContextualNoteImage(fixture(), { ...input, documentMarkdown: "Fresh mycelium research.", beforeMarkdown: "Fresh introduction.", afterMarkdown: "Fresh conclusion." }, calls);
    expect(JSON.parse(calls.plan.mock.calls[0][0].context).selectionContext).toEqual({ before: "Fresh introduction.", after: "Fresh conclusion." });
    const read = JSON.parse(calls.plan.mock.calls.find(([request]) => request.stage === "read")![0].context) as Context;
    expect(read.evidence.find((item) => item.entityId === "origin")?.passages[0].text).toBe("Fresh mycelium research.");
  });

  it("lets independent questions read shared evidence without charging it twice", async () => {
    const snapshot = fixture(); const calls = drivers(); const session = new ImageGenerationSession();
    calls.plan.mockImplementation(async (request) => request.stage === "search"
      ? { queries: ["hyphae", "roots"], focus: "Compare the structure and function of this network." } : response(request));
    await generateContextualNoteImage(snapshot, input, calls, { session });
    const reads = calls.plan.mock.calls.filter(([request]) => request.stage === "read").map(([request]) => JSON.parse(request.context) as Context);
    expect(reads).toHaveLength(2);
    const ids = reads.map((read) => read.evidence.map((item) => item.id));
    expect(ids[0].some((id) => ids[1].includes(id))).toBe(true);
    expect(session.evidence.size).toBe(new Set(ids.flat()).size);
  });

  it("reads more than sixteen relevant notes when useful, and discloses the emergency evidence ceiling", async () => {
    const snapshot = fixture(); const calls = drivers(); const session = new ImageGenerationSession();
    snapshot.notes.push(...Array.from({ length: 120 }, (_, i) => note(`observation-${i}`, `Roots ${i}`, `Mycelium observation ${i}: hyphae reach tree roots.`)));
    calls.plan.mockImplementation(async (request) => request.stage === "search"
      ? { queries: ["mycelium", "hyphae"], focus: "Compare the observations." } : response(request));
    const result = await generateContextualNoteImage(snapshot, input, calls, { session });
    const reads = calls.plan.mock.calls.filter(([request]) => request.stage === "read");
    expect(reads).toHaveLength(2);
    expect(session.evidence.size).toBeGreaterThan(16);
    expect(session.evidence.size).toBeLessThanOrEqual(96);
    expect(result.contextNotice).toContain("partial");
    for (const [request] of calls.plan.mock.calls) expect(JSON.parse(request.context).evidence.length).toBeLessThanOrEqual(96);
  });

  it("finishes prepared readers when later questions exhaust the byte budget", async () => {
    const snapshot = fixture(); const calls = drivers(); const session = new ImageGenerationSession();
    const queries = ["copper", "silver", "carbon", "iron", "sulfur", "nickel"];
    snapshot.notes.push(...queries.flatMap((query) => Array.from({ length: 8 }, (_, i) =>
      note(`${query}-${i}`, `${query} study ${i}`, `${query} ${i} ${"樹木の観測と分析。".repeat(130)}`))));
    calls.plan.mockImplementation(async (request) => request.stage === "search"
      ? { queries, focus: "Compare the studies." } : response(request));
    const result = await generateContextualNoteImage(snapshot, input, calls, { session });
    expect(session.branches.filter((branch) => branch.evidence?.length).every((branch) => branch.finding)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify([...session.evidence.values()])).length).toBeLessThanOrEqual(64_000);
    expect(result.contextNotice).toContain("partial");
    expect(calls.render).toHaveBeenCalledOnce();
  });

  it("reserves compression work adaptively when broad branches return long multibyte findings", async () => {
    const calls = drivers(); const session = new ImageGenerationSession(); let sequence = 0;
    calls.plan.mockImplementation(async (request) => {
      if (request.stage === "search") return { queries: Array.from({ length: 6 }, (_, i) => `mycelium direction ${i}`), focus: "Resolve the different interpretations." };
      if (request.stage === "read" || request.stage === "merge") {
        return { summary: "🌳".repeat(3_200), evidenceIds: (JSON.parse(request.context) as Context).evidence.map((item) => item.id),
          queries: Array.from({ length: 3 }, () => `mycelium refinement ${sequence++} ${"🌱".repeat(180)}`), complete: false };
      }
      return response(request);
    });
    const result = await generateContextualNoteImage(fixture(), { ...input, selectedText: "🌱".repeat(32_000) }, calls, { session });
    expect(calls.plan.mock.calls.filter(([request]) => request.stage !== "compose").length).toBeLessThanOrEqual(18);
    expect(calls.plan.mock.calls.filter(([request]) => request.stage === "read").length).toBeGreaterThan(6);
    for (const [request] of calls.plan.mock.calls) expect(new TextEncoder().encode(request.context).length).toBeLessThan(256_000);
    expect(calls.render).toHaveBeenCalledOnce();
    expect(result.contextNotice).toContain("partial");
  });

  it.each([false, true])("Selection only sends no title, surrounding prose or Space signals with global context %s", async (global) => {
    const snapshot = fixture(); snapshot.settings.includeExistingNotesInAIContext = global;
    const calls = drivers();
    await generateContextualNoteImage(snapshot, { ...input, contextMode: "selection", documentMarkdown: "Private surrounding prose", beforeMarkdown: "Private before", quality: "fast" }, calls);
    expect(calls.plan).toHaveBeenCalledOnce();
    expect(JSON.parse(calls.plan.mock.calls[0][0].context)).toEqual({ selectedPassage: input.selectedText, activeNoteTitle: "", visualDirection: input.instruction, contextEnabled: false, evidence: [] });
    expect(calls.render).toHaveBeenCalledWith(expect.not.stringContaining("Active note:"), expect.any(AbortSignal), "fast");
  });

  it("defaults to the global privacy setting and accepts explicit one-request Space consent", async () => {
    const snapshot = fixture(); snapshot.settings.includeExistingNotesInAIContext = false;
    const calls = drivers(); await generateContextualNoteImage(snapshot, input, calls);
    expect(calls.plan).toHaveBeenCalledOnce(); calls.plan.mockClear();
    await generateContextualNoteImage(snapshot, { ...input, contextMode: "space" }, calls);
    expect(calls.plan.mock.calls[0][0].stage).toBe("search");
    expect(snapshot.settings.includeExistingNotesInAIContext).toBe(false);
  });

  it("does not read unrelated notes when search finds no matches", async () => {
    const calls = drivers(); calls.plan.mockImplementation(async (request) => request.stage === "search" ? { queries: ["zygomorphicquartz"], focus: "Find a match." } : response(request));
    await generateContextualNoteImage(fixture(), input, calls);
    expect(calls.plan.mock.calls.map(([request]) => request.stage)).toEqual(["search", "compose"]);
    expect(JSON.parse(calls.plan.mock.calls[1][0].context).evidence).toEqual([]);
  });

  it.each(["read", "merge", "compose"])("rejects invented evidence at the %s handoff before rendering", async (stage) => {
    const snapshot = fixture(); snapshot.notes.push(note("different", "Counterexample", "Counterexample observations disagree."));
    const calls = drivers(); calls.plan.mockImplementation(async (request) => {
      if (request.stage === "search") return { queries: ["mycelium", "counterexample"], focus: "Compare observations." };
      return request.stage === stage ? { ...response(request), evidenceIds: ["source:other-space"] } : response(request);
    });
    await expect(generateContextualNoteImage(snapshot, input, calls)).rejects.toThrow("did not read");
    expect(calls.render).not.toHaveBeenCalled();
  });

  it("retries a failed compose stage without redoing successful research", async () => {
    const snapshot = fixture(); const calls = drivers(); const session = new ImageGenerationSession(); let fail = true;
    calls.plan.mockImplementation(async (request) => { if (request.stage === "compose" && fail) { fail = false; throw new Error("The illustration planner did not finish within 90 seconds"); } return response(request); });
    await expect(generateContextualNoteImage(snapshot, input, calls, { session })).rejects.toThrow("Preparing the image brief failed");
    expect(calls.render).not.toHaveBeenCalled();
    await generateContextualNoteImage(snapshot, input, calls, { session });
    expect(calls.plan.mock.calls.map(([request]) => request.stage)).toEqual(["search", "read", "compose", "compose"]);
    expect(session.diagnostics.some((entry) => entry.stage === "compose" && entry.kind === "timeout")).toBe(true);
  });

  it("retains successful reader siblings while retrying only the failed branch", async () => {
    const snapshot = fixture(); snapshot.notes.push(note("counter", "Counterexample", "Counterexample observations disagree."));
    const session = new ImageGenerationSession(); const calls = drivers(); let fail = true;
    calls.plan.mockImplementation(async (request) => {
      if (request.stage === "search") return { queries: ["mycelium", "counterexample"], focus: "Compare evidence." };
      if (request.stage === "read" && JSON.parse(request.context).question === "counterexample" && fail) { fail = false; throw new Error("Provider unavailable"); }
      return response(request);
    });
    await expect(generateContextualNoteImage(snapshot, input, calls, { session })).rejects.toThrow("Provider unavailable");
    await generateContextualNoteImage(snapshot, input, calls, { session });
    const reads = calls.plan.mock.calls.filter(([request]) => request.stage === "read").map(([request]) => JSON.parse(request.context).question);
    expect(reads.filter((query) => query === "mycelium")).toHaveLength(1);
    expect(reads.filter((query) => query === "counterexample")).toHaveLength(2);
  });

  it("reuses the brief after rendering failure, and retains downloaded images for insertion retry", async () => {
    const snapshot = fixture(); const calls = drivers(); const session = new ImageGenerationSession();
    calls.render.mockRejectedValueOnce(new Error("Image transport failed"));
    await expect(generateContextualNoteImage(snapshot, input, calls, { session })).rejects.toThrow("Image transport failed");
    const planned = calls.plan.mock.calls.length;
    await generateContextualNoteImage(snapshot, input, calls, { session });
    await generateContextualNoteImage(snapshot, input, calls, { session });
    expect(calls.plan).toHaveBeenCalledTimes(planned); expect(calls.render).toHaveBeenCalledTimes(2);
    session.clearImage(); await generateContextualNoteImage(snapshot, input, calls, { session });
    expect(calls.plan).toHaveBeenCalledTimes(planned); expect(calls.render).toHaveBeenCalledTimes(3);
  });

  it("ignores unrelated edits but invalidates changed evidence before rendering and on retry", async () => {
    const snapshot = fixture(); snapshot.notes.push(note("unrelated", "Shopping", "Buy apples."));
    let current = structuredClone(snapshot); const calls = drivers();
    calls.plan.mockImplementation(async (request) => { current.notes.find((item) => item.id === "unrelated")!.body = "Buy oranges."; return response(request); });
    await generateContextualNoteImage(snapshot, input, calls, { currentSnapshot: () => current });
    expect(calls.render).toHaveBeenCalledOnce();
    const session = new ImageGenerationSession(); current = structuredClone(snapshot);
    calls.render.mockClear(); calls.plan.mockImplementation(async (request) => {
      if (request.stage === "read") current.notes[1].body = "Different evidence";
      return response(request);
    });
    await expect(generateContextualNoteImage(snapshot, input, calls, { session, currentSnapshot: () => current })).rejects.toThrow("supporting passage changed");
    expect(calls.render).not.toHaveBeenCalled();
    calls.plan.mockImplementation(async (request) => response(request));
    await generateContextualNoteImage(current, input, calls, { session });
    expect(calls.render).toHaveBeenCalledOnce();
  });

  it.each(["space", "settings", "origin", "cancel"])("prevents late commits on %s changes", async (change) => {
    const snapshot = fixture(); let current = structuredClone(snapshot); const controller = new AbortController(); const calls = drivers();
    calls.plan.mockImplementation(async (request) => {
      if (change === "space") current.workspace.id = "foreign";
      if (change === "settings") current.settings.includeExistingNotesInAIContext = false;
      if (change === "origin") current.notes[0].body = "Changed selection";
      if (change === "cancel") controller.abort(new Error("User cancelled"));
      return response(request);
    });
    await expect(generateContextualNoteImage(snapshot, input, calls, { signal: controller.signal, currentSnapshot: () => current })).rejects.toThrow();
    expect(calls.render).not.toHaveBeenCalled();
  });

  it("does not resurrect a cleared session after a late provider response", async () => {
    const session = new ImageGenerationSession(); const calls = drivers();
    calls.plan.mockImplementation(async (request) => { session.clear(); return response(request); });
    await expect(generateContextualNoteImage(fixture(), input, calls, { session })).rejects.toThrow("cancelled");
    expect(session.search).toBeUndefined(); expect(calls.render).not.toHaveBeenCalled();
  });

  it("bounds Unicode packets and rejects unknown output actions", async () => {
    const snapshot = fixture(); const calls = drivers();
    await generateContextualNoteImage(snapshot, { ...input, selectedText: "🌲".repeat(32_000) }, calls);
    for (const [request] of calls.plan.mock.calls) expect(new TextEncoder().encode(request.context).length).toBeLessThan(256_000);
    expect(() => buildAIImagePrompt(snapshot, { originNoteId: "origin" }, brief)).toThrow("Select the passage");
    expect(() => buildAIImagePrompt(snapshot, { ...input, selectedText: "x".repeat(32_001) }, brief)).toThrow("too large");
    expect(() => parseImagePlanningResult({ ...brief, noteActions: [] }, "compose")).toThrow();
    expect(() => parseImagePlanningContext({ stage: "search", context: JSON.stringify({ selectedPassage: "x", contextEnabled: false, evidence: [] }) })).toThrow();
  });
});
