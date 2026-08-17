import { nanoid } from "nanoid";
import type {
  AppSnapshot,
  Note,
  OrganizeContentResult,
  OrganizedWikiArticle,
  ParsedImport,
  ReasoningEffort,
  Source,
} from "../../types";
import { truncateUnicode } from "../text";
import {
  createKnowledgeRunContext,
  createNoteDigestRangeManifests,
  createNoteRoutingCall,
  createRootAssignment,
  createSourceReadingPlan,
  noteVersion,
  type KnowledgeImportSourceInput,
} from "./context";
import type { KnowledgeAssignmentDriver } from "./service";
import { runKnowledgeOrchestration } from "./service";
import type {
  KnowledgeArtifact,
  KnowledgeOwnerProposal,
  KnowledgeReference,
  KnowledgeResultProvenance,
  KnowledgeRunResult,
  KnowledgeTelemetry,
} from "./protocol";
import type { KnowledgeRuntimeEvent } from "./runtime";

export interface KnowledgeEnrichmentOptions {
  snapshot: AppSnapshot;
  originNote: Note;
  model: string;
  effort: ReasoningEffort;
  driver: KnowledgeAssignmentDriver;
  signal?: AbortSignal;
  onTelemetry?: (
    telemetry: KnowledgeTelemetry,
    history: readonly KnowledgeRuntimeEvent[],
  ) => void;
}

export interface KnowledgeEnrichmentResult {
  result: OrganizeContentResult;
  baseOriginVersion: string;
  destinationBaseVersions: Array<{ noteId: string; version: string }>;
  history: readonly KnowledgeRuntimeEvent[];
}

export async function runKnowledgeEnrichment(
  options: KnowledgeEnrichmentOptions,
): Promise<KnowledgeEnrichmentResult> {
  const runId = `knowledge-enrichment:${nanoid(12)}`;
  const directSources = options.snapshot.sources
    .filter(({ id }) => options.originNote.sourceIds.includes(id))
    .map(sourceInput);
  const context = createKnowledgeRunContext(
    runId,
    options.snapshot,
    directSources,
    "",
    {
      includeExistingNotes:
        options.snapshot.settings.includeExistingNotesInAIContext,
      // Enrichment contracts the hybrid routing universe anchored on the
      // origin note instead of exposing whole-Space digest shards.
      hybridNoteRouting: true,
      hybridRoutingAnchorNoteIds: [options.originNote.id],
      directFullNoteAccessIds: [options.originNote.id],
      hybridRoutingMatchText: [
        options.originNote.title,
        options.originNote.summary,
        options.originNote.body,
      ].join("\n"),
    },
  );
  const root = createRootAssignment(context);
  root.objective = `Use the saved note “${options.originNote.title}” as new evidence. Identify only durable canonical articles that gain meaningful context, coordinate exact owners for existing destinations, and return no replacement or companion project note.`;
  root.references = [
    {
      kind: "note",
      noteId: options.originNote.id,
      version: noteVersion(options.originNote),
    },
    ...root.references,
  ];
  root.constraints.rules.push(
    "Return an empty project notes array; the saved origin note remains authoritative.",
    "Keep tasks in the origin note and never copy them into a canonical article.",
    "Do not create a summary, plan, list, checklist, or paraphrased companion to the origin note.",
  );
  root.constraints.mustPreserve.push(
    `Origin note ${options.originNote.id} at version ${noteVersion(options.originNote)}`,
  );
  // Routing the origin against itself is noise: schedule the typed routing
  // pass only when the contracted universe holds other notes to classify.
  const hasRoutableCompanions = context.space.noteDigestRanges.length > 0;
  const noteRouting = hasRoutableCompanions
    ? createNoteRoutingCall(
        context,
        root.assignmentId,
        [
          `Saved note “${options.originNote.title}”: ${options.originNote.summary}`,
          `Opening: ${truncateUnicode(
            options.originNote.body.replace(/\s+/g, " ").trim(),
            600,
          )}`,
        ].join("\n"),
      )
    : undefined;
  if (noteRouting) {
    root.constraints.rules.push(
      "Host-verified typed routing classifies frozen note digests against the origin note, and validated routes arrive as metadata-only routedNotes context. Treat duplicate routes as merge signals and contradicts/extends/uncertain routes as revision or comparison candidates; open a full body only by citing its exact frozen note reference beside the exact router artifact, and open a duplicate body only inside its exact destination owner. Routing is orientation, never source evidence or write authority.",
    );
  }
  const orchestration = await runKnowledgeOrchestration({
    runContext: context,
    rootAssignment: root,
    model: options.model,
    effort: options.effort,
    driver: options.driver,
    signal: options.signal,
    physicalConcurrency: 6,
    ...(noteRouting ? { initialCoordinationCalls: [noteRouting] } : {}),
    onTelemetry: options.onTelemetry,
  });
  return {
    result: finalizeEnrichmentResult(
      orchestration.result,
      options.snapshot,
      options.originNote,
      orchestration.history,
    ),
    baseOriginVersion: noteVersion(options.originNote),
    destinationBaseVersions: orchestration.result.ownerProposals.map(
      ({ destinationNoteId, baseVersion }) => ({
        noteId: destinationNoteId,
        version: baseVersion,
      }),
    ),
    history: orchestration.history,
  };
}

