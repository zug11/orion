// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import { chatWithOrion, deleteApiKey, deleteAnthropicApiKey, saveApiKey, saveAnthropicApiKey } from "../storage";
import { researchSpace } from "./research";
import type { WorkflowDependencies } from "./types";

afterEach(async () => { vi.unstubAllGlobals(); await deleteApiKey(); await deleteAnthropicApiKey(); });

describe("MCP research provider transport", () => {
  it.each(["gpt-5.6-sol", "claude-sonnet-5"])("sends complete task/reference records and exact reader evidence to %s without a live call", async model => {
    const snapshot = createEmptySnapshot("Transport", "2026-10-11", "transport");
    snapshot.settings.model = model;
    snapshot.settings.apiKeyConfigured = snapshot.settings.anthropicApiKeyConfigured = true;
    snapshot.notes = [{ id: "anchor", title: "Unrelated title", slug: "anchor", body: "The exact observation.", summary: "", aliases: [], tags: [],
      sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-11", updatedAt: "2026-10-11" }];
    const question = `${"🌔".repeat(7_980)} closing qualifier`, material = `${"文".repeat(23_980)} closing limitation`;
    await saveApiKey("sk-offline-fixture"); await saveAnthropicApiKey("sk-ant-offline-fixture");
    let reads = 0, syntheses = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const payload = JSON.parse(model.startsWith("claude") ? body.messages[0].content : body.input);
      const records = payload.readingContext?.referenceRecords ?? payload.notes;
      expect(records.filter((record: { title: string }) => record.title.startsWith("Research question")).map((record: { body: string }) => record.body).join("")).toBe(question);
      expect(records.filter((record: { title: string }) => record.title.startsWith("Comparison material")).map((record: { body: string }) => record.body).join("")).toBe(material);
      expect(payload.conversation).toEqual([]);
      let result;
      if (payload.readingContext) {
        expect(new TextEncoder().encode(JSON.stringify(payload.readingContext)).length).toBeLessThanOrEqual(320_000);
        expect(payload.readingContext.referenceTargets[0]).toMatchObject({ id: "anchor", title: "Unrelated title" });
        expect(payload).not.toHaveProperty("notes"); // Reproduces the actual specialized transport.
        expect(body.instructions ?? body.system).toContain("No note write is authorized");
        result = reads++ === 0 ? { reply: "", readRequests: [{ kind: "note-full", id: "anchor", query: "", start: 0 }], checkpoint: null }
          : { reply: "The text contains an observation [[e1]].", readRequests: [], checkpoint: null };
      } else {
        syntheses++;
        expect(payload.notes.find((record: { summary: string }) => record.summary.startsWith("Evidence ID e1"))?.body).toContain("The exact observation.");
        result = { reply: JSON.stringify({ answer: "Observation.", findings: [{ claim: "The text contains an observation.", kind: "fact", evidenceIds: ["e1"] }], gaps: [], followUpQuestions: [] }) };
      }
      return new Response(JSON.stringify(model.startsWith("claude") ? { content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn" }
        : { status: "completed", output_text: JSON.stringify(result) }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const dependencies = { signal: new AbortController().signal, assertCurrent: async () => {}, progress: async () => {}, chat: chatWithOrion } as unknown as WorkflowDependencies;
    const result = await researchSpace(snapshot, { question, material, note_ids: ["anchor"] }, dependencies);
    expect(result.findings[0].citations[0].id).toBe("anchor"); expect(reads).toBe(2); expect(syntheses).toBe(1);
  });
});
