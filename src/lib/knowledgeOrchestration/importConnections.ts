import { existingCanonicalPhraseDestinations, isLinkablePhrase, normalizeConceptPhrase } from "../concepts";
import type { AppSnapshot, Note, OrganizedConcept, SuggestedConnection } from "../../types";
import type {
  KnowledgeSourceReading,
  KnowledgeWritingBlueprint,
  KnowledgeWritingBlueprintOutput,
} from "./protocol";

interface ConnectionPlanningInput {
  outputs: readonly KnowledgeWritingBlueprintOutput[];
  seedDispositions: KnowledgeWritingBlueprint["seedDispositions"];
  readings: readonly {
    artifact: { artifactId: string };
    reading: KnowledgeSourceReading;
  }[];
  notes: readonly Pick<Note, "id" | "title">[];
  /** Local collision safety only; none of this catalog is returned to writers. */
  existingVocabulary?: Pick<AppSnapshot, "notes" | "concepts">;
}

/** Local recovery uses declared semantic evidence, never source co-membership. */
export function planLocalImportConnections({
  outputs, seedDispositions, readings, notes, existingVocabulary,
}: ConnectionPlanningInput): Pick<KnowledgeWritingBlueprint, "concepts" | "suggestedConnections"> {
  const outputById = new Map(outputs.map((output) => [output.outputId, output]));
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const readingByArtifact = new Map(readings.map((entry) => [entry.artifact.artifactId, entry.reading]));
  const phraseOwners = new Map<string, Map<string, OrganizedConcept>>();
  const connections = new Map<string, SuggestedConnection>();

  for (const disposition of seedDispositions) {
    if (disposition.disposition === "omitted" || !disposition.outputId) continue;
    const output = outputById.get(disposition.outputId);
    const reading = readingByArtifact.get(disposition.artifactId);
    const seed = reading?.synthesisSeeds.find((candidate) => candidate.seedId === disposition.seedId);
    if (!output || !reading || !seed) continue;
    const claimIds = new Set(seed.claimIds);
    const grounding = [seed.thesis, ...reading.sourceClaims.filter((claim) => claimIds.has(claim.claimId)).map((claim) => claim.text)].join(" ");
    for (const phrase of seed.linkPhrases ?? []) {
      if (!isLinkablePhrase(phrase) || !containsPhrase(grounding, phrase)) continue;
      const key = normalizeConceptPhrase(phrase);
      const destinationId = output.existingDestination?.noteId;
      if (outputs.some((candidate) => candidate.outputId !== output.outputId &&
        normalizeConceptPhrase(candidate.title) === key) ||
        notes.some((note) => note.id !== destinationId && normalizeConceptPhrase(note.title) === key) ||
        (existingVocabulary && existingCanonicalPhraseDestinations(existingVocabulary, phrase)
          .some((noteId) => noteId !== destinationId))) {
        // Keep the accepted source output, but leave established vocabulary in
        // place. Recovery cannot choose to redirect a user's canonical phrase.
        continue;
      }
      const owners = phraseOwners.get(key) ?? new Map<string, OrganizedConcept>();
      owners.set(output.outputId, {
        label: phrase.trim(), aliases: [], description: seed.thesis,
        canonicalTitle: output.title, relatedTitles: [],
      });
      phraseOwners.set(key, owners);
    }
    const kind = contributionKind(seed.contribution);
    if (!kind) continue;
    for (const noteId of seed.relatedNoteIds) {
      const target = noteById.get(noteId);
      if (!target || normalizeConceptPhrase(target.title) === normalizeConceptPhrase(output.title)) continue;
      const key = `${output.outputId}\u0000${noteId}\u0000${kind}`;
      connections.set(key, {
        fromTitle: output.title, toTitle: target.title, kind, reason: seed.rationale,
      });
    }
  }

  const concepts = [...phraseOwners.values()].flatMap((owners) => {
    const candidates = [...owners.values()];
    if (candidates.length === 1) return candidates;
    // An exact canonical title is defensible; keyword overlap or repetition is
    // not sufficient to choose one argument as the owner of an ambiguous term.
    const exact = candidates.filter((candidate) =>
      normalizeConceptPhrase(candidate.canonicalTitle) === normalizeConceptPhrase(candidate.label),
    );
    return exact.length === 1 ? exact : [];
  });
  return { concepts, suggestedConnections: [...connections.values()] };
}

function contributionKind(contribution: KnowledgeSourceReading["synthesisSeeds"][number]["contribution"]): SuggestedConnection["kind"] | undefined {
  switch (contribution) {
    case "extends": return "related";
    case "qualifies": return "qualifies";
    case "contradicts": return "conflicts";
    case "connects": return "related";
    case "new": return undefined;
  }
}

function containsPhrase(text: string, phrase: string): boolean {
  const normalized = normalizeConceptPhrase(text);
  const needle = normalizeConceptPhrase(phrase);
  let start = normalized.indexOf(needle);
  while (start >= 0) {
    const before = normalized[start - 1] ?? "";
    const after = normalized[start + needle.length] ?? "";
    if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) return true;
    start = normalized.indexOf(needle, start + 1);
  }
  return false;
}
