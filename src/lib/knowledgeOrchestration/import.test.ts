import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { Note, ParsedImport } from "../../types";
import {
  KnowledgeImportRunError,
  landFailedKnowledgeImport,
  runKnowledgeImportBatch,
  snapshotStillMatchesImportBase,
  validateAndFinalizeImportResult,
} from "./import";
import {
  createKnowledgeRunContext,
  createMandatoryCoverageCall,
  createRootAssignment,
  noteVersion,
  stableSnapshotVersion,
} from "./context";
import {
  artifactPayload,
  fixedPipelineResponse,
  longPdfText,
  routingArtifact,
  runResult,
} from "./testFixtures";
import {
  KnowledgeProviderExecutionError,
  KnowledgeProviderTimeoutError,
  type KnowledgeAssignmentExecutionRequest,
} from "./service";
import type { KnowledgeRuntimeEvent } from "./runtime";
import { prepareSpaceKnowledgeIndex } from "../spaceKnowledge";

const NOW = "2026-08-11T10:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

describe("variable-width import integration", () => {
  it.each(["overlap", "tasks", "guidance", "populated", "preferences", "preservation"])(
    "keeps shared planning for compact imports needing %s decisions", async (reason) => {
      const snapshot = createEmptySnapshot("Space", NOW);
      if (reason === "populated") {
        snapshot.notes = [wikiNote()];
        snapshot.settings.includeExistingNotesInAIContext = false;
      }
      if (reason === "preferences") snapshot.settings.organizationInstructions = "Combine every idea into one note.";
      let planCalls = 0;
      await runKnowledgeImportBatch({
        snapshot,
        sources: [
          { sourceId: "s1", parsed: parsed("Memo", reason === "tasks" ? "- [ ] Review the research" : "Inherited trauma generates political myths.") },
          { sourceId: "s2", parsed: parsed("Research", "Sincerity alternates with irony.") },
        ],
        importGuidance: reason === "guidance" ? "Combine both sources into one argument." : "",
        model: snapshot.settings.model, effort: "high",
        driver: async (request) => {
          const response = fixedPipelineResponse(request);
          if (request.assignment.output.kind === "writing-blueprint") {
            planCalls += 1;
            const readings = readingsFromPipelineMaterials(request);
            if (reason === "preservation") expect(readings[0].reading.mustPreserve).toContain("Retain the author's qualification exactly.");
            if (reason !== "overlap") {
              const payload = response.response.payload as { outputs: Array<Record<string, unknown>>; seedDispositions: Array<Record<string, unknown>>; writerSlots: Array<Record<string, unknown>> };
              const template = payload.outputs[0];
              payload.outputs = readings.map(({ artifactId, reading }, index) => ({
                ...template, outputId: `output-${index + 1}`, title: index === 0 ? "Primordial wound" : "Metamodern oscillation",
                sourceIds: [reading.sourceId], mustPreserve: reading.mustPreserve,
                claimSelections: [{ artifactId, claimIds: reading.sourceClaims.map(({ claimId }) => claimId) }],
              }));
              payload.seedDispositions = readings.flatMap(({ artifactId, reading }, index) => reading.synthesisSeeds.map(({ seedId }) => ({
                artifactId, seedId, disposition: "output", outputId: `output-${index + 1}`, rationale: "This is a distinct idea.",
              })));
              payload.writerSlots = [{ writerSlotId: "writer-1", objective: "Write the assigned ideas.", outputIds: ["output-1", "output-2"] }];
            }
          }
          if (request.assignment.output.kind === "source-reading") {
            const reading = response.response.payload as { synthesisSeeds: Array<{ proposedTitle: string; thesis: string }>; mustPreserve: string[] };
            const first = request.assignment.output.sourceId === "s1";
            reading.synthesisSeeds[0].proposedTitle = first || reason === "overlap" ? "Primordial wound" : "Metamodern oscillation";
            reading.synthesisSeeds[0].thesis = first ? "Inherited trauma generates political myths." : "Sincerity alternates with irony.";
            if (reason === "preservation") reading.mustPreserve.push("Retain the author's qualification exactly.");
          }
          return response;
        },
      });
      expect(planCalls).toBe(1);
    },
  );

  it("starts the fixed transport deadline only after a globally queued call dispatches", async () => {
    vi.useFakeTimers();
    const snapshot = createEmptySnapshot("Space", NOW);
    const driver: import("./service").KnowledgeAssignmentDriver = async (request) => {
      // Waiting longer than the five-minute provider timeout is not a provider failure.
      await new Promise((resolve) => setTimeout(resolve, 310_000));
      request.onProviderStart?.();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return fixedPipelineResponse(request);
    };
    driver.schedulesProviderCalls = true;
    const pending = runKnowledgeImportBatch({ snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("First", "First text") }, { sourceId: "s2", parsed: parsed("Second", "Second text") }],
      importGuidance: "", model: snapshot.settings.model, effort: "high", driver,
    });
    await vi.runAllTimersAsync();
    const output = await pending;
    expect(output.organized.notes).toHaveLength(1);
    expect(output.landing).toBeUndefined();
  });

  it("finishes two distinct short notes in two provider rounds while preserving high-effort writers", async () => {
    vi.useFakeTimers();
    const snapshot = createEmptySnapshot("Space", NOW);
    const stages: Array<{ kind: string; at: number; effort: string }> = [];
    const start = Date.now();
    const pending = runKnowledgeImportBatch({
      snapshot,
      sources: [
        { sourceId: "s1", parsed: parsed("Memo", "Inherited trauma creates political myths.") },
        { sourceId: "s2", parsed: parsed("Research", "Metamodern oscillation alternates sincerity and irony.") },
      ],
      importGuidance: "", model: "gpt-5.6-sol", effort: "high",
      driver: async (request) => {
        const kind = request.assignment.output.kind;
        stages.push({ kind, at: Date.now() - start, effort: request.effort });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const response = fixedPipelineResponse(request);
        if (request.assignment.output.kind === "source-reading") {
          const seed = (response.response.payload as { synthesisSeeds: Array<{ proposedTitle: string; thesis: string }> }).synthesisSeeds[0];
          seed.proposedTitle = request.assignment.output.sourceId === "s1" ? "Primordial wound" : "Metamodern oscillation";
          seed.thesis = request.assignment.output.sourceId === "s1" ? "Inherited trauma creates political myths." : "Sincerity and irony alternate as cultural moods.";
        }
        return response;
      },
    });
    await vi.runAllTimersAsync();
    const output = await pending;
    expect(stages.map(({ kind }) => kind)).toEqual(["source-reading", "source-reading", "writer-result", "writer-result"]);
    expect(stages.slice(0, 2).map(({ at, effort }) => ({ at, effort }))).toEqual([{ at: 0, effort: "medium" }, { at: 0, effort: "medium" }]);
    expect(stages.slice(2).map(({ at, effort }) => ({ at, effort }))).toEqual([{ at: 1_000, effort: "high" }, { at: 1_000, effort: "high" }]);
    expect(Date.now() - start).toBe(2_000);
    expect(output.organized.notes.map(({ title }) => title)).toEqual(["Primordial wound", "Metamodern oscillation"]);
    expect(output.provenance.map(({ sourceIds }) => sourceIds)).toEqual([["s1"], ["s2"]]);
    expect(output.warnings).not.toContain("Orion repaired the note plan locally from the completed readings before writing the notes.");
  });

  it("reads two short sources together and writes disjoint ideas together without a provider reading plan", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let readers = 0, writers = 0;
    let releaseReaders!: () => void, releaseWriters!: () => void;
    const readingGate = new Promise<void>((resolve) => { releaseReaders = resolve; });
    const writingGate = new Promise<void>((resolve) => { releaseWriters = resolve; });
    const kinds: string[] = [];
    const slots: string[] = [];
    const pending = runKnowledgeImportBatch({
      snapshot,
      sources: [
        { sourceId: "s1", parsed: parsed("Source one", "Memory shapes the city.") },
        { sourceId: "s2", parsed: parsed("Source two", "Responsibility shapes the council.") },
      ],
      importGuidance: "Preserve the two distinct ideas.",
      model: snapshot.settings.model, effort: "high",
      driver: async (request) => {
        const kind = request.assignment.output.kind;
        kinds.push(kind);
        if (kind === "source-reading") { readers += 1; await readingGate; }
        if (kind === "writer-result") {
          writers += 1;
          slots.push(request.assignment.output.writerSlotId);
          await writingGate;
        }
        const response = fixedPipelineResponse(request);
        if (kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          const payload = response.response.payload as {
            outputs: Array<Record<string, unknown>>;
            seedDispositions: Array<Record<string, unknown>>;
            writerSlots: Array<Record<string, unknown>>;
          };
          const template = payload.outputs[0];
          payload.outputs = readings.map(({ artifactId, reading }, index) => ({
            ...template, outputId: `output-${index + 1}`,
            title: index === 0 ? "Memory and the city" : "Responsibility and the council",
            editorialBrief: "Write this distinct idea from its selected evidence.",
            sourceIds: [reading.sourceId],
            claimSelections: [{ artifactId, claimIds: reading.sourceClaims.map(({ claimId }) => claimId) }],
            mustPreserve: reading.mustPreserve,
          }));
          payload.seedDispositions = readings.flatMap(({ artifactId, reading }, index) =>
            reading.synthesisSeeds.map(({ seedId }) => ({ artifactId, seedId,
              disposition: "output", outputId: `output-${index + 1}`, rationale: "This seed defines a distinct idea." })));
          payload.writerSlots = [{ writerSlotId: "writer-1", objective: "Write both ideas.", outputIds: ["output-1", "output-2"] }];
        }
        return response;
      },
    });
    await vi.waitFor(() => expect(readers).toBe(2));
    expect(writers).toBe(0);
    releaseReaders();
    await vi.waitFor(() => expect(writers).toBe(2));
    expect(new Set(slots).size).toBe(2);
    releaseWriters();
    const output = await pending;
    expect(kinds).toEqual(["source-reading", "source-reading", "writing-blueprint", "writer-result", "writer-result"]);
    expect(output.organized.notes).toHaveLength(2);
    expect(output.provenance.map(({ sourceIds }) => sourceIds)).toEqual([["s1"], ["s2"]]);
    expect(output.landing).toBeUndefined();
    expect(snapshot.notes).toEqual([]);
  });

  it("uses one immutable batch and permits direct one-call completion", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const driver = vi.fn().mockResolvedValue({
      response: { kind: "complete", payload: runResult() },
    });
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
      importGuidance: "Preserve the central distinction.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver,
    });
    expect(driver).toHaveBeenCalledTimes(1);
    expect(output.organized.notes[0].title).toBe("Finding");
    expect(snapshotStillMatchesImportBase(snapshot, output.baseSnapshotVersion)).toBe(
      true,
    );
    snapshot.spaceOverview = {
      title: "A refreshed orientation",
      body: "Overview-only state changed while the import was running.",
      relatedNoteIds: [],
      generatedAt: "2026-08-11T10:01:00.000Z",
      stale: false,
    };
    expect(snapshotStillMatchesImportBase(snapshot, output.baseSnapshotVersion)).toBe(
      true,
    );
    snapshot.workspace.description = "Changed knowledge scope";
    expect(snapshotStillMatchesImportBase(snapshot, output.baseSnapshotVersion)).toBe(
      false,
    );
  });

  it("routes only local hybrid candidates before a short import", async () => {
    const snapshot = snapshotWithNotes(60);
    const linked = snapshot.notes[17];
    snapshot.spaceOverview = {
      title: `Around ${linked.title}`,
      body: `${linked.title} is the only current route into this question.`,
      relatedNoteIds: [linked.id, "missing-note", snapshot.notes[59].id],
      generatedAt: NOW,
      stale: true,
    };
    snapshot.spaceKnowledge = prepareSpaceKnowledgeIndex(snapshot, NOW);
    const requests: KnowledgeAssignmentExecutionRequest[] = [];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        requests.push(request);
        if (request.assignment.output.kind === "note-routing") {
          expect(request.assignment.purpose).toBe("router");
          expect(request.assignment.output.rangeId).toBe("note-digests-inline");
          expect(request.assignment.output.expectedNotes).toHaveLength(1);
          expect(request.assignment.objective).toContain(
            "Assignment material synopsis",
          );
          expect(request.assignment.objective).toContain("Brief text");
          expect(
            new Set(
              request.assignment.output.expectedNotes.map(({ noteId }) => noteId),
            ),
          ).toEqual(new Set([linked.id]));
          return {
            response: {
              kind: "complete",
              payload: {
                rangeId: request.assignment.output.rangeId,
                routes: request.assignment.output.expectedNotes.map(
                  ({ noteId, noteVersion }, index) => ({
                    noteId,
                    noteVersion,
                    relation: index === 0 ? "extends" : "unrelated",
                    rationale: "A bounded routing judgment.",
                    candidateNoteIds: [],
                  }),
                ),
                warnings: [],
              },
            },
          };
        }
        expect(request.assignment.purpose).toBe("root");
        const routingArtifacts = request.completedChildArtifacts.filter(
          ({ routing }) => routing !== undefined,
        );
        expect(routingArtifacts).toHaveLength(1);
        expect(routingArtifacts[0].routing?.routes).toHaveLength(1);
        const routedNotes = request.context.spaceOrientation.routedNotes ?? [];
        expect(routedNotes.map(({ relation }) => relation)).toEqual(["extends"]);
        expect(
          request.context.spaceOrientation.linkedNotes?.map(({ noteId }) => noteId),
        ).toEqual([linked.id]);
        expect(
          request.context.runManifest?.candidateNotes.map(({ noteId }) => noteId),
        ).toEqual([linked.id]);
        expect(JSON.stringify(request.context)).not.toContain(
          snapshot.notes[59].body,
        );
        return { response: { kind: "complete", payload: runResult() } };
      },
    });

    expect(requests).toHaveLength(2);
    expect(requests[0].assignment.purpose).toBe("router");
    expect(requests[1].assignment.purpose).toBe("root");
    expect(output.organized.notes[0].title).toBe("Finding");
  });

  it("contracts one bounded relevance-selected routing range in a 150-note Space", async () => {
    const snapshot = snapshotWithNotes(150);
    const anchor = snapshot.notes[10];
    snapshot.notes[30].summary = "Solenoid winding actuation research.";
    snapshot.notes[60].title = "Thermal drift";
    snapshot.notes[90].aliases = ["actuation flux"];
    snapshot.spaceOverview = {
      title: `Around ${anchor.title}`,
      body: `${anchor.title} anchors this question.`,
      relatedNoteIds: [anchor.id],
      generatedAt: NOW,
      stale: false,
    };
    const expectedUniverse = new Set([
      anchor.id,
      snapshot.notes[30].id,
      snapshot.notes[60].id,
      snapshot.notes[90].id,
    ]);
    const requests: KnowledgeAssignmentExecutionRequest[] = [];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed(
            "Coil study",
            "The solenoid winding archive explains actuation flux and thermal drift.",
          ),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        requests.push(request);
        if (request.assignment.output.kind === "note-routing") {
          expect(request.assignment.output.rangeId).toBe("note-digests-inline");
          expect(
            new Set(
              request.assignment.output.expectedNotes.map(({ noteId }) => noteId),
            ),
          ).toEqual(expectedUniverse);
          return {
            response: {
              kind: "complete",
              payload: {
                rangeId: request.assignment.output.rangeId,
                routes: request.assignment.output.expectedNotes.map(
                  ({ noteId, noteVersion }) => ({
                    noteId,
                    noteVersion,
                    relation: "unrelated",
                    rationale: "A bounded routing judgment.",
                    candidateNoteIds: [],
                  }),
                ),
                warnings: [],
              },
            },
          };
        }
        expect(request.assignment.purpose).toBe("root");
        expect(
          new Set(
            (request.context.runManifest?.candidateNotes ?? []).map(
              ({ noteId }) => noteId,
            ),
          ),
        ).toEqual(expectedUniverse);
        return { response: { kind: "complete", payload: runResult() } };
      },
    });

    expect(requests).toHaveLength(2);
    expect(output.organized.notes[0].title).toBe("Finding");
  });

  it("rejects the import as coverage when the contracted routing pass fails", async () => {
    const snapshot = snapshotWithNotes(30);
    const failure = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "note-routing") {
          throw new Error("The router driver failed.");
        }
        return { response: { kind: "complete", payload: runResult() } };
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    if (!(failure instanceof KnowledgeImportRunError)) {
      throw new Error("Expected the routing failure to reject the import.");
    }
    expect(failure.diagnostic.code).toBe("coverage");
    expect(failure.diagnostic.resumable).toBe(false);
  });

  it("skips routing entirely when existing-note context is disabled", async () => {
    const snapshot = snapshotWithNotes(60);
    snapshot.settings.includeExistingNotesInAIContext = false;
    const requests: KnowledgeAssignmentExecutionRequest[] = [];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        requests.push(request);
        expect(request.assignment.purpose).toBe("root");
        expect(request.context.runManifest?.candidateNotes).toEqual([]);
        return { response: { kind: "complete", payload: runResult() } };
      },
    });

    expect(requests).toHaveLength(1);
    expect(output.organized.notes[0].title).toBe("Finding");
  });

  it("reuses a validated typed-routing pass for an unchanged direct retry", async () => {
    const snapshot = snapshotWithNotes(60);
    const store = new Map<string, string>();
    const routingCache = {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const routerCalls: string[] = [];
    const rootRoutedRelations: string[][] = [];
    let duplicatedNoteId = "";
    const run = () =>
      runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        routingCache,
        driver: async (request) => {
          if (request.assignment.output.kind === "note-routing") {
            routerCalls.push(request.assignment.assignmentId);
            const expectedNotes = request.assignment.output.expectedNotes;
            duplicatedNoteId = expectedNotes[1].noteId;
            return {
              response: {
                kind: "complete",
                payload: {
                  rangeId: request.assignment.output.rangeId,
                  routes: expectedNotes.map(
                    ({ noteId, noteVersion }, index) => ({
                      noteId,
                      noteVersion,
                      relation:
                        index === 0
                          ? "extends"
                          : index === 1
                            ? "duplicate"
                            : "unrelated",
                      rationale: "A bounded routing judgment.",
                      candidateNoteIds:
                        index === 1 ? [expectedNotes[0].noteId] : [],
                    }),
                  ),
                  warnings: [],
                },
              },
            };
          }
          expect(request.assignment.purpose).toBe("root");
          expect(
            request.assignment.constraints.rules.some((rule) =>
              rule.includes("Host-verified typed routing"),
            ),
          ).toBe(true);
          rootRoutedRelations.push(
            (request.context.spaceOrientation.routedNotes ?? []).map(
              ({ relation }) => relation,
            ),
          );
          return { response: { kind: "complete", payload: runResult() } };
        },
      });

    const first = await run();
    expect(routerCalls).toHaveLength(1);
    expect(store.size).toBe(1);
    const duplicatedTitle = snapshot.notes.find(
      ({ id }) => id === duplicatedNoteId,
    )!.title;
    expect(first.warnings).toContain(
      `Imported material appears already covered by “${duplicatedTitle}”.`,
    );

    const second = await run();
    expect(routerCalls).toHaveLength(1);
    expect(rootRoutedRelations).toEqual([
      ["extends", "duplicate"],
      ["extends", "duplicate"],
    ]);
    expect(second.warnings).toContain(
      `Imported material appears already covered by “${duplicatedTitle}”.`,
    );
    expect(second.organized.notes[0].title).toBe("Finding");
  });

  it("misses the routing cache when a routed note changes", async () => {
    const snapshot = snapshotWithNotes(40);
    const store = new Map<string, string>();
    const routingCache = {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    let routerCalls = 0;
    let routedNoteId = "";
    const run = () =>
      runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        routingCache,
        driver: async (request) => {
          if (request.assignment.output.kind === "note-routing") {
            routerCalls += 1;
            routedNoteId = request.assignment.output.expectedNotes[0]?.noteId ?? "";
            return {
              response: {
                kind: "complete",
                payload: {
                  rangeId: request.assignment.output.rangeId,
                  routes: request.assignment.output.expectedNotes.map(
                    ({ noteId, noteVersion }) => ({
                      noteId,
                      noteVersion,
                      relation: "unrelated",
                      rationale: "A bounded routing judgment.",
                      candidateNoteIds: [],
                    }),
                  ),
                  warnings: [],
                },
              },
            };
          }
          return { response: { kind: "complete", payload: runResult() } };
        },
      });

    await run();
    expect(routerCalls).toBe(1);
    await run();
    expect(routerCalls).toBe(1);

    const routedNote = snapshot.notes.find(({ id }) => id === routedNoteId);
    if (!routedNote) throw new Error("Expected a locally selected routing note.");
    routedNote.body += "\n\nA new paragraph the router has not seen.";
    await run();
    expect(routerCalls).toBe(2);
    expect(store.size).toBe(2);
  });

  it("stores no routing fingerprint when the run fails before routing completes", async () => {
    const snapshot = snapshotWithNotes(30);
    const store = new Map<string, string>();
    const routingCache = {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const failure = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      routingCache,
      driver: async (request) => {
        if (request.assignment.output.kind === "note-routing") {
          throw new Error("The router driver failed.");
        }
        return { response: { kind: "complete", payload: runResult() } };
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(KnowledgeImportRunError);
    expect(store.size).toBe(0);
  });

  it("rejects a replacement article for a duplicate-routed note and surfaces stable warnings", () => {
    const snapshot = snapshotWithNotes(6);
    const duplicated = snapshot.notes[1];
    const routing = routingArtifact("assignment:run:router:note-digests-inline", {
      rangeId: "note-digests-inline",
      routes: snapshot.notes.map((note) => ({
        noteId: note.id,
        noteVersion: noteVersion(note),
        relation: note.id === duplicated.id ? "duplicate" : "unrelated",
        rationale: "A bounded routing judgment.",
        candidateNoteIds: [],
      })),
      warnings: [],
    });
    const history: KnowledgeRuntimeEvent[] = [
      { sequence: 1, type: "artifact-recorded", artifact: routing },
    ];
    const sources = [
      { sourceId: "s1", parsed: parsed("Short", "Brief text") },
    ];
    const replacement = runResult();
    replacement.result.wikiArticles = [
      {
        title: duplicated.title,
        summary: "A replacement copy.",
        body: "# Replacement\n\nCopied treatment.",
        overview: "A replacement copy.",
        spaceRelevance: "",
        sourceGroundedDetails: [],
        uncertainties: [],
        tags: [],
        aliases: [],
        links: [],
      },
    ];
    replacement.provenance.push({
      kind: "wikiArticle",
      title: duplicated.title,
      sourceIds: ["s1"],
      evidenceReferences: [{ kind: "source", sourceId: "s1" }],
    });
    expect(() =>
      validateAndFinalizeImportResult(replacement, snapshot, sources, history),
    ).toThrow(/duplicate-routed note must gain an exact owner revision/);

    const finalized = validateAndFinalizeImportResult(
      runResult(),
      snapshot,
      sources,
      history,
    );
    expect(finalized.warnings).toContain(
      `Imported material appears already covered by “${duplicated.title}”.`,
    );
    const repeated = validateAndFinalizeImportResult(
      finalized,
      snapshot,
      sources,
      history,
    );
    expect(
      repeated.warnings.filter((warning) =>
        warning.includes(duplicated.title),
      ),
    ).toHaveLength(1);
  });

  it("invalidates knowledge changes but not an overview-only refresh", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const organizationBase = stableSnapshotVersion(snapshot);
    snapshot.settings.organizationInstructions = "Prefer conceptual tensions.";
    expect(stableSnapshotVersion(snapshot)).not.toBe(organizationBase);

    snapshot.settings.organizationInstructions = "";
    const relationshipBase = stableSnapshotVersion(snapshot);
    snapshot.relationships = [
      {
        id: "relationship-1",
        fromNoteId: "note-a",
        toNoteId: "note-b",
        kind: "contrasts",
        label: "contrasts",
        strength: 0.8,
      },
    ];
    expect(stableSnapshotVersion(snapshot)).not.toBe(relationshipBase);

    snapshot.relationships = [];
    const overviewBase = stableSnapshotVersion(snapshot);
    snapshot.spaceOverview = {
      title: "Across this Space",
      body: "A new synthesis.",
      relatedNoteIds: [],
      generatedAt: NOW,
      stale: false,
    };
    expect(stableSnapshotVersion(snapshot)).toBe(overviewBase);
  });

  it("rejects missing or cross-batch provenance", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const invalid = runResult();
    invalid.provenance[0].sourceIds = ["another-source"];
    expect(() =>
      validateAndFinalizeImportResult(
        invalid,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).toThrow(/another import source/);

    const missing = runResult();
    missing.result.notes.push({
      title: "Second finding",
      summary: "Another result.",
      body: "# Second finding\n\nAnother result.",
      tags: [],
      aliases: [],
      links: [],
    });
    expect(() =>
      validateAndFinalizeImportResult(
        missing,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).toThrow(/Missing source provenance/);

    const empty = runResult();
    empty.provenance[0].sourceIds = [];
    expect(() =>
      validateAndFinalizeImportResult(
        empty,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).toThrow(/omitted source provenance/);

    const wrongRange = runResult();
    wrongRange.provenance[0].evidenceReferences = [
      { kind: "source-range", sourceId: "s1", rangeId: "range-999" },
    ];
    expect(() =>
      validateAndFinalizeImportResult(
        wrongRange,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).toThrow(/unavailable source range/);
  });

  it("requires exact source-evidence closure and current note versions", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const emptyEvidence = runResult();
    emptyEvidence.provenance[0].evidenceReferences = [];
    expect(() =>
      validateAndFinalizeImportResult(
        emptyEvidence,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).toThrow(/no source evidence/);

    const crossSource = runResult();
    crossSource.provenance[0].evidenceReferences = [
      { kind: "source", sourceId: "s2" },
    ];
    expect(() =>
      validateAndFinalizeImportResult(
        crossSource,
        snapshot,
        [
          { sourceId: "s1", parsed: parsed("Source 1", "Text") },
          { sourceId: "s2", parsed: parsed("Source 2", "Text") },
        ],
        [],
      ),
    ).toThrow(/did not evidence claimed source|unclaimed source/);

    const existing = wikiNote();
    snapshot.notes = [existing];
    const staleNote = runResult();
    staleNote.provenance[0].evidenceReferences = [
      { kind: "source", sourceId: "s1" },
      { kind: "note", noteId: existing.id, version: "stale" },
    ];
    expect(() =>
      validateAndFinalizeImportResult(
        staleNote,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).toThrow(/stale note/);

    const artifactEvidence = runResult();
    artifactEvidence.provenance[0].evidenceReferences = [
      { kind: "artifact", artifactId: "artifact:evidence:1" },
    ];
    const history: KnowledgeRuntimeEvent[] = [
      {
        sequence: 0,
        type: "artifact-recorded",
        artifact: {
          ...artifactPayload("Grounded range summary"),
          artifactId: "artifact:evidence:1",
          assignmentId: "reader",
          purpose: "evidence",
          references: [
            { kind: "source-range", sourceId: "s1", rangeId: "full" },
          ],
        },
      },
    ];
    expect(() =>
      validateAndFinalizeImportResult(
        artifactEvidence,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        history,
      ),
    ).not.toThrow();
  });

  it("grows clean long-source reading to six without forcing tangents into notes", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const source = parsed("Hegel", longPdfText(240));
    let active = 0;
    let maximumActive = 0;
    let coverageCount = 0;
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: source }],
      importGuidance: "Preserve the development of the argument.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.purpose === "source-reader") {
          coverageCount += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 3));
          active -= 1;
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(coverageCount).toBeGreaterThan(9);
    expect(maximumActive).toBe(6);
    expect(output.organized.notes[0].title).toBe("Finding");
    expect(
      output.orchestration.history.filter(
        (event) =>
          event.type === "assignment-started" &&
          event.assignmentId.endsWith(":root"),
      ),
    ).toHaveLength(0);
  });

  it("does not count an assigned range unless the completed artifact grounds it", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const sources = [
      {
        sourceId: "s1",
        parsed: parsed("Long source", longPdfText(8, 10_000)),
      },
    ];
    const context = createKnowledgeRunContext(
      "run-grounded-coverage",
      snapshot,
      sources,
      "",
    );
    const root = createRootAssignment(context);
    const call = createMandatoryCoverageCall(context, root.assignmentId);
    if (!call || call.primitive !== "fan_out") {
      throw new Error("Expected mandatory range assignments.");
    }
    const history = call.assignments.flatMap(
      (assignment, index): KnowledgeRuntimeEvent[] => {
        const payload = artifactPayload(`Range ${index + 1}`);
        payload.references = index === 0 ? [] : [...assignment.references];
        payload.mustPreserve = [...assignment.constraints.mustPreserve];
        return [
          {
            sequence: index * 2,
            type: "assignment-created",
            callId: call.callId,
            primitive: "fan_out",
            assignment,
          },
          {
            sequence: index * 2 + 1,
            type: "artifact-recorded",
            artifact: {
              artifactId: `artifact-range-${index + 1}`,
              assignmentId: assignment.assignmentId,
              purpose: "evidence",
              ...payload,
            },
          },
        ];
      },
    );

    expect(() =>
      validateAndFinalizeImportResult(runResult(), snapshot, sources, history),
    ).toThrow(/did not successfully read mandatory source range/);
  });

  it("finishes twelve source readings without a Space-reading prepass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const snapshot = snapshotWithNotes(205);
    const source = parsed("Large book", "A".repeat(1_000_000));
    let active = 0;
    let maximumActive = 0;
    const sourceTimeouts: number[] = [];
    const digestTimeouts: number[] = [];
    const output = runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: source }],
      importGuidance: "Prioritize arguments that extend or challenge the Space.",
      model: snapshot.settings.model,
      effort: "xhigh",
      driver: async (request) => {
        const { assignment, context, timeoutMs } = request;
        if (
          assignment.purpose === "evidence" ||
          assignment.purpose === "reading-blueprint" ||
          assignment.purpose === "source-reader" ||
          assignment.purpose === "writing-blueprint"
        ) {
          expect(request.effort).toBe("medium");
        } else if (assignment.purpose === "writer") {
          expect(request.effort).toBe("xhigh");
        }
        const digestMaterial = context.resolvedMaterials.find(
          ({ reference }) => reference.kind === "note-digest-range",
        )?.material as
          | { noteDigests: Array<{ noteId: string }> }
          | undefined;
        const isDigest =
          assignment.purpose === "evidence" && Boolean(digestMaterial);
        const isSource = assignment.purpose === "source-reader";
        if (!isDigest && !isSource) return fixedPipelineResponse(request);
        (isDigest ? digestTimeouts : sourceTimeouts).push(timeoutMs);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) =>
          setTimeout(resolve, isDigest ? 15_000 : 25_000),
        );
        active -= 1;
        return fixedPipelineResponse(request);
      },
    });

    // Four initial reads establish provider health before width grows to six.
    await vi.advanceTimersByTimeAsync(80_000);
    await expect(output).resolves.toMatchObject({
      organized: { notes: [{ title: "Finding" }] },
    });
    expect(sourceTimeouts).toHaveLength(12);
    expect(sourceTimeouts.every((timeout) => timeout === 300_000)).toBe(true);
    expect(digestTimeouts).toHaveLength(0);
    expect(maximumActive).toBe(6);
  });

  it("requires a completed exact owner artifact and rejects stale work", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const existing = wikiNote();
    snapshot.notes = [existing];
    const value = runResult();
    value.ownerProposals = [
      {
        destinationNoteId: existing.id,
        baseVersion: noteVersion(existing),
        title: existing.title,
        summary: "Integrated summary",
        body: "# Existing\n\nIntegrated evidence.",
        aliases: [],
        tags: [],
        sourceIds: ["s1"],
      },
    ];
    value.result.wikiArticles = [
      {
        title: existing.title,
        summary: "Integrated summary",
        body: "# Existing\n\nIntegrated evidence.",
        overview: "A deliberately rich overview.",
        spaceRelevance: "This changes the Space's central distinction.",
        sourceGroundedDetails: ["A grounded detail."],
        uncertainties: ["A surviving uncertainty."],
        aliases: [],
        tags: [],
        links: [{ targetTitle: "Finding", context: "A live relationship." }],
      },
    ];
    value.provenance.push({
      kind: "wikiArticle",
      title: existing.title,
      sourceIds: ["s1"],
      evidenceReferences: [{ kind: "source", sourceId: "s1" }],
    });
    const history: KnowledgeRuntimeEvent[] = [
      {
        sequence: 0,
        type: "destination-owner-granted",
        assignmentId: "owner",
        destinationNoteIds: [existing.id],
      },
    ];
    expect(() =>
      validateAndFinalizeImportResult(
        value,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        history,
      ),
    ).toThrow(/completed exact owner proposal/);
    const ownerArtifact = {
      ...artifactPayload("Integrated owner revision"),
      artifactId: "artifact:owner:1",
      assignmentId: "owner",
      purpose: "owner" as const,
      ownerProposals: [structuredClone(value.ownerProposals[0])],
    };
    history.push({
      sequence: 1,
      type: "artifact-recorded",
      artifact: ownerArtifact,
    });
    const finalized = validateAndFinalizeImportResult(
      value,
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
      history,
    );
    expect(finalized.result.wikiArticles[0].body).toContain("Integrated evidence");
    expect(finalized.result.wikiArticles[0]).toMatchObject({
      overview: "A deliberately rich overview.",
      spaceRelevance: "This changes the Space's central distinction.",
      sourceGroundedDetails: ["A grounded detail."],
      uncertainties: ["A surviving uncertainty."],
      links: [{ targetTitle: "Finding", context: "A live relationship." }],
    });

    value.ownerProposals[0].baseVersion = "stale";
    ownerArtifact.ownerProposals[0].baseVersion = "stale";
    expect(() =>
      validateAndFinalizeImportResult(
        value,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        history,
      ),
    ).toThrow(/stale/);
  });

  it("does not require legacy Space-digest artifacts in a large Space", () => {
    const snapshot = snapshotWithNotes(137);
    expect(() =>
      validateAndFinalizeImportResult(
        runResult(),
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
        [],
      ),
    ).not.toThrow();
  });

  it("repairs a malformed reading blueprint locally without starting a legacy root writer", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const purposes: string[] = [];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "Read through the Space's central question.",
      model: snapshot.settings.model,
      effort: "xhigh",
      driver: async (request) => {
        purposes.push(request.assignment.purpose);
        if (request.assignment.purpose === "reading-blueprint") {
          expect(request.effort).toBe("medium");
          return { response: { kind: "complete", payload: {} } };
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(output.warnings).toContain(
      "Orion used its local reading map because the first organization pass was unavailable.",
    );
    expect(purposes).not.toContain("root");
    expect(purposes[purposes.length - 1]).toBe("writer");
  });

  it("does not fan out source readers after a provider-wide reading-plan failure", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let sourceReaderCalls = 0;
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.output.kind === "reading-blueprint") {
            throw new KnowledgeProviderExecutionError(
              "OpenAI rate or usage limits were reached.",
            );
          }
          if (request.assignment.output.kind === "source-reading") {
            sourceReaderCalls += 1;
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(sourceReaderCalls).toBe(0);
    expect(interrupted?.diagnostic).toMatchObject({
      stage: "reading",
      code: "provider-rate-limit",
      completedReadings: 0,
      resumable: true,
    });
    expect(interrupted?.checkpoint?.completedSourceReadings).toEqual([]);
  });

  it("gives a writer only the exact source claims selected by its slot", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let inspectedWriter = false;
    await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "source-reading") {
          const response = fixedPipelineResponse(request);
          const payload = response.response.payload as {
            sourceClaims: Array<{
              claimId: string;
              text: string;
              support: Array<{ sourceId: string; rangeId: string }>;
            }>;
            synthesisSeeds: Array<{
              seedId: string;
              proposedTitle: string;
              thesis: string;
              claimIds: string[];
              importance: "low" | "medium" | "high";
              contribution: "new" | "extends" | "contradicts" | "connects" | "qualifies";
              relatedNoteIds: string[];
              rationale: string;
            }>;
          };
          payload.sourceClaims.push({
            claimId: "claim-not-selected",
            text: "This claim must stay outside writer context.",
            support: [
              {
                sourceId: request.assignment.output.sourceId,
                rangeId: request.assignment.output.rangeId,
              },
            ],
          });
          payload.synthesisSeeds.push({
            seedId: "seed-not-selected",
            proposedTitle: "A low-value peripheral detail",
            thesis: "This peripheral detail does not belong in the final note.",
            claimIds: ["claim-not-selected"],
            importance: "low",
            contribution: "qualifies",
            relatedNoteIds: [],
            rationale: "The fixture proves unselected claims stay out of writer context.",
          });
          return response;
        }
        if (request.assignment.purpose === "writer") {
          inspectedWriter = true;
          const readingMaterials = request.context.pipelineMaterials?.filter(
            ({ kind }) => kind === "source-reading",
          ) ?? [];
          expect(readingMaterials.length).toBeGreaterThan(0);
          for (const { payload } of readingMaterials) {
            const scoped = payload as {
              reading?: unknown;
              selectedSourceClaims: Array<{ claimId: string }>;
              selectedSynthesisSeeds: Array<{
                seedId: string;
                contribution: string;
                relatedNoteIds: string[];
              }>;
            };
            expect(scoped.reading).toBeUndefined();
            expect(scoped.selectedSourceClaims.map(({ claimId }) => claimId)).toEqual([
              "claim-1",
            ]);
            expect(scoped.selectedSynthesisSeeds).toEqual([
              expect.objectContaining({
                seedId: "seed-1",
                contribution: "new",
                relatedNoteIds: [],
              }),
            ]);
          }
        }
        return fixedPipelineResponse(request);
      },
    });
    expect(inspectedWriter).toBe(true);
  });

  it("repairs missing writer drafts locally and never starts a post-writer model call", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const purposes: string[] = [];
    const output = await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          purposes.push(request.assignment.purpose);
          const response = fixedPipelineResponse(request);
          if (request.assignment.purpose === "writer") {
            (response.response.payload as { drafts: unknown[] }).drafts = [];
          }
          return response;
        },
      });
    expect(purposes[purposes.length - 1]).toBe("writer");
    expect(purposes).not.toContain("root");
    expect(purposes.filter((purpose) => purpose === "writer")).toHaveLength(2);
    expect(output.organized.notes[0].body).toContain(
      "Grounded claim from range-1.",
    );
    expect(output.warnings).toContain(
      "Orion completed “Finding” directly from its validated source readings after the generated draft could not be used.",
    );
  });

  it("repairs a note plan that repeatedly drops a synthesis seed", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let planCalls = 0;
    const output = await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          const response = fixedPipelineResponse(request);
          if (request.assignment.output.kind === "writing-blueprint") {
            planCalls += 1;
            const payload = response.response.payload as {
              seedDispositions: unknown[];
            };
            payload.seedDispositions = payload.seedDispositions.slice(1);
          }
          return response;
        },
      });
    expect(planCalls).toBe(2);
    expect(output.organized.notes).toHaveLength(2);
    expect(output.warnings).toContain(
      "Orion repaired the note plan locally from the completed readings before writing the notes.",
    );
  });

  it("allows synthesis seeds to be reassigned across disjoint note outputs", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        const response = fixedPipelineResponse(request);
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          const [first, ...rest] = readings;
          if (!first || rest.length === 0) {
            throw new Error("The fixture requires at least two source readings.");
          }
          const payload = response.response.payload as {
            outputs: Array<Record<string, unknown>>;
            seedDispositions: unknown[];
            writerSlots: Array<Record<string, unknown>>;
          };
          payload.outputs = [
            singleSlotOutput("output-1", "Finding", [first], "writer-1"),
            singleSlotOutput("output-2", "Second Finding", rest, "writer-2"),
          ];
          payload.seedDispositions = exactSeedDispositions([
            { outputId: "output-1", readings: [first] },
            { outputId: "output-2", readings: rest },
          ]);
          payload.writerSlots = [
            {
              writerSlotId: "writer-1",
              objective: "Write the first note.",
              outputIds: ["output-1"],
            },
            {
              writerSlotId: "writer-2",
              objective: "Write the second note.",
              outputIds: ["output-2"],
            },
          ];
        }
        return response;
      },
    });
    expect(output.organized.notes.map(({ title }) => title)).toEqual([
      "Finding",
      "Second Finding",
    ]);
  });

  it("repairs a note draft that fails to echo its exact required material", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const output = await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          const response = fixedPipelineResponse(request);
          if (request.assignment.output.kind === "writer-result") {
            const payload = response.response.payload as {
              drafts: Array<{ mustPreserve: string[] }>;
            };
            payload.drafts[0].mustPreserve = [];
          }
          return response;
        },
      });
    expect(output.organized.notes[0].body).toContain(
      "Grounded claim from range-1.",
    );
    expect(output.warnings).toContain(
      "Orion completed “Finding” directly from its validated source readings after the generated draft could not be used.",
    );
  });

  it("uses the full frozen Space to repair title collisions without disclosing note context", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.settings.includeExistingNotesInAIContext = false;
    snapshot.notes = [
      {
        ...wikiNote(),
        id: "private-existing",
        title: "Finding",
        slug: "finding",
      },
    ];
    let writerCalls = 0;
    const output = await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.purpose === "writer") writerCalls += 1;
          return fixedPipelineResponse(request);
        },
    });
    expect(writerCalls).toBe(2);
    expect(output.organized.notes[0].title).toBe("Finding (2)");
    expect(output.warnings).toContain(
      "Orion repaired the note plan locally from the completed readings before writing the notes.",
    );
  });

  it.each([
    ["stale", "note-existing", "stale-version", /revision is stale/],
    [
      "cross-Space",
      "note-from-another-space",
      "unknown",
      /Across this Space did not link|unavailable wiki article/,
    ],
  ])(
    "repairs a %s existing-article destination as a safe new-note plan",
    async (_caseName, noteId, baseVersion, _expectedError) => {
      const snapshot = createEmptySnapshot("Space", NOW);
      snapshot.notes = [wikiNote()];
      let writerCalls = 0;
      const output = await runKnowledgeImportBatch({
          snapshot,
          sources: [
            {
              sourceId: "s1",
              parsed: parsed("Long source", longPdfText(8, 10_000)),
            },
          ],
          importGuidance: "",
          model: snapshot.settings.model,
          effort: snapshot.settings.reasoningEffort,
          driver: async (request) => {
            if (request.assignment.purpose === "writer") writerCalls += 1;
            const response = fixedPipelineResponse(request);
            if (request.assignment.output.kind === "writing-blueprint") {
              const readings = readingsFromPipelineMaterials(request);
              if (readings.length < 2) {
                throw new Error("The invalid revision fixture requires two source readings.");
              }
              const payload = response.response.payload as {
                outputs: Array<Record<string, unknown>>;
                seedDispositions: unknown[];
                writerSlots: Array<Record<string, unknown>>;
              };
              const projectNote = {
                ...payload.outputs[0],
                writerSlotId: "writer-note",
              };
              payload.outputs = [
                {
                  ...payload.outputs[0],
                  outputId: "revision-1",
                  operation: "revise",
                  kind: "wikiArticle",
                  title: "Existing",
                  writerSlotId: "writer-revision",
                  existingDestination: { noteId, baseVersion },
                },
                projectNote,
              ];
              payload.seedDispositions = exactSeedDispositions([
                { outputId: "revision-1", readings },
                { outputId: "output-1", readings },
              ]);
              payload.writerSlots = [
                {
                  writerSlotId: "writer-revision",
                  objective: "Revise the canonical article.",
                  outputIds: ["revision-1"],
                },
                {
                  writerSlotId: "writer-note",
                  objective: "Write the project note.",
                  outputIds: ["output-1"],
                },
              ];
            }
            return response;
          },
        });
      expect(writerCalls).toBe(2);
      expect(output.organized.wikiArticles).toEqual([]);
      expect(output.organized.notes).toHaveLength(2);
      expect(output.warnings).toContain(
        "Orion repaired the note plan locally from the completed readings before writing the notes.",
      );
    },
  );

  it("preserves rich writer fields through a fixed-pipeline wiki revision", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const existing = wikiNote();
    snapshot.notes = [existing];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        const response = fixedPipelineResponse(request);
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          if (readings.length < 2) {
            throw new Error("The wiki revision fixture requires two source readings.");
          }
          const payload = response.response.payload as {
            outputs: Array<Record<string, unknown>>;
            seedDispositions: unknown[];
            writerSlots: Array<Record<string, unknown>>;
          };
          payload.outputs[0] = {
            ...payload.outputs[0],
            writerSlotId: "writer-note",
          };
          payload.outputs.push({
            ...payload.outputs[0],
            outputId: "revision-1",
            operation: "revise",
            kind: "wikiArticle",
            title: existing.title,
            editorialBrief: "Integrate the new evidence into useful prior prose.",
            writerSlotId: "writer-revision",
            existingDestination: {
              noteId: existing.id,
              baseVersion: noteVersion(existing),
            },
          });
          payload.seedDispositions = exactSeedDispositions([
            { outputId: "output-1", readings },
            { outputId: "revision-1", readings },
          ]);
          payload.writerSlots = [
            {
              writerSlotId: "writer-note",
              objective: "Write the project note.",
              outputIds: ["output-1"],
            },
            {
              writerSlotId: "writer-revision",
              objective: "Revise the canonical article.",
              outputIds: ["revision-1"],
            },
          ];
        }
        if (
          request.assignment.output.kind === "writer-result" &&
          request.assignment.output.writerSlotId === "writer-revision"
        ) {
          const payload = response.response.payload as {
            drafts: Array<Record<string, unknown>>;
          };
          payload.drafts[0] = {
            ...payload.drafts[0],
            summary: "An integrated canonical account.",
            body: "# Existing\n\nUseful prose integrated with the new evidence.",
            overview: "A rich overview retained after ownership validation.",
            spaceRelevance: "It changes the Space's central distinction.",
            sourceGroundedDetails: ["A precise source-grounded detail."],
            uncertainties: ["One genuine uncertainty remains."],
            links: [{ targetTitle: "Finding", context: "A related project note." }],
          };
        }
        return response;
      },
    });
    expect(output.organized.wikiArticles).toContainEqual(
      expect.objectContaining({
        title: existing.title,
        overview: "A rich overview retained after ownership validation.",
        spaceRelevance: "It changes the Space's central distinction.",
        sourceGroundedDetails: ["A precise source-grounded detail."],
        uncertainties: ["One genuine uncertainty remains."],
        links: [{ targetTitle: "Finding", context: "A related project note." }],
      }),
    );
  });

  it("supplies one bounded frozen destination directory for a later wiki in a large Space", async () => {
    const snapshot = snapshotWithNotes(55);
    const destination = snapshot.notes[54];
    expect(destination.kind).toBe("wiki");
    snapshot.spaceOverview = {
      title: `Around ${destination.title}`,
      body: `${destination.title} is the one existing article relevant to this import.`,
      relatedNoteIds: [destination.id, "missing-note"],
      generatedAt: NOW,
      stale: true,
    };
    snapshot.spaceKnowledge = prepareSpaceKnowledgeIndex(snapshot, NOW);
    let inspectedPlan = false;
    let digestCalls = 0;
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.purpose === "evidence") digestCalls += 1;
        const response = fixedPipelineResponse(request);
        if (request.assignment.output.kind === "reading-blueprint") {
          const hierarchy = request.context.pipelineMaterials?.find(
            ({ kind }) => kind === "space-blueprint",
          )?.payload as
            | {
                root: { id: string; noteIds?: string[] };
                clusters: Array<{ noteIds: string[] }>;
              }
            | undefined;
          expect(hierarchy?.root.id).toBe("space-blueprint-root");
          expect(hierarchy?.clusters.length).toBeGreaterThan(0);
          expect(
            request.context.spaceOrientation.linkedNotes?.map(
              ({ noteId }) => noteId,
            ),
          ).toEqual([destination.id]);
          expect(request.context.spaceOrientation.spaceBlueprint?.root.id).toBe(
            "space-blueprint-root",
          );
          expect(request.context.runManifest?.candidateNotes).toHaveLength(1);
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          if (readings.length < 2) {
            throw new Error("The wiki directory fixture requires two source readings.");
          }
          inspectedPlan = true;
          expect(
            request.context.resolvedMaterials.map(({ reference }) =>
              reference.kind === "note"
                ? `${reference.kind}:${reference.noteId}`
                : `${reference.kind}:${"artifactId" in reference ? reference.artifactId : ""}`,
            ),
          ).toEqual([
            expect.stringMatching(/^artifact:/),
            `note:${destination.id}`,
          ]);
          expect(request.completedChildArtifacts).toHaveLength(1);
          expect(request.completedChildArtifacts[0]?.routing?.routes).toEqual([
            expect.objectContaining({
              noteId: destination.id,
              relation: "extends",
            }),
          ]);
          const directoryMaterial = request.context.pipelineMaterials?.find(
            ({ payload }) =>
              typeof payload === "object" &&
              payload !== null &&
              "revisionCandidates" in payload,
          );
          const directory =
            directoryMaterial?.payload as {
              revisionCandidates: Array<{
                noteId: string;
                title: string;
                version: string;
              }>;
              collisionTitles: string[];
            };
          expect(directory.revisionCandidates).toHaveLength(1);
          expect(directory.revisionCandidates[0]).toEqual(
            expect.objectContaining({
              noteId: destination.id,
              title: destination.title,
              version: noteVersion(destination),
            }),
          );
          expect(directory.collisionTitles).toHaveLength(55);
          expect(
            new TextEncoder().encode(JSON.stringify(request.context)).byteLength,
          ).toBeLessThan(1_000_000);

          const payload = response.response.payload as {
            outputs: Array<Record<string, unknown>>;
            seedDispositions: unknown[];
            writerSlots: Array<Record<string, unknown>>;
          };
          payload.outputs[0] = {
            ...payload.outputs[0],
            writerSlotId: "writer-note",
          };
          payload.outputs.push({
            ...payload.outputs[0],
            outputId: "revision-late",
            operation: "revise",
            kind: "wikiArticle",
            title: destination.title,
            writerSlotId: "writer-revision",
            existingDestination: {
              noteId: destination.id,
              baseVersion: noteVersion(destination),
            },
          });
          payload.seedDispositions = exactSeedDispositions([
            { outputId: "output-1", readings },
            { outputId: "revision-late", readings },
          ]);
          payload.writerSlots = [
            {
              writerSlotId: "writer-note",
              objective: "Write the project note.",
              outputIds: ["output-1"],
            },
            {
              writerSlotId: "writer-revision",
              objective: "Revise the later wiki.",
              outputIds: ["revision-late"],
            },
          ];
        }
        return response;
      },
    });
    expect(inspectedPlan).toBe(true);
    expect(digestCalls).toBe(0);
    expect(output.organized.wikiArticles.some(({ title }) => title === destination.title)).toBe(
      true,
    );
  });

  it("omits overview, linked notes, and destination metadata when Space context is off", async () => {
    const snapshot = snapshotWithNotes(55);
    snapshot.settings.includeExistingNotesInAIContext = false;
    snapshot.spaceOverview = {
      title: snapshot.notes[0].title,
      body: `${snapshot.notes[0].title} is private context.`,
      relatedNoteIds: [snapshot.notes[0].id],
      generatedAt: NOW,
      stale: false,
    };
    await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (
          request.assignment.output.kind === "reading-blueprint" ||
          request.assignment.output.kind === "writing-blueprint"
        ) {
          expect(request.context.spaceOrientation.overview).toBeUndefined();
          expect(request.context.spaceOrientation.linkedNotes).toEqual([]);
          expect(request.context.spaceOrientation.noteTitles).toEqual([]);
          expect(request.context.spaceOrientation.noteSignals).toEqual([]);
          expect(request.context.spaceOrientation.conceptLabels).toEqual([]);
          expect(request.context.runManifest?.candidateNotes).toEqual([]);
          expect(request.context.runManifest?.concepts).toEqual([]);
          expect(request.context.runManifest?.relationships).toEqual([]);
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          const directory = request.context.pipelineMaterials?.find(
            ({ payload }) =>
              typeof payload === "object" &&
              payload !== null &&
              "revisionCandidates" in payload,
          )?.payload as
            | { revisionCandidates: unknown[]; collisionTitles: string[] }
            | undefined;
          expect(directory).toEqual({
            revisionCandidates: [],
            collisionTitles: [],
          });
        }
        expect(JSON.stringify(request.context)).not.toContain(
          snapshot.notes[0].body,
        );
        return fixedPipelineResponse(request);
      },
    });
  });

  it("makes no provider call when the fixed import is already cancelled", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before import."));
    const driver = vi.fn();
    await expect(
      runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Cancelled before import/);
    expect(driver).not.toHaveBeenCalled();
  });

  it("splits only an incomplete range, keeps successful siblings, and restores canonical evidence locally", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const callsByRange = new Map<string, number>();
    let inspectedCanonicalReading = false;
    const outcome = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "source-reading") {
          const rangeId = request.assignment.output.rangeId;
          callsByRange.set(rangeId, (callsByRange.get(rangeId) ?? 0) + 1);
          const response = fixedPipelineResponse(request);
          if (rangeId === "range-1") {
            const payload = response.response.payload as {
              coverage: { complete: boolean; limitations: string[] };
              sourceClaims: Array<{ claimId: string }>;
              synthesisSeeds: Array<{ claimIds: string[] }>;
            };
            payload.coverage = {
              complete: false,
              limitations: ["This range is too dense for one faithful pass."],
            };
            payload.sourceClaims[0].claimId = "discarded-parent-claim";
            payload.synthesisSeeds[0].claimIds = ["discarded-parent-claim"];
          } else if (rangeId.startsWith("range-1.part-")) {
            const payload = response.response.payload as {
              sourceClaims: Array<{ claimId: string }>;
              synthesisSeeds: Array<{ claimIds: string[] }>;
            };
            payload.sourceClaims[0].claimId = "x".repeat(300);
            payload.synthesisSeeds[0].claimIds = ["x".repeat(300)];
          }
          return response;
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = request.context.pipelineMaterials
            ?.filter(({ kind }) => kind === "source-reading")
            .map(({ payload }) => payload as {
              reading: {
                rangeId: string;
                sourceClaims: Array<{ claimId: string; support: Array<{ rangeId: string }> }>;
              };
            }) ?? [];
          const recovered = readings.find(
            ({ reading }) => reading.rangeId === "range-1",
          )?.reading;
          expect(recovered).toBeDefined();
          expect(recovered?.sourceClaims).toHaveLength(2);
          expect(
            recovered?.sourceClaims.every(({ claimId, support }) =>
              claimId.startsWith("claim-") &&
              claimId.length <= 300 &&
              support.every(({ rangeId }) => rangeId === "range-1"),
            ),
          ).toBe(true);
          expect(JSON.stringify(recovered)).not.toContain(
            "discarded-parent-claim",
          );
          inspectedCanonicalReading = true;
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(outcome.organized.notes).toEqual([
      expect.objectContaining({ title: "Finding" }),
    ]);
    expect(callsByRange.get("range-1")).toBe(1);
    expect(callsByRange.get("range-1.part-1")).toBe(1);
    expect(callsByRange.get("range-1.part-2")).toBe(1);
    expect(callsByRange.get("range-2")).toBe(1);
    expect(inspectedCanonicalReading).toBe(true);
    const sourceArtifacts = outcome.orchestration.artifacts.filter(
      ({ purpose }) => purpose === "evidence",
    );
    expect(
      sourceArtifacts.flatMap((artifact) => [
        ...artifact.references,
        ...artifact.claims.flatMap(({ references }) => references),
      ]),
    ).not.toContainEqual(
      expect.objectContaining({ rangeId: expect.stringContaining(".part-") }),
    );
    const incompleteParentAssignmentId = outcome.orchestration.history.flatMap(
      (event) =>
        event.type === "assignment-created" &&
        event.assignment.output.kind === "source-reading" &&
        event.assignment.output.rangeId === "range-1"
          ? [event.assignment.assignmentId]
          : [],
    )[0];
    expect(incompleteParentAssignmentId).toBeDefined();
    expect(
      outcome.orchestration.history.filter(
        (event) =>
          event.type === "assignment-failed" &&
          event.assignmentId === incompleteParentAssignmentId,
      ),
    ).toHaveLength(1);
    expect(
      outcome.orchestration.history.filter(
        (event) =>
          event.type === "assignment-completed" &&
          event.assignmentId === incompleteParentAssignmentId,
      ),
    ).toHaveLength(0);
  });

  it("keeps a successful child while only its dense sibling widens again", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const callsByRange = new Map<string, number>();
    const readerRequestIds: string[] = [];
    const readingTotals: number[] = [];
    let readerAbortEvents = 0;
    let initialReadingTotal: number | undefined;
    let inspectedCanonicalReading = false;
    const outcome = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Nested adaptive source", longPdfText(8, 20_000)),
        },
      ],
      importGuidance: "Retain the complete argument.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      onTelemetry: (telemetry) => {
        if (telemetry.pipelineStage !== "reading") return;
        initialReadingTotal ??= telemetry.readingTotal;
        readingTotals.push(telemetry.readingTotal ?? 0);
      },
      driver: async (request, signal) => {
        if (request.assignment.output.kind === "source-reading") {
          signal.addEventListener(
            "abort",
            () => {
              readerAbortEvents += 1;
            },
            { once: true },
          );
          const rangeId = request.assignment.output.rangeId;
          callsByRange.set(rangeId, (callsByRange.get(rangeId) ?? 0) + 1);
          readerRequestIds.push(request.requestId);
          const response = fixedPipelineResponse(request);
          if (rangeId === "range-1" || rangeId === "range-1.part-2") {
            const payload = response.response.payload as {
              coverage: { complete: boolean; limitations: string[] };
            };
            payload.coverage = {
              complete: false,
              limitations: ["This branch still needs a closer read."],
            };
          }
          return response;
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          const reading = request.context.pipelineMaterials
            ?.filter(({ kind }) => kind === "source-reading")
            .map(({ payload }) => payload as {
              reading: { rangeId: string; sourceClaims: unknown[] };
            })
            .find(({ reading }) => reading.rangeId === "range-1")?.reading;
          expect(reading?.sourceClaims).toHaveLength(3);
          inspectedCanonicalReading = true;
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(outcome.organized.notes).toEqual([
      expect.objectContaining({ title: "Finding" }),
    ]);
    expect(callsByRange.get("range-1.part-1")).toBe(1);
    expect(callsByRange.get("range-1.part-2")).toBe(1);
    expect(callsByRange.get("range-1.part-2-1")).toBe(1);
    expect(callsByRange.get("range-1.part-2-2")).toBe(1);
    expect(inspectedCanonicalReading).toBe(true);
    expect(Math.max(...readingTotals)).toBe((initialReadingTotal ?? 0) + 2);
    expect(new Set(readerRequestIds).size).toBe(readerRequestIds.length);
    expect(readerAbortEvents).toBe(0);
  });

  it("retains more than 200 small adaptive claims and interpretations when the aggregate remains bounded", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let inspectedCanonicalReading = false;
    const outcome = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Many small findings", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "source-reading") {
          const { sourceId, rangeId } = request.assignment.output;
          const response = fixedPipelineResponse(request);
          const payload = response.response.payload as {
            coverage: { complete: boolean; limitations: string[] };
            sourceClaims: Array<{
              claimId: string;
              text: string;
              support: Array<{ sourceId: string; rangeId: string }>;
            }>;
            synthesisSeeds: Array<{
              seedId: string;
              proposedTitle: string;
              thesis: string;
              claimIds: string[];
              importance: "low" | "medium" | "high";
              contribution: "new" | "extends" | "contradicts" | "connects" | "qualifies";
              relatedNoteIds: string[];
              rationale: string;
            }>;
            spaceInterpretations: Array<{
              interpretationId: string;
              text: string;
              sourceClaimIds: string[];
              relatedNoteIds: string[];
              rationale: string;
            }>;
          };
          if (rangeId === "range-1") {
            payload.coverage = {
              complete: false,
              limitations: ["This range needs two narrower readings."],
            };
          } else if (rangeId.startsWith("range-1.part-")) {
            payload.sourceClaims = Array.from({ length: 101 }, (_, index) => ({
              claimId: `claim-${index + 1}`,
              text: `Small grounded finding ${index + 1}.`,
              support: [{ sourceId, rangeId }],
            }));
            payload.synthesisSeeds = Array.from(
              { length: Math.ceil(payload.sourceClaims.length / 4) },
              (_, index) => ({
                seedId: `seed-${index + 1}`,
                proposedTitle: `Small durable mechanism ${index + 1}`,
                thesis: `The related observations jointly support mechanism ${index + 1}.`,
                claimIds: payload.sourceClaims.slice(index * 4, index * 4 + 4)
                  .map(({ claimId }) => claimId),
                importance: "high",
                contribution: "new",
                relatedNoteIds: [],
                rationale: "At most four related observations support one mechanism, repeated across readings.",
              }),
            );
            payload.spaceInterpretations = payload.sourceClaims.map(
              ({ claimId }, index) => ({
                interpretationId: `interpretation-${index + 1}`,
                text: `Small Space interpretation ${index + 1}.`,
                sourceClaimIds: [claimId],
                relatedNoteIds: [],
                rationale: "This is an editorial lens on the selected claim.",
              }),
            );
          }
          return response;
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          const reading = request.context.pipelineMaterials
            ?.filter(({ kind }) => kind === "source-reading")
            .map(({ payload }) => payload as {
              reading: {
                rangeId: string;
                sourceClaims: unknown[];
                spaceInterpretations: unknown[];
              };
            })
            .find(({ reading }) => reading.rangeId === "range-1")?.reading;
          expect(reading?.sourceClaims).toHaveLength(202);
          expect(reading?.spaceInterpretations).toHaveLength(202);
          inspectedCanonicalReading = true;
        }
        return fixedPipelineResponse(request);
      },
    });

    // Twenty-six exact repeated mechanisms plus the untouched sibling finding.
    // The 202-claim reading is retained without forcing it into twelve notes.
    expect(outcome.organized.notes).toHaveLength(27);
    expect(new Set(outcome.organized.notes.map(({ title }) => title)).size).toBe(27);
    expect(inspectedCanonicalReading).toBe(true);
  });

  it("rejects an oversized aggregate reading set before constructing the writing-plan request", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let writingPlanCalls = 0;
    await expect(
      runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Oversized evidence", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.output.kind === "source-reading") {
            const { sourceId, rangeId } = request.assignment.output;
            const response = fixedPipelineResponse(request);
            const payload = response.response.payload as {
              sourceClaims: Array<{
                claimId: string;
                text: string;
                support: Array<{ sourceId: string; rangeId: string }>;
              }>;
              synthesisSeeds: Array<{
                seedId: string;
                proposedTitle: string;
                thesis: string;
                claimIds: string[];
                importance: "low" | "medium" | "high";
                contribution: "new" | "extends" | "contradicts" | "connects" | "qualifies";
                relatedNoteIds: string[];
                rationale: string;
              }>;
            };
            payload.sourceClaims = Array.from({ length: 200 }, (_, index) => ({
              claimId: `claim-${index + 1}`,
              text: `${String(index + 1).padStart(3, "0")}:${"x".repeat(3_890)}`,
              support: [{ sourceId, rangeId }],
            }));
            payload.synthesisSeeds = payload.sourceClaims.map(
              ({ claimId }, index) => ({
                seedId: `seed-${index + 1}`,
                proposedTitle: `Oversized durable finding ${index + 1}`,
                thesis: `Oversized atomic thesis ${index + 1}.`,
                claimIds: [claimId],
                importance: "high",
                contribution: "new",
                relatedNoteIds: [],
                rationale: "The fixture keeps exact semantic coverage while testing bytes.",
              }),
            );
            return response;
          }
          if (request.assignment.output.kind === "writing-blueprint") {
            writingPlanCalls += 1;
          }
          return fixedPipelineResponse(request);
        },
      }),
    ).rejects.toThrow(/writing-plan evidence budget/i);
    expect(writingPlanCalls).toBe(0);
  });

  it("splits an incomplete token-dense Unicode range without exceeding six physical readers", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const callsByRange = new Map<string, number>();
    let activeReaders = 0;
    let maximumActiveReaders = 0;
    const outcome = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "dense-unicode",
          parsed: parsed("Dense Unicode", "界".repeat(75_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind !== "source-reading") {
          return fixedPipelineResponse(request);
        }
        const rangeId = request.assignment.output.rangeId;
        callsByRange.set(rangeId, (callsByRange.get(rangeId) ?? 0) + 1);
        activeReaders += 1;
        maximumActiveReaders = Math.max(maximumActiveReaders, activeReaders);
        try {
          await new Promise((resolve) => setTimeout(resolve, 3));
          const response = fixedPipelineResponse(request);
          if (rangeId === "range-1") {
            const payload = response.response.payload as {
              coverage: { complete: boolean; limitations: string[] };
            };
            payload.coverage = {
              complete: false,
              limitations: ["The Unicode-dense range needs narrower passes."],
            };
          }
          return response;
        } finally {
          activeReaders -= 1;
        }
      },
    });

    expect(outcome.organized.notes).toEqual([
      expect.objectContaining({ title: "Finding" }),
    ]);
    expect(callsByRange.get("range-1")).toBe(1);
    expect(callsByRange.get("range-1.part-1")).toBe(1);
    expect(callsByRange.get("range-1.part-2")).toBe(1);
    // A contract failure in the first cohort keeps this short queue at four.
    expect(maximumActiveReaders).toBe(4);
  });

  it("repairs a genuinely small ordinary range once instead of splitting it", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const smallRangeCalls: string[] = [];
    const smallRangeRequests: Array<{ attempt: number; requestId: string }> = [];
    await expect(
      runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "long-source",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
          {
            sourceId: "small-source",
            parsed: parsed("Small source", "A genuinely small source."),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (
            request.assignment.output.kind === "source-reading" &&
            request.assignment.output.sourceId === "small-source"
          ) {
            smallRangeCalls.push(request.assignment.output.rangeId);
            smallRangeRequests.push({
              attempt: request.attempt,
              requestId: request.requestId,
            });
            throw new Error("The small reader returned malformed output.");
          }
          return fixedPipelineResponse(request);
        },
      }),
    ).rejects.toThrow(/small reader returned malformed output/i);

    expect(smallRangeCalls).toEqual(["full", "full"]);
    expect(smallRangeCalls.some((rangeId) => rangeId.includes(".part-"))).toBe(
      false,
    );
    expect(smallRangeRequests.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(new Set(smallRangeRequests.map(({ requestId }) => requestId)).size).toBe(2);
  });

  it("retries a transient provider failure once without splitting the logical range", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const callsByRange = new Map<string, number>();
    const firstRangeRequests: Array<{ attempt: number; requestId: string }> = [];
    const outcome = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind !== "source-reading") {
          return fixedPipelineResponse(request);
        }
        const rangeId = request.assignment.output.rangeId;
        const count = (callsByRange.get(rangeId) ?? 0) + 1;
        callsByRange.set(rangeId, count);
        if (rangeId === "range-1") {
          firstRangeRequests.push({
            attempt: request.attempt,
            requestId: request.requestId,
          });
        }
        if (rangeId === "range-1" && count === 1) {
          throw new KnowledgeProviderExecutionError(
            "OpenAI is temporarily unavailable.",
            { retryable: true, retryAfterMs: 0 },
          );
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(outcome.organized.notes).toEqual([
      expect.objectContaining({ title: "Finding" }),
    ]);
    expect(callsByRange.get("range-1")).toBe(2);
    expect(firstRangeRequests.map(({ attempt }) => attempt)).toEqual([1, 2]);
    expect(new Set(firstRangeRequests.map(({ requestId }) => requestId)).size).toBe(2);
    expect([...callsByRange.keys()].some((rangeId) => rangeId.includes(".part-"))).toBe(
      false,
    );
  });

  it("does not recursively split a provider timeout", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const calledRanges: string[] = [];
    await expect(
      runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.output.kind !== "source-reading") {
            return fixedPipelineResponse(request);
          }
          calledRanges.push(request.assignment.output.rangeId);
          if (request.assignment.output.rangeId === "range-1") {
            throw new KnowledgeProviderTimeoutError(
              "OpenAI did not respond within the transport window.",
            );
          }
          return fixedPipelineResponse(request);
        },
      }),
    ).rejects.toThrow(/transport window/i);

    expect(calledRanges).toContain("range-1");
    expect(calledRanges.some((rangeId) => rangeId.includes(".part-"))).toBe(false);
  });

  it("aborts active reader siblings after one provider-wide fatal failure", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let activeReaders = 0;
    let maximumActiveReaders = 0;
    let abortedSiblings = 0;
    let writerCalls = 0;
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Wide source", longPdfText(80)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request, signal) => {
          if (request.assignment.purpose === "writer") writerCalls += 1;
          if (request.assignment.output.kind !== "source-reading") {
            return fixedPipelineResponse(request);
          }
          activeReaders += 1;
          maximumActiveReaders = Math.max(maximumActiveReaders, activeReaders);
          try {
            if (request.assignment.output.rangeId === "range-1") {
              await new Promise((resolve) => setTimeout(resolve, 5));
              throw new KnowledgeProviderExecutionError(
                "OpenAI is temporarily unavailable.",
              );
            }
            return await new Promise<ReturnType<typeof fixedPipelineResponse>>(
              (resolve, reject) => {
                const timeout = setTimeout(
                  () => resolve(fixedPipelineResponse(request)),
                  100,
                );
                signal.addEventListener(
                  "abort",
                  () => {
                    clearTimeout(timeout);
                    abortedSiblings += 1;
                    reject(
                      signal.reason ??
                        new Error("The reader stage was cancelled."),
                    );
                  },
                  { once: true },
                );
              },
            );
          } finally {
            activeReaders -= 1;
          }
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(interrupted?.diagnostic.code).toBe("provider-network");
    expect(maximumActiveReaders).toBeGreaterThan(1);
    expect(maximumActiveReaders).toBeLessThanOrEqual(6);
    expect(abortedSiblings).toBeGreaterThan(0);
    expect(writerCalls).toBe(0);
  });

  it("does not create a split storm for a plain provider outage and reports the widened total", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const calledRanges: string[] = [];
    let initialReadingTotal: number | undefined;
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Long source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        onTelemetry: (telemetry) => {
          if (telemetry.pipelineStage === "reading") {
            initialReadingTotal ??= telemetry.readingTotal;
          }
        },
        driver: async (request) => {
          if (request.assignment.output.kind !== "source-reading") {
            return fixedPipelineResponse(request);
          }
          const rangeId = request.assignment.output.rangeId;
          calledRanges.push(rangeId);
          if (rangeId === "range-1") {
            const response = fixedPipelineResponse(request);
            const payload = response.response.payload as {
              coverage: { complete: boolean; limitations: string[] };
            };
            payload.coverage = {
              complete: false,
              limitations: ["This range needs a closer read."],
            };
            return response;
          }
          if (rangeId === "range-1.part-2") {
            throw new Error("OpenAI returned HTTP 503 Service Unavailable.");
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(interrupted).toBeDefined();
    expect(interrupted?.diagnostic.totalReadings).toBe(
      (initialReadingTotal ?? 0) + 1,
    );
    expect(calledRanges).toContain("range-1.part-2");
    expect(calledRanges.some((rangeId) => rangeId.includes("part-2-"))).toBe(
      false,
    );
  });

  it("checkpoints accepted adaptive leaves and resumes only the rejected frontier", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const sources = [
      {
        sourceId: "s1",
        parsed: parsed("Long source", longPdfText(8, 10_000)),
      },
    ];
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: false,
        driver: async (request) => {
          if (request.assignment.output.kind !== "source-reading") {
            return fixedPipelineResponse(request);
          }
          const rangeId = request.assignment.output.rangeId;
          if (rangeId === "range-1") {
            const response = fixedPipelineResponse(request);
            const payload = response.response.payload as {
              coverage: { complete: boolean; limitations: string[] };
            };
            payload.coverage = {
              complete: false,
              limitations: ["Read both halves independently."],
            };
            return response;
          }
          if (rangeId === "range-1.part-2") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new KnowledgeProviderTimeoutError("Provider timeout.");
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    const checkpoint = interrupted?.checkpoint;
    expect(checkpoint).toBeDefined();
    const rangeProgress = checkpoint?.adaptiveReadingProgress.find(
      ({ sourceId, rangeId }) => sourceId === "s1" && rangeId === "range-1",
    );
    expect(rangeProgress?.leaves.map(({ path }) => path)).toEqual([[1]]);
    expect(rangeProgress?.pending.map(({ path }) => path)).toEqual([[2]]);
    expect(rangeProgress?.attemptCount).toBe(3);
    expect(rangeProgress?.logicalTaskCount).toBe(3);

    const fusedCheckpoint = structuredClone(checkpoint!);
    fusedCheckpoint.runAdaptiveAttemptCount = 72;
    let fuseCheckpoint = fusedCheckpoint;
    for (let resumeIndex = 0; resumeIndex < 2; resumeIndex += 1) {
      let fuseError: KnowledgeImportRunError | undefined;
      let readerCalls = 0;
      try {
        await runKnowledgeImportBatch({
          snapshot,
          sources,
          importGuidance: "",
          model: snapshot.settings.model,
          effort: snapshot.settings.reasoningEffort,
          landOnFailure: false,
          resume: fuseCheckpoint,
          driver: async (request) => {
            if (request.assignment.output.kind === "source-reading") {
              readerCalls += 1;
            }
            return fixedPipelineResponse(request);
          },
        });
      } catch (error) {
        if (!(error instanceof KnowledgeImportRunError)) throw error;
        fuseError = error;
      }
      expect(fuseError?.diagnostic.technicalDetail).toMatch(/safety fuse/i);
      expect(readerCalls).toBe(0);
      expect(fuseError?.checkpoint?.runAdaptiveAttemptCount).toBe(72);
      fuseCheckpoint = fuseError!.checkpoint!;
    }

    const tamperedCheckpoint = structuredClone(checkpoint!);
    tamperedCheckpoint.runAdaptiveAttemptCount = 73;
    await expect(
      runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: false,
        resume: tamperedCheckpoint,
        driver: async (request) => fixedPipelineResponse(request),
      }),
    ).rejects.toThrow(/invalid adaptive run counters/i);

    const resumedRanges: string[] = [];
    const resumed = await runKnowledgeImportBatch({
      snapshot,
      sources,
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      resume: checkpoint,
      driver: async (request) => {
        if (request.assignment.output.kind === "source-reading") {
          resumedRanges.push(request.assignment.output.rangeId);
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(resumedRanges).toEqual(["range-1.part-2"]);
    expect(resumed.organized.notes[0].title).toBe("Finding");
  });

  it("stops one persistently malformed canonical branch at the adaptive safety fuse", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const malformedBranchCalls: string[] = [];
    let writerCalls = 0;
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Dense unpaged source", "x".repeat(900_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.purpose === "writer") writerCalls += 1;
          const response = fixedPipelineResponse(request);
          if (
            request.assignment.output.kind === "source-reading" &&
            (request.assignment.output.rangeId === "range-1" ||
              request.assignment.output.rangeId.startsWith("range-1.part-"))
          ) {
            malformedBranchCalls.push(request.assignment.output.rangeId);
            const payload = response.response.payload as {
              coverage: { complete: boolean; limitations: string[] };
            };
            payload.coverage = {
              complete: false,
              limitations: ["This malformed branch keeps requesting subdivision."],
            };
          }
          return response;
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(interrupted?.diagnostic).toMatchObject({
      stage: "reading",
      code: "validation",
      resumable: true,
    });
    expect(interrupted?.diagnostic.technicalDetail).toMatch(/safety fuse/i);
    expect(malformedBranchCalls.length).toBeLessThanOrEqual(7);
    expect(writerCalls).toBe(0);
  });

  it("bounds adaptive logical width across the complete reading run", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const sourceReaderCalls: string[] = [];
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Wide malformed source", "y".repeat(900_000)),
          },
        ],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          const response = fixedPipelineResponse(request);
          if (request.assignment.output.kind === "source-reading") {
            const rangeId = request.assignment.output.rangeId;
            sourceReaderCalls.push(rangeId);
            if (!rangeId.includes(".part-") || rangeId.endsWith(".part-2")) {
              const payload = response.response.payload as {
                coverage: { complete: boolean; limitations: string[] };
              };
              payload.coverage = {
                complete: false,
                limitations: ["This branch keeps requesting a closer read."],
              };
            }
          }
          return response;
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(interrupted?.diagnostic.technicalDetail).toMatch(/safety fuse/i);
    expect(sourceReaderCalls.length).toBeLessThanOrEqual(48);
    expect(interrupted?.checkpoint).toBeDefined();
  });

  it("narrows a failed range to indivisible leaves, repairs once, and lets sibling readers finish", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const failedRangeCalls = new Map<string, number>();
    let completedSiblingReaders = 0;
    let writerCalls = 0;
    const outcome = runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Long paged source", longPdfText(8, 10_000)),
        },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.purpose === "writer") writerCalls += 1;
        if (request.assignment.purpose !== "source-reader") {
          return fixedPipelineResponse(request);
        }
        if (request.assignment.output.kind !== "source-reading") {
          throw new Error("Expected a source reading.");
        }
        if (request.assignment.output.rangeId.startsWith("range-1")) {
          const rangeId = request.assignment.output.rangeId;
          failedRangeCalls.set(rangeId, (failedRangeCalls.get(rangeId) ?? 0) + 1);
          throw new Error("A mandatory reader failed.");
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        completedSiblingReaders += 1;
        return fixedPipelineResponse(request);
      },
    });
    await expect(outcome).rejects.toThrow(/mandatory reader failed/i);
    expect(
      [...failedRangeCalls.keys()].some((rangeId) => rangeId.includes(".part-")),
    ).toBe(true);
    expect(Math.max(...failedRangeCalls.values())).toBe(2);
    expect(completedSiblingReaders).toBeGreaterThan(0);
    expect(writerCalls).toBe(0);
  });

  it("retains completed readings and resumes without reading them again", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const sources = [
      {
        sourceId: "s1",
        parsed: parsed("Recoverable source", longPdfText(8, 10_000)),
      },
    ];
    const firstReaderRequests: KnowledgeAssignmentExecutionRequest[] = [];
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "Preserve the argument.",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.output.kind === "source-reading") {
            firstReaderRequests.push(request);
            if (request.assignment.output.rangeId === "range-2") {
              throw new KnowledgeProviderTimeoutError(
                "OpenAI did not respond within the transport window.",
              );
            }
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(interrupted).toBeDefined();
    expect(interrupted?.diagnostic).toMatchObject({
      stage: "reading",
      code: "provider-timeout",
      completedReadings: firstReaderRequests.length - 1,
      totalReadings: firstReaderRequests.length,
      resumable: true,
    });
    expect(interrupted?.checkpoint?.completedSourceReadings).toHaveLength(
      firstReaderRequests.length - 1,
    );

    const landed = landFailedKnowledgeImport(interrupted!, sources, snapshot);
    expect(landed?.landing?.tier).toBe(1);
    expect(landed?.landing?.diagnostic).toEqual(interrupted!.diagnostic);
    expect(landed?.landing?.checkpoint).toEqual(interrupted!.checkpoint);
    expect(landed?.landing?.checkpoint).not.toBe(interrupted!.checkpoint);

    const resumedReaderRequests: KnowledgeAssignmentExecutionRequest[] = [];
    const resumed = await runKnowledgeImportBatch({
      snapshot,
      sources,
      importGuidance: "Preserve the argument.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "source-reading") {
          resumedReaderRequests.push(request);
        }
        return fixedPipelineResponse(request);
      },
      resume: landed?.landing?.checkpoint,
    });

    expect(resumed.organized.notes[0].title).toBe("Finding");
    expect(
      resumedReaderRequests.map(({ assignment }) =>
        assignment.output.kind === "source-reading"
          ? assignment.output.rangeId
          : "",
      ),
    ).toEqual(["range-2"]);
    const failedFirstRequest = firstReaderRequests.find(
      ({ assignment }) =>
        assignment.output.kind === "source-reading" &&
        assignment.output.rangeId === "range-2",
    );
    expect(resumedReaderRequests[0].attempt).toBeGreaterThan(
      failedFirstRequest?.attempt ?? 0,
    );
    expect(resumedReaderRequests[0].requestId).not.toBe(
      failedFirstRequest?.requestId,
    );
  });

  it.each(["malformed", "timeout"] as const)(
    "handles a %s post-reading route without widening revision authority",
    async (routingFailure) => {
      const snapshot = createEmptySnapshot("Space", NOW);
      const existing = wikiNote();
      snapshot.notes = [existing];
      snapshot.spaceOverview = {
        title: "Around Existing",
        body: "Existing is the canonical article relevant to this import.",
        relatedNoteIds: [existing.id],
        generatedAt: NOW,
        stale: false,
      };
      snapshot.spaceKnowledge = prepareSpaceKnowledgeIndex(snapshot, NOW);
      let routerCalls = 0;
      const planRequests: KnowledgeAssignmentExecutionRequest[] = [];
      const pending = runKnowledgeImportBatch({
        snapshot,
        sources: [
          {
            sourceId: "s1",
            parsed: parsed("Degraded routed source", longPdfText(8, 10_000)),
          },
        ],
        importGuidance: "Preserve the argument.",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.output.kind === "note-routing") {
            routerCalls += 1;
            if (routingFailure === "timeout") {
              throw new KnowledgeProviderTimeoutError(
                "Provider timeout while routing existing notes.",
              );
            }
            return {
              response: { kind: "complete", payload: {} },
            } as ReturnType<typeof fixedPipelineResponse>;
          }
          const response = fixedPipelineResponse(request);
          if (request.assignment.output.kind === "writing-blueprint") {
            planRequests.push(request);
            expect(
              request.assignment.constraints.rules.some((rule) =>
                rule.includes("did not establish revision authority"),
              ),
            ).toBe(true);
            expect(
              request.context.resolvedMaterials.some(
                ({ reference }) => reference.kind === "note",
              ),
            ).toBe(false);
            expect(request.completedChildArtifacts).toEqual([]);
            const directory = request.context.pipelineMaterials?.find(
              ({ payload }) =>
                typeof payload === "object" &&
                payload !== null &&
                "revisionCandidates" in payload,
            )?.payload as
              | { revisionCandidates: unknown[]; collisionTitles: string[] }
              | undefined;
            expect(directory?.revisionCandidates).toEqual([]);
            expect(directory?.collisionTitles).toContain(existing.title);
            if (planRequests.length === 1) {
              const payload = response.response.payload as {
                outputs: Array<Record<string, unknown>>;
              };
              payload.outputs[0] = {
                ...payload.outputs[0],
                operation: "revise",
                kind: "wikiArticle",
                title: existing.title,
                existingDestination: {
                  noteId: existing.id,
                  baseVersion: noteVersion(existing),
                },
              };
            }
          }
          return response;
        },
      });

      if (routingFailure === "timeout") {
        await expect(pending).rejects.toMatchObject({ diagnostic: { code: "provider-timeout", resumable: true } });
        expect(routerCalls).toBe(1);
        expect(planRequests).toHaveLength(0);
        return;
      }
      const output = await pending;
      expect(routerCalls).toBe(2);
      expect(planRequests).toHaveLength(2);
      expect(planRequests[1].observations[0]?.message).toContain(
        "cannot revise existing articles without validated post-reading routing",
      );
      expect(output.organized.notes).toContainEqual(
        expect.objectContaining({ title: "Finding" }),
      );
      expect(output.organized.wikiArticles).toEqual([]);
      expect(output.warnings).toContain(
        "Orion could not safely match this import to existing notes, so it created new source-grounded notes without revising prior writing.",
      );
    },
  );

  it("resumes from accepted post-reading routing without rerouting or changing the note plan", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const existing = wikiNote();
    snapshot.notes = [existing];
    snapshot.spaceOverview = {
      title: "Around Existing",
      body: "Existing is the canonical article relevant to this import.",
      relatedNoteIds: [existing.id],
      generatedAt: NOW,
      stale: false,
    };
    snapshot.spaceKnowledge = prepareSpaceKnowledgeIndex(snapshot, NOW);
    const sources = [
      {
        sourceId: "s1",
        parsed: parsed("Recoverable routed source", longPdfText(8, 10_000)),
      },
    ];
    let routingCalls = 0;
    let planCalls = 0;
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "Preserve the argument.",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: false,
        driver: async (request) => {
          const response = fixedPipelineResponse(request);
          if (request.assignment.output.kind === "note-routing") {
            routingCalls += 1;
          }
          if (request.assignment.output.kind === "writing-blueprint") {
            planCalls += 1;
            const readings = readingsFromPipelineMaterials(request);
            if (readings.length < 2) {
              throw new Error("The routed revision fixture requires two source readings.");
            }
            const payload = response.response.payload as {
              outputs: Array<Record<string, unknown>>;
              seedDispositions: unknown[];
              writerSlots: Array<Record<string, unknown>>;
            };
            payload.outputs[0] = {
              ...payload.outputs[0],
              writerSlotId: "writer-routed",
            };
            payload.outputs.push({
              ...payload.outputs[0],
              outputId: "revision-routed",
              operation: "revise",
              kind: "wikiArticle",
              title: existing.title,
              editorialBrief: "Integrate the routed source into the canonical article.",
              writerSlotId: "writer-routed",
              existingDestination: {
                noteId: existing.id,
                baseVersion: noteVersion(existing),
              },
            });
            payload.seedDispositions = exactSeedDispositions([
              { outputId: "output-1", readings },
              { outputId: "revision-routed", readings },
            ]);
            payload.writerSlots = [
              {
                writerSlotId: "writer-routed",
                objective: "Write the project note and routed article revision.",
                outputIds: ["output-1", "revision-routed"],
              },
            ];
          }
          if (request.assignment.output.kind === "writer-result") {
            throw new KnowledgeProviderTimeoutError("Provider timeout while writing.");
          }
          return response;
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(routingCalls).toBeGreaterThan(0);
    expect(planCalls).toBe(1);
    expect(interrupted?.diagnostic.stage).toBe("writing");
    expect(interrupted?.checkpoint?.postReadingRouting?.mode).toBe("routed");
    expect(interrupted?.checkpoint?.writingBlueprint?.outputs).toContainEqual(
      expect.objectContaining({
        outputId: "revision-routed",
        title: existing.title,
        existingDestination: {
          noteId: existing.id,
          baseVersion: noteVersion(existing),
        },
      }),
    );

    const resumedKinds: string[] = [];
    const resumed = await runKnowledgeImportBatch({
      snapshot,
      sources,
      importGuidance: "Preserve the argument.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      resume: interrupted?.checkpoint,
      driver: async (request) => {
        resumedKinds.push(request.assignment.output.kind);
        return fixedPipelineResponse(request);
      },
    });

    expect(resumedKinds).toEqual(["writer-result"]);
    expect(routingCalls).toBeGreaterThan(0);
    expect(planCalls).toBe(1);
    expect(resumed.organized.notes).toContainEqual(
      expect.objectContaining({ title: "Finding" }),
    );
    expect(resumed.organized.wikiArticles).toContainEqual(
      expect.objectContaining({ title: existing.title }),
    );
  });

  it("rejects a recovery checkpoint after the import identity changes", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const sources = [
      {
        sourceId: "s1",
        parsed: parsed("Recoverable source", longPdfText(8, 10_000)),
      },
    ];
    let checkpoint;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "Original guidance.",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => {
          if (request.assignment.output.kind === "source-reading") {
            throw new KnowledgeProviderTimeoutError("Provider timeout.");
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      checkpoint = error.checkpoint;
    }

    await expect(
      runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "Changed guidance.",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async (request) => fixedPipelineResponse(request),
        resume: checkpoint,
      }),
    ).rejects.toThrow(/can no longer resume/);
  });

  it("exposes a classified diagnostic without leaking keys or user paths", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let diagnosticError: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        driver: async () => {
          throw new KnowledgeProviderExecutionError(
            "Unauthorized apiKey='sk-secret-token-123456789' at /Users/zelda/Library/Application Support/Orion.",
          );
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      diagnosticError = error;
    }

    expect(diagnosticError?.diagnostic).toMatchObject({
      stage: "direct",
      code: "provider-auth",
      resumable: false,
    });
    expect(diagnosticError?.diagnostic.technicalDetail).toContain("[redacted]");
    expect(diagnosticError?.diagnostic.technicalDetail).toContain("~/Library");
    expect(diagnosticError?.diagnostic.technicalDetail).not.toContain("zelda");
    expect(diagnosticError?.diagnostic.technicalDetail).not.toContain(
      "sk-secret-token",
    );
  });

  it("accepts several small planned notes in one bounded writing pass", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(80)) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          const [first, ...rest] = readings;
          return {
            response: {
              kind: "complete",
              payload: {
                spaceThesis: "Two small findings share one writing pass.",
                outputs: [
                  singleSlotOutput("output-1", "Finding", [first], "writer-1"),
                  singleSlotOutput("output-2", "Finding Two", rest, "writer-1"),
                ],
                seedDispositions: exactSeedDispositions([
                  { outputId: "output-1", readings: [first] },
                  { outputId: "output-2", readings: rest },
                ]),
                writerSlots: [
                  {
                    writerSlotId: "writer-1",
                    objective: "Write both project notes.",
                    outputIds: ["output-1", "output-2"],
                  },
                ],
                concepts: [],
                suggestedConnections: [],
                warnings: [],
              },
            },
          };
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(output.organized.notes.map(({ title }) => title).sort()).toEqual([
      "Finding",
      "Finding Two",
    ]);
  });

  it("recursively narrows a contract-invalid multi-note writer while retaining successful siblings", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const writerCalls: Array<{ slotId: string; outputIds: string[] }> = [];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(80)) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          const partitions = [0, 1, 2].map((offset) =>
            readings.filter((_, index) => index % 3 === offset),
          );
          expect(partitions.every((values) => values.length > 0)).toBe(true);
          return {
            response: {
              kind: "complete",
              payload: {
                spaceThesis: "Three findings share one initial writing pass.",
                outputs: partitions.map((values, index) =>
                  singleSlotOutput(
                    `output-${index + 1}`,
                    `Finding ${index + 1}`,
                    values,
                    "writer-wide",
                  ),
                ),
                seedDispositions: exactSeedDispositions(
                  partitions.map((readings, index) => ({
                    outputId: `output-${index + 1}`,
                    readings,
                  })),
                ),
                writerSlots: [
                  {
                    writerSlotId: "writer-wide",
                    objective: "Write all three project notes.",
                    outputIds: ["output-1", "output-2", "output-3"],
                  },
                ],
                concepts: [],
                suggestedConnections: [],
                warnings: [],
              },
            },
          };
        }
        if (request.assignment.output.kind === "writer-result") {
          writerCalls.push({
            slotId: request.assignment.output.writerSlotId,
            outputIds: [...request.assignment.output.outputIds],
          });
          if (request.assignment.output.outputIds.length > 1) {
            const invalid = fixedPipelineResponse(request) as {
              response: { payload: { drafts: unknown[] } };
            };
            invalid.response.payload.drafts = [];
            return invalid as ReturnType<typeof fixedPipelineResponse>;
          }
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(output.organized.notes.map(({ title }) => title).sort()).toEqual([
      "Finding 1",
      "Finding 2",
      "Finding 3",
    ]);
    expect(writerCalls.filter(({ slotId }) => slotId === "writer-wide")).toHaveLength(2);
    expect(writerCalls.filter(({ outputIds }) => outputIds.length === 2)).toHaveLength(2);
    expect(writerCalls.filter(({ outputIds }) => outputIds.length === 1)).toHaveLength(3);
    expect(
      writerCalls.filter(({ outputIds }) => outputIds.join(",") === "output-3"),
    ).toHaveLength(1);
    expect(output.warnings.some((warning) => warning.includes("completed “"))).toBe(
      false,
    );
    expect(output.landing).toBeUndefined();
  });

  it("checkpoints accepted per-output drafts and resumes only the failed writer child", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const sources = [{ sourceId: "s1", parsed: parsed("Long", longPdfText(80)) }];
    const writingBlueprint = (request: KnowledgeAssignmentExecutionRequest) => {
      const readings = readingsFromPipelineMaterials(request);
      return {
        response: {
          kind: "complete" as const,
          payload: {
            spaceThesis: "Two findings share one recoverable writing slot.",
            outputs: [
              singleSlotOutput("output-1", "Finding 1", readings, "writer-wide"),
              singleSlotOutput("output-2", "Finding 2", readings, "writer-wide"),
            ],
            seedDispositions: exactSeedDispositions([
              { outputId: "output-1", readings },
              { outputId: "output-2", readings },
            ]),
            writerSlots: [
              {
                writerSlotId: "writer-wide",
                objective: "Write both findings.",
                outputIds: ["output-1", "output-2"],
              },
            ],
            concepts: [],
            suggestedConnections: [],
            warnings: [],
          },
        },
      };
    };
    let interrupted: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources,
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: false,
        driver: async (request) => {
          if (request.assignment.output.kind === "writing-blueprint") {
            return writingBlueprint(request);
          }
          if (request.assignment.output.kind === "writer-result") {
            if (request.assignment.output.outputIds.length > 1) {
              const invalid = fixedPipelineResponse(request) as {
                response: { payload: { drafts: unknown[] } };
              };
              invalid.response.payload.drafts = [];
              return invalid as ReturnType<typeof fixedPipelineResponse>;
            }
            if (request.assignment.output.outputIds[0] === "output-2") {
              await new Promise((resolve) => setTimeout(resolve, 10));
              throw new KnowledgeProviderTimeoutError("Provider timeout.");
            }
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      interrupted = error;
    }

    expect(interrupted?.checkpoint?.writerProgress.slots).toEqual([
      expect.objectContaining({
        writerSlotId: "writer-wide",
        drafts: [expect.objectContaining({ outputId: "output-1" })],
      }),
    ]);
    const resumedWriterOutputs: string[][] = [];
    const resumed = await runKnowledgeImportBatch({
      snapshot,
      sources,
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      resume: interrupted?.checkpoint,
      driver: async (request) => {
        if (request.assignment.output.kind === "writer-result") {
          resumedWriterOutputs.push([...request.assignment.output.outputIds]);
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(resumedWriterOutputs).toEqual([["output-2"]]);
    expect(resumed.organized.notes.map(({ title }) => title).sort()).toEqual([
      "Finding 1",
      "Finding 2",
    ]);
  });

  it("opens one run-wide writer circuit and grounds the remaining outputs locally", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let writerCalls = 0;
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(80)) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        const response = fixedPipelineResponse(request);
        if (request.assignment.output.kind === "source-reading") {
          const payload = response.response.payload as {
            sourceClaims: Array<{
              claimId: string;
              text: string;
              support: Array<{ sourceId: string; rangeId: string }>;
            }>;
            synthesisSeeds: Array<Record<string, unknown>>;
          };
          const { sourceId, rangeId } = request.assignment.output;
          payload.sourceClaims = Array.from({ length: 4 }, (_, index) => ({
            claimId: `claim-${index + 1}`,
            text: `Independently useful circuit claim ${index + 1}.`,
            support: [{ sourceId, rangeId }],
          }));
          payload.synthesisSeeds = Array.from({ length: 4 }, (_, index) => ({
            seedId: `seed-${index + 1}`,
            proposedTitle: `Circuit knowledge object ${[...rangeId]
              .map((character) => character.codePointAt(0))
              .join("-")} ${index + 1}`,
            thesis: `Circuit thesis ${index + 1} from ${rangeId}.`,
            claimIds: [`claim-${index + 1}`],
            importance: "high",
            contribution: "new",
            relatedNoteIds: [],
            rationale: "The writer-circuit fixture needs an independently owned seed.",
          }));
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          const readings = readingsFromPipelineMaterials(request);
          const outputs = Array.from({ length: 12 }, (_, index) =>
            ({
              ...singleSlotOutput(
              `output-${index + 1}`,
              `Finding ${index + 1}`,
              readings,
              `writer-${Math.floor(index / 2) + 1}`,
              ),
              claimSelections: readings.map(({ artifactId, reading }) => ({
                artifactId,
                claimIds: reading.sourceClaims.map(({ claimId }) => claimId),
              })),
            }),
          );
          return {
            response: {
              kind: "complete",
              payload: {
                spaceThesis: "Twelve bounded findings test the writer circuit.",
                outputs,
                seedDispositions: exactSeedDispositions(
                  outputs.map(({ outputId }) => ({ outputId, readings })),
                ),
                writerSlots: Array.from({ length: 6 }, (_, index) => ({
                  writerSlotId: `writer-${index + 1}`,
                  objective: `Write findings ${index * 2 + 1} and ${index * 2 + 2}.`,
                  outputIds: [`output-${index * 2 + 1}`, `output-${index * 2 + 2}`],
                })),
                concepts: [],
                suggestedConnections: [],
                warnings: [],
              },
            },
          };
        }
        if (request.assignment.output.kind === "writer-result") {
          writerCalls += 1;
          const invalid = response as {
            response: { payload: { drafts: unknown[] } };
          };
          invalid.response.payload.drafts = [];
          return invalid as ReturnType<typeof fixedPipelineResponse>;
        }
        return response;
      },
    });

    expect(writerCalls).toBe(12);
    expect(output.organized.notes).toHaveLength(12);
    expect(output.warnings.filter((warning) => warning.includes("completed “"))).toHaveLength(12);
    expect(output.landing).toBeUndefined();
  });

  it("corrects a writing plan that selected an unknown claim without pausing the import", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const writingBlueprintRequests: KnowledgeAssignmentExecutionRequest[] = [];
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(12)) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind !== "writing-blueprint") {
          return fixedPipelineResponse(request);
        }
        writingBlueprintRequests.push(request);
        const valid = fixedPipelineResponse(request) as {
          response: {
            kind: "complete";
            payload: {
              outputs: Array<{
                claimSelections: Array<{ claimIds: string[] }>;
              }>;
            };
          };
        };
        if (writingBlueprintRequests.length === 1) {
          const broken = structuredClone(valid);
          broken.response.payload.outputs[0].claimSelections[0].claimIds.push(
            "range9-claim-01",
          );
          return broken;
        }
        return valid;
      },
    });

    expect(writingBlueprintRequests).toHaveLength(2);
    expect(writingBlueprintRequests[0].observations).toEqual([]);
    expect(writingBlueprintRequests[1].observations).toHaveLength(1);
    expect(writingBlueprintRequests[1].observations[0].message).toContain(
      "selected unknown claim range9-claim-01",
    );
    expect(output.organized.notes[0].title).toBe("Finding");
  });

  it("corrects malformed plan and writer response shapes without asking to resume", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let planCalls = 0;
    let writerCalls = 0;
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(12)) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "writing-blueprint") {
          planCalls += 1;
          if (planCalls === 1) {
            return {
              response: { kind: "complete", payload: {} },
            } as ReturnType<typeof fixedPipelineResponse>;
          }
        }
        if (request.assignment.output.kind === "writer-result") {
          writerCalls += 1;
          if (writerCalls === 1) {
            return {
              response: { kind: "complete", payload: { drafts: [] } },
            } as unknown as ReturnType<typeof fixedPipelineResponse>;
          }
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(planCalls).toBe(2);
    expect(writerCalls).toBe(2);
    expect(output.organized.notes[0].title).toBe("Finding");
    expect(output.landing).toBeUndefined();
  });

  it("checkpoints a timed-out writing planner without launching any writers", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let planCalls = 0;
    let writerCalls = 0;
    const pending = runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(36)) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        if (request.assignment.output.kind === "writing-blueprint") {
          planCalls += 1;
          throw new KnowledgeProviderTimeoutError(
            "OpenAI did not respond within the transport window.",
          );
        }
        if (request.assignment.output.kind === "writer-result") {
          writerCalls += 1;
        }
        return fixedPipelineResponse(request);
      },
    });

    await expect(pending).rejects.toMatchObject({
      diagnostic: { stage: "writing-plan", code: "provider-timeout", resumable: true },
    });
    expect(planCalls).toBe(1);
    expect(writerCalls).toBe(0);
  });

  it("does not fan out doomed writers after a provider-wide planning failure", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let writerCalls = 0;
    let error: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(36)) }],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: false,
        driver: async (request) => {
          if (request.assignment.output.kind === "writing-blueprint") {
            throw new KnowledgeProviderExecutionError(
              "The provider service is unavailable.",
            );
          }
          if (request.assignment.output.kind === "writer-result") {
            writerCalls += 1;
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (caught) {
      if (!(caught instanceof KnowledgeImportRunError)) throw caught;
      error = caught;
    }

    expect(writerCalls).toBe(0);
    expect(error?.diagnostic.stage).toBe("writing-plan");
    expect(error?.diagnostic.code).not.toBe("unknown");
  });

  it("repairs a seed-omitting Hegel plan while preserving every distinct thesis", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let planCalls = 0;
    const writerSlots: string[] = [];
    let readerOrdinal = 0;
    const emittedHighSeedTitles = new Set<string>();
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        {
          sourceId: "s1",
          parsed: parsed("Hegel Three Studies", longPdfText(80)),
        },
      ],
      importGuidance: "Focus on the major arguments and their development.",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      driver: async (request) => {
        const response = fixedPipelineResponse(request);
        if (request.assignment.output.kind === "source-reading") {
          const { sourceId, rangeId } = request.assignment.output;
          const firstSeedOrdinal = readerOrdinal * 5;
          readerOrdinal += 1;
          const payload = response.response.payload as {
            sourceClaims: Array<Record<string, unknown>>;
            synthesisSeeds: Array<Record<string, unknown>>;
          };
          payload.sourceClaims = Array.from({ length: 5 }, (_, offset) => {
            const ordinal = firstSeedOrdinal + offset;
            const title = hegelSemanticFixtureTitle(ordinal);
            emittedHighSeedTitles.add(title);
            return {
              claimId: `claim-semantic-${ordinal + 1}`,
              text: `${title} supplies a distinct, source-grounded thesis for the Space.`,
              support: [{ sourceId, rangeId }],
            };
          });
          payload.synthesisSeeds = Array.from({ length: 5 }, (_, offset) => {
            const ordinal = firstSeedOrdinal + offset;
            const title = hegelSemanticFixtureTitle(ordinal);
            return {
              seedId: `seed-semantic-${ordinal + 1}`,
              proposedTitle: title,
              thesis: `${title} is a durable knowledge object rather than a section recap.`,
              claimIds: [`claim-semantic-${ordinal + 1}`],
              importance: "high",
              contribution: "new",
              relatedNoteIds: [],
              rationale: "This idea warrants an independent semantic note.",
            };
          });
        }
        if (request.assignment.output.kind === "writing-blueprint") {
          planCalls += 1;
          const readings = readingsFromPipelineMaterials(request);
          const payload = response.response.payload as {
            outputs: Array<{
              claimSelections: Array<{ artifactId: string; claimIds: string[] }>;
            }>;
            seedDispositions: Array<Record<string, unknown>>;
          };
          payload.outputs[0].claimSelections = readings.map(
            ({ artifactId, reading }) => ({
              artifactId,
              claimIds: reading.sourceClaims.map(({ claimId }) => claimId),
            }),
          );
          let primaryAssigned = false;
          payload.seedDispositions = readings.flatMap(({ artifactId, reading }) =>
            reading.synthesisSeeds.map(({ seedId }) => {
              const disposition = primaryAssigned ? "merged" : "output";
              primaryAssigned = true;
              return {
                artifactId,
                seedId,
                disposition,
                outputId: "output-1",
                rationale:
                  disposition === "output"
                    ? "The collapsed book plan treats one idea as primary."
                    : "The collapsed book plan incorrectly folds this distinct idea into one note.",
              };
            }),
          );
          // A structural omission, rather than an arbitrary numeric output
          // floor, triggers recovery. Every retained clear thesis stays whole.
          payload.seedDispositions = payload.seedDispositions.slice(1);
        }
        if (request.assignment.output.kind === "writer-result") {
          writerSlots.push(request.assignment.output.writerSlotId);
        }
        return response;
      },
    });

    expect(planCalls).toBe(2);
    expect(emittedHighSeedTitles.size).toBeGreaterThanOrEqual(18);
    expect(new Set(writerSlots).size).toBeGreaterThan(1);
    expect(new Set(writerSlots).size).toBeLessThanOrEqual(6);
    expect(output.organized.notes.length).toBe(emittedHighSeedTitles.size);
    expect(new Set(output.organized.notes.map(({ title }) => title)).size).toBe(
      output.organized.notes.length,
    );
    expect(
      output.organized.notes.some(({ title }) =>
        /Hegel Three Studies|\bPart\s+\d+\b|\brange[-\s]?\d+\b|\bpages?\s+\d+\b/i.test(
          title,
        ),
      ),
    ).toBe(false);
    expect(output.landing).toBeUndefined();
    expect(output.warnings).toContain(
      "Orion repaired the note plan locally from the completed readings before writing the notes.",
    );
  });

  it("reuses cached range readings for unchanged material and misses on changed text", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const store = new Map<string, string>();
    const readingCache = {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const text = longPdfText(12);
    const readerRequests: string[] = [];
    const run = (
      sourceText: string,
      importGuidance = "",
      sourceId = "s1",
    ) =>
      runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId, parsed: parsed("Long", sourceText) }],
        importGuidance,
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        readingCache,
        driver: async (request) => {
          if (request.assignment.output.kind === "source-reading") {
            readerRequests.push(request.assignment.assignmentId);
          }
          return fixedPipelineResponse(request);
        },
      });

    const first = await run(text);
    expect(first.organized.notes[0].title).toBe("Finding");
    const readerCallsAfterFirst = readerRequests.length;
    expect(readerCallsAfterFirst).toBeGreaterThan(0);
    expect(store.size).toBeGreaterThan(0);

    const second = await run(text, "", "fresh-source-id");
    expect(second.organized.notes[0].title).toBe("Finding");
    expect(readerRequests.length).toBe(readerCallsAfterFirst);

    const third = await run(text, "Read this source through a different lens.");
    expect(third.organized.notes[0].title).toBe("Finding");
    expect(readerRequests.length).toBeGreaterThan(readerCallsAfterFirst);
    const readerCallsAfterGuidanceChange = readerRequests.length;

    const fourth = await run(
      text.replace("## Page 1\n", "## Page 1\n\nA revised opening paragraph.\n"),
      "Read this source through a different lens.",
    );
    expect(fourth.organized.notes[0].title).toBe("Finding");
    expect(readerRequests.length).toBeGreaterThan(readerCallsAfterGuidanceChange);
  });
});

