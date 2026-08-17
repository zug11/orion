import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../../data/defaults";
import type { Note, ParsedImport } from "../../types";
import {
  buildAssignmentContextPacket,
  buildRoutedNoteContext,
  buildTargetedImportSpaceContext,
  createNoteDigestRangeManifests,
  createMandatoryCoverageCall,
  createKnowledgeRunContext,
  createDuplicateRoutingCandidates,
  createNoteRoutingCacheKey,
  createNoteRoutingCall,
  createRoutedFullNoteReferences,
  createRootAssignment,
  createSeededRoutingArtifact,
  createSourceReadingPlan,
  createSpaceDigestCall,
  KnowledgeArtifactRegistry,
  noteVersion,
  referenceAllowedInRun,
  resolveKnowledgeReference,
  validateCompleteNoteRoutingCoverage,
} from "./context";
import type { KnowledgeNoteRoutingResult } from "./protocol";
import { assignment, ownerAssignment, routingArtifact } from "./testFixtures";

const NOW = "2026-08-11T10:00:00.000Z";

describe("knowledge run context", () => {
  it("exposes short content directly but only bounded handles for a long source", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const short = parsed("Short", "Small grounded text.");
    const long = parsed(
      "Long",
      Array.from(
        { length: 80 },
        (_, index) => `## Page ${index + 1}\n\n${"A".repeat(1_100)}`,
      ).join("\n\n"),
    );
    const context = createKnowledgeRunContext(
      "run",
      snapshot,
      [
        { sourceId: "short", parsed: short },
        { sourceId: "long", parsed: long },
      ],
      "Focus on disagreements.",
    );
    const root = createRootAssignment(context);
    expect(root.references).toContainEqual({
      kind: "source-range",
      sourceId: "short",
      rangeId: "full",
    });
    expect(root.references).toContainEqual({ kind: "source", sourceId: "long" });
    expect(context.sources.find(({ sourceId }) => sourceId === "long")?.ranges.length)
      .toBeGreaterThan(1);
    const coverage = createMandatoryCoverageCall(context, root.assignmentId);
    const longRanges =
      context.sources.find(({ sourceId }) => sourceId === "long")?.ranges ?? [];
    if (!coverage || coverage.primitive !== "fan_out") {
      throw new Error("Expected mandatory source coverage to fan out.");
    }
    expect(coverage.assignments).toHaveLength(longRanges.length);
    expect(
      coverage.assignments.every(
        (assignment, index) =>
          assignment.references[0]?.kind === "source-range" &&
          assignment.references[0].sourceId === "long" &&
          assignment.references[0].rangeId === longRanges[index].rangeId,
      ),
    ).toBe(true);
  });

  it("resolves only declared same-Space references and detects stale owners", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const note = makeNote("note-a", "Current body");
    snapshot.notes = [note];
    const context = createKnowledgeRunContext(
      "run",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
      "",
    );
    const registry = new KnowledgeArtifactRegistry();
    expect(() =>
      resolveKnowledgeReference(
        context,
        { kind: "note", noteId: "other-space-note", version: "x" },
        registry,
      ),
    ).toThrow(/Unknown note in this Space/);

    const owner = ownerAssignment("owner", "root", "note-a", noteVersion(note));
    owner.references = [
      { kind: "note", noteId: "note-a", version: noteVersion(note) },
    ];
    expect(buildAssignmentContextPacket(context, owner, registry).resolvedMaterials)
      .toHaveLength(1);
    const stale = ownerAssignment("stale", "root", "note-a", "old");
    stale.references = [
      { kind: "note", noteId: "note-a", version: noteVersion(note) },
    ];
    expect(referenceAllowedInRun(context, registry, stale)).toMatch(/stale/);
  });

  it("does not inherit undeclared parent or Space material", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = [makeNote("note-a", "Secret body")];
    const context = createKnowledgeRunContext(
      "run",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "Text") }],
      "",
    );
    const child = assignment("child", "root");
    child.references = [{ kind: "source", sourceId: "s1" }];
    const packet = buildAssignmentContextPacket(
      context,
      child,
      new KnowledgeArtifactRegistry(),
    );
    expect(JSON.stringify(packet)).not.toContain("Secret body");
    expect(packet.excludedContext).toContain("Every other Orion Space");
  });

  it("orients a 60-note import from only visible overview links", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 60 }, (_, index) => {
      const note = makeNote(
        `note-${index + 1}`,
        `${"界".repeat(6_000)} PRIVATE_${index + 1}`,
      );
      note.title = `Topic ${index + 1}`;
      note.summary = `${"論".repeat(900)} summary ${index + 1}`;
      note.aliases = index === 1 ? ["Second thread"] : [];
      return note;
    });
    snapshot.concepts = Array.from({ length: 12 }, (_, index) => ({
      id: `concept-${index + 1}`,
      label: `Topic ${index + 1}`,
      aliases: [],
      description: `Concept ${index + 1}`,
      noteIds: [`note-${index + 1}`],
      canonicalNoteId: `note-${index + 1}`,
      color: "#7890ff",
      autoLink: true,
    }));
    snapshot.spaceOverview = {
      title: "A stale but useful map",
      body: Array.from({ length: 12 }, (_, index) => `Topic ${index + 1}`).join(
        ", ",
      ),
      relatedNoteIds: ["note-60", "missing-note", "note-2", "note-2"],
      generatedAt: NOW,
      stale: true,
    };

    const targeted = buildTargetedImportSpaceContext(snapshot);
    expect(targeted.basis).toBe("saved-overview");
    expect(targeted.overview?.stale).toBe(true);
    expect(targeted.linkedNotes.map(({ noteId }) => noteId)).toEqual(
      Array.from({ length: 8 }, (_, index) => `note-${index + 1}`),
    );
    expect(
      new TextEncoder().encode(JSON.stringify(targeted)).byteLength,
    ).toBeLessThanOrEqual(48 * 1_024);
    expect(JSON.stringify(targeted)).not.toContain("PRIVATE_60");

    const context = createKnowledgeRunContext(
      "run-targeted-large-space",
      snapshot,
      [{ sourceId: "new-source", parsed: parsed("Source", "Text") }],
      "",
      { useOverviewLinkedNoteContext: true },
    );
    expect(context.space.noteDigestRanges).toEqual([
      {
        rangeId: "note-digests-inline",
        noteIds: targeted.linkedNotes.map(({ noteId }) => noteId),
      },
    ]);
    expect(context.space.notes.map(({ noteId }) => noteId)).toEqual(
      targeted.linkedNotes.map(({ noteId }) => noteId),
    );
    expect([...context.materials.notes.keys()]).toEqual(
      targeted.linkedNotes.map(({ noteId }) => noteId),
    );
  });

  it("keeps a stale overview with no valid visible links summary-only", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const hidden = makeNote("note-hidden", "PRIVATE_HIDDEN_BODY");
    hidden.title = "Hidden archive";
    snapshot.notes = [hidden];
    snapshot.spaceOverview = {
      title: "An older orientation",
      body:
        "This overview does not visibly name any surviving note. orion-note://note-hidden is untrusted prose, not disclosure authority.",
      relatedNoteIds: ["missing-note", hidden.id],
      generatedAt: NOW,
      stale: true,
    };
    const context = createKnowledgeRunContext(
      "run-summary-only",
      snapshot,
      [{ sourceId: "new-source", parsed: parsed("Source", "Text") }],
      "",
      { useOverviewLinkedNoteContext: true },
    );
    const packet = buildAssignmentContextPacket(
      context,
      createRootAssignment(context),
      new KnowledgeArtifactRegistry(),
    );

    expect(packet.spaceOrientation.overview?.title).toBe("An older orientation");
    expect(packet.spaceOrientation.linkedNotes).toEqual([]);
    expect(packet.spaceOrientation.noteSignals).toEqual([]);
    expect(packet.runManifest?.candidateNotes).toEqual([]);
    expect(JSON.stringify(packet)).not.toContain("PRIVATE_HIDDEN_BODY");
  });

  it("uses the local Home overview when no saved overview exists", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const note = makeNote("note-local", "A locally summarized body.");
    note.title = "Local thread";
    snapshot.notes = [note];

    const targeted = buildTargetedImportSpaceContext(snapshot);

    expect(targeted.basis).toBe("local-overview");
    expect(targeted.overview?.body).toContain("Local thread");
    expect(targeted.linkedNotes.map(({ noteId }) => noteId)).toEqual([
      "note-local",
    ]);
  });

  it("exposes no existing-Space packets when existing-note context is off", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const note = makeNote("note-private", "PRIVATE_DISABLED_NOTE");
    note.title = "Private concept";
    snapshot.notes = [note];
    snapshot.spaceOverview = {
      title: "Private concept",
      body: "Private concept is central.",
      relatedNoteIds: [note.id],
      generatedAt: NOW,
      stale: false,
    };
    snapshot.concepts = [
      {
        id: "concept-private",
        label: "Private concept",
        aliases: [],
        description: "PRIVATE_CONCEPT_DESCRIPTION",
        noteIds: [note.id],
        canonicalNoteId: note.id,
        color: "#7890ff",
        autoLink: true,
      },
    ];
    snapshot.relationships = [
      {
        id: "relationship-private",
        fromNoteId: note.id,
        toNoteId: note.id,
        kind: "related",
        label: "PRIVATE_RELATIONSHIP",
        strength: 1,
      },
    ];
    snapshot.sources = [
      {
        id: "old-source",
        title: "Old private source",
        kind: "text",
        importedAt: NOW,
        text: "PRIVATE_OLD_SOURCE",
        noteIds: [note.id],
      },
    ];
    snapshot.settings.includeExistingNotesInAIContext = false;
    const context = createKnowledgeRunContext(
      "run-disabled-context",
      snapshot,
      [{ sourceId: "new-source", parsed: parsed("New source", "New text") }],
      "",
      { useOverviewLinkedNoteContext: true },
    );
    const packet = buildAssignmentContextPacket(
      context,
      createRootAssignment(context),
      new KnowledgeArtifactRegistry(),
    );

    expect(packet.spaceOrientation.overview).toBeUndefined();
    expect(packet.spaceOrientation.linkedNotes).toEqual([]);
    expect(packet.spaceOrientation.noteTitles).toEqual([]);
    expect(packet.spaceOrientation.noteSignals).toEqual([]);
    expect(packet.spaceOrientation.conceptLabels).toEqual([]);
    expect(packet.runManifest?.candidateNotes).toEqual([]);
    expect(packet.runManifest?.concepts).toEqual([]);
    expect(packet.runManifest?.relationships).toEqual([]);
    expect(context.space.sources).toEqual([]);
    expect(() =>
      resolveKnowledgeReference(
        context,
        { kind: "source", sourceId: "old-source" },
        new KnowledgeArtifactRegistry(),
      ),
    ).toThrow(/Unknown source/);
    expect(JSON.stringify(packet)).not.toMatch(
      /PRIVATE_DISABLED_NOTE|PRIVATE_CONCEPT_DESCRIPTION|PRIVATE_RELATIONSHIP|PRIVATE_OLD_SOURCE/,
    );
  });

  it("covers all 137 notes exactly once in bounded digest ranges without leaking full bodies", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 137 }, (_, index) => {
      const note = makeNote(
        `note-${String(index + 1).padStart(3, "0")}`,
        `# Note ${index + 1}\n\nOpening argument ${"developed prose ".repeat(120)}\n\nPRIVATE_BODY_SENTINEL_${index + 1}`,
      );
      note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
      note.summary = `A compact orientation to topic ${index + 1}.`;
      note.kind = index % 4 === 0 ? "wiki" : "article";
      return note;
    });
    const context = createKnowledgeRunContext(
      "run-large-space",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "A new topic.") }],
      "Focus on material that changes the Space.",
    );

    expect(context.space.notes).toEqual([]);
    expect(context.space.noteDigestRanges.map(({ noteIds }) => noteIds.length)).toEqual([
      28,
      28,
      27,
      27,
      27,
    ]);
    const coveredIds = context.space.noteDigestRanges.flatMap(({ noteIds }) => noteIds);
    expect(coveredIds).toHaveLength(137);
    expect(new Set(coveredIds)).toEqual(new Set(snapshot.notes.map(({ id }) => id)));

    const root = createRootAssignment(context);
    const coverage = createSpaceDigestCall(context, root.assignmentId);
    if (!coverage || coverage.primitive !== "fan_out") {
      throw new Error("Expected large-Space digest coverage to fan out.");
    }
    expect(coverage.assignments).toHaveLength(5);
    const registry = new KnowledgeArtifactRegistry();
    for (const [index, digestAssignment] of coverage.assignments.entries()) {
      const packet = buildAssignmentContextPacket(context, digestAssignment, registry);
      const expectedRange = context.space.noteDigestRanges[index];
      const digestMaterial = packet.resolvedMaterials.find(
        ({ reference }) => reference.kind === "note-digest-range",
      )?.material as
        | { rangeId: string; noteDigests: Array<{ noteId: string }> }
        | undefined;
      expect(digestMaterial?.rangeId).toBe(expectedRange.rangeId);
      expect(digestMaterial?.noteDigests.map(({ noteId }) => noteId)).toEqual(
        expectedRange.noteIds,
      );
      const serialized = JSON.stringify(packet);
      expect(serialized).not.toContain('"body":');
      for (const note of snapshot.notes) {
        expect(serialized).not.toContain(note.body);
      }
    }
  });

  it("balances a 205-note Space into deterministic 24–32-note routing ranges", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 205 }, (_, index) => {
      const note = makeNote(`note-${String(index + 1).padStart(3, "0")}`, "Body");
      note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
      return note;
    });

    const ranges = createNoteDigestRangeManifests(snapshot.notes);

    expect(ranges).toHaveLength(7);
    expect(ranges.every(({ noteIds }) => noteIds.length >= 24)).toBe(true);
    expect(ranges.every(({ noteIds }) => noteIds.length <= 32)).toBe(true);
    expect(ranges.flatMap(({ noteIds }) => noteIds)).toHaveLength(205);
    expect(new Set(ranges.flatMap(({ noteIds }) => noteIds))).toEqual(
      new Set(snapshot.notes.map(({ id }) => id)),
    );
  });

  it("bounds digest shards by serialized identifier bytes", () => {
    const notes = Array.from({ length: 100 }, (_, index) => {
      const suffix = String(index + 1).padStart(3, "0");
      return makeNote(`${"long-id-".repeat(35)}${suffix}`, "Body");
    });

    const ranges = createNoteDigestRangeManifests(notes);

    expect(ranges.length).toBeGreaterThan(1);
    expect(
      ranges.every(
        ({ noteIds }) =>
          noteIds.reduce(
            (total, noteId) =>
              total + new TextEncoder().encode(noteId).byteLength,
            0,
          ) <= 10_000,
      ),
    ).toBe(true);
    expect(ranges.flatMap(({ noteIds }) => noteIds)).toHaveLength(notes.length);
  });

  it("routes exactly 600 ordinary note IDs in bounded shards without omission", () => {
    const notes = Array.from({ length: 600 }, (_, index) =>
      makeNote(`note-${String(index + 1).padStart(4, "0")}`, "Body"),
    );

    const ranges = createNoteDigestRangeManifests(notes);

    expect(ranges).toHaveLength(19);
    expect(ranges.every(({ noteIds }) => noteIds.length >= 24)).toBe(true);
    expect(ranges.every(({ noteIds }) => noteIds.length <= 32)).toBe(true);
    expect(new Set(ranges.flatMap(({ noteIds }) => noteIds))).toEqual(
      new Set(notes.map(({ id }) => id)),
    );
  });

  it("inlines small directories while retaining one exact routing handle", () => {
    for (const count of [0, 1, 48, 71, 72]) {
      const notes = Array.from({ length: count }, (_, index) =>
        makeNote(`note-${String(index + 1).padStart(3, "0")}`, "Body"),
      );
      const ranges = createNoteDigestRangeManifests(notes);
      expect(ranges.flatMap(({ noteIds }) => noteIds)).toHaveLength(count);
      expect(ranges).toHaveLength(count === 0 ? 0 : count <= 71 ? 1 : 3);
      if (count === 72) {
        expect(ranges.map(({ noteIds }) => noteIds.length)).toEqual([24, 24, 24]);
      }
    }
  });

  it("enforces exact typed routing coverage before exposing relevant full-note references", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 72 }, (_, index) => {
      const note = makeNote(`note-${String(index + 1).padStart(3, "0")}`, "Body");
      note.title = `Topic ${index + 1}`;
      return note;
    });
    const context = createKnowledgeRunContext(
      "run-routing",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "New material") }],
      "",
    );
    const call = createNoteRoutingCall(
      context,
      createRootAssignment(context).assignmentId,
    );
    if (!call || call.primitive !== "fan_out") {
      throw new Error("Expected host-owned routing fan-out.");
    }
    expect(call.assignments).toHaveLength(3);
    expect(call.assignments.every(({ purpose }) => purpose === "router")).toBe(true);
    expect(
      call.assignments.every(({ output }) => output.kind === "note-routing"),
    ).toBe(true);

    const artifacts = call.assignments.map((routingAssignment, rangeIndex) => {
      if (routingAssignment.output.kind !== "note-routing") {
        throw new Error("Expected routing output.");
      }
      const routingOutput = routingAssignment.output;
      const routing: KnowledgeNoteRoutingResult = {
        rangeId: routingOutput.rangeId,
        routes: routingOutput.expectedNotes.map(
          ({ noteId, noteVersion }, routeIndex) => ({
            noteId,
            noteVersion,
            relation:
              rangeIndex === 0 && routeIndex === 0
                ? ("extends" as const)
                : rangeIndex === 0 && routeIndex === 1
                  ? ("duplicate" as const)
                  : ("unrelated" as const),
            rationale: "A bounded routing judgment.",
            candidateNoteIds:
              rangeIndex === 0 && routeIndex === 1
                ? [routingOutput.expectedNotes[0].noteId]
                : [],
          }),
        ),
        warnings: [],
      };
      return routingArtifact(routingAssignment.assignmentId, routing);
    });

    expect(validateCompleteNoteRoutingCoverage(context, artifacts)).toHaveLength(3);
    expect(createRoutedFullNoteReferences(context, artifacts)).toEqual([
      {
        kind: "note",
        noteId: artifacts[0].routing!.routes[0].noteId,
        version: artifacts[0].routing!.routes[0].noteVersion,
      },
    ]);
    expect(createDuplicateRoutingCandidates(context, artifacts)).toEqual([
      {
        noteId: artifacts[0].routing!.routes[1].noteId,
        noteVersion: artifacts[0].routing!.routes[1].noteVersion,
        candidateNoteIds: [artifacts[0].routing!.routes[0].noteId],
      },
    ]);

    expect(() => validateCompleteNoteRoutingCoverage(context, artifacts.slice(1)))
      .toThrow(/omitted digest range/);
    expect(() =>
      validateCompleteNoteRoutingCoverage(context, [artifacts[0], ...artifacts]),
    ).toThrow(/covered digest range more than once/);

    const stale = structuredClone(artifacts);
    stale[0].routing!.routes[0].noteVersion = "stale-version";
    expect(() => validateCompleteNoteRoutingCoverage(context, stale)).toThrow(
      /stale or substituted note/,
    );

    const crossSpace = structuredClone(artifacts);
    crossSpace[0].routing!.routes[0].candidateNoteIds = ["other-space-note"];
    expect(() => validateCompleteNoteRoutingCoverage(context, crossSpace)).toThrow(
      /candidate outside this Space/,
    );
  });

  it("opens exact note bodies only through their typed route and frozen owner", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const origin = makeNote("origin", "DIRECT_ORIGIN_BODY");
    const extending = makeNote("extends", "EXTENDING_NOTE_BODY");
    const duplicate = makeNote("duplicate", "DUPLICATE_NOTE_BODY");
    const unrelated = makeNote("unrelated", "UNRELATED_NOTE_BODY");
    extending.summary = "New material extends an existing thread.";
    duplicate.summary = "New material duplicates an existing thread.";
    unrelated.summary = "New material appears nearby but is unrelated.";
    snapshot.notes = [origin, extending, duplicate, unrelated];
    const context = createKnowledgeRunContext(
      "run-routed-access",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "New material") }],
      "",
      {
        hybridNoteRouting: true,
        hybridRoutingAnchorNoteIds: [origin.id],
        directFullNoteAccessIds: [origin.id],
      },
    );
    const call = createNoteRoutingCall(
      context,
      createRootAssignment(context).assignmentId,
    );
    if (!call || call.primitive !== "fan_out") {
      throw new Error("Expected host-owned routing fan-out.");
    }
    expect(call.assignments).toHaveLength(1);
    const router = call.assignments[0];
    if (router.output.kind !== "note-routing") {
      throw new Error("Expected typed note routing.");
    }
    expect(router.output.expectedNotes.map(({ noteId }) => noteId)).not.toContain(
      origin.id,
    );
    const routes = router.output.expectedNotes.map(({ noteId, noteVersion }) => ({
      noteId,
      noteVersion,
      relation:
        noteId === extending.id
          ? ("extends" as const)
          : noteId === duplicate.id
            ? ("duplicate" as const)
            : ("unrelated" as const),
      rationale: "A bounded routing judgment.",
      candidateNoteIds:
        noteId === duplicate.id ? [extending.id] : [],
    }));
    const artifact = routingArtifact(router.assignmentId, {
      rangeId: router.output.rangeId,
      routes,
      warnings: [],
    });
    const registry = new KnowledgeArtifactRegistry();
    registry.record(artifact);
    const artifactReference = {
      kind: "artifact" as const,
      artifactId: artifact.artifactId,
    };

    const routedReader = assignment("routed-reader", "root");
    routedReader.references = [
      { kind: "note", noteId: extending.id, version: noteVersion(extending) },
      artifactReference,
    ];
    expect(referenceAllowedInRun(context, registry, routedReader)).toBeUndefined();
    expect(
      JSON.stringify(
        buildAssignmentContextPacket(context, routedReader, registry)
          .resolvedMaterials,
      ),
    ).toContain("EXTENDING_NOTE_BODY");

    const missingRouteArtifact = structuredClone(routedReader);
    missingRouteArtifact.references = missingRouteArtifact.references.filter(
      ({ kind }) => kind !== "artifact",
    );
    expect(
      referenceAllowedInRun(context, registry, missingRouteArtifact),
    ).toMatch(/requires the router artifact/);

    const unrelatedReader = structuredClone(routedReader);
    unrelatedReader.references = [
      { kind: "note", noteId: unrelated.id, version: noteVersion(unrelated) },
      artifactReference,
    ];
    expect(referenceAllowedInRun(context, registry, unrelatedReader)).toMatch(
      /Unrelated note.*cannot be opened/,
    );

    const duplicateReader = structuredClone(routedReader);
    duplicateReader.references = [
      { kind: "note", noteId: duplicate.id, version: noteVersion(duplicate) },
      artifactReference,
    ];
    expect(referenceAllowedInRun(context, registry, duplicateReader)).toMatch(
      /only be opened by its exact destination owner/,
    );

    const duplicateOwner = ownerAssignment(
      "duplicate-owner",
      "root",
      duplicate.id,
      noteVersion(duplicate),
    );
    duplicateOwner.references = [
      { kind: "note", noteId: duplicate.id, version: noteVersion(duplicate) },
      artifactReference,
    ];
    expect(referenceAllowedInRun(context, registry, duplicateOwner)).toBeUndefined();
    expect(
      JSON.stringify(
        buildAssignmentContextPacket(context, duplicateOwner, registry)
          .resolvedMaterials,
      ),
    ).toContain("DUPLICATE_NOTE_BODY");

    const directReader = structuredClone(routedReader);
    directReader.references = [
      { kind: "note", noteId: origin.id, version: noteVersion(origin) },
    ];
    expect(referenceAllowedInRun(context, registry, directReader)).toBeUndefined();

    const directOwner = ownerAssignment(
      "origin-owner",
      "root",
      origin.id,
      noteVersion(origin),
    );
    directOwner.references = [
      { kind: "note", noteId: origin.id, version: noteVersion(origin) },
    ];
    expect(referenceAllowedInRun(context, registry, directOwner)).toMatch(
      /requires the router artifact/,
    );
  });

  it("locally narrows hybrid routing even when the whole Space fits one range", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 60 }, (_, index) => {
      const note = makeNote(
        `note-${String(index + 1).padStart(3, "0")}`,
        `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(40)}`,
      );
      note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
      note.summary = `Reflection ${index + 1}.`;
      return note;
    });
    const linked = snapshot.notes[7];
    const relevant = snapshot.notes[22];
    relevant.summary = "Fresh material develops a distinct magnetic question.";
    snapshot.spaceOverview = {
      title: `Around ${linked.title}`,
      body: `${linked.title} carries this question.`,
      relatedNoteIds: [linked.id],
      generatedAt: NOW,
      stale: false,
    };

    const context = createKnowledgeRunContext(
      "run-hybrid-small",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "Fresh material") }],
      "",
      { useOverviewLinkedNoteContext: true, hybridNoteRouting: true },
    );

    expect(context.space.noteDigestRanges).toHaveLength(1);
    expect(context.space.noteDigestRanges[0].rangeId).toBe("note-digests-inline");
    expect(new Set(context.space.noteDigestRanges[0].noteIds)).toEqual(
      new Set([linked.id, relevant.id]),
    );
    expect(context.materials.notes.size).toBe(2);
    expect(context.targetedSpaceContext?.linkedNotes.map(({ noteId }) => noteId))
      .toEqual([linked.id]);
  });

  it("keeps a directly opened origin out of its own routing contract", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    const origin = makeNote("origin", "A direct origin body.");
    origin.title = "Magnetic actuation";
    const relevant = makeNote("relevant", "Existing discussion.");
    relevant.summary = "Magnetic actuation and winding design.";
    const unrelated = makeNote("unrelated", "A recipe for sourdough.");
    snapshot.notes = [origin, relevant, unrelated];

    const context = createKnowledgeRunContext(
      "run-direct-origin",
      snapshot,
      [],
      "",
      {
        includeExistingNotes: true,
        hybridNoteRouting: true,
        hybridRoutingMatchText: `${origin.title}\n${origin.body}`,
        directFullNoteAccessIds: [origin.id],
      },
    );

    expect(context.noteAccess).toEqual({
      directFullNoteIds: [origin.id],
      requireTypedRouting: true,
    });
    expect(context.materials.notes.has(origin.id)).toBe(true);
    expect(context.space.noteDigestRanges[0]?.noteIds).toEqual([relevant.id]);
    expect(context.space.notes.map(({ noteId }) => noteId)).toEqual([
      relevant.id,
    ]);
  });

  it("bounds hybrid routing for a large targeted Space to anchored relevant digests", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 120 }, (_, index) => {
      const note = makeNote(
        `note-${String(index + 1).padStart(3, "0")}`,
        `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(40)}`,
      );
      note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
      note.summary = `Reflection ${index + 1}.`;
      return note;
    });
    snapshot.notes[4].summary = "Solenoid winding actuation research.";
    snapshot.notes[49].title = "Thermal drift";
    const anchor = snapshot.notes[99];
    snapshot.spaceOverview = {
      title: `Around ${anchor.title}`,
      body: `${anchor.title} anchors this question.`,
      relatedNoteIds: [anchor.id],
      generatedAt: NOW,
      stale: false,
    };
    const createHybridContext = (runId: string) =>
      createKnowledgeRunContext(
        runId,
        snapshot,
        [
          {
            sourceId: "s1",
            parsed: parsed(
              "Coil study",
              "The solenoid winding archive explains actuation flux and thermal drift.",
            ),
          },
        ],
        "",
        { useOverviewLinkedNoteContext: true, hybridNoteRouting: true },
      );
    const context = createHybridContext("run-hybrid-large");

    const expectedUniverse = new Set([
      anchor.id,
      snapshot.notes[4].id,
      snapshot.notes[49].id,
    ]);
    expect(context.space.noteDigestRanges).toHaveLength(1);
    expect(context.space.noteDigestRanges[0].rangeId).toBe("note-digests-inline");
    expect(new Set(context.space.noteDigestRanges[0].noteIds)).toEqual(
      expectedUniverse,
    );
    expect(new Set(context.materials.notes.keys())).toEqual(expectedUniverse);
    expect(
      createHybridContext("run-hybrid-large-repeat").space.noteDigestRanges,
    ).toEqual(context.space.noteDigestRanges);

    const call = createNoteRoutingCall(
      context,
      createRootAssignment(context).assignmentId,
    );
    if (!call || call.primitive !== "fan_out" || call.assignments.length !== 1) {
      throw new Error("Expected exactly one hybrid routing assignment.");
    }
    const routingAssignment = call.assignments[0];
    if (routingAssignment.output.kind !== "note-routing") {
      throw new Error("Expected routing output.");
    }
    const routingOutput = routingAssignment.output;
    const completeRouting: KnowledgeNoteRoutingResult = {
      rangeId: routingOutput.rangeId,
      routes: routingOutput.expectedNotes.map(({ noteId, noteVersion }) => ({
        noteId,
        noteVersion,
        relation: "unrelated",
        rationale: "A bounded routing judgment.",
        candidateNoteIds: [],
      })),
      warnings: [],
    };
    const artifacts = [
      routingArtifact(routingAssignment.assignmentId, completeRouting),
    ];
    expect(validateCompleteNoteRoutingCoverage(context, artifacts)).toHaveLength(1);

    const unselectedSpaceNote = snapshot.notes[0];
    const widened = structuredClone(artifacts);
    widened[0].routing!.routes.push({
      noteId: unselectedSpaceNote.id,
      noteVersion: noteVersion(unselectedSpaceNote),
      relation: "unrelated",
      rationale: "A route beyond the frozen contract.",
      candidateNoteIds: [],
    });
    expect(() => validateCompleteNoteRoutingCoverage(context, widened)).toThrow(
      /did not cover|exactly once/,
    );
  });

  it("materializes bounded routed-note context with relation priority and no duplicate bodies", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 12 }, (_, index) => {
      const note = makeNote(
        `note-${String(index + 1).padStart(3, "0")}`,
        `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(40)}`,
      );
      note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
      note.summary = `Reflection ${index + 1}.`;
      return note;
    });
    const linked = snapshot.notes[0];
    snapshot.notes[1].summary = "Fresh material in a contradictory account.";
    snapshot.notes[2].summary = "Fresh material that duplicates Topic 1.";
    snapshot.spaceOverview = {
      title: `Around ${linked.title}`,
      body: `${linked.title} carries this question.`,
      relatedNoteIds: [linked.id],
      generatedAt: NOW,
      stale: false,
    };
    const context = createKnowledgeRunContext(
      "run-routed-context",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "Fresh material") }],
      "",
      { useOverviewLinkedNoteContext: true, hybridNoteRouting: true },
    );
    const call = createNoteRoutingCall(
      context,
      createRootAssignment(context).assignmentId,
    );
    if (!call || call.primitive !== "fan_out" || call.assignments.length !== 1) {
      throw new Error("Expected exactly one routing assignment.");
    }
    const routingAssignment = call.assignments[0];
    if (routingAssignment.output.kind !== "note-routing") {
      throw new Error("Expected routing output.");
    }
    const expectedNotes = routingAssignment.output.expectedNotes;
    const linkedIndex = expectedNotes.findIndex(
      ({ noteId }) => noteId === linked.id,
    );
    const relationFor = (index: number) =>
      index === linkedIndex
        ? ("extends" as const)
        : index === (linkedIndex + 1) % expectedNotes.length
          ? ("contradicts" as const)
          : index === (linkedIndex + 2) % expectedNotes.length
            ? ("duplicate" as const)
            : ("extends" as const);
    const routing: KnowledgeNoteRoutingResult = {
      rangeId: routingAssignment.output.rangeId,
      routes: expectedNotes.map(({ noteId, noteVersion }, index) => ({
        noteId,
        noteVersion,
        relation: relationFor(index),
        rationale: "A bounded routing judgment.",
        candidateNoteIds:
          relationFor(index) === "duplicate" ? [linked.id] : [],
      })),
      warnings: [],
    };
    const routed = buildRoutedNoteContext(context, [
      routingArtifact(routingAssignment.assignmentId, routing),
    ]);

    if (!routed) throw new Error("Expected routed-note context.");
    expect(routed[0].relation).toBe("contradicts");
    expect(routed.every((entry) => !("body" in entry))).toBe(true);
    const duplicate = routed.find(({ relation }) => relation === "duplicate");
    expect(duplicate?.candidateNoteIds).toEqual([linked.id]);
    const linkedEntry = routed.find(({ noteId }) => noteId === linked.id);
    expect(linkedEntry).not.toHaveProperty("body");
    expect(
      buildRoutedNoteContext(context, [
        routingArtifact(
          routingAssignment.assignmentId,
          { ...routing, routes: routing.routes.slice(1) },
        ),
      ]),
    ).toBeUndefined();
  });

  it("keys the routing cache by frozen contract, material, guidance, model, and effort", () => {
    const buildSnapshot = () => {
      const snapshot = createEmptySnapshot("Space", NOW);
      snapshot.notes = Array.from({ length: 12 }, (_, index) => {
        const note = makeNote(
          `note-${String(index + 1).padStart(3, "0")}`,
          `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(20)}`,
        );
        note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
        note.summary = `Reflection ${index + 1}.`;
        return note;
      });
      snapshot.notes[4].summary = "Fresh material focus.";
      return snapshot;
    };
    const build = (
      snapshot: ReturnType<typeof buildSnapshot>,
      runId: string,
      text: string,
      guidance: string,
    ) =>
      createKnowledgeRunContext(
        runId,
        snapshot,
        [{ sourceId: "s1", parsed: parsed("Source", text) }],
        guidance,
        { useOverviewLinkedNoteContext: true, hybridNoteRouting: true },
      );
    const snapshot = buildSnapshot();
    const key = createNoteRoutingCacheKey(
      build(snapshot, "run-key-a", "Fresh material", "Focus"),
      "gpt-5.6-sol",
      "high",
    );
    expect(
      createNoteRoutingCacheKey(
        build(snapshot, "run-key-b", "Fresh material", "Focus"),
        "gpt-5.6-sol",
        "high",
      ),
    ).toBe(key);
    expect(
      createNoteRoutingCacheKey(
        build(snapshot, "run-key-c", "Different material entirely", "Focus"),
        "gpt-5.6-sol",
        "high",
      ),
    ).not.toBe(key);
    expect(
      createNoteRoutingCacheKey(
        build(snapshot, "run-key-d", "Fresh material", "Another emphasis"),
        "gpt-5.6-sol",
        "high",
      ),
    ).not.toBe(key);
    expect(
      createNoteRoutingCacheKey(
        build(snapshot, "run-key-e", "Fresh material", "Focus"),
        "claude-fable-5",
        "high",
      ),
    ).not.toBe(key);
    expect(
      createNoteRoutingCacheKey(
        build(snapshot, "run-key-f", "Fresh material", "Focus"),
        "gpt-5.6-sol",
        "medium",
      ),
    ).not.toBe(key);
    const changed = buildSnapshot();
    changed.notes[4].body += "\n\nA newly added paragraph.";
    expect(
      createNoteRoutingCacheKey(
        build(changed, "run-key-g", "Fresh material", "Focus"),
        "gpt-5.6-sol",
        "high",
      ),
    ).not.toBe(key);
  });

  it("seeds a deterministic router artifact that satisfies coverage and routed context", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.notes = Array.from({ length: 8 }, (_, index) => {
      const note = makeNote(
        `note-${String(index + 1).padStart(3, "0")}`,
        `# Topic ${index + 1}\n\n${"Grounded existing prose. ".repeat(20)}`,
      );
      note.title = `Topic ${String(index + 1).padStart(3, "0")}`;
      note.summary = `Reflection ${index + 1}.`;
      return note;
    });
    const context = createKnowledgeRunContext(
      "run-seeded-routing",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Source", "Fresh material") }],
      "",
      { useOverviewLinkedNoteContext: true, hybridNoteRouting: true },
    );
    const range = context.space.noteDigestRanges[0];
    const digests = context.materials.noteDigestRanges.get(range.rangeId)!;
    const results: KnowledgeNoteRoutingResult[] = [
      {
        rangeId: range.rangeId,
        routes: digests.map(({ noteId, version }, index) => ({
          noteId,
          noteVersion: version,
          relation: index === 0 ? "extends" : "unrelated",
          rationale: "A bounded routing judgment.",
          candidateNoteIds: [],
        })),
        warnings: [],
      },
    ];

    const artifacts = createSeededRoutingArtifact(context, results);
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    expect(artifact.purpose).toBe("router");
    expect(artifact.references).toEqual([
      { kind: "note-digest-range", rangeId: range.rangeId },
    ]);
    expect(artifact.mustPreserve).toEqual([
      `Space routing range ${range.rangeId}`,
    ]);
    expect(artifact.assessment.reviewedNoteIds).toEqual(
      results[0].routes.map(({ noteId }) => noteId),
    );
    expect(artifact.routing).toEqual(results[0]);
    expect(createSeededRoutingArtifact(context, results)).toEqual(artifacts);

    expect(validateCompleteNoteRoutingCoverage(context, artifacts)).toHaveLength(1);
    const routed = buildRoutedNoteContext(context, artifacts);
    expect(routed?.map(({ relation }) => relation)).toEqual(["extends"]);

    const staleResults = structuredClone(results);
    staleResults[0].routes[0].noteVersion = "stale-version";
    const staleArtifacts = createSeededRoutingArtifact(context, staleResults);
    expect(staleArtifacts[0].artifactId).not.toBe(artifact.artifactId);
    expect(() =>
      validateCompleteNoteRoutingCoverage(context, staleArtifacts),
    ).toThrow(/stale or substituted note/);
  });

  it("gives page-range readers bounded task and Space orientation without note bodies", () => {
    const snapshot = createEmptySnapshot("Space", NOW);
    snapshot.settings.organizationInstructions =
      "Prefer conceptual development over a chronological transcript.";
    const note = makeNote(
      "note-positivism",
      `# Positivism\n\nAn opening paragraph.\n\nPRIVATE_NOTE_BODY_SENTINEL\n\n${"Further private prose. ".repeat(80)}`,
    );
    note.title = "Positivism";
    note.summary = "Positive inquiry studies observable regularities and their limits.";
    snapshot.notes = [note];
    const sourceText = Array.from(
      { length: 6 },
      (_, index) =>
        `## Page ${index + 1}\n\nPositivism and social order on page ${index + 1}. ${"Evidence. ".repeat(1_000)}`,
    ).join("\n\n");
    const context = createKnowledgeRunContext(
      "run-page-aware",
      snapshot,
      [{ sourceId: "s1", parsed: parsed("Comte lecture", sourceText) }],
      "Focus on how the argument connects positive inquiry to social order.",
    );
    expect(context.sources[0].ranges).toMatchObject([
      { rangeId: "range-1", pageStart: 1, pageEnd: 3 },
      { rangeId: "range-2", pageStart: 4, pageEnd: 6 },
    ]);
    const root = createRootAssignment(context);
    const coverage = createMandatoryCoverageCall(context, root.assignmentId);
    if (!coverage || coverage.primitive !== "fan_out") {
      throw new Error("Expected page-aware source coverage to fan out.");
    }
    const packet = buildAssignmentContextPacket(
      context,
      coverage.assignments[0],
      new KnowledgeArtifactRegistry(),
    );
    expect(packet.spaceOrientation.importGuidance).toContain(
      "positive inquiry to social order",
    );
    expect(packet.spaceOrientation.organizationInstructions).toContain(
      "conceptual development",
    );
    expect(packet.spaceOrientation.noteSignals).toContainEqual(
      expect.objectContaining({
        noteId: "note-positivism",
        title: "Positivism",
      }),
    );
    expect(JSON.stringify(packet)).not.toContain("PRIVATE_NOTE_BODY_SENTINEL");
  });

  it("budgets source readings across the whole batch instead of per document", () => {
    const plan = createSourceReadingPlan([
      { sourceId: "book-a", parsed: parsed("Book A", "A".repeat(260_000)) },
      { sourceId: "book-b", parsed: parsed("Book B", "B".repeat(260_000)) },
    ]);

    expect([...plan.values()].flat()).toHaveLength(12);
    expect(plan.get("book-a")).toHaveLength(6);
    expect(plan.get("book-b")).toHaveLength(6);
    expect(plan.get("book-a")?.map(({ content }) => content).join("")).toBe(
      "A".repeat(260_000),
    );
    expect(plan.get("book-b")?.map(({ content }) => content).join("")).toBe(
      "B".repeat(260_000),
    );
  });

  it("gives a Hegel-sized book nine density-bounded logical readings", () => {
    const text = Array.from(
      { length: 206 },
      (_, index) => `## Page ${index + 1}\n\n${"H".repeat(1_880)}`,
    ).join("\n\n");

    const sections = createSourceReadingPlan([
      { sourceId: "hegel", parsed: parsed("Hegel: Three Studies", text) },
    ]).get("hegel");

    expect(sections).toHaveLength(9);
    if (!sections) throw new Error("Expected a Hegel reading plan.");
    expect(sections?.[0]).toMatchObject({ pageStart: 1 });
    expect(sections[sections.length - 1]).toMatchObject({ pageEnd: 206 });
    expect(sections?.map(({ content }) => content).join("")).toBe(text);
    expect(
      sections?.every(
        ({ content }) =>
          new TextEncoder().encode(content).byteLength <= 72_000 &&
          Math.ceil(content.length / 4) <= 12_000,
      ),
    ).toBe(true);
  });

  it("keeps a modest five-page source on the page-aware adaptive path", () => {
    const text = Array.from(
      { length: 5 },
      (_, index) => `## Page ${index + 1}\n\n${"A".repeat(500)}`,
    ).join("\n\n");

    const sections = createSourceReadingPlan([
      { sourceId: "five-pages", parsed: parsed("Five pages", text) },
    ]).get("five-pages");

    expect(sections).toHaveLength(3);
    expect(sections).toMatchObject([
      { pageStart: 1, pageEnd: 2 },
      { pageStart: 3, pageEnd: 4 },
      { pageStart: 5, pageEnd: 5 },
    ]);
    expect(sections?.map(({ content }) => content).join("")).toBe(text);
  });

  it("adds readings when token density needs more coverage than character count", () => {
    const text = "界".repeat(75_000);

    const sections = createSourceReadingPlan([
      { sourceId: "dense-unicode", parsed: parsed("Dense Unicode", text) },
    ]).get("dense-unicode");

    expect(sections).toHaveLength(12);
    expect(sections?.map(({ content }) => content).join("")).toBe(text);
    expect(sections?.every(({ content }) => [...content].length <= 6_250)).toBe(
      true,
    );
  });

  it("reserves one canonical group for every short source before deepening a book", () => {
    const bookText = Array.from(
      { length: 206 },
      (_, index) => `## Page ${index + 1}\n\n${"H".repeat(1_880)}`,
    ).join("\n\n");
    const shortSources = Array.from({ length: 7 }, (_, index) => ({
      sourceId: `short-${index + 1}`,
      parsed: parsed(`Short ${index + 1}`, `Short source ${index + 1}.`),
    }));

    const plan = createSourceReadingPlan([
      { sourceId: "hegel", parsed: parsed("Hegel: Three Studies", bookText) },
      ...shortSources,
    ]);
    const bookSections = plan.get("hegel");

    expect(bookSections).toHaveLength(5);
    expect(bookSections?.map(({ content }) => content).join("")).toBe(bookText);
    expect(shortSources.every(({ sourceId }) => !plan.has(sourceId))).toBe(true);
    expect((bookSections?.length ?? 0) + shortSources.length).toBe(12);
  });

  it("rejects a skewed batch instead of assigning one oversized long range", () => {
    const smallSources = Array.from({ length: 11 }, (_, index) => ({
      sourceId: `small-${index + 1}`,
      parsed: parsed(`Small ${index + 1}`, "A".repeat(60_001)),
    }));

    expect(() =>
      createSourceReadingPlan([
        ...smallSources,
        {
          sourceId: "oversized-book",
          parsed: parsed("Oversized book", "B".repeat(1_100_000)),
        },
      ]),
    ).toThrow(/needs 22 canonical evidence groups.*bounded synthesis input/);
  });

  it("rejects an inherently over-budget batch before starting partial AI work", () => {
    const sources = Array.from({ length: 13 }, (_, index) => ({
      sourceId: `book-${index + 1}`,
      parsed: parsed(`Book ${index + 1}`, "A".repeat(60_001)),
    }));

    expect(() => createSourceReadingPlan(sources)).toThrow(
      /needs 13 canonical evidence groups.*bounded synthesis input/,
    );

    expect(() =>
      createSourceReadingPlan([
        {
          sourceId: "unicode-book",
          parsed: parsed("Unicode book", "😀".repeat(500_000)),
        },
      ]),
    ).toThrow(/too large for one bounded synthesis/);
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

function makeNote(id: string, body: string): Note {
  return {
    id,
    title: "Existing",
    slug: "existing",
    summary: "Existing note",
    body,
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
