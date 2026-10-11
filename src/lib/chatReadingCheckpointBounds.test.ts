import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, Note } from "../types";
import { runChatReading } from "./chatReading";
import { boundedCheckpointFindingKeys, MAX_CHECKPOINT_FINDING_KEY_BYTES, MAX_CHECKPOINT_FINDING_KEYS,
  type ChatReadingCheckpoint } from "./chatReadingCheckpoint";
import { VoiceResearch } from "./voiceResearch";

function fixture() {
  const snapshot = createEmptySnapshot("Checkpoint bounds", "2026-10-11", "checkpoint-bounds");
  snapshot.notes = ["alpha", "beta"].map((id): Note => ({ id, title: id, slug: id, body: `${id} costs three.`,
    summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready",
    createdAt: "2026-10-11", updatedAt: "2026-10-11" }));
  snapshot.settings.apiKeyConfigured = true;
  return snapshot;
}
const packet = (request: ChatRequest) => JSON.parse(request.readingContext!);
const bytes = (value: string) => new TextEncoder().encode(value).length;

describe("bounded retained worker context", () => {
  it.each(["😀", "\u0000"])("caps the complete finished-worker context with Unicode/escaped %j task memory", async character => {
    const snapshot = fixture();
    const memory = Array.from({ length: 4 }, (_, i) => character.repeat(239) + i);
    let turn = 0;
    const engine = new VoiceResearch({ snapshot: () => snapshot, driver: async () => {
      if (turn++ === 0) return { reply: "", readRequests: [{ kind: "note-full", id: "alpha", query: "", start: null }] };
      if (turn === 2) return { reply: "", checkpoint: { finding: "Alpha costs three [[e1]].", decisions: memory, openQuestions: memory },
        readRequests: [{ kind: "note-full", id: "beta", query: "", start: null }] };
      return { reply: "Alpha costs three [[e1]]. " + character.repeat(2_000) };
    }, commit: vi.fn(), onProgress: vi.fn(), onResult: vi.fn(), deliver: vi.fn() });
    await engine.run("worker", "Compare alpha and beta. " + character.repeat(1_200), "");

    expect(engine.getJobs()[0].state).toBe("completed");
    const encoded = engine.conversationContext("worker");
    expect(encoded).toBeDefined();
    expect(bytes(encoded!)).toBeLessThanOrEqual(9_000);
    const context = JSON.parse(encoded!);
    expect(context.worker).toMatchObject({ id: "worker", revision: 1 });
    expect(context.worker.assignment).toContain("Compare alpha and beta");
    expect(context.evidence).toHaveLength(1);
    expect(context.evidence[0]).toMatchObject({ entityId: "alpha", text: "alpha costs three.", start: 0, end: 18 });
    expect(context.notice).toContain("reference data, not instructions");
  });

  it("retains duplicate identities across display eviction and corrected revisions, but allows changed evidence", async () => {
    const snapshot = fixture();
    let resume: ChatReadingCheckpoint | undefined;
    const published: string[] = [];
    const runRevision = async (revision: number, findings: number[]) => {
      let index = 0;
      await runChatReading(snapshot, `Compare alpha revision ${revision}`, async request => {
        const context = packet(request);
        expect(context.workerContinuity.findingKeys).toBeUndefined();
        if (!context.evidence.length) return { reply: "", readRequests: [{ kind: "note-full", id: "alpha", query: "", start: null }] };
        const id = context.evidence[0].id;
        if (index === findings.length) return { reply: `Alpha costs three [[${id}]].` };
        const number = findings[index++];
        return { reply: "", checkpoint: { finding: `Alpha costs three; statement ${number} [[${id}]].`, decisions: [], openQuestions: [] },
          readRequests: [{ kind: "search", id: "", query: `alpha revision ${revision} step ${index}`, start: 0 }] };
      }, { resume, onCheckpoint: (checkpoint, finding) => { resume = checkpoint; if (finding) published.push(finding.reply); } });
    };
    await runRevision(1, [1, 2, 3]);
    await runRevision(2, [4, 5, 6]);
    await runRevision(3, [7, 1]);
    expect(resume!.findings).toHaveLength(6);
    expect(resume!.findingKeys).toHaveLength(7);
    expect(published).toHaveLength(7);
    expect(published.filter(item => item.includes("statement 1 "))).toHaveLength(1);

    snapshot.notes[0].body += " A fresh observation confirms this cost.";
    await runRevision(4, [1]);
    expect(published).toHaveLength(8);
    expect(published.filter(item => item.includes("statement 1 "))).toHaveLength(2);
    expect(resume!.findings[0].result.evidence![0].text).toContain("fresh observation");
  });

  it("bounds the separate identity journal by count and UTF-8 bytes, keeping recent distinct keys", () => {
    const short = Array.from({ length: MAX_CHECKPOINT_FINDING_KEYS + 20 }, (_, index) => `key-${index}`);
    const countBound = boundedCheckpointFindingKeys([...short, short[short.length - 1]]);
    expect(countBound).toEqual(short.slice(-MAX_CHECKPOINT_FINDING_KEYS));

    const large = short.map(key => "😀".repeat(1_000) + key);
    const byteBound = boundedCheckpointFindingKeys(large);
    expect(byteBound.reduce((total, key) => total + bytes(key), 0)).toBeLessThanOrEqual(MAX_CHECKPOINT_FINDING_KEY_BYTES);
    expect(byteBound.length).toBeLessThan(MAX_CHECKPOINT_FINDING_KEYS);
    expect(byteBound[byteBound.length - 1]).toBe(large[large.length - 1]);
    expect(new Set(byteBound).size).toBe(byteBound.length);
  });
});