export function finalizeEnrichmentResult(
  value: KnowledgeRunResult,
  snapshot: AppSnapshot,
  originNote: Note,
  history: readonly KnowledgeRuntimeEvent[],
): OrganizeContentResult {
  if (value.result.notes.length > 0) {
    throw new Error("Knowledge enrichment cannot create a companion project note.");
  }
  const directSourceIds = new Set(
    snapshot.sources
      .filter(({ id }) => originNote.sourceIds.includes(id))
      .map(({ id }) => id),
  );
  const ownerGrantsByAssignment = new Map<string, Set<string>>();
  for (const event of history) {
    if (event.type !== "destination-owner-granted") continue;
    ownerGrantsByAssignment.set(
      event.assignmentId,
      new Set(event.destinationNoteIds),
    );
  }
  const completedOwnerArtifacts = history.flatMap((event) =>
    event.type === "artifact-recorded" && event.artifact.purpose === "owner"
      ? [event.artifact]
      : [],
  );
  const proposals = new Map<string, KnowledgeOwnerProposal>();
  const proposedDestinations = new Set<string>();
  for (const proposal of value.ownerProposals) {
    if (proposedDestinations.has(proposal.destinationNoteId)) {
      throw new Error(
        `Knowledge enrichment repeated an owner proposal for ${proposal.destinationNoteId}.`,
      );
    }
    proposedDestinations.add(proposal.destinationNoteId);
    const note = snapshot.notes.find(({ id }) => id === proposal.destinationNoteId);
    if (!note || note.kind !== "wiki" || note.id === originNote.id) {
      throw new Error("Knowledge enrichment targeted an unavailable canonical article.");
    }
    const matchingArtifact = completedOwnerArtifacts.find(
      (artifact) =>
        ownerGrantsByAssignment
          .get(artifact.assignmentId)
          ?.has(proposal.destinationNoteId) &&
        artifact.ownerProposals.some((candidate) =>
          ownerProposalsEqual(candidate, proposal),
        ),
    );
    if (!matchingArtifact) {
      throw new Error(
        `An article revision has no completed exact owner proposal: ${note.id}`,
      );
    }
    if (proposal.baseVersion !== noteVersion(note)) {
      throw new Error(`An article revision is stale: ${note.id}`);
    }
    if (normalizedTitle(proposal.title) !== normalizedTitle(note.title)) {
      throw new Error(`An article owner cannot rename its destination: ${note.id}`);
    }
    if (proposal.sourceIds.length === 0) {
      throw new Error(`An article revision has no direct source provenance: ${note.id}`);
    }
    if (new Set(proposal.sourceIds).size !== proposal.sourceIds.length) {
      throw new Error(`An article revision repeated source provenance: ${note.id}`);
    }
    if (proposal.sourceIds.some((sourceId) => !directSourceIds.has(sourceId))) {
      throw new Error("An article revision cited a source unrelated to the origin note.");
    }
    proposals.set(note.id, proposal);
  }

  const articles = new Map<string, OrganizedWikiArticle>();
  for (const article of value.result.wikiArticles) {
    const existing = resolveExistingArticle(snapshot, article.title);
    if (existing && !proposals.has(existing.id)) {
      throw new Error(
        `An existing article revision was returned without an exclusive owner: ${existing.id}`,
      );
    }
    articles.set(normalizedTitle(article.title), article);
  }
  for (const [noteId, proposal] of proposals) {
    const destination = snapshot.notes.find(({ id }) => id === noteId)!;
    articles.set(normalizedTitle(destination.title), articleFromProposal(proposal));
  }

  validateEnrichmentProvenance(
    value.provenance,
    [...articles.values()],
    snapshot,
    originNote,
    history,
  );
  return {
    ...value.result,
    notes: [],
    wikiArticles: [...articles.values()],
  };
}

