import { describe, expect, it, vi } from "vitest";
import { createEmptyVault } from "../../data/defaults";
import type { AppSnapshot, ChatRequest, Note, OrganizeContentResult } from "../../types";
import { buildImportPayload } from "../../components/ImportStudio";
import { buildAssistantContext, exactPassages, validateResearchResult } from "./context";
import { executeAssistantWorkflow } from "./workflows";
import { composeWorkflowVault, rebaseCommittedWorkflow } from "./commit";
import type { WorkflowDependencies } from "./types";

const note = (id: string, body = "A durable observation about tides and lunar gravity."): Note => ({ id, title: id, body, summary: "", slug: id, aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: "2026-01-01", updatedAt: "2026-01-01" });
const fixture = () => {
  const vault = createEmptyVault();
  const space = vault.spaces[0];
  space.notes = [note("tides"), note("gravity")];
  space.settings.assistantAccess = { enabled: true, allowAI: true, allowWrites: true, spaceIds: [space.workspace.id] };
  space.settings.apiKeyConfigured = true;
  return vault;
};
function dependencies(): WorkflowDependencies {
  return {
    signal: new AbortController().signal, assertCurrent: vi.fn(async () => {}), progress: vi.fn(async () => {}),
    chat: vi.fn(async () => ({ reply: "A generated article." })),
    organize: vi.fn(async (): Promise<OrganizeContentResult> => ({ notes: [], wikiArticles: [], concepts: [], suggestedConnections: [] })),
    driver: vi.fn(async () => { throw new Error("Unexpected knowledge provider call"); }),
    buildImportPayload,
    readInput: vi.fn(async () => ({ title: "Observation", fileName: "observation.txt", mimeType: "text/plain", byteSize: 32, format: "text" as const, text: "An imported observation with a complete source.", warnings: [] })),
    previousResult: vi.fn(async () => ({})), illustrate: vi.fn(async (body) => ({ body, warnings: [] })),
  };
}

describe("desktop workflow evidence", () => {
  it("returns exact Unicode-safe ranges, versions, and bounded coverage", () => {
    const body = `${"Prefix ".repeat(1000)} a lunar evidence marker 🌔 ${"Suffix ".repeat(1000)}`;
    const ranges = exactPassages(body, "lunar evidence", 4_000);
    expect(ranges.some((range) => range.text.includes("lunar evidence"))).toBe(true);
    for (const range of ranges) expect(body.slice(range.start, range.end)).toBe(range.text);
    const space = fixture().spaces[0]; space.notes[0].body = body;
    const packet = buildAssistantContext(space, { query: "lunar evidence", note_ids: ["tides"] });
    expect(packet.evidence[0].complete).toBe(false);
    expect(packet.evidence[0].notes[0].orionUrl).toContain(encodeURIComponent(space.workspace.id));
    expect(packet.coverage.exhaustive).toBe(false);
    expect(() => buildAssistantContext(space, { query: "tides", note_ids: ["another-space-note"] })).toThrow("exact Space");
  });
  it("rejects fabricated evidence references and derives citations locally", () => {
    const evidence = buildAssistantContext(fixture().spaces[0], { query: "tides" }).evidence;
    const value = { answer: "Tides", findings: [{ claim: "The author discusses lunar gravity.", kind: "fact", evidenceIds: [evidence[0].id] }], gaps: [], followUpQuestions: [] };
    expect(validateResearchResult(value, evidence).findings[0].citations[0].id).toBe(evidence[0].entityId);
    value.findings[0].evidenceIds = ["note:invented"];
    expect(() => validateResearchResult(value, evidence)).toThrow("outside");
  });
  it("keeps context local and blocks AI when existing-note context is off", async () => {
    const space = fixture().spaces[0]; space.settings.includeExistingNotesInAIContext = false;
    const deps = dependencies();
    const context = await executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "a", operation: "context", input: { query: "tides" } }, deps);
    expect(context.result.providerCalls).toBe(0);
    await expect(executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "b", operation: "research", input: { question: "Why?" } }, deps)).rejects.toThrow("context is off");
    expect(deps.chat).not.toHaveBeenCalled(); expect(deps.driver).not.toHaveBeenCalled();
  });
  it("sends bounded research records without Chat history or write authority", async () => {
    const space = fixture().spaces[0]; const deps = dependencies();
    deps.chat = vi.fn(async (request: ChatRequest) => {
      expect(request.prompt.length).toBeLessThan(8_000);
      expect(request.notes.every((item) => item.body.length <= 8_000)).toBe(true);
      expect(request.history).toEqual([]); expect(request.allowNoteActions).toBeUndefined();
      return { reply: JSON.stringify({ answer: "Insufficient evidence.", findings: [], gaps: ["Missing measurements."], followUpQuestions: [] }) };
    });
    const result = await executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "research", operation: "research", input: { question: "Q".repeat(8_000), material: "M".repeat(24_000) } }, deps);
    expect(result.snapshot).toBeUndefined(); expect(result.result.gaps).toEqual(["Missing measurements."]);
  });
});

