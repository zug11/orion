import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { ParsedImport } from "../../types";
import { runKnowledgeImportBatch } from "./import";
import type {
  KnowledgeSourceReading,
  KnowledgeWriterResult,
  KnowledgeWritingBlueprint,
  KnowledgeWritingBlueprintOutput,
} from "./protocol";
import type { KnowledgeAssignmentExecutionRequest } from "./service";
import { fixedPipelineResponse } from "./testFixtures";

const NOW = "2026-08-31T10:00:00.000Z";
type Idea = {
  title: string;
  thesis: string;
  details?: string[];
  interpretation?: string;
  requirements?: string[];
};

function source(sourceId: string, ideas: readonly Idea[]) {
  const text = ideas.flatMap(({ thesis, details }) => [thesis, ...(details ?? [])]).join("\n\n");
  const parsed: ParsedImport = {
    title: sourceId, fileName: `${sourceId}.txt`, mimeType: "text/plain",
    format: "text", byteSize: text.length, text, warnings: [],
  };
  return { sourceId, parsed };
}

function readingResponse(request: KnowledgeAssignmentExecutionRequest, ideas: readonly Idea[]) {
  const result = fixedPipelineResponse(request);
  const reading = result.response.payload as KnowledgeSourceReading;
  reading.sourceClaims = [];
  reading.synthesisSeeds = [];
  reading.spaceInterpretations = [];
  reading.mustPreserve.push(...ideas.flatMap(({ requirements }) => requirements ?? []));
  for (const [index, idea] of ideas.entries()) {
    const claimIds = [idea.thesis, ...(idea.details ?? [])].map((text, ordinal) => {
      const claimId = `claim-${index + 1}-${ordinal + 1}`;
      reading.sourceClaims.push({
        claimId, text, support: [{ sourceId: reading.sourceId, rangeId: reading.rangeId }],
      });
      return claimId;
    });
    reading.synthesisSeeds.push({
      seedId: `seed-${index + 1}`, proposedTitle: idea.title, thesis: idea.thesis,
      claimIds, importance: "high", contribution: "new", relatedNoteIds: [],
      rationale: "This is a distinct source-supported thesis.",
    });
    if (idea.interpretation) {
      reading.spaceInterpretations.push({
        interpretationId: `interpretation-${index + 1}`, text: idea.interpretation,
        sourceClaimIds: claimIds, relatedNoteIds: [],
        rationale: "This is an interpretation, not an additional source assertion.",
      });
    }
  }
  return result;
}

async function recoveredImport(
  ideasBySource: Record<string, Idea[]>,
  writer?: (request: KnowledgeAssignmentExecutionRequest, result: KnowledgeWriterResult) => void,
) {
  const snapshot = createEmptySnapshot("Import quality", NOW);
  const requests: KnowledgeAssignmentExecutionRequest[] = [];
  let activeWriters = 0;
  let maximumWriters = 0;
  const result = await runKnowledgeImportBatch({
    snapshot, sources: Object.entries(ideasBySource).map(([sourceId, ideas]) => source(sourceId, ideas)),
    // Deliberate guidance keeps this on the shared planner even for small seeds.
    importGuidance: "Preserve every distinct thesis and its qualifications.",
    model: snapshot.settings.model, effort: snapshot.settings.reasoningEffort,
    driver: async (request) => {
      requests.push(request);
      if (request.assignment.output.kind === "source-reading") {
        return readingResponse(request, ideasBySource[request.assignment.output.sourceId]);
      }
      const response = fixedPipelineResponse(request);
      if (request.assignment.output.kind === "writing-blueprint") {
        // Exhaust precisely the planner's contract retry, then use local planning.
        (response.response.payload as KnowledgeWritingBlueprint).seedDispositions = [];
      }
      if (request.assignment.output.kind === "writer-result") {
        activeWriters += 1;
        maximumWriters = Math.max(maximumWriters, activeWriters);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const payload = response.response.payload as KnowledgeWriterResult;
        if (writer) writer(request, payload);
        else payload.drafts = [];
        activeWriters -= 1;
      }
      return response;
    },
  });
  return { result, requests, maximumWriters };
}