describe("landing ladder", () => {
  it("keeps the failing path unchanged when landing is off", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    let landedError: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId: "s1", parsed: parsed("Short", "Brief text") }],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: false,
        driver: async () => {
          throw new Error("The provider connection was reset unexpectedly.");
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      landedError = error;
    }

    expect(landedError?.diagnostic).toMatchObject({
      stage: "direct",
      code: "provider-network",
      resumable: false,
    });
  });

  it("repairs a persistently sabotaged writing stage without invoking the landing ladder", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const frozen = structuredClone(snapshot);
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [
        { sourceId: "s1", parsed: parsed("First Volume", longPdfText(24)) },
        { sourceId: "s2", parsed: parsed("Second Volume", longPdfText(24)) },
      ],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      landOnFailure: true,
      driver: async (request) => {
        if (request.assignment.output.kind === "writer-result") {
          const sabotaged = structuredClone(
            fixedPipelineResponse(request),
          ) as {
            response: {
              kind: string;
              payload: { drafts: Array<{ outputId: string }> };
            };
          };
          sabotaged.response.payload.drafts[0].outputId = "ghost-output";
          return sabotaged as ReturnType<typeof fixedPipelineResponse>;
        }
        return fixedPipelineResponse(request);
      },
    });

    expect(snapshot).toEqual(frozen);
    expect(output.landing).toBeUndefined();
    expect(output.warnings).toContain(
      "Orion completed “Finding” directly from its validated source readings after the generated draft could not be used.",
    );
    expect(output.organized.notes.map(({ title }) => title).sort()).toEqual([
      "Finding",
    ]);
    for (const note of output.organized.notes) {
      expect(note.body).not.toContain("Synthesize every selected range claim.");
      expect(note.body).toContain("Grounded claim from range-1.");
      expect(note.body).not.toContain("Complete summary of range-1.");
      expect(note.body).not.toContain("- Grounded claim from range-1.");
      expect(note.body).not.toMatch(/\bPart\s+\d+:/);
    }
    expect(output.organized.wikiArticles).toEqual([]);
    expect(output.provenance).toHaveLength(1);
    for (const entry of output.provenance) {
      expect(entry.kind).toBe("note");
      expect(entry.sourceIds).toHaveLength(2);
      expect(entry.evidenceReferences.length).toBeGreaterThan(0);
      for (const reference of entry.evidenceReferences) {
        expect(reference.kind).toBe("artifact");
      }
    }
    expect(
      snapshotStillMatchesImportBase(snapshot, output.baseSnapshotVersion),
    ).toBe(true);
  });

  it("lands a direct-path persistent provider crash at tier 2 with the source text preserved", async () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const text = "Brief text that must survive the landing intact.";
    const output = await runKnowledgeImportBatch({
      snapshot,
      sources: [{ sourceId: "s1", parsed: parsed("Short", text) }],
      importGuidance: "",
      model: snapshot.settings.model,
      effort: snapshot.settings.reasoningEffort,
      landOnFailure: true,
      driver: async () => {
        throw new Error("The provider connection was reset unexpectedly.");
      },
    });

    expect(output.landing).toMatchObject({
      tier: 2,
      code: "provider-network",
      diagnostic: {
        stage: "direct",
        code: "provider-network",
        technicalDetail: "The provider connection was reset unexpectedly.",
        resumable: false,
      },
    });
    expect(output.warnings[0]).toMatch(/^Orion landed this import plainly/);
    expect(output.organized.notes).toHaveLength(1);
    expect(output.organized.notes[0].title).toBe("Short");
    expect(output.organized.notes[0].body).toBe(text);
    expect(output.provenance).toEqual([
      {
        kind: "note",
        title: "Short",
        sourceIds: ["s1"],
        evidenceReferences: [{ kind: "source", sourceId: "s1" }],
      },
    ]);
    expect(
      snapshotStillMatchesImportBase(snapshot, output.baseSnapshotVersion),
    ).toBe(true);
  });

  it("still rejects cancellation when landing is enabled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const snapshot = createEmptySnapshot("Space", NOW);
    let cancelledError: KnowledgeImportRunError | undefined;
    try {
      await runKnowledgeImportBatch({
        snapshot,
        sources: [{ sourceId: "s1", parsed: parsed("Long", longPdfText(24)) }],
        importGuidance: "",
        model: snapshot.settings.model,
        effort: snapshot.settings.reasoningEffort,
        landOnFailure: true,
        signal: controller.signal,
        driver: async (request) => {
          calls += 1;
          if (calls === 2) controller.abort();
          if (controller.signal.aborted) {
            throw (
              controller.signal.reason ??
              new Error("The knowledge run was cancelled.")
            );
          }
          return fixedPipelineResponse(request);
        },
      });
    } catch (error) {
      if (!(error instanceof KnowledgeImportRunError)) throw error;
      cancelledError = error;
    }

    expect(cancelledError?.diagnostic.code).toBe("cancelled");
    expect(cancelledError?.diagnostic.resumable).toBe(false);
  });
});