describe("desktop workflow writes", () => {
  it("uses the real local import assembler and preserves the full source without AI", async () => {
    const space = fixture().spaces[0]; space.settings.assistantAccess.allowAI = false;
    const original = structuredClone(space); const deps = dependencies();
    const outcome = await executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "import", operation: "import", input: { mode: "local", inputs: [{ kind: "text", title: "Observation", text: "Material" }] } }, deps);
    expect(outcome.snapshot?.sources[0].text).toBe("An imported observation with a complete source.");
    expect(outcome.snapshot?.notes).toHaveLength(3);
    expect(outcome.snapshot?.activeNoteId).toBe(space.activeNoteId);
    expect(space).toEqual(original); expect(deps.chat).not.toHaveBeenCalled(); expect(deps.driver).not.toHaveBeenCalled();
    expect(outcome.result.sourceIds).toHaveLength(1);
  });
  it("reuses preserved source IDs, original import time, and citation targets in assembly", () => {
    const space = fixture().spaces[0];
    space.sources = [{ id: "preserved", title: "Original", kind: "text", text: "Original extracted text", importedAt: "2020-01-01", noteIds: ["tides"] }];
    const payload = buildImportPayload([{ item: { id: "input", fileName: "original.txt", mimeType: "text/plain", byteSize: 23, status: "ready", included: true,
      parsed: { title: "Original", fileName: "original.txt", mimeType: "text/plain", byteSize: 23, format: "text", text: "Original extracted text", warnings: [] } } }], space, "New focus", new Map([["input", "preserved"]]));
    expect(payload.sources[0].id).toBe("preserved"); expect(payload.sources[0].importedAt).toBe("2020-01-01");
    expect(payload.sources[0].noteIds).toContain("tides"); expect(payload.notes[0].sourceIds).toEqual(["preserved"]);
  });
  it("generates without exposing private notes when context is disabled", async () => {
    const space = fixture().spaces[0]; space.settings.includeExistingNotesInAIContext = false;
    space.notes[0].body = "PRIVATE_UNIQUE_CONTENT"; const deps = dependencies();
    deps.chat = vi.fn(async (request) => { expect(JSON.stringify(request)).not.toContain("PRIVATE_UNIQUE_CONTENT"); return { reply: "A self-contained generated article." }; });
    const outcome = await executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "generate", operation: "generate", input: { kind: "note", instruction: "Write about lunar phases" } }, deps);
    expect(outcome.snapshot?.notes).toHaveLength(3);
    expect(outcome.snapshot?.notes[outcome.snapshot.notes.length - 1]?.tags).not.toContain("orion-generate-pending");
    expect(outcome.snapshot?.studio).toEqual(space.studio);
  });
  it("rejects revoked write permission before reading an import file", async () => {
    const space = fixture().spaces[0]; space.settings.assistantAccess.allowWrites = false; const deps = dependencies();
    await expect(executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "no", operation: "import", input: { inputs: [{ kind: "file", path: "/tmp/a.pdf" }] } }, deps)).rejects.toThrow("writes are disabled");
    expect(deps.readInput).not.toHaveBeenCalled();
  });
  it("develops an existing canonical article without duplicating it and preserves source back-references", async () => {
    const space = fixture().spaces[0]; const deps = dependencies();
    space.sources = [{ id: "source-a", title: "Observation", kind: "text", text: "Lunar gravity influences tides.", importedAt: "2026-01-01", noteIds: ["tides"] }];
    space.notes[0].sourceIds = ["source-a"];
    deps.organize = vi.fn(async (request) => {
      expect(request.content).toContain("Existing canonical article to preserve and develop");
      return { notes: [{ title: "gravity", summary: "", body: "Lunar gravity shapes the tides.", aliases: [], tags: [], links: [] }], wikiArticles: [], concepts: [], suggestedConnections: [] };
    });
    const outcome = await executeAssistantWorkflow(space, { space_id: space.workspace.id, request_id: "develop", operation: "develop_concept", input: { title: "gravity", origin_note_id: "tides" } }, deps);
    expect(outcome.snapshot?.notes).toHaveLength(2);
    expect(outcome.snapshot?.notes.find((note) => note.id === "gravity")?.sourceIds).toEqual(["source-a"]);
    expect(outcome.snapshot?.sources[0].noteIds).toEqual(["tides", "gravity"]);
  });
});

describe("workflow commits alongside user edits", () => {
  it("rejects changed knowledge before saving and preserves other Spaces and navigation", () => {
    const vault = fixture(); const base = vault.spaces[0]; const generated = { ...base, notes: [...base.notes, note("new")] };
    const proposed = composeWorkflowVault(vault, base, generated);
    expect(proposed.activeSpaceId).toBe(vault.activeSpaceId); expect(proposed.spaces[0].activeNoteId).toBe(base.activeNoteId);
    const changed = structuredClone(vault); changed.spaces[0].notes[0].body = "New user edit";
    expect(() => composeWorkflowVault(changed, base, generated)).toThrow("changed");
  });
  it("preserves edits and deletions that arrive while the native commit is in flight", () => {
    const vault = fixture(); const base = vault.spaces[0];
    const generated: AppSnapshot = { ...base, notes: [note("tides", "AI revision"), base.notes[1], note("new")] };
    const saved = composeWorkflowVault(vault, base, generated);
    const live = structuredClone(vault); live.spaces[0].notes = [note("tides", "Later user edit")];
    const merged = rebaseCommittedWorkflow(vault, saved, live, base.workspace.id);
    expect(merged.spaces[0].notes.map((item) => item.id)).toEqual(["tides", "new"]);
    expect(merged.spaces[0].notes[0].body).toBe("Later user edit");
  });
  it("keeps the generated revision when only reading position changes during a save", () => {
    const vault = fixture(); const base = vault.spaces[0];
    const saved = composeWorkflowVault(vault, base, { ...base, notes: [note("tides", "AI revision"), base.notes[1]] });
    const live = structuredClone(vault); live.spaces[0].notes[0].lastOpenedAt = "2026-09-05";
    const merged = rebaseCommittedWorkflow(vault, saved, live, base.workspace.id);
    expect(merged.spaces[0].notes[0].body).toBe("AI revision"); expect(merged.spaces[0].notes[0].lastOpenedAt).toBe("2026-09-05");
  });
});