describe("idea-first import planning and grounded recovery", () => {
  it("preserves more than twelve clear theses without forced buckets and keeps physical width bounded", async () => {
    const ideas = Array.from({ length: 15 }, (_, index) => ({
      title: `Distinct mechanism ${index + 1}`,
      thesis: `Mechanism ${index + 1} has its own independently supported explanatory consequence.`,
    }));
    const { result, maximumWriters, requests } = await recoveredImport({
      first: ideas.slice(0, 8), second: ideas.slice(8),
    });

    expect(result.organized.notes).toHaveLength(15);
    expect(new Set(result.organized.notes.map(({ title }) => title))).toEqual(
      new Set(ideas.map(({ title }) => title)),
    );
    for (const idea of ideas) {
      const note = result.organized.notes.find(({ title }) => title === idea.title)!;
      expect(note.body).toBe(idea.thesis);
    }
    expect(maximumWriters).toBeLessThanOrEqual(6);
    expect(maximumWriters).toBeGreaterThan(1);
    expect(requests.filter(({ assignment }) => assignment.output.kind === "writing-blueprint")).toHaveLength(2);
    expect(requests[requests.length - 1]?.assignment.output.kind).toBe("writer-result");
    expect(result.landing).toBeUndefined();
  });

  it("does not combine different theses just because they share a title or generic words", async () => {
    const { result } = await recoveredImport({
      first: [{ title: "Shared language", thesis: "Shared language may help a group articulate a loss." }],
      second: [{ title: "Shared language", thesis: "Shared language can also conceal incompatible accounts of history." }],
    });
    expect(result.organized.notes).toHaveLength(2);
    expect(result.organized.notes.map(({ body }) => body)).toEqual([
      "Shared language may help a group articulate a loss.",
      "Shared language can also conceal incompatible accounts of history.",
    ]);
  });

  it("reports aggregate output overflow without merging or discarding clear theses", async () => {
    const ideas = Array.from({ length: 31 }, (_, index) => ({
      title: `Independent principle ${index + 1}`,
      thesis: `Principle ${index + 1} establishes an independent constraint on the proposed explanation.`,
    }));
    let wrote = false;
    await expect(recoveredImport({ first: ideas.slice(0, 16), second: ideas.slice(16) }, () => {
      wrote = true;
    })).rejects.toThrow(/31 distinct knowledge objects.*30-output safety limit/);
    expect(wrote).toBe(false);
  });

  it("coalesces only exact duplicate ideas and retains both sources", async () => {
    const idea = { title: "Situated recollection", thesis: "A recollection may reveal the writer's perspective without establishing a universal pattern." };
    const { result } = await recoveredImport({ first: [idea], second: [{ ...idea }] });
    expect(result.organized.notes).toHaveLength(1);
    expect(result.organized.notes[0].body).toBe(idea.thesis);
    expect(result.provenance[0].sourceIds.sort()).toEqual(["first", "second"]);
  });

  it("writes one thesis, keeps distinct qualified details verbatim, and labels interpretation", async () => {
    const thesis = "The diary proposes that a ritual may offer temporary relief, not a universal cure.";
    const detail = "The writer asks whether that relief can endure; the diary does not establish that it will.";
    const interpretation = "One possible interpretation is that the ritual mediates uncertainty rather than resolving it.";
    const { result, requests } = await recoveredImport({
      first: [{ title: "Ritual and uncertainty", thesis, details: [thesis, detail], interpretation }],
      second: [{ title: "Independent counterexample", thesis: "A second account describes a situation in which no relief was reported." }],
    });
    const note = result.organized.notes.find(({ title }) => title === "Ritual and uncertainty")!;
    expect(note.body).toBe(`${thesis}\n\n## Source statements\n\n${detail}\n\n## Interpretation\n\n${interpretation}`);
    expect(note.summary).toBe(thesis);
    expect(note.body).not.toContain("# Ritual and uncertainty");
    expect(note.body).not.toContain("Synthesize every selected range claim.");
    expect(requests.filter(({ assignment }) => assignment.output.kind === "source-reading")
      .every(({ assignment }) => assignment.constraints.rules.some((rule) => rule.includes("epistemic status")))).toBe(true);
    expect(requests.filter(({ assignment }) => assignment.output.kind === "writer-result")
      .every(({ assignment }) => assignment.constraints.rules.some((rule) => rule.includes("hypotheses, questions")))).toBe(true);
  });

  it("carries reading requirements to applicable outputs without widening selected prose or tasks", async () => {
    const qualification = "Retain the observer's uncertainty; this is a hypothesis, not an established effect.";
    const taskRequirement = "Keep the explicit comparison task with its supporting source claim.";
    const task = "- [ ] Compare the two observations";
    const { result, requests } = await recoveredImport({
      first: [
        {
          title: "Tentative effect",
          thesis: "The observer hypothesizes that the intervention may have an effect.",
          details: [task],
          requirements: [qualification, taskRequirement],
        },
        {
          title: "Alternative explanation",
          thesis: "The observer also considers chance as an alternative explanation.",
        },
      ],
      second: [{ title: "Independent limit", thesis: "The second report concerns an independent measurement limit." }],
    });
    const outputs = requests.filter(({ assignment }) => assignment.output.kind === "writer-result")
      .flatMap(({ context }) => context.pipelineMaterials?.filter(({ kind }) => kind === "writing-blueprint")
        .flatMap(({ payload }) => (payload as { assignedOutputs: KnowledgeWritingBlueprintOutput[] }).assignedOutputs) ?? []);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      if (output.sourceIds.includes("first")) {
        expect(output.mustPreserve).toContain(qualification);
        expect(output.mustPreserve).toContain(taskRequirement);
        expect(output.mustPreserve.some((required) => required.startsWith("Source range first/"))).toBe(true);
      } else {
        expect(output.mustPreserve).not.toContain(qualification);
        expect(output.mustPreserve).not.toContain(taskRequirement);
      }
      expect(output.editorialBrief).toContain("never authorize copying unselected prose or tasks");
    }
    expect(result.organized.notes.filter(({ body }) => body.includes(task)).map(({ title }) => title))
      .toEqual(["Tentative effect"]);
    expect(result.organized.notes.every(({ body }) => !body.includes(qualification))).toBe(true);
  });

  it("rejects repeated generated prose through the existing correction pass and preserves corrected text", async () => {
    const repeated = "A tentative explanation remains a hypothesis until the available evidence can distinguish it from alternatives.";
    const corrected = `${repeated}\n\nThe specific counterexample narrows the claim without resolving the wider question.`;
    const { result, requests } = await recoveredImport({
      first: [{ title: "Tentative explanation", thesis: repeated }],
      second: [{ title: "Independent observation", thesis: "An independent observation limits what can be generalized from the first case." }],
    }, (request, payload) => {
      for (const draft of payload.drafts) {
        draft.body = request.observations.length === 0
          ? `${repeated}\n\n${repeated}`
          : corrected;
      }
    });
    expect(result.organized.notes.every(({ body }) => body === corrected)).toBe(true);
    expect(requests.filter(({ assignment }) => assignment.output.kind === "writer-result")).toHaveLength(4);
    expect(result.warnings.some((warning) => warning.includes("completed “"))).toBe(false);
  });

  it("does not treat deliberately repeated quotations as duplicate explanatory prose", async () => {
    const quoted = "A repeated line may be meaningful evidence when the source deliberately repeats it.";
    const body = `> ${quoted}\n\n> ${quoted}\n\nThe repetition is part of the example being discussed.`;
    const { result, requests } = await recoveredImport({
      first: [{ title: "Deliberate repetition", thesis: quoted }],
      second: [{ title: "Distinct contrast", thesis: "The contrasting passage presents a different pattern of emphasis." }],
    }, (_request, payload) => {
      payload.drafts.forEach((draft) => { draft.body = body; });
    });
    expect(result.organized.notes.every((note) => note.body === body)).toBe(true);
    expect(requests.filter(({ assignment }) => assignment.output.kind === "writer-result")).toHaveLength(2);
  });
});
