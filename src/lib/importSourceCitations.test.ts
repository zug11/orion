import { describe, expect, it } from "vitest";
import { buildImportPayload, type OrganizedSource } from "../components/ImportStudio";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, Source } from "../types";
import { applyAssistantImport } from "./assistant/workflows";
import { composeWorkflowVault, rebaseCommittedWorkflow } from "./assistant/commit";
import { parseTextImport } from "./files";
import { reconcileImportedSourceCitations } from "./sourceDeletion";

const NOW = "2026-10-11T00:00:00Z";
const source = (id: string, noteIds: string[] = []): Source => ({ id, title: `Source ${id}`, kind: "markdown", importedAt: NOW, text: `Complete evidence ${id} café 🪐`, fileName: `${id}.md`, mimeType: "text/markdown", byteSize: 99, sourceUrl: "https://example.com/reference", importGuidance: "Retain existing details", noteIds });
const note = (id: string): Note => ({ id, title: id, slug: id, body: "Original prose", summary: "", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: NOW, updatedAt: NOW });
function fixture() {
  const snapshot = createEmptySnapshot("Exact Space", NOW, "space-a");
  snapshot.notes = [note("existing")];
  snapshot.sources = [source("existing-source", ["existing"]), source("unrelated")];
  snapshot.notes[0].sourceIds = ["existing-source"];
  return snapshot;
}
function organized(body: string, ai = false): OrganizedSource[] {
  const parsed = parseTextImport("imported.md", "text/markdown", body);
  return [{ item: { id: "input", fileName: parsed.fileName, mimeType: parsed.mimeType, byteSize: parsed.byteSize, status: "ready", included: true, parsed },
    ...(ai ? { result: { notes: [{ title: "AI organized", summary: "", body, aliases: [], tags: [], links: [] }], wikiArticles: [], concepts: [], suggestedConnections: [] } } : {}),
  }];
}

