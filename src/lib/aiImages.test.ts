// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, Source } from "../types";
import { buildAIImagePrompt, generateContextualNoteImage } from "./aiImages";
import { parseImagePlanningContext, parseImagePlanningResult, type ImagePlanningRequest, type ImagePlanningResult } from "./aiImagePlanning";

const NOW = "2026-09-26T00:00:00.000Z";
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
  snapshot.spaceOverview = { title: "A generic old overview", body: "An undefined thread in the atlas", relatedNoteIds: [], generatedAt: NOW, stale: true };
  return snapshot;
}
const brief = { visualBrief: "An underground mycelium network connecting tree roots, no computer imagery.", alt: "Branching mycelium between tree roots", evidenceIds: ["note:related", "source:original"] };
const image = { fileName: "image.jpg", mimeType: "image/jpeg" as const, byteSize: 4, base64Data: "/9j/2Q==" };
const input = { originNoteId: "origin", selectedText: "The network has no centre.", instruction: "Use a cutaway view." };
function drivers() {
  return { plan: vi.fn<(request: ImagePlanningRequest, signal?: AbortSignal) => Promise<ImagePlanningResult>>()
    .mockResolvedValueOnce({ queries: ["mycelium hyphae roots"], noteIds: ["related"], sourceIds: ["original"] })
    .mockResolvedValueOnce(brief), render: vi.fn().mockResolvedValue(image) };
}

