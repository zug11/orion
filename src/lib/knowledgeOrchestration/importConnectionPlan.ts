import { existingCanonicalPhraseDestinations, normalizeConceptPhrase } from "../concepts";
import type { AppSnapshot } from "../../types";
import type { KnowledgeWritingBlueprint } from "./protocol";

/** Validate identity, not semantic entailment: the provider must justify meaning. */
export function validateImportConnectionPlan(
  plan: Pick<KnowledgeWritingBlueprint, "concepts" | "suggestedConnections"> & Partial<Pick<KnowledgeWritingBlueprint, "outputs">>,
  snapshot?: Pick<AppSnapshot, "notes" | "concepts">,
): void {
  const ownerByPhrase = new Map<string, string>();
  for (const concept of plan.concepts) {
    const owner = normalizeConceptPhrase(concept.canonicalTitle);
    const existingDestination = snapshot?.notes.find((note) => normalizeConceptPhrase(note.title) === owner);
    for (const phrase of [concept.label, ...concept.aliases]) {
      const key = normalizeConceptPhrase(phrase);
      const previous = ownerByPhrase.get(key);
      if (previous && previous !== owner) {
        throw new Error(`The note plan assigned multiple canonical destinations to “${phrase}”.`);
      }
      ownerByPhrase.set(key, owner);
      if (plan.outputs?.some((output) => normalizeConceptPhrase(output.title) === key && key !== owner)) {
        throw new Error(`The note plan cannot redirect another output's exact title “${phrase}”.`);
      }
      if (snapshot && existingCanonicalPhraseDestinations(snapshot, phrase)
        .some((noteId) => noteId !== existingDestination?.id)) {
        throw new Error(`The note plan cannot redirect the established link phrase “${phrase}”.`);
      }
    }
  }
  for (const connection of plan.suggestedConnections) {
    if (normalizeConceptPhrase(connection.fromTitle) === normalizeConceptPhrase(connection.toTitle)) {
      throw new Error("The note plan connected an argument to itself.");
    }
    // Only unmistakable boilerplate is rejected locally. Nuanced relationship
    // reasons still require semantic judgment; a regex cannot verify support.
    if (/^(?:they |both(?: notes| arguments)? )?(?:share|come from|derive from|are from|have) (?:a |the )?(?:same |common )?source[.!]?$/i.test(connection.reason.trim())) {
      throw new Error("Shared source membership alone does not establish an argument connection.");
    }
  }
}

/** Writers receive vocabulary and endpoints, never unrelated plans or sibling prose. */
export function scopedImportConnectionPlan(
  plan: KnowledgeWritingBlueprint,
  outputIds: readonly string[],
) {
  const assignedIds = new Set(outputIds);
  const titles = new Set(plan.outputs.filter((output) => assignedIds.has(output.outputId))
    .map((output) => normalizeConceptPhrase(output.title)));
  const touches = (title: string) => titles.has(normalizeConceptPhrase(title));
  const concepts = plan.concepts.filter((concept) =>
    touches(concept.canonicalTitle) || concept.relatedTitles.some(touches));
  const suggestedConnections = plan.suggestedConnections.filter((connection) =>
    touches(connection.fromTitle) || touches(connection.toTitle));
  const destinations = new Set([
    ...titles,
    ...concepts.map((concept) => normalizeConceptPhrase(concept.canonicalTitle)),
    ...suggestedConnections.flatMap((connection) =>
      [connection.fromTitle, connection.toTitle].map(normalizeConceptPhrase)),
  ]);
  return {
    concepts: concepts.map((concept) => ({
      ...concept, relatedTitles: concept.relatedTitles.filter(touches),
    })),
    suggestedConnections,
    outputDirectory: plan.outputs.filter((output) => destinations.has(normalizeConceptPhrase(output.title)))
      .map(({ outputId, title, kind }) => ({ outputId, title, kind })),
  };
}
