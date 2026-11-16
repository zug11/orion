import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatRequest } from "../types";
import { VoiceResearch, type VoiceDriver, type VoiceResearchAssignment } from "./voiceResearch";
import { VoiceReservations } from "./voiceReservations";
import { localVoiceTurnDecision, routeVoiceTurn } from "./voiceWorkOrders";

describe("voice question through routing and real evidence readers", () => {
  it("uses the selected ChatGPT plan for a dense-Space ranking, reads evidence in parallel and completes without a provider delegation", async () => {
    const snapshot = createEmptySnapshot("Orion product improvements", "2026-11-16", "dense-space");
    snapshot.settings.model = "chatgpt:gpt-6.1-sol";
    snapshot.settings.reasoningEffort = "medium";
    snapshot.settings.chatgptConfigured = true;
    snapshot.settings.apiKeyConfigured = false;
    snapshot.notes = Array.from({ length: 11 }, (_, index) => ({
      id: `idea-${index}`, title: `Ambitious idea ${index}`, slug: `idea-${index}`,
      body: `Idea ${index} proposes an ambitious improvement with an explicit user benefit.\n\n` + "Supporting project detail. ".repeat(index ? 400 : 9_600),
      summary: "", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [],
      createdAt: "2026-11-16", updatedAt: "2026-11-16",
    }));
    const prompt = "whats the 5 most ambitious ideas";
    const turn = { key: 1, prompt, delegated: false, delegationId: null };
    const assignments = [
      { subject: "Product possibilities", focus: "Read Space notes for ambitious product ideas and their stated purpose." },
      { subject: "Technical possibilities", focus: "Read Space notes for ambitious technical ideas and dependencies." },
      { subject: "Novel interactions", focus: "Read Space notes for ambitious interaction ideas and distinct user benefits." },
    ];
    const finishes = new Map<string, () => void>();
    const driver = vi.fn<VoiceDriver>(async request => {
      expect(request.model).toBe("chatgpt:gpt-6.1-sol");
      expect(request.allowNoteActions).toBe(false);
      if (request.mode === "inline-writing") {
        expect(request.effort).toBe("low");
        expect(request.prompt).toContain(prompt);
        expect(JSON.parse(request.notes[0].body)).toMatchObject({ availableNotes: 11, spaceName: snapshot.workspace.name });
        return { reply: JSON.stringify({ action: "batch", assignments }) };
      }
      expect(request.mode).toBe("chat-reading");
      expect(request.effort).toBe("medium");
      expect(request.prompt).toBe(prompt);
      expect(request.editNoteId).toBeUndefined();
      const scope = childScope(request);
      const index = assignments.findIndex(assignment => assignment.subject === scope.subject) + 1;
      expect(index).toBeGreaterThan(0);
      const packet = JSON.parse(request.readingContext!);
      const evidence = packet.evidence.find((entry: { entityId: string }) => entry.entityId === `idea-${index}`);
      if (!evidence) return { reply: "", readRequests: [{ kind: "note", id: `idea-${index}`, query: `Idea ${index}`, start: null }] };
      expect(evidence.text).toContain(`Idea ${index} proposes`);
      await new Promise<void>(resolve => finishes.set(scope.subject, resolve));
      return { reply: `Candidate ${index} has a stated user benefit [[${evidence.id}]]. This investigation covers its own angle; it does not establish a whole-Space top five.`, readRequests: [] };
    });
    const deliver = vi.fn(), commit = vi.fn(), onResult = vi.fn();
    const engine = new VoiceResearch({ snapshot: () => snapshot, driver, commit, deliver, onResult, onProgress: vi.fn() });
    const reservations = new VoiceReservations(() => "reserved-idea-worker");
    try {
      expect(localVoiceTurnDecision({ ...turn, jobs: [] })).toBeNull();
      expect(reservations.reserve(turn, 1, "routing")).toBe(true);
      const decision = await routeVoiceTurn({ ...turn, snapshot, jobs: [], conversation: "", driver });
      expect(decision.action).toBe("batch");
      if (decision.action !== "batch") throw new Error("The question did not admit a research team");
      expect(decision.assignments).toHaveLength(3);
      const ids = [reservations.members(turn.key)[0].id, "idea-worker-2", "idea-worker-3"];
      expect(reservations.handoff(turn, ids)).toMatchObject({ prompt });
      const work = decision.assignments.map((assignment, index) => engine.run(ids[index], prompt, "", undefined, null, false, undefined, assignment));
      await vi.waitFor(() => expect(finishes.size).toBe(3));
      expect(engine.getJobs().map(job => job.state)).toEqual(["running", "running", "running"]);
      expect(reservations.isReplay({ ...turn, delegated: true, delegationId: "late-delegation" }, engine.getJobs())).toBe(true);
      expect(driver.mock.calls.filter(([request]) => request.mode === "inline-writing")).toHaveLength(1);
      for (const subject of assignments.map(assignment => assignment.subject).reverse()) finishes.get(subject)!();
      await Promise.all(work);
      const jobs = engine.getJobs();
      expect(jobs).toHaveLength(3);
      expect(jobs.every(job => job.state === "completed" && job.prompt === prompt && job.revision === 1)).toBe(true);
      expect(jobs.map(job => job.result?.evidence?.map(evidence => evidence.entityId))).toEqual([["idea-1"], ["idea-2"], ["idea-3"]]);
      expect(jobs.every(job => job.result?.coverage?.openedNotes === 1 && job.result.coverage.availableNotes === 11)).toBe(true);
      expect(onResult).toHaveBeenCalledTimes(3);
      expect(deliver.mock.calls.filter(call => call[3]?.completion)).toHaveLength(3);
      expect(commit).not.toHaveBeenCalled();
    } finally {
      for (const finish of finishes.values()) finish();
      engine.dispose();
    }
  });
});

function childScope(request: ChatRequest): VoiceResearchAssignment {
  const line = request.history[0].content.split("\n")[0];
  return JSON.parse(line.slice("Read-only child research scope: ".length));
}
