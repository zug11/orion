import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest, ChatResult } from "../types";
import { runChatReading } from "./chatReading";
import { parseChatVoicePresentation } from "./chatReadingProtocol";

function fixture() {
  const snapshot = createEmptySnapshot("Research", "2026-10-12", "research");
  snapshot.notes = [{ id: "n", title: "Evidence", slug: "evidence", body: "Alpha is connected to beta, but the cause is unknown.",
    summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: "2026-10-12", updatedAt: "2026-10-12" }];
  return snapshot;
}
const read = { kind: "note-full" as const, id: "n", query: "", start: null };
const packet = (request: ChatRequest) => JSON.parse(request.readingContext!);

describe("voice reader presentation and format recovery", () => {
  it("gets a task label and a cited spoken summary in the same reading calls while retaining the detailed answer", async () => {
    const labels = vi.fn(), snapshot = fixture();
    const driver = vi.fn(async (request: ChatRequest): Promise<ChatResult> => {
      const context = packet(request); expect(context.voicePresentationEnabled).toBe(true);
      expect(request.allowNoteActions).toBe(false);
      return context.evidence.length ? { reply: "Detailed analysis. ".repeat(60) + "The cause remains unknown [[e1]].",
        voice: { label: "Alpha and beta's relationship", summary: "Alpha is connected to beta, but the cause is unknown [[e1]]." } }
        : { reply: "", readRequests: [read], voice: { label: "Alpha and beta's relationship", summary: "" } };
    });
    const result = await runChatReading(snapshot, "Read the relationship", driver, { onWorkLabel: labels });
    expect(driver).toHaveBeenCalledTimes(2); expect(labels).toHaveBeenCalledWith("Alpha and beta's relationship");
    expect(result.reply).toContain("Detailed analysis."); expect(result.voice?.summary).toContain("#orion-evidence-e1");
    expect(result.evidence?.[0].entityId).toBe("n"); expect(snapshot.notes[0].body).toContain("cause is unknown");
  });
  it("repairs a malformed final JSON answer once without repeating successful reads or widening authority", async () => {
    const requests: ChatRequest[] = [], progress = vi.fn();
    const result = await runChatReading(fixture(), "Read the relationship", async request => {
      requests.push(request);
      if (requests.length === 1) return { reply: "", readRequests: [read] };
      if (requests.length === 2) throw "OpenAI's response could not be used: the answer was not valid JSON (CHAT_JSON). Try again.";
      expect(packet(request).correction).toContain("complete JSON object");
      expect(packet(request).evidence).toEqual(packet(requests[1]).evidence);
      expect(packet(request).documents[0]).toMatchObject({ id: "n", complete: true });
      expect(request.allowNoteActions).toBe(false); expect(request.prompt).toBe("Read the relationship");
      return { reply: "The cause remains unknown [[e1]]." };
    }, { onProgress: progress });
    expect(requests).toHaveLength(3); expect(result.reply).toContain("cause remains unknown");
    expect(progress).toHaveBeenCalledWith("Retrying the answer format");
  });
  it("stops after one format retry and never repairs a provider failure into a successful answer", async () => {
    const driver = vi.fn(async () => { throw new Error("Invalid JSON (CHAT_JSON)"); });
    await expect(runChatReading(fixture(), "Read it", driver)).rejects.toThrow("CHAT_JSON");
    expect(driver).toHaveBeenCalledTimes(2);
  });
  it("does not let a spoken summary introduce uncited evidence", async () => {
    let calls = 0;
    const result = await runChatReading(fixture(), "Read the relationship", async request => {
      calls++;
      if (calls === 1) return { reply: "", readRequests: [read] };
      if (calls === 2) return { reply: "Unknown cause [[e1]].", voice: { label: "Relationship", summary: "A causal result." } };
      expect(packet(request).correction).toContain("spoken finding also needs an exact evidence citation");
      return { reply: "Unknown cause [[e1]].", voice: { label: "Relationship", summary: "The cause is unknown [[e1]]." } };
    }, { onWorkLabel: vi.fn() });
    expect(result.voice?.summary).toContain("cause is unknown"); expect(calls).toBe(3);
  });
  it.each([
    { label: "", summary: "text" }, { label: "x".repeat(81), summary: "text" },
    { label: "Valid", summary: "x".repeat(361) }, { label: "Bad\nlabel", summary: "text" },
    { label: "Valid", summary: "text", noteId: "other" },
  ])("rejects malformed or overlong presentation metadata: %j", value => {
    expect(() => parseChatVoicePresentation(value)).toThrow("CHAT_VOICE");
  });
});