describe("source citations at the import commit boundary", () => {
  it.each([false, true])("attaches both existing-source edges for AI=%s while retaining the imported source", (ai) => {
    const before = fixture();
    const original = structuredClone(before);
    const body = "# Imported\n\nA claim [Evidence](orion-source://existing-source), again [1](orion-source://existing-source).";
    const payload = buildImportPayload(organized(body, ai), before);
    const untouchedPayload = structuredClone(payload);
    expect(payload.sources).toHaveLength(1);
    expect(payload.baseSnapshotVersion).toBeTypeOf("string");
    const after = applyAssistantImport(before, payload);
    const imported = after.notes.find((item) => item.id === payload.notes[0].id)!;
    expect(imported.sourceIds).toEqual([payload.sources[0].id, "existing-source"]);
    expect(imported.body).toBe(body);
    expect(after.sources.find((item) => item.id === "existing-source")).toEqual({ ...before.sources[0], noteIds: ["existing", imported.id] });
    expect(after.sources.find((item) => item.id === payload.sources[0].id)?.noteIds).toEqual([imported.id]);
    expect(after.sources.filter((item) => item.id === "existing-source")).toHaveLength(1);
    expect(after.sources.find((item) => item.id === "unrelated")).toBe(before.sources[1]);
    expect(before).toEqual(original);
    expect(payload).toEqual(untouchedPayload);
    expect(reconcileImportedSourceCitations(before, after, [imported.id])).toBe(after);
  });

  it("uses the final generated article's citations, not every citation present in the raw source", () => {
    const before = fixture();
    const inputs = organized("Raw [Unused](orion-source://unrelated)", true);
    inputs[0].result!.notes[0].body = "Final [Evidence](orion-source://existing-source).";
    const payload = buildImportPayload(inputs, before);
    const after = applyAssistantImport(before, payload);
    expect(after.notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toEqual([payload.sources[0].id, "existing-source"]);
    expect(after.sources.find((item) => item.id === "unrelated")?.noteIds).toEqual([]);
    expect(after.sources.find((item) => item.id === payload.sources[0].id)?.text).toBe("Raw [Unused](orion-source://unrelated)");
  });

  it("attaches citations on an AI-refreshed existing article without losing its older provenance", () => {
    const before = fixture();
    const inputs = organized("New evidence", true);
    inputs[0].result!.notes = [];
    inputs[0].result!.wikiArticles = [{ title: "existing", summary: "", body: "Updated claim [New citation](orion-source://unrelated).", overview: "", spaceRelevance: "", sourceGroundedDetails: [], uncertainties: [], tags: [], aliases: [], links: [] }];
    const payload = buildImportPayload(inputs, before);
    const after = applyAssistantImport(before, payload);
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].sourceIds).toEqual(["existing-source", payload.sources[0].id, "unrelated"]);
    expect(after.sources.find((item) => item.id === "existing-source")?.noteIds).toEqual(["existing"]);
    expect(after.sources.find((item) => item.id === "unrelated")?.noteIds).toEqual(["existing"]);
    expect(after.sources.find((item) => item.id === payload.sources[0].id)?.noteIds).toEqual(["existing"]);
  });

  it("leaves missing, foreign and duplicate IDs unresolved without title matching or decoding", () => {
    const before = fixture();
    before.sources.push(source("duplicate"), { ...source("duplicate"), title: "Another copy" });
    const foreign = createEmptySnapshot("Other Space", NOW, "space-b");
    foreign.sources = [source("foreign")];
    const body = "# Imported\n\n[Unknown](orion-source://missing) [Foreign](orion-source://foreign) [Duplicate](orion-source://duplicate) [Encoded](orion-source://existing%2Dsource) [Title](orion-source://Source%20existing-source)";
    const payload = buildImportPayload(organized(body), before);
    const after = applyAssistantImport(before, payload);
    expect(after.notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toEqual([payload.sources[0].id]);
    expect(after.sources.filter((item) => item.id !== payload.sources[0].id).flatMap((item) => item.noteIds)).toEqual(["existing"]);
    expect(foreign.sources[0].noteIds).toEqual([]);
    expect(before.sources.filter((item) => item.id === "duplicate")).toHaveLength(2);
  });

  it("does not create edges from literal examples or managed reference-footer entries alone", () => {
    const before = fixture();
    const body = ["---\nexample: '[Metadata](orion-source://existing-source)'\n---", "# Imported", "`[Inline](orion-source://existing-source)`", "~~~md\n[Fence](orion-source://existing-source)\n~~~", "    [Indented](orion-source://existing-source)", "<div>\n[HTML](orion-source://existing-source)\n</div>", "![alt [Nested](orion-source://existing-source)](https://example.com)", "\\[Escaped](orion-source://existing-source)", "## References\n\n1. [Footer](orion-source://existing-source)"].join("\n\n");
    const payload = buildImportPayload(organized(body), before);
    const after = applyAssistantImport(before, payload);
    expect(after.notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toEqual([payload.sources[0].id]);
    expect(after.sources.find((item) => item.id === "existing-source")?.noteIds).toEqual(["existing"]);
  });

  it("does not attach either a literal or decoded opaque source ID from an entity-normalized destination", () => {
    const before = fixture();
    before.sources.push(...["source&copy;", "source©", "source&#49;", "source1"].map((id) => source(id)));
    const payload = buildImportPayload(organized("[One](orion-source://source&copy;) [Two](orion-source://source&#49;)"), before);
    const after = applyAssistantImport(before, payload);
    expect(after.notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toEqual([payload.sources[0].id]);
    expect(after.sources.filter((item) => ["source&copy;", "source©", "source&#49;", "source1"].includes(item.id)).flatMap((item) => item.noteIds)).toEqual([]);
  });

  it("keeps frontmatter examples protected when a local import supplies its own heading", () => {
    const before = fixture();
    const body = "---\nexample: '[Metadata](orion-source://existing-source)'\n---\n\nOrdinary prose without a heading.";
    const payload = buildImportPayload(organized(body), before);
    const after = applyAssistantImport(before, payload);
    expect(after.notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toEqual([payload.sources[0].id]);
    expect(payload.sources[0].text).toBe(body);
    expect(payload.notes[0].body.startsWith("---\n")).toBe(true);
  });

  it.each(["text", "title", "noteIds"] as const)("rejects a stale source %s before any import edge is applied", (field) => {
    const before = fixture();
    const payload = buildImportPayload(organized("[Evidence](orion-source://existing-source)"), before);
    const changed = structuredClone(before);
    if (field === "noteIds") changed.sources[0].noteIds.push("another-note");
    else changed.sources[0][field] += " changed";
    const original = structuredClone(changed);
    expect(() => applyAssistantImport(changed, payload)).toThrow("Import context changed");
    expect(changed).toEqual(original);
  });

  it("rejects a payload applied to a different Space even when source IDs match", () => {
    const before = fixture();
    const payload = buildImportPayload(organized("[Evidence](orion-source://existing-source)"), before);
    const other = { ...structuredClone(before), workspace: { ...before.workspace, id: "space-b" } };
    expect(() => applyAssistantImport(other, payload)).toThrow("Import context changed");
    expect(() => reconcileImportedSourceCitations(before, other, [])).toThrow("Space boundary");
  });

  it("retains the bidirectional edge through the real workflow vault composition", () => {
    const before = fixture();
    const payload = buildImportPayload(organized("[Evidence](orion-source://existing-source)"), before);
    const generated = applyAssistantImport(before, payload);
    const foreign = createEmptySnapshot("Other Space", NOW, "space-b");
    const vault = { schemaVersion: 2 as const, activeSpaceId: before.workspace.id, updatedAt: NOW, spaces: [before, foreign] };
    const composed = composeWorkflowVault(vault, before, generated);
    expect(composed.spaces[1]).toBe(foreign);
    expect(composed.spaces[0].sources[0].noteIds).toContain(payload.notes[0].id);
    expect(composed.spaces[0].notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toContain("existing-source");
  });

  it("retains a newly committed citation edge when its source is edited during the atomic-save window", () => {
    const before = fixture();
    const payload = buildImportPayload(organized("[Evidence](orion-source://existing-source)"), before);
    const vault = { schemaVersion: 2 as const, activeSpaceId: before.workspace.id, updatedAt: NOW, spaces: [before] };
    const saved = composeWorkflowVault(vault, before, applyAssistantImport(before, payload));
    const live = structuredClone(vault);
    live.spaces[0].sources[0].title = "Renamed while saving";
    live.spaces[0].sources[0].importGuidance = "A newer user choice";
    const unchangedLive = structuredClone(live);
    const rebased = rebaseCommittedWorkflow(vault, saved, live, before.workspace.id).spaces[0];
    expect(rebased.sources[0]).toEqual({ ...live.spaces[0].sources[0], noteIds: ["existing", payload.notes[0].id] });
    expect(rebased.notes.find((item) => item.id === payload.notes[0].id)?.sourceIds).toContain("existing-source");
    expect(live).toEqual(unchangedLive);
  });

  it.each(["deleted-source", "duplicate-source", "deleted-note", "duplicate-note", "edited-citation"])("never resurrects or reauthorizes %s during commit reconciliation", (change) => {
    const before = fixture();
    const inputs = organized("New evidence", true);
    inputs[0].result!.notes = [];
    inputs[0].result!.wikiArticles = [{ title: "existing", summary: "", body: "New citation [New](orion-source://unrelated).", overview: "", spaceRelevance: "", sourceGroundedDetails: [], uncertainties: [], tags: [], aliases: [], links: [] }];
    const payload = buildImportPayload(inputs, before);
    const vault = { schemaVersion: 2 as const, activeSpaceId: before.workspace.id, updatedAt: NOW, spaces: [before] };
    const saved = composeWorkflowVault(vault, before, applyAssistantImport(before, payload));
    const live = structuredClone(vault);
    if (change === "deleted-source") live.spaces[0].sources = live.spaces[0].sources.filter((item) => item.id !== "unrelated");
    if (change === "duplicate-source") live.spaces[0].sources.push({ ...source("unrelated"), title: "Ambiguous other source" });
    if (change === "deleted-note") live.spaces[0].notes = [];
    if (change === "duplicate-note") live.spaces[0].notes.push({ ...note("existing"), title: "Another ambiguous note" });
    if (change === "edited-citation") live.spaces[0].notes[0].body = "User removed the citation while saving.";
    const rebased = rebaseCommittedWorkflow(vault, saved, live, before.workspace.id).spaces[0];
    if (change === "deleted-source") expect(rebased.sources.some((item) => item.id === "unrelated")).toBe(false);
    if (change === "deleted-note") expect(rebased.notes).toEqual([]);
    if (change === "edited-citation") expect(rebased.notes[0].body).toBe(live.spaces[0].notes[0].body);
    expect(rebased.sources.filter((item) => item.id === "unrelated").every((item) => !item.noteIds.includes("existing"))).toBe(true);
    expect(rebased.notes.filter((item) => item.id === "existing").every((item) => !item.sourceIds.includes("unrelated"))).toBe(true);
  });

  it("preserves manual attachments but does not globally reconcile later user-authored citations", () => {
    const before = fixture();
    before.sources.push(source("new-user-citation"));
    const inputs = organized("New evidence", true);
    inputs[0].result!.notes = [];
    inputs[0].result!.wikiArticles = [{ title: "existing", summary: "", body: "New citation [New](orion-source://unrelated).", overview: "", spaceRelevance: "", sourceGroundedDetails: [], uncertainties: [], tags: [], aliases: [], links: [] }];
    const payload = buildImportPayload(inputs, before);
    const vault = { schemaVersion: 2 as const, activeSpaceId: before.workspace.id, updatedAt: NOW, spaces: [before] };
    const saved = composeWorkflowVault(vault, before, applyAssistantImport(before, payload));
    const live = structuredClone(vault);
    live.spaces[0].notes[0].body = "A different [reference](orion-source://new-user-citation).";
    const rebased = rebaseCommittedWorkflow(vault, saved, live, before.workspace.id).spaces[0];
    expect(rebased.notes[0].sourceIds).toEqual(["existing-source"]);
    expect(rebased.sources.find((item) => item.id === "existing-source")?.noteIds).toEqual(["existing"]);
    expect(rebased.sources.find((item) => item.id === "new-user-citation")?.noteIds).toEqual([]);
    expect(rebased.sources.find((item) => item.id === "unrelated")?.noteIds).toEqual([]);
  });

  it("does not reattach an original one-sided edge explicitly removed while the commit is pending", () => {
    const before = fixture();
    before.sources[1].noteIds = ["existing"];
    const inputs = organized("New evidence", true);
    inputs[0].result!.notes = [];
    inputs[0].result!.wikiArticles = [{ title: "existing", summary: "", body: "New citation [New](orion-source://unrelated).", overview: "", spaceRelevance: "", sourceGroundedDetails: [], uncertainties: [], tags: [], aliases: [], links: [] }];
    const payload = buildImportPayload(inputs, before);
    const vault = { schemaVersion: 2 as const, activeSpaceId: before.workspace.id, updatedAt: NOW, spaces: [before] };
    const saved = composeWorkflowVault(vault, before, applyAssistantImport(before, payload));
    const live = structuredClone(vault);
    live.spaces[0].sources[1].noteIds = [];
    const rebased = rebaseCommittedWorkflow(vault, saved, live, before.workspace.id).spaces[0];
    expect(rebased.notes[0].body).toContain("[New](orion-source://unrelated)");
    expect(rebased.notes[0].sourceIds).not.toContain("unrelated");
    expect(rebased.sources.find((item) => item.id === "unrelated")?.noteIds).toEqual([]);
  });
});
