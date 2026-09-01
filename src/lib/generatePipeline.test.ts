// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { buildGenerationContext, generationNoteEvidence } from "./generationContext";
import { buildGenerateWritingRequest, createGeneratePlaceholderNote } from "./generate";
import { generateFromSpace, parseGenerateOutline } from "./generatePipeline";
import type { ChatRequest, ChatResult } from "../types";

function fixture() {
  const snapshot = createEmptySnapshot("Stories", "2026-08-31T00:00:00Z");
  snapshot.notes = Array.from({ length: 45 }, (_, index) => ({
    ...createGeneratePlaceholderNote({ id: `note-${index}`, title: index === 44 ? "Yayokotama" : `Character ${index}`, kind: "note", now: snapshot.updatedAt }),
    tags: [], body: index === 44 ? "Yayokotama is a city built around two rival answers to suffering. Publishing premise from the actual notes." : `Character ${index} has a distinct narrative about shared responsibility.`,
  }));
  snapshot.notes.push(createGeneratePlaceholderNote({ id: "output", title: "Publisher pitch", kind: "slide-deck", now: snapshot.updatedAt }));
  return snapshot;
}
const input = { originNoteId: "output", kind: "slide-deck" as const, instruction: "Explain Yayokotama to a publisher" };
function outline() {
  return { thesis: "A specific story about competing visions of responsibility.", sections: Array.from({ length: 8 }, (_, index) => ({
    title: `Idea ${index + 1}`, brief: `Explain story dimension ${index + 1}.`, noteIds: [`note-${index}`],
  })) };
}
function reply(text: string): ChatResult { return { reply: text }; }

describe("Space generation context", () => {
  it("indexes all 45 authored notes without Sources and retrieves the relevant last note", () => {
    const snapshot = fixture();
    const context = buildGenerationContext(snapshot, input.instruction);
    expect(snapshot.sources).toHaveLength(0);
    expect(context.directory).toHaveLength(45);
    expect(context.availableNoteCount).toBe(45);
    expect(context.candidates[0].id).toBe("note-44");
    const request = buildGenerateWritingRequest(snapshot, input);
    expect(JSON.stringify(request)).toContain("Publishing premise from the actual notes");
    expect(request.notes.length).toBeLessThanOrEqual(80);
    expect(context.candidates.some(({ id }) => id === "output")).toBe(false);
  });

  it("keeps global privacy off unless this generation explicitly opts in", () => {
    const snapshot = fixture();
    snapshot.settings.includeExistingNotesInAIContext = false;
    expect(buildGenerationContext(snapshot, input.instruction).directory).toEqual([]);
    expect(JSON.stringify(buildGenerateWritingRequest(snapshot, input))).not.toContain("Publishing premise");
    expect(JSON.stringify(buildGenerateWritingRequest(snapshot, { ...input, useSpaceNotes: true }))).toContain("Publishing premise");
    expect(snapshot.settings.includeExistingNotesInAIContext).toBe(false);
    snapshot.settings.includeExistingNotesInAIContext = true;
    expect(JSON.stringify(buildGenerateWritingRequest(snapshot, { ...input, useSpaceNotes: false }))).not.toContain("Publishing premise");
  });

  it("retrieves a relevant late passage with honest truncation inside the native body bound", () => {
    const note = fixture().notes[0];
    note.body = "Unrelated opening. ".repeat(3_000) + "\n\nThe publisher needs this late Yayokotama revelation.\n\n" + "Background. ".repeat(1_000);
    const evidence = generationNoteEvidence(note, "Yayokotama publisher");
    expect(evidence.body).toContain("late Yayokotama revelation");
    expect(evidence.body).toContain("omitted");
    expect([...evidence.body].length).toBeLessThanOrEqual(7_000);
  });
});

describe("parallel generation", () => {
  it("uses one medium outline followed by six scoped high-effort writers, with local ordered assembly", async () => {
    const snapshot = fixture();
    snapshot.settings.reasoningEffort = "high";
    const requests: ChatRequest[] = [];
    let active = 0, maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const driver = vi.fn(async (request: ChatRequest) => {
      requests.push(request);
      if (requests.length === 1) return reply(JSON.stringify(outline()));
      active += 1; maximum = Math.max(maximum, active);
      await gate;
      active -= 1;
      const assigned = JSON.parse(request.prompt.match(/Write ONLY these assigned sections, exactly once, in this order: (.+)/)![1]) as ReturnType<typeof outline>["sections"];
      const ids = assigned.flatMap(({ noteIds }) => noteIds);
      for (const note of request.notes.filter(({ summary }) => summary.startsWith("Exact note version"))) {
        expect(ids.some((id) => note.title.endsWith(`[${id}]`))).toBe(true);
      }
      expect(request.effort).toBe("high");
      expect(request.prompt.length).toBeLessThan(8_000);
      return reply(assigned.map(({ title }) => `## ${title}\n\n- Grounded point\n\nImage: A city\n\n> Spoken context.`).join("\n\n"));
    });
    const pending = generateFromSpace(snapshot, input, driver);
    await vi.waitFor(() => expect(active).toBe(6));
    expect(requests[0].effort).toBe("medium");
    release();
    const body = await pending;
    expect(maximum).toBe(6);
    expect(driver).toHaveBeenCalledTimes(7);
    expect(body.match(/^## .+$/gm)).toEqual(outline().sections.map(({ title }) => `## ${title}`));
  });

  it("rejects foreign IDs, duplicate titles and empty grounding", () => {
    const plan = outline();
    const ids = fixture().notes.map(({ id }) => id);
    plan.sections[0].noteIds = ["another-space-note"];
    expect(() => parseGenerateOutline(JSON.stringify(plan), ids)).toThrow(/outside/);
    plan.sections[0].noteIds = ["note-0"];
    plan.sections[1].title = plan.sections[0].title;
    expect(() => parseGenerateOutline(JSON.stringify(plan), ids)).toThrow(/repeats/);
    expect(() => parseGenerateOutline(JSON.stringify({ ...outline(), sections: outline().sections.map((section) => ({ ...section, noteIds: [] })) }), ids)).toThrow(/ground/);
  });

  it("does not launch writers after cancellation during the outline", async () => {
    const controller = new AbortController();
    const driver = vi.fn(async () => { controller.abort(new Error("Stopped")); return reply(JSON.stringify(outline())); });
    await expect(generateFromSpace(fixture(), input, driver, { signal: controller.signal })).rejects.toThrow("Stopped");
    expect(driver).toHaveBeenCalledOnce();
  });

  it("never assembles a partial deck when a writing section fails", async () => {
    let calls = 0;
    await expect(generateFromSpace(fixture(), input, async () => {
      if (calls++ === 0) return reply(JSON.stringify(outline()));
      throw new Error("Provider offline");
    })).rejects.toThrow(/writing sections failed/);
  });
});