describe("Space-aware illustration planning", () => {
  it("reads exact notes and original source text before rendering an interpreted brief", async () => {
    const snapshot = fixture();
    snapshot.settings.model = "claude-sonnet-5";
    snapshot.settings.reasoningEffort = "high";
    const calls = drivers();
    const result = await generateContextualNoteImage(snapshot, input, calls);
    expect(calls.plan).toHaveBeenCalledTimes(2);
    const first = calls.plan.mock.calls[0][0];
    expect(first).toMatchObject({ stage: "select", model: "claude-sonnet-5", effort: "high" });
    expect(first.context).not.toContain("An undefined thread");
    const context = JSON.parse(calls.plan.mock.calls[1][0].context);
    expect(context.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "note:related", passages: [{ start: 0, end: snapshot.notes[1].body.length, text: snapshot.notes[1].body }] }),
      expect.objectContaining({ id: "source:original", passages: [{ start: 0, end: snapshot.sources[0].text.length, text: snapshot.sources[0].text }] }),
    ]));
    expect(calls.render).toHaveBeenCalledOnce();
    expect(calls.render.mock.calls[0][0]).toContain(brief.visualBrief);
    expect(calls.render.mock.calls[0][0]).toContain(input.selectedText);
    expect(calls.render.mock.calls[0][0]).toContain(input.instruction);
    expect(result.alt).toBe(brief.alt);
    expect(snapshot.notes[0].body).not.toContain("orion-image");
  });

  it("can discover relevant notes and source passages beyond the initial directory and body prefix", async () => {
    const snapshot = fixture();
    snapshot.notes = [snapshot.notes[0], ...Array.from({ length: 18 }, (_, i) => note(`filler-${i}`, "Network", "The network has no centre.")),
      note("hidden", "Fungal branching", "Hyphae connect distant tree roots.")];
    snapshot.sources = [...Array.from({ length: 14 }, (_, i) => source(`filler-source-${i}`, "The network has no centre.")),
      source("deep", `${"A separate observation. ".repeat(600)}Mycelium connects roots through branching hyphae.`)];
    const calls = { plan: vi.fn(async (request: ImagePlanningRequest) => {
      if (request.stage === "select") {
        expect(request.context).not.toContain('"id":"hidden"');
        expect(request.context).not.toContain('"id":"deep"');
        return { queries: ["hyphae mycelium"], noteIds: [], sourceIds: [] };
      }
      const context = JSON.parse(request.context);
      expect(context.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "note:hidden" }), expect.objectContaining({ id: "source:deep", complete: false }),
      ]));
      const evidence = context.evidence.find((item: { id: string }) => item.id === "source:deep");
      expect(evidence.passages.some((part: { text: string; start: number; end: number }) => {
        expect(part.text).toBe(snapshot.sources[snapshot.sources.length - 1].text.slice(part.start, part.end));
        return part.text.includes("branching hyphae");
      })).toBe(true);
      return { ...brief, evidenceIds: ["note:hidden", "source:deep"] };
    }), render: vi.fn().mockResolvedValue(image) };
    await generateContextualNoteImage(snapshot, input, calls);
  });

  it("uses captured live editor text and nearby context instead of a stale persisted body", async () => {
    const snapshot = fixture();
    const calls = drivers();
    await generateContextualNoteImage(snapshot, { ...input, documentMarkdown: "Fresh mycelium research.", beforeMarkdown: "Fresh introduction.", afterMarkdown: "Fresh conclusion." }, calls);
    const context = JSON.parse(calls.plan.mock.calls[0][0].context);
    expect(context.selectionContext).toEqual({ before: "Fresh introduction.", after: "Fresh conclusion." });
    expect(context.evidence[0].passages[0].text).toBe("Fresh mycelium research.");
    expect(context.evidence[0].passages[0].text).not.toContain("computers");
  });

  it("sends only the selection, title and direction when existing context is disabled", async () => {
    const snapshot = fixture();
    snapshot.settings.includeExistingNotesInAIContext = false;
    const calls = { plan: vi.fn().mockResolvedValue({ ...brief, evidenceIds: [] }), render: vi.fn().mockResolvedValue(image) };
    await generateContextualNoteImage(snapshot, { ...input, documentMarkdown: "Private surrounding prose", beforeMarkdown: "Private before" }, calls);
    expect(calls.plan).toHaveBeenCalledOnce();
    const request = calls.plan.mock.calls[0][0];
    expect(request.stage).toBe("compose");
    expect(JSON.parse(request.context)).toEqual({ selectedPassage: input.selectedText, activeNoteTitle: "The network", visualDirection: input.instruction, contextEnabled: false, evidence: [] });
    expect(request.context).not.toContain("mycelium");
  });

  it.each(["noteIds", "sourceIds"] as const)("rejects unknown or cross-Space %s before any second call or image request", async (key) => {
    const calls = drivers();
    calls.plan.mockReset().mockResolvedValue({ queries: [], noteIds: [], sourceIds: [], [key]: ["foreign-space-record"] });
    await expect(generateContextualNoteImage(fixture(), input, calls)).rejects.toThrow("active-Space directory");
    expect(calls.plan).toHaveBeenCalledOnce();
    expect(calls.render).not.toHaveBeenCalled();
  });

  it("rejects invented evidence references and planner write actions", async () => {
    const calls = drivers();
    calls.plan.mockReset().mockResolvedValueOnce({ queries: [], noteIds: [], sourceIds: [] }).mockResolvedValueOnce({ ...brief, evidenceIds: ["source:invented"] });
    await expect(generateContextualNoteImage(fixture(), input, calls)).rejects.toThrow("did not read");
    expect(calls.render).not.toHaveBeenCalled();
    expect(() => parseImagePlanningResult({ ...brief, noteActions: [{ title: "Bad write" }] }, "compose")).toThrow("invalid");
  });

  it.each(["cancel", "space", "settings", "source"])("stops before rendering if %s changes during planning", async (change) => {
    const snapshot = fixture();
    let current = structuredClone(snapshot);
    const controller = new AbortController();
    const calls = drivers();
    calls.plan.mockReset().mockImplementation(async () => {
      if (change === "cancel") controller.abort(new Error("Stopped"));
      if (change === "space") current = { ...current, workspace: { ...current.workspace, id: "other-space" } };
      if (change === "settings") current.settings.includeExistingNotesInAIContext = false;
      if (change === "source") current.sources[0].text = "Changed evidence";
      return { queries: [], noteIds: [], sourceIds: [] };
    });
    await expect(generateContextualNoteImage(snapshot, input, calls, { signal: controller.signal, currentSnapshot: () => current })).rejects.toThrow();
    expect(calls.plan).toHaveBeenCalledOnce();
    expect(calls.render).not.toHaveBeenCalled();
  });

  it("fails without charging for an image if planning fails", async () => {
    const calls = drivers();
    calls.plan.mockReset().mockRejectedValue(new Error("Provider unavailable"));
    await expect(generateContextualNoteImage(fixture(), input, calls)).rejects.toThrow("Provider unavailable");
    expect(calls.render).not.toHaveBeenCalled();
  });

  it("bounds Unicode packets and results, rejects empty/oversized selections and keeps exact highlights", async () => {
    const snapshot = fixture();
    const calls = drivers();
    calls.plan.mockReset().mockResolvedValueOnce({ queries: [], noteIds: [], sourceIds: [] }).mockResolvedValueOnce({ ...brief, evidenceIds: [] });
    snapshot.notes[0].body = "🌲".repeat(10_000);
    await generateContextualNoteImage(snapshot, { ...input, selectedText: "🌲".repeat(32_000) }, calls);
    calls.plan.mock.calls.forEach(([request]) => expect(new TextEncoder().encode(request.context).length).toBeLessThan(256_000));
    expect(() => buildAIImagePrompt(snapshot, { originNoteId: "origin" }, brief)).toThrow("Select the passage");
    expect(() => buildAIImagePrompt(snapshot, { ...input, selectedText: "x".repeat(32_001) }, brief)).toThrow("too large");
    expect(() => parseImagePlanningResult({ ...brief, visualBrief: "x".repeat(6_001) }, "compose")).toThrow("invalid");
    expect(() => parseImagePlanningResult({ queries: ["a", "a"], noteIds: [], sourceIds: [] }, "select")).toThrow("invalid");
    expect(() => parseImagePlanningContext({ stage: "compose", context: JSON.stringify({ selectedPassage: "x", contextEnabled: false, evidence: [], directory: [] }) })).toThrow("invalid");
  });
});
