import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest } from "../types";
import { voiceFindingDelivery } from "./voiceFindingDelivery";
import { preparedFindingReference, synthesizeVoiceFindings, voiceSynthesisContext } from "./voiceFindingSynthesis";
import { parseVoiceSynthesisContext, parseVoiceSynthesisResult } from "./voiceSynthesisProtocol";

function finding(id: string, text = "Evidence supports this, but only in the material checked.") {
  const delivery = voiceFindingDelivery({ id, spaceId: "space", revision: 2, sequence: 3, subject: "Question", prompt: "Compare these accounts", state: "completed",
    result: { reply: text, voice: { label: "Finding", summary: text }, evidence: [{ id: "e1", kind: "note", entityId: `note-${id}`, title: `Source ${id}`, version: "v1", start: 0, end: 4, text: "Text", offsetUnit: "utf16" }] } });
  return { id, revision: 2, sequence: 3, text: delivery.commentary, reference: delivery.quiet, delegationId: null, background: true, completion: true };
}

describe("background synthesis contract", () => {
  it("retains disagreement, caveats and exact worker-local provenance without granting actions", async () => {
    const snapshot = createEmptySnapshot(); snapshot.workspace.id = "space";
    const items = [finding("a", "Supports this, within a limited sample."), finding("b", "Contradicts this, but the source is incomplete.")];
    const driver = vi.fn(async (_request: ChatRequest) => ({ reply: "", synthesis: { reply: "The accounts disagree; both have limits.", included: ["f1", "f2"], deferred: [] } }));
    const prepared = await synthesizeVoiceFindings(snapshot, items, { key: "turn", text: "user: Compare their evidence." }, ["An earlier offer, not proof of hearing."], new AbortController().signal, driver);
    const request = driver.mock.calls[0][0], input = JSON.parse(request.synthesisContext!);
    expect(request).toMatchObject({ mode: "voice-synthesis", notes: [], sources: [], concepts: [], history: [], allowNoteActions: false, model: snapshot.settings.model });
    expect(input.findings.map((item: any) => item.finding)).toEqual(items.map(item => item.text));
    const packet = JSON.parse(preparedFindingReference(prepared));
    expect(packet.findings.map((item: any) => item.provenance.sourceReferences[0].entityId)).toEqual(["note-a", "note-b"]);
    expect(packet.summary).toContain("disagree");
  });
  it("requires an exact partition and permits a quiet deferred result", () => {
    const context = voiceSynthesisContext("space", [finding("a"), finding("b")], "A different topic", []);
    expect(parseVoiceSynthesisResult({ reply: "", included: [], deferred: ["f1", "f2"] }, context).reply).toBe("");
    for (const value of [
      { reply: "x", included: ["f1"], deferred: [] },
      { reply: "x", included: ["f1"], deferred: ["f1"] },
      { reply: "x", included: ["f1"], deferred: ["f3"] },
      { reply: "", included: ["f1"], deferred: ["f2"] },
      { reply: "x", included: [], deferred: ["f1", "f2"] },
      { reply: "x", included: ["f1"], deferred: ["f2"], noteActions: [] },
    ]) expect(() => parseVoiceSynthesisResult(value, context)).toThrow(/VOICE_SYNTHESIS/);
  });
  it("rejects mismatched identities, cross-Space provenance, duplicate workers and invalid context", () => {
    expect(() => voiceSynthesisContext("other", [finding("a")], "", [])).toThrow(/identity/);
    expect(() => voiceSynthesisContext("space", [{ ...finding("a"), sequence: 4 }], "", [])).toThrow(/identity/);
    expect(() => voiceSynthesisContext("space", [finding("a"), finding("a")], "", [])).toThrow(/VOICE_SYNTHESIS/);
    const context = voiceSynthesisContext("space", [finding("a")], "", []);
    context.findings[0].provenance = '{"spaceId":"other"}';
    expect(() => parseVoiceSynthesisContext(JSON.stringify(context))).toThrow(/VOICE_SYNTHESIS/);
  });
  it("prepares fewer whole findings when encoded context is large, without clipping their caveats", async () => {
    const snapshot = createEmptySnapshot(); snapshot.workspace.id = "space";
    const items = [finding("a"), finding("b"), finding("c"), finding("d")].map(item => ({ ...item, text: `${"界".repeat(5000)} ending qualification.` }));
    const driver = vi.fn(async (request: ChatRequest) => ({ reply: "", synthesis: { reply: "With the qualifications retained.", included: JSON.parse(request.synthesisContext!).findings.map((f: any) => f.key), deferred: [] } }));
    const result = await synthesizeVoiceFindings(snapshot, items, { key: "turn", text: "" }, [], new AbortController().signal, driver);
    expect(result.context.findings.length).toBeLessThan(4);
    expect(result.context.findings.every(f => f.finding.endsWith("ending qualification."))).toBe(true);
    expect(driver).toHaveBeenCalledOnce();
  });
  it("does not dispatch after cancellation and rejects unsupported model output", async () => {
    const snapshot = createEmptySnapshot(); snapshot.workspace.id = "space";
    const driver = vi.fn(async () => ({ reply: "Saved a note.", noteActions: [] }));
    const controller = new AbortController(); controller.abort();
    await expect(synthesizeVoiceFindings(snapshot, [finding("a")], { key: "", text: "" }, [], controller.signal, driver)).rejects.toThrow(/cancelled/);
    expect(driver).not.toHaveBeenCalled();
    await expect(synthesizeVoiceFindings(snapshot, [finding("a")], { key: "", text: "" }, [], new AbortController().signal, driver)).rejects.toThrow(/VOICE_SYNTHESIS/);
  });
  it("reserves voice packet space for an escaped summary and preserves whole source names", async () => {
    const snapshot = createEmptySnapshot(); snapshot.workspace.id = "space";
    const items = ["a", "b", "c", "d"].map(id => {
      const item = finding(id), reference = JSON.parse(item.reference);
      reference.sourceReferences = Array.from({ length: 4 }, (_, i) => ({ entityId: `${id}-${i}`, title: "S".repeat(1_500) }));
      return { ...item, reference: JSON.stringify(reference) };
    });
    const driver = vi.fn(async (request: ChatRequest) => ({ reply: "", synthesis: { reply: "\u0000".repeat(900), included: JSON.parse(request.synthesisContext!).findings.map((f: any) => f.key), deferred: [] } }));
    const result = await synthesizeVoiceFindings(snapshot, items, { key: "turn", text: "" }, [], new AbortController().signal, driver);
    const reference = preparedFindingReference(result);
    expect(result.context.findings.length).toBeLessThan(4);
    expect(reference.length).toBeLessThanOrEqual(24_000);
    expect(JSON.parse(reference).findings.every((f: any) => f.provenance.sourceReferences.every((source: any) => source.title.length === 1_500))).toBe(true);
  });
});