function validateEnrichmentProvenance(
  provenance: readonly KnowledgeResultProvenance[],
  articles: readonly OrganizedWikiArticle[],
  snapshot: AppSnapshot,
  originNote: Note,
  history: readonly KnowledgeRuntimeEvent[],
) {
  const directSources = new Map(
    snapshot.sources
      .filter(({ id }) => originNote.sourceIds.includes(id))
      .map((source) => [source.id, source]),
  );
  const readingPlan = createSourceReadingPlan(
    [...directSources.values()].map(sourceInput),
  );
  const allowedSourceRanges = new Set<string>();
  for (const sourceId of directSources.keys()) {
    const sections = readingPlan.get(sourceId) ?? [];
    if (sections.length > 0) {
      sections.forEach(({ index }) =>
        allowedSourceRanges.add(`${sourceId}/range-${index + 1}`),
      );
    } else {
      allowedSourceRanges.add(`${sourceId}/full`);
    }
  }
  const notes = new Map(snapshot.notes.map((note) => [note.id, note]));
  const conceptIds = new Set(snapshot.concepts.map(({ id }) => id));
  const noteDigestRangeIds = new Set(
    createNoteDigestRangeManifests(snapshot.notes).map(({ rangeId }) => rangeId),
  );
  const artifactsById = new Map(
    history.flatMap((event) =>
      event.type === "artifact-recorded"
        ? [[event.artifact.artifactId, event.artifact] as const]
        : [],
    ),
  );
  const expectedArticles = new Map(
    articles.map((article) => [normalizedTitle(article.title), article]),
  );
  const provenanceByArticle = new Map<string, KnowledgeResultProvenance>();
  for (const entry of provenance) {
    const key = normalizedTitle(entry.title);
    if (entry.kind !== "wikiArticle" || !expectedArticles.has(key)) {
      throw new Error(
        `Enrichment provenance described an unknown final article: ${entry.title}.`,
      );
    }
    if (provenanceByArticle.has(key)) {
      throw new Error(`Enrichment provenance repeated ${entry.title}.`);
    }
    if (entry.sourceIds.length === 0) {
      throw new Error(`Enrichment provenance omitted direct sources for ${entry.title}.`);
    }
    if (new Set(entry.sourceIds).size !== entry.sourceIds.length) {
      throw new Error(`Enrichment provenance repeated direct sources for ${entry.title}.`);
    }
    if (entry.sourceIds.some((sourceId) => !directSources.has(sourceId))) {
      throw new Error("Enrichment provenance cited an unrelated source.");
    }
    if (entry.evidenceReferences.length === 0) {
      throw new Error(
        `Enrichment provenance contains no available evidence for ${entry.title}.`,
      );
    }
    const evidencedSourceIds = collectEnrichmentEvidenceSourceIds(
      entry.evidenceReferences,
      directSources,
      allowedSourceRanges,
      notes,
      conceptIds,
      noteDigestRangeIds,
      artifactsById,
    );
    const missingEvidence = entry.sourceIds.find(
      (sourceId) => !evidencedSourceIds.has(sourceId),
    );
    if (missingEvidence) {
      throw new Error(
        `Enrichment provenance did not evidence claimed source ${missingEvidence} for ${entry.title}.`,
      );
    }
    const unclaimedEvidence = [...evidencedSourceIds].find(
      (sourceId) => !entry.sourceIds.includes(sourceId),
    );
    if (unclaimedEvidence) {
      throw new Error(
        `Enrichment provenance cited unclaimed source ${unclaimedEvidence} for ${entry.title}.`,
      );
    }
    provenanceByArticle.set(key, entry);
  }
  for (const [key, article] of expectedArticles) {
    if (!provenanceByArticle.has(key)) {
      throw new Error(`Missing enrichment provenance for ${article.title}.`);
    }
  }
}

