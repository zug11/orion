import { describe, expect, it } from "vitest";
import type { ChatCoverage, ChatResult } from "../types";
import { voiceFindingDelivery } from "./voiceFindingDelivery";

const coverage: ChatCoverage = { availableNotes: 4, availableSources: 2, openedNotes: 1, openedSources: 0, searches: 1, limited: true };
const finding: ChatResult = { reply: "The passage suggests a connection [1](#orion-evidence-e1), but it does not establish causation.", coverage,
  evidence: [{ id: "e1", kind: "note", entityId: "n", title: "Draft", version: "v", text: "A connection", start: 0, end: 12, offsetUnit: "utf16" }] };
function input(result = finding) { return { id: "private-job-identity", revision: 7, sequence: 3, subject: "Causation", state: "running" as const, result }; }

describe("natural finding delivery", () => {
  it("keeps identity and status in quiet context while offering the whole qualified finding", () => {
    const delivery = voiceFindingDelivery(input());
    expect(JSON.parse(delivery.quiet)).toMatchObject({ id: "private-job-identity", revision: 7, sequence: 3, stage: "intermediate", limited: true,
      evidenceIds: ["e1"], action: { kind: "none", saved: false }, finding: expect.stringContaining("does not establish causation") });
    expect(delivery.commentary).toContain("material checked so far");
    expect(delivery.commentary).toContain("The passage suggests a connection, but it does not establish causation.");
    expect(delivery.commentary).not.toMatch(/private-job-identity|revision|intermediate finding|research is still running|nothing saved|#orion-evidence|\[1\]/i);
  });
  it("does not convert provider action payloads or an empty receipt into a save confirmation", () => {
    const result = { ...finding, noteActions: [{ title: "Not persisted", body: "A proposed note", tags: [], aliases: [], summary: "" }] };
    for (const receipt of [undefined, { savedNoteIds: [], savedTitles: ["Not persisted"] }]) {
      const delivery = voiceFindingDelivery({ ...input(result), state: "completed", receipt, acknowledgement: "saved" });
      expect(JSON.parse(delivery.quiet).action).toEqual({ kind: "none", saved: false });
      expect(delivery.commentary).toContain("does not establish causation");
      expect(delivery.commentary).not.toContain("Saved.");
    }
  });
  it("acknowledges explicit Keep only from a receipt without repeating the old finding", () => {
    const receipt = { savedNoteIds: ["created-note"], savedTitles: ["Connection"] };
    const first = voiceFindingDelivery({ ...input(), state: "completed", receipt, acknowledgement: "saved" });
    expect(first.commentary).toBe("Saved.");
    expect(JSON.parse(first.quiet).action).toEqual({ kind: "saved", confirmed: true, ...receipt });
    expect(first.commentary).not.toContain("created-note");
    const replay = voiceFindingDelivery({ ...input(), state: "completed", receipt, acknowledgement: "already-saved" });
    expect(replay.commentary).toBe("It’s already saved.");
  });
  it("keeps proposal review actionable without claiming the note was edited or saved", () => {
    const result = { ...finding, editProposal: { spaceId: "s", noteId: "n", title: "Draft", baseBody: "Original", edits: [{ before: "Original", after: "Proposed" }] } };
    const delivery = voiceFindingDelivery({ ...input(result), state: "completed" });
    expect(JSON.parse(delivery.quiet).action).toEqual({ kind: "proposal", applied: false, noteId: "n", requiresReview: true });
    expect(delivery.commentary).toContain("review the proposed changes");
    expect(delivery.commentary).toContain("accept or discard");
    expect(delivery.commentary).not.toMatch(/saved|already applied/i);
  });
  it("preserves an ending caveat beyond the previous short prefix and never narrates an oversized partial excerpt", () => {
    const reply = "The draft makes an observation. ".repeat(100) + "However, this does not establish causation and needs further evidence.";
    const normal = voiceFindingDelivery({ ...input({ ...finding, reply }), state: "completed" });
    expect(normal.commentary).toContain("However, this does not establish causation and needs further evidence.");
    expect(JSON.parse(normal.quiet)).not.toHaveProperty("finding");
    const oversized = voiceFindingDelivery({ ...input({ ...finding, reply: "Unsupported opening. ".repeat(1_000) }), state: "completed" });
    expect(oversized.commentary).toBe("The detailed finding is available in the work summary.");
    expect(JSON.parse(oversized.quiet).contentOmitted).toBe(true);
    expect(oversized.commentary).not.toContain("Unsupported opening");
  });

  it("carries exact Space source identities without putting source metadata or passage text into narration", () => {
    const evidence = [finding.evidence![0], { ...finding.evidence![0], id: "e2", kind: "source" as const,
      entityId: "原文-source", title: "Évidence — original 🪶", version: "source:exact-version", text: "A private supporting passage" }];
    const delivery = voiceFindingDelivery({ ...input({ ...finding, evidence }), spaceId: "space-original", state: "completed" });
    const quiet = JSON.parse(delivery.quiet);
    expect(quiet).toMatchObject({ spaceId: "space-original", id: "private-job-identity", revision: 7, sequence: 3,
      sourceReferencesOmitted: 0, evidenceIds: ["e1", "e2"] });
    expect(quiet.sourceReferences[1]).toEqual({ evidenceId: "e2", kind: "source", entityId: "原文-source",
      title: "Évidence — original 🪶", version: "source:exact-version", start: 0, end: 12, offsetUnit: "utf16" });
    expect(delivery.commentary).not.toMatch(/原文|source:exact|Évidence|private supporting/);
    expect(delivery.quiet).not.toContain("private supporting passage");
  });

  it("bounds source context without inventing shortened titles or identifiers", () => {
    const evidence = Array.from({ length: 30 }, (_, index) => ({ ...finding.evidence![0], id: `e${index + 1}`,
      title: index === 0 ? "🪶".repeat(501) : `Exact source ${index} ${"🪶".repeat(400)}`,
      entityId: index === 1 ? "n".repeat(201) : `n${index}` }));
    const delivery = voiceFindingDelivery(input({ ...finding, evidence }));
    const quiet = JSON.parse(delivery.quiet);
    expect(quiet.sourceReferences.length).toBeGreaterThan(0);
    expect(quiet.sourceReferences.length).toBeLessThanOrEqual(12);
    expect(JSON.stringify(quiet.sourceReferences).length).toBeLessThanOrEqual(6_000);
    expect(quiet.sourceReferencesOmitted).toBe(evidence.length - quiet.sourceReferences.length);
    expect(quiet.evidenceIds).not.toContain("e1"); expect(quiet.evidenceIds).not.toContain("e2");
    for (const reference of quiet.sourceReferences) expect(reference.title).toBe(evidence.find(item => item.id === reference.evidenceId)!.title);
    expect(delivery.quiet.length).toBeLessThanOrEqual(24_000);
  });

  it("keeps JSON transport bounded when escaping expands a legitimate finding", () => {
    const delivery = voiceFindingDelivery(input({ ...finding, reply: `Finding ${"\u0001".repeat(5_500)} with an ending caveat.` }));
    expect(delivery.commentary).toContain("with an ending caveat.");
    expect(delivery.quiet.length).toBeLessThanOrEqual(24_000);
    expect(JSON.parse(delivery.quiet)).toMatchObject({ contentOmitted: true, evidenceIds: ["e1"] });
    expect(JSON.parse(delivery.quiet)).not.toHaveProperty("finding");
  });
});
