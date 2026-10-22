import { describe, expect, it } from "vitest";
import type { ChatCoverage, ChatResult } from "../types";
import { voiceFindingDelivery } from "./voiceFindingDelivery";

const coverage: ChatCoverage = { availableNotes: 4, availableSources: 2, openedNotes: 1, openedSources: 0, searches: 1, limited: true };
const finding: ChatResult = { reply: "The passage suggests a connection [1](#orion-evidence-e1), but it does not establish causation.", coverage,
  evidence: [{ id: "e1", kind: "note", entityId: "n", title: "Draft", version: "v", text: "A connection", start: 0, end: 12, offsetUnit: "utf16" }] };
function input(result = finding) { return { id: "private-job-identity", revision: 7, sequence: 3, subject: "Causation", state: "running" as const, result }; }

describe("natural finding delivery", () => {
  it("preserves a failed follow-up beside the spoken summary without discarding returned web evidence", () => {
    const webResearch = { attempted: 2, completed: 1, issue: "Perplexity's shared request limit is busy. Retry in about 20 seconds. (WEB_REQUEST_RATE_LIMIT)" };
    const delivery = voiceFindingDelivery({ ...input({ ...finding, webResearch, voice: { label: "Connection", summary: finding.reply } }), state: "completed" });
    expect(JSON.parse(delivery.quiet).webResearch).toEqual(webResearch);
    expect(delivery.commentary).toContain("does not establish causation");
    expect(delivery.commentary).toContain("Some web research returned; another lookup could not finish.");
    expect(delivery.commentary).toContain("shared request limit");
    expect(delivery.commentary).not.toContain("WEB_REQUEST_RATE_LIMIT");
    const saved = voiceFindingDelivery({ ...input({ ...finding, webResearch }), acknowledgement: "saved", receipt: { savedNoteIds: ["saved"], savedTitles: ["Connection"] } });
    expect(saved.commentary).toBe("Saved.");
  });
  it("keeps the actual web failure available even when a long finding must stay quiet", () => {
    const webResearch = { attempted: 1, completed: 0, issue: "Perplexity needs API credit. Check your Perplexity API billing. (WEB_HTTP_402)" };
    const delivery = voiceFindingDelivery(input({ ...finding, reply: "A long provisional discussion. ".repeat(300), webResearch }));
    expect(delivery.commentary).toBe("");
    expect(JSON.parse(delivery.quiet)).toMatchObject({ contentOmitted: true, webResearch });
    const requested = voiceFindingDelivery({ ...input({ ...finding, reply: "A long provisional discussion. ".repeat(300), webResearch }), requested: true });
    expect(requested.commentary).toContain("Web research did not return usable evidence.");
    expect(requested.commentary).toContain("API credit");
  });
  it("automatically offers the separate qualified summary of a long final answer", () => {
    const reply = "A detailed discussion of the evidence. ".repeat(100) + "The cause remains uncertain.";
    const delivery = voiceFindingDelivery({ ...input({ ...finding, reply, voice: { label: "Connection and causation", summary: finding.reply } }), state: "completed" });
    expect(delivery).toMatchObject({ background: true, completion: true });
    expect(delivery.commentary).toContain("The passage suggests a connection, but it does not establish causation.");
    expect(delivery.commentary).toContain("material checked so far");
    expect(delivery.commentary).not.toMatch(/ready|open|second|detailed discussion/i);
    expect(JSON.parse(delivery.quiet).finding).toBe(reply);
  });
  it("keeps the spoken summary in quiet voice context when a web notice pushes the answer over its limit", () => {
    const summary = "The source supports a connection, but the cause remains uncertain [1](#orion-evidence-e1).";
    const result = { ...finding, reply: "A detailed finding. ".repeat(310), voice: { label: "Connection", summary },
      webResearch: { attempted: 2, completed: 1, issue: "A later lookup timed out." } };
    const delivery = voiceFindingDelivery({ ...input(result), state: "completed" });
    const quiet = JSON.parse(delivery.quiet);
    expect(quiet).toMatchObject({ contentOmitted: true, summary: "The source supports a connection, but the cause remains uncertain.",
      webResearch: result.webResearch, evidenceIds: ["e1"] });
    expect(quiet).not.toHaveProperty("finding");
    expect(delivery.commentary).toContain("cause remains uncertain");
  });
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
  it("keeps long answers quiet and complete, including their ending caveat, until explicitly requested", () => {
    const reply = "The draft makes an observation. ".repeat(100) + "However, this does not establish causation and needs further evidence.";
    const normal = voiceFindingDelivery({ ...input({ ...finding, reply }), state: "completed" });
    expect(normal.commentary).toBe("");
    expect(JSON.parse(normal.quiet).finding).toBe(reply);
    const requested = voiceFindingDelivery({ ...input({ ...finding, reply }), requested: true, state: "completed" });
    expect(requested.background).toBe(false);
    expect(requested.commentary).toContain("However, this does not establish causation and needs further evidence.");
    const oversized = voiceFindingDelivery({ ...input({ ...finding, reply: "Unsupported opening. ".repeat(1_000) }), state: "completed" });
    expect(oversized.commentary).toBe("");
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
    const delivery = voiceFindingDelivery({ ...input({ ...finding, reply: `Finding ${"\u0001".repeat(5_500)} with an ending caveat.` }), requested: true });
    expect(delivery.commentary).toContain("with an ending caveat.");
    expect(delivery.quiet.length).toBeLessThanOrEqual(24_000);
    expect(JSON.parse(delivery.quiet)).toMatchObject({ contentOmitted: true, evidenceIds: ["e1"] });
    expect(JSON.parse(delivery.quiet)).not.toHaveProperty("finding");
  });
  it("bounds spontaneous findings by actual transport bytes without chopping multilingual caveats", () => {
    const reply = "文".repeat(170) + "。This remains uncertain.";
    const delivery = voiceFindingDelivery(input({ ...finding, reply }));
    expect(delivery.commentary).toBe("");
    expect(JSON.parse(delivery.quiet).finding).toBe(reply);
    const short = voiceFindingDelivery(input());
    expect(short.background).toBe(true);
    expect(new TextEncoder().encode(short.commentary).length).toBeLessThanOrEqual(480);
  });
});
