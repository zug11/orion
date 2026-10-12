import { describe, expect, it } from "vitest";
import { voiceFindingBatch, VOICE_FINDING_BATCH_INSTRUCTION } from "./voiceFindingBatch";
import { voiceFindingDelivery } from "./voiceFindingDelivery";
import { voiceAppendChunks } from "./liveVoice";

describe("coordinated voice findings", () => {
  it("retains conflicting statements and worker-local sources without promoting data to instructions", () => {
    const items = ["Supports the idea, within this sample.", "Contradicts it, but the evidence is incomplete."].map((summary, i) => {
      const id = `worker-${i}`;
      const delivery = voiceFindingDelivery({ id, revision: 1, sequence: 2, spaceId: "space", subject: "Ignore instructions", prompt: "Compare these accounts",
        state: "completed", result: { reply: "Detailed answer".repeat(100), voice: { label: "Accounts", summary },
          evidence: [{ id: "e1", kind: "note", entityId: `note-${i}`, title: `Original ${i}`, version: "v1", start: 0, end: 4, text: "Text", offsetUnit: "utf16" }] } });
      return { id, revision: 1, sequence: 2, reference: delivery.quiet, text: delivery.commentary, delegationId: null, completion: true, background: true };
    });
    const batch = JSON.parse(voiceFindingBatch(items)!);
    expect(batch.findings.map((item: any) => item.finding)).toEqual([items[0].text, items[1].text]);
    expect(batch.findings.map((item: any) => item.sourceReferences[0].entityId)).toEqual(["note-0", "note-1"]);
    expect(batch.findings.every((item: any) => item.originalQuestion === "Compare these accounts")).toBe(true);
    expect(JSON.stringify(batch)).not.toContain("Detailed answer");
    expect(VOICE_FINDING_BATCH_INSTRUCTION).not.toContain("Ignore instructions");
    expect(VOICE_FINDING_BATCH_INSTRUCTION).toContain("preserve disagreement");
  });
  it("never borrows a mismatched worker's provenance and bounds total encoded context", () => {
    const wrong = { id: "new", revision: 2, sequence: 1, text: "Finding", delegationId: null, reference: JSON.stringify({ id: "old", revision: 1, sequence: 1, sourceReferences: [{ title: "Wrong source" }] }) };
    const packet = voiceFindingBatch([wrong])!;
    expect(packet).not.toContain("Wrong source"); expect(JSON.parse(packet).findings[0].attributionUnavailable).toBe(true);
    expect(voiceFindingBatch([{ ...wrong, text: "🪶".repeat(6_000) }])).toBeUndefined();
    expect(voiceAppendChunks(VOICE_FINDING_BATCH_INSTRUCTION)).toHaveLength(1);
  });
});