function collectEnrichmentEvidenceSourceIds(
  references: readonly KnowledgeReference[],
  directSources: ReadonlyMap<string, Source>,
  allowedSourceRanges: ReadonlySet<string>,
  notes: ReadonlyMap<string, Note>,
  conceptIds: ReadonlySet<string>,
  noteDigestRangeIds: ReadonlySet<string>,
  artifactsById: ReadonlyMap<string, KnowledgeArtifact>,
  visitedArtifacts = new Set<string>(),
): Set<string> {
  const evidenced = new Set<string>();
  for (const reference of references) {
    if (reference.kind === "source") {
      if (!directSources.has(reference.sourceId)) {
        throw new Error("Enrichment provenance cited an unrelated source.");
      }
      evidenced.add(reference.sourceId);
      continue;
    }
    if (reference.kind === "source-range") {
      if (
        !directSources.has(reference.sourceId) ||
        !allowedSourceRanges.has(`${reference.sourceId}/${reference.rangeId}`)
      ) {
        throw new Error(
          `Enrichment provenance cited an unavailable source range: ${reference.sourceId}/${reference.rangeId}.`,
        );
      }
      evidenced.add(reference.sourceId);
      continue;
    }
    if (reference.kind === "note") {
      const note = notes.get(reference.noteId);
      if (!note || noteVersion(note) !== reference.version) {
        throw new Error("Enrichment provenance cited an unavailable note version.");
      }
      for (const sourceId of note.sourceIds) {
        if (directSources.has(sourceId)) evidenced.add(sourceId);
      }
      continue;
    }
    if (reference.kind === "concept") {
      if (!conceptIds.has(reference.conceptId)) {
        throw new Error("Enrichment provenance cited a concept outside this Space.");
      }
      continue;
    }
    if (reference.kind === "note-digest-range") {
      if (!noteDigestRangeIds.has(reference.rangeId)) {
        throw new Error("Enrichment provenance cited an unavailable note digest range.");
      }
      continue;
    }
    const artifact = artifactsById.get(reference.artifactId);
    if (!artifact) {
      throw new Error("Enrichment provenance cited an unavailable run artifact.");
    }
    if (visitedArtifacts.has(artifact.artifactId)) continue;
    visitedArtifacts.add(artifact.artifactId);
    const nested = collectEnrichmentEvidenceSourceIds(
      [
        ...artifact.references,
        ...artifact.claims.flatMap((claim) => claim.references),
      ],
      directSources,
      allowedSourceRanges,
      notes,
      conceptIds,
      noteDigestRangeIds,
      artifactsById,
      visitedArtifacts,
    );
    nested.forEach((sourceId) => evidenced.add(sourceId));
  }
  return evidenced;
}

function ownerProposalsEqual(
  left: KnowledgeOwnerProposal,
  right: KnowledgeOwnerProposal,
): boolean {
  return (
    left.destinationNoteId === right.destinationNoteId &&
    left.baseVersion === right.baseVersion &&
    left.title === right.title &&
    left.summary === right.summary &&
    left.body === right.body &&
    left.aliases.length === right.aliases.length &&
    left.aliases.every((value, index) => value === right.aliases[index]) &&
    left.tags.length === right.tags.length &&
    left.tags.every((value, index) => value === right.tags[index]) &&
    left.sourceIds.length === right.sourceIds.length &&
    left.sourceIds.every((value, index) => value === right.sourceIds[index])
  );
}

function sourceInput(source: Source): KnowledgeImportSourceInput {
  return { sourceId: source.id, parsed: sourceAsParsedImport(source) };
}

function sourceAsParsedImport(source: Source): ParsedImport {
  return {
    title: source.title,
    fileName: source.fileName || `${source.title}.txt`,
    mimeType: source.mimeType || "text/plain;charset=utf-8",
    format: source.kind,
    byteSize: source.byteSize ?? new TextEncoder().encode(source.text).byteLength,
    sourceUrl: source.sourceUrl,
    text: source.text,
    warnings: [],
  };
}

function articleFromProposal(proposal: KnowledgeOwnerProposal): OrganizedWikiArticle {
  return {
    title: proposal.title,
    summary: proposal.summary,
    body: proposal.body,
    overview: proposal.summary,
    spaceRelevance: "",
    sourceGroundedDetails: [],
    uncertainties: [],
    tags: [...proposal.tags],
    aliases: [...proposal.aliases],
    links: [],
  };
}

function resolveExistingArticle(snapshot: AppSnapshot, title: string) {
  const key = normalizedTitle(title);
  const exact = snapshot.notes.filter(
    (note) => note.kind === "wiki" && normalizedTitle(note.title) === key,
  );
  return exact.length === 1 ? exact[0] : undefined;
}

function normalizedTitle(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