function parsed(title: string, text: string): ParsedImport {
  return {
    title,
    fileName: `${title}.txt`,
    mimeType: "text/plain",
    format: "text",
    byteSize: text.length,
    text,
    warnings: [],
  };
}


function wikiNote(): Note {
  return {
    id: "note-existing",
    title: "Existing",
    slug: "existing",
    summary: "Existing summary",
    body: "# Existing\n\nUseful prose.",
    aliases: [],
    tags: [],
    kind: "wiki",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function snapshotWithNotes(count: number) {
  const snapshot = createEmptySnapshot("Space", NOW);
  snapshot.notes = Array.from({ length: count }, (_, index) => ({
    ...wikiNote(),
    id: `note-${String(index + 1).padStart(3, "0")}`,
    title: `Topic ${String(index + 1).padStart(3, "0")}`,
    slug: `topic-${index + 1}`,
    summary: `Summary for topic ${index + 1}.`,
    body: `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(50)}`,
    kind: index % 3 === 0 ? ("wiki" as const) : ("article" as const),
  }));
  return snapshot;
}

interface PipelineReadingMaterial {
  artifactId: string;
  reading: {
    sourceId: string;
    sourceClaims: Array<{ claimId: string }>;
    synthesisSeeds: Array<{
      seedId: string;
      claimIds: string[];
    }>;
    mustPreserve: string[];
  };
}

function readingsFromPipelineMaterials(
  request: KnowledgeAssignmentExecutionRequest,
): PipelineReadingMaterial[] {
  return (
    request.context.pipelineMaterials
      ?.filter(({ kind }) => kind === "source-reading")
      .map(({ payload }) => payload as PipelineReadingMaterial) ?? []
  );
}

function singleSlotOutput(
  outputId: string,
  title: string,
  readings: PipelineReadingMaterial[],
  writerSlotId: string,
) {
  return {
    outputId,
    operation: "create",
    kind: "note",
    title,
    editorialBrief: `Synthesize the selected claims into ${title}.`,
    sourceIds: [...new Set(readings.map(({ reading }) => reading.sourceId))],
    claimSelections: readings.map(({ artifactId, reading }) => ({
      artifactId,
      claimIds: [reading.sourceClaims[0].claimId],
    })),
    lensSelections: [],
    mustPreserve: [
      ...new Set(readings.flatMap(({ reading }) => reading.mustPreserve)),
    ],
    estimatedTokens: 800,
    writerSlotId,
    existingDestination: null,
  };
}

function exactSeedDispositions(
  assignments: Array<{
    outputId: string;
    readings: PipelineReadingMaterial[];
  }>,
) {
  const allSeeds = new Map(
    assignments
      .flatMap(({ readings }) => readings)
      .flatMap(({ artifactId, reading }) =>
        reading.synthesisSeeds.map((seed) => [
          `${artifactId}\u0000${seed.seedId}`,
          { artifactId, seed },
        ] as const),
      ),
  );
  const assigned = new Set<string>();
  const dispositions: Array<{
    artifactId: string;
    seedId: string;
    disposition: "output" | "merged";
    outputId: string;
    rationale: string;
  }> = [];

  for (const assignment of assignments) {
    const eligible = assignment.readings.flatMap(({ artifactId, reading }) =>
      reading.synthesisSeeds.map((seed) => ({ artifactId, seed })),
    );
    const primary = eligible.find(
      ({ artifactId, seed }) => !assigned.has(`${artifactId}\u0000${seed.seedId}`),
    );
    if (!primary) {
      throw new Error(`Fixture output ${assignment.outputId} has no primary seed.`);
    }
    const key = `${primary.artifactId}\u0000${primary.seed.seedId}`;
    assigned.add(key);
    dispositions.push({
      artifactId: primary.artifactId,
      seedId: primary.seed.seedId,
      disposition: "output",
      outputId: assignment.outputId,
      rationale: "This seed defines the fixture output's knowledge object.",
    });
  }

  for (const [key, { artifactId, seed }] of allSeeds) {
    if (assigned.has(key)) continue;
    const destination = assignments.find(({ readings }) =>
      readings.some((reading) => reading.artifactId === artifactId),
    );
    if (!destination) {
      throw new Error(`Fixture seed ${seed.seedId} has no eligible output.`);
    }
    dispositions.push({
      artifactId,
      seedId: seed.seedId,
      disposition: "merged",
      outputId: destination.outputId,
      rationale: "This compatible fixture seed is merged into the selected output.",
    });
  }

  return dispositions;
}

const HEGEL_SEMANTIC_FIXTURE_TITLES = [
  "Contradiction as Immanent Critique",
  "Identity Depends on Nonidentity",
  "Determinate Negation Produces Content",
  "Conceptual Mediation Shapes Experience",
  "Freedom Requires Institutional Form",
  "History Is Legible Through Rupture",
  "Totality Reveals Systemic Dependence",
  "Reconciliation Must Preserve Difference",
  "The Subject Is Socially Mediated",
  "Objectivity Exceeds Conceptual Capture",
  "Dialectics Resists Fixed Oppositions",
  "Second Nature Conceals Historical Formation",
  "Truth Emerges Through Internal Tension",
  "Reason Is Both Critical and Practical",
  "Experience Revises the Concept",
  "Universality Bears Particular Content",
  "Spirit Is Collective Self-Interpretation",
  "Negativity Prevents Premature Closure",
  "The Whole Is Known Through Its Fractures",
  "Philosophy Interprets Social Contradiction",
  "Concepts Carry Historical Sediment",
  "Critique Begins Inside Its Object",
  "Systematic Ambition Generates Its Own Limits",
  "Emancipation Requires More Than Recognition",
] as const;

function hegelSemanticFixtureTitle(ordinal: number): string {
  const base = HEGEL_SEMANTIC_FIXTURE_TITLES[
    ordinal % HEGEL_SEMANTIC_FIXTURE_TITLES.length
  ];
  const cycle = Math.floor(ordinal / HEGEL_SEMANTIC_FIXTURE_TITLES.length);
  return cycle === 0 ? base : `${base}: Further Consequence ${cycle + 1}`;
}
