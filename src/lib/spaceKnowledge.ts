import type {
  AppSnapshot,
  Note,
  OrganizeContentRequest,
  OrganizeContentResult,
  SpaceKnowledgeBlueprint,
  SpaceKnowledgeIndex,
  SpaceNoteDigest,
} from "../types";

const CLUSTER_TARGET_MAX = 32;
const MAX_DIGEST_SUMMARY_CHARS = 700;
const MAX_DIGEST_SKETCH_CHARS = 1_000;
const MAX_DIGEST_HEADINGS = 24;
const MAX_DIGEST_CONCEPTS = 32;
const MAX_DIGEST_RELATIONSHIPS = 24;
const MAX_BLUEPRINT_BODY_CHARS = 8_000;
const MAX_BLUEPRINT_LABELS = 24;

export interface SpaceBlueprintOrientation {
  root: {
    id: string;
    fingerprint: string;
    title: string;
    body: string;
    stale: boolean;
  };
  clusters: Array<{
    id: string;
    fingerprint: string;
    title: string;
    body: string;
    noteIds: string[];
  }>;
}

export function stableKnowledgeHash(value: string): string {
  let high = 0xcbf29ce4;
  let low = 0x84222325;
  for (let index = 0; index < value.length; index += 1) {
    low ^= value.charCodeAt(index);
    const lowTimesPrime = low * 0x1b3;
    const cross = high * 0x1b3 + low * 0x100;
    low = lowTimesPrime >>> 0;
    high = cross >>> 0;
  }
  return `${high.toString(16).padStart(8, "0")}${low
    .toString(16)
    .padStart(8, "0")}`;
}

export function spaceNoteVersion(note: Note): string {
  return stableKnowledgeHash(
    JSON.stringify({
      id: note.id,
      title: note.title,
      summary: note.summary,
      body: note.body,
      aliases: note.aliases,
      tags: note.tags,
      conceptIds: note.conceptIds,
      sourceIds: note.sourceIds,
      updatedAt: note.updatedAt,
    }),
  );
}

export function buildSpaceNoteDigests(snapshot: AppSnapshot): SpaceNoteDigest[] {
  const eligibleNotes = snapshot.notes
    .filter(isKnowledgeNote)
    .sort((left, right) => left.id.localeCompare(right.id));
  const noteById = new Map(eligibleNotes.map((note) => [note.id, note] as const));
  const conceptsByNoteId = new Map<string, string[]>();
  const relationshipsByNoteId = new Map<string, string[]>();
  const conceptById = new Map(snapshot.concepts.map((concept) => [concept.id, concept]));
  const append = (
    index: Map<string, string[]>,
    noteId: string,
    value: string,
    maximum: number,
  ) => {
    if (!noteById.has(noteId) || !value.trim()) return;
    const values = index.get(noteId) ?? [];
    if (!values.includes(value) && values.length < maximum) {
      values.push(value);
      index.set(noteId, values);
    }
  };

  for (const concept of snapshot.concepts) {
    const noteIds = new Set(concept.noteIds);
    if (concept.canonicalNoteId) noteIds.add(concept.canonicalNoteId);
    for (const noteId of noteIds) {
      append(
        conceptsByNoteId,
        noteId,
        concept.label,
        MAX_DIGEST_CONCEPTS,
      );
    }
  }
  for (const note of eligibleNotes) {
    for (const conceptId of note.conceptIds) {
      const concept = conceptById.get(conceptId);
      if (concept) {
        append(
          conceptsByNoteId,
          note.id,
          concept.label,
          MAX_DIGEST_CONCEPTS,
        );
      }
    }
  }
  for (const relationship of snapshot.relationships) {
    const from = noteById.get(relationship.fromNoteId);
    const to = noteById.get(relationship.toNoteId);
    if (!from || !to) continue;
    const label = relationship.label.trim()
      ? ` (${relationship.label.trim()})`
      : "";
    append(
      relationshipsByNoteId,
      from.id,
      `${relationship.kind}: ${to.title}${label}`,
      MAX_DIGEST_RELATIONSHIPS,
    );
    append(
      relationshipsByNoteId,
      to.id,
      `${relationship.kind} from ${from.title}${label}`,
      MAX_DIGEST_RELATIONSHIPS,
    );
  }

  return eligibleNotes.map((note) => {
    const noteVersion = spaceNoteVersion(note);
    const headings = extractNoteHeadings(note.body);
    const wholeBodySketch = buildNoteWholeBodySketch(note.body, headings);
    const summary = truncateUnicode(
      plainText(note.summary) || wholeBodySketch,
      MAX_DIGEST_SUMMARY_CHARS,
    );
    const quality = !wholeBodySketch
      ? "fallback"
      : wholeBodySketch.length < 80 ||
          (summary.length < 24 && note.body.length < 160)
        ? "weak"
        : "complete";
    const qualityReason =
      quality === "complete"
        ? "Distributed whole-body sketch and substantive summary available."
        : quality === "weak"
          ? "The note is short or has too little prose for a strong semantic sketch."
          : "The note has no readable body; routing can use metadata only.";
    return {
      noteId: note.id,
      noteVersion,
      title: note.title,
      aliases: [...note.aliases],
      tags: [...note.tags],
      summary,
      headings,
      wholeBodySketch,
      conceptLabels: [...(conceptsByNoteId.get(note.id) ?? [])],
      relationshipHints: [...(relationshipsByNoteId.get(note.id) ?? [])],
      sourceIds: [...note.sourceIds],
      reference: note.kind === "wiki",
      bodyCharacters: note.body.length,
      contentFingerprint: stableKnowledgeHash(
        JSON.stringify({
          noteVersion,
          headings,
          wholeBodySketch,
          concepts: conceptsByNoteId.get(note.id) ?? [],
          relationships: relationshipsByNoteId.get(note.id) ?? [],
        }),
      ),
      quality,
      qualityReason,
    } satisfies SpaceNoteDigest;
  });
}

export function prepareSpaceKnowledgeIndex(
  snapshot: AppSnapshot,
  generatedAt = new Date().toISOString(),
): SpaceKnowledgeIndex {
  const digests = buildSpaceNoteDigests(snapshot);
  const previousIndex = spaceKnowledgeIndexHasValidStructure(
    snapshot.spaceKnowledge,
  )
    ? snapshot.spaceKnowledge
    : undefined;
  const previousById = new Map(
    (previousIndex?.blueprints ?? []).map((blueprint) => [
      blueprint.id,
      blueprint,
    ]),
  );
  const blueprints: SpaceKnowledgeBlueprint[] = [];
  let currentLevel = buildIncrementalLeafGroups(
    digests,
    previousIndex,
  ).map(
    ({ id, members }, index) =>
      createOrReuseBlueprint({
        id: id ?? blueprintId(0, index, members.map(({ noteId }) => noteId)),
        level: 0,
        noteIds: members.map(({ noteId }) => noteId),
        childBlueprintIds: [],
        fingerprint: stableKnowledgeHash(
          JSON.stringify(
            members.map(({ noteId, contentFingerprint }) => [
              noteId,
              contentFingerprint,
            ]),
          ),
        ),
        generatedAt,
        digests: members,
        children: [],
        previousById,
      }),
  );
  blueprints.push(...currentLevel);

  let level = 1;
  while (currentLevel.length > CLUSTER_TARGET_MAX) {
    const parentLevel = balancedGroups(currentLevel, CLUSTER_TARGET_MAX).map(
      (children, index) =>
        createOrReuseBlueprint({
          id: blueprintId(
            level,
            index,
            children.map(({ id }) => id),
          ),
          level,
          noteIds: children.flatMap(({ noteIds }) => noteIds),
          childBlueprintIds: children.map(({ id }) => id),
          fingerprint: stableKnowledgeHash(
            JSON.stringify(
              children.map(({ id, fingerprint }) => [id, fingerprint]),
            ),
          ),
          generatedAt,
          digests: [],
          children,
          previousById,
        }),
    );
    blueprints.push(...parentLevel);
    currentLevel = parentLevel;
    level += 1;
  }

  const rootFingerprint = stableKnowledgeHash(
    JSON.stringify({
      workspace: [snapshot.workspace.name, snapshot.workspace.description],
      children: currentLevel.map(({ id, fingerprint }) => [id, fingerprint]),
    }),
  );
  const rootId = digests.length > 0 ? "space-blueprint-root" : null;
  if (rootId) {
    blueprints.push(
      createOrReuseBlueprint({
        id: rootId,
        level,
        noteIds: digests.map(({ noteId }) => noteId),
        childBlueprintIds: currentLevel.map(({ id }) => id),
        fingerprint: rootFingerprint,
        generatedAt,
        digests: [],
        children: currentLevel,
        previousById,
        rootName: snapshot.workspace.name,
        rootDescription: snapshot.workspace.description,
      }),
    );
  }
  const snapshotFingerprint = stableKnowledgeHash(
    JSON.stringify({
      workspace: [snapshot.workspace.name, snapshot.workspace.description],
      digests: digests.map(({ noteId, contentFingerprint }) => [
        noteId,
        contentFingerprint,
      ]),
    }),
  );
  const allProvider =
    blueprints.length > 0 && blueprints.every(({ origin }) => origin === "provider");
  return {
    schemaVersion: 1,
    snapshotFingerprint,
    digests,
    blueprints,
    rootBlueprintId: rootId,
    updatedAt: generatedAt,
    stale: !allProvider,
  };
}

function buildIncrementalLeafGroups(
  digests: readonly SpaceNoteDigest[],
  previous: SpaceKnowledgeIndex | undefined,
): Array<{ id?: string; members: SpaceNoteDigest[] }> {
  const digestById = new Map(digests.map((digest) => [digest.noteId, digest]));
  const previousLeaves = (previous?.blueprints ?? [])
    .filter(({ level, childBlueprintIds }) =>
      level === 0 && childBlueprintIds.length === 0,
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  if (previousLeaves.length === 0) {
    return balancedGroups(digests, CLUSTER_TARGET_MAX).map((members) => ({
      members,
    }));
  }

  const assigned = new Set<string>();
  const groups: Array<{ id?: string; members: SpaceNoteDigest[] }> =
    previousLeaves.flatMap((leaf) => {
      const members = leaf.noteIds.flatMap((noteId) => {
        const digest = digestById.get(noteId);
        if (!digest || assigned.has(noteId)) return [];
        assigned.add(noteId);
        return [digest];
      });
      return members.length > 0 ? [{ id: leaf.id, members }] : [];
    });
  const additions = digests.filter(({ noteId }) => !assigned.has(noteId));
  for (const digest of additions) {
    const candidates = groups
      .filter(({ members }) => members.length < CLUSTER_TARGET_MAX)
      .map((group) => ({
        group,
        score: incrementalClusterScore(digest, group.members),
      }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.group.members.length - right.group.members.length ||
          (left.group.id ?? "").localeCompare(right.group.id ?? ""),
      );
    const destination = candidates[0]?.group;
    if (destination) destination.members.push(digest);
    else groups.push({ members: [digest] });
  }
  return groups;
}

function incrementalClusterScore(
  digest: SpaceNoteDigest,
  members: readonly SpaceNoteDigest[],
): number {
  const digestTokens = normalizedTokens(
    [
      digest.title,
      ...digest.aliases,
      ...digest.tags,
      ...digest.conceptLabels,
      digest.summary,
      digest.wholeBodySketch,
    ].join(" "),
  );
  const clusterTokens = normalizedTokens(
    members
      .flatMap(
        ({
          title,
          aliases,
          tags,
          conceptLabels,
          summary,
          wholeBodySketch,
        }) => [
          title,
          ...aliases,
          ...tags,
          ...conceptLabels,
          summary,
          wholeBodySketch,
        ],
      )
      .join(" "),
  );
  let score = 0;
  for (const token of digestTokens) {
    if (clusterTokens.has(token)) score += 1;
  }
  return score;
}

export function getSpaceKnowledgeRoot(
  index: SpaceKnowledgeIndex | undefined,
): SpaceKnowledgeBlueprint | undefined {
  if (!index?.rootBlueprintId) return undefined;
  return index.blueprints.find(({ id }) => id === index.rootBlueprintId);
}

export function spaceKnowledgeIsCurrent(snapshot: AppSnapshot): boolean {
  const index = snapshot.spaceKnowledge;
  if (!index || !spaceKnowledgeIndexHasValidStructure(index)) return false;
  const expectedDigests = buildSpaceNoteDigests(snapshot);
  const expectedFingerprint = stableKnowledgeHash(
    JSON.stringify({
      workspace: [snapshot.workspace.name, snapshot.workspace.description],
      digests: expectedDigests.map(({ noteId, contentFingerprint }) => [
        noteId,
        contentFingerprint,
      ]),
    }),
  );
  if (index.snapshotFingerprint !== expectedFingerprint) return false;
  if (index.digests.length !== expectedDigests.length) return false;
  return expectedDigests.every((expected, position) => {
    const actual = index.digests[position];
    return (
      actual?.noteId === expected.noteId &&
      actual.noteVersion === expected.noteVersion &&
      actual.contentFingerprint === expected.contentFingerprint
    );
  });
}

export function pendingSpaceBlueprints(
  index: SpaceKnowledgeIndex,
): SpaceKnowledgeBlueprint[] {
  const root = getSpaceKnowledgeRoot(index);
  const singleRootChild =
    root?.childBlueprintIds.length === 1 ? root.childBlueprintIds[0] : undefined;
  return index.blueprints
    .filter(
      ({ id, origin }) =>
        id !== index.rootBlueprintId &&
        id !== singleRootChild &&
        origin !== "provider",
    )
    .sort((left, right) => left.level - right.level || left.id.localeCompare(right.id));
}

export function buildSpaceBlueprintRequest(
  snapshot: AppSnapshot,
  index: SpaceKnowledgeIndex,
  blueprintId: string,
): OrganizeContentRequest {
  const blueprint = requireBlueprint(index, blueprintId);
  const children = blueprint.childBlueprintIds.map((id) => requireBlueprint(index, id));
  const digests = index.digests.filter(({ noteId }) =>
    blueprint.noteIds.includes(noteId),
  );
  const material = children.length
    ? children.map(blueprintPacket)
    : digests.map(digestPacket);
  return {
    content: [
      `Space: ${snapshot.workspace.name}`,
      snapshot.workspace.description,
      `Blueprint level: ${blueprint.level}`,
      `Expected note IDs (${blueprint.noteIds.length}): ${blueprint.noteIds.join(", ")}`,
      `Typed child material:\n${JSON.stringify(material)}`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 90_000),
    sourceName: `${snapshot.workspace.name} knowledge cluster`,
    spaceName: snapshot.workspace.name,
    spaceDescription: snapshot.workspace.description,
    model: snapshot.settings.model,
    effort: boundedBlueprintEffort(snapshot.settings.reasoningEffort),
    timeoutMs: 300_000,
    taskInstructions:
      "Space-blueprint task: return exactly one entry in notes and empty wikiArticles, concepts, and suggestedConnections. Synthesize only the supplied typed child material. The title names this cluster's intellectual centre. The body is a compact orientation of its thesis, durable concepts, meaningful relationships, tensions, and open questions. Do not invent facts, cite process, list source files, use [[wiki]] syntax, or claim to have opened note bodies beyond the supplied digests. Preserve disagreement and uncertainty. Never output user notes or tasks.",
    organizationInstructions: snapshot.settings.organizationInstructions,
  };
}

export function applySpaceBlueprintResult(
  index: SpaceKnowledgeIndex,
  blueprintId: string,
  result: OrganizeContentResult,
  generatedAt: string,
): SpaceKnowledgeIndex {
  const generated = result.notes[0];
  const title = cleanGeneratedProse(generated?.title ?? "").slice(0, 160);
  const body = cleanGeneratedProse(generated?.body ?? "").slice(
    0,
    MAX_BLUEPRINT_BODY_CHARS,
  );
  if (!title || !body) {
    throw new Error("Orion did not return a usable Space cluster blueprint.");
  }
  const focusConcepts = extractLabelCandidates(body, "concept");
  const tensions = extractLabelCandidates(body, "tension");
  const openQuestions = extractQuestions(body);
  return {
    ...index,
    blueprints: index.blueprints.map((blueprint) =>
      blueprint.id === blueprintId
        ? {
            ...blueprint,
            title,
            body,
            focusConcepts:
              focusConcepts.length > 0 ? focusConcepts : blueprint.focusConcepts,
            tensions: tensions.length > 0 ? tensions : blueprint.tensions,
            openQuestions:
              openQuestions.length > 0
                ? openQuestions
                : blueprint.openQuestions,
            generatedAt,
            origin: "provider",
          }
        : blueprint,
    ),
    updatedAt: generatedAt,
    stale: true,
  };
}

export function buildSpaceRootRequest(
  snapshot: AppSnapshot,
  index: SpaceKnowledgeIndex,
): OrganizeContentRequest {
  const root = getSpaceKnowledgeRoot(index);
  if (!root) throw new Error("This Space has no knowledge to summarize.");
  const children = root.childBlueprintIds.map((id) => requireBlueprint(index, id));
  return {
    content: [
      `Space: ${snapshot.workspace.name}`,
      snapshot.workspace.description,
      `Root fingerprint: ${root.fingerprint}`,
      `Validated child blueprints:\n${JSON.stringify(children.map(blueprintPacket))}`,
      snapshot.spaceOverview
        ? [
            "Previous Across this Space overview:",
            snapshot.spaceOverview.title,
            snapshot.spaceOverview.body,
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 90_000),
    sourceName: `${snapshot.workspace.name} Space root blueprint`,
    spaceName: snapshot.workspace.name,
    spaceDescription: snapshot.workspace.description,
    model: snapshot.settings.model,
    effort: boundedBlueprintEffort(snapshot.settings.reasoningEffort),
    timeoutMs: 300_000,
    taskInstructions:
      "Root Space-blueprint task: return exactly one entry in notes and empty wikiArticles, concepts, and suggestedConnections. Write the note as the living Across this Space orientation. Its editorial title should capture the Space's current intellectual centre. Its cohesive body should explain the central material, meaningful relationships, tensions, open questions, and direction of work in roughly five to eight compact paragraphs. Synthesize only the validated child blueprints. Do not make a source inventory, change log, Context from section, or [[wiki]] links; do not invent facts. Preserve a worthwhile previous title unless the centre materially changed.",
    organizationInstructions: snapshot.settings.organizationInstructions,
  };
}

export function applySpaceRootResult(
  index: SpaceKnowledgeIndex,
  result: OrganizeContentResult,
  generatedAt: string,
): SpaceKnowledgeIndex {
  if (!index.rootBlueprintId) return index;
  const updated = applySpaceBlueprintResult(
    index,
    index.rootBlueprintId,
    result,
    generatedAt,
  );
  const root = getSpaceKnowledgeRoot(updated);
  const soleChildId =
    root?.childBlueprintIds.length === 1 ? root.childBlueprintIds[0] : undefined;
  return {
    ...updated,
    blueprints: soleChildId
      ? updated.blueprints.map((blueprint) =>
          blueprint.id === soleChildId && blueprint.origin !== "provider"
            ? {
                ...blueprint,
                title: root?.title ?? blueprint.title,
                body: root?.body ?? blueprint.body,
                focusConcepts: root?.focusConcepts ?? blueprint.focusConcepts,
                tensions: root?.tensions ?? blueprint.tensions,
                openQuestions: root?.openQuestions ?? blueprint.openQuestions,
                generatedAt,
                origin: "provider",
              }
            : blueprint,
        )
      : updated.blueprints,
    stale: false,
    updatedAt: generatedAt,
  };
}

export function buildSpaceBlueprintOrientation(
  snapshot: AppSnapshot,
  relevanceText: string,
  maximumClusters = 4,
): SpaceBlueprintOrientation | undefined {
  const index = snapshot.spaceKnowledge;
  const root = getSpaceKnowledgeRoot(index);
  if (!index || !root || !spaceKnowledgeIsCurrent(snapshot)) return undefined;
  const children = root.childBlueprintIds
    .map((id) => index.blueprints.find((blueprint) => blueprint.id === id))
    .filter((blueprint): blueprint is SpaceKnowledgeBlueprint => Boolean(blueprint));
  const matcher = normalizedTokens(relevanceText);
  const scored = children
    .map((blueprint) => ({
      blueprint,
      score: scoreBlueprint(blueprint, index, matcher),
    }))
    .sort(
      (left, right) =>
        right.score - left.score || left.blueprint.id.localeCompare(right.blueprint.id),
    );
  const selected = scored
    .filter(({ score }, index) => score > 0 || index === 0)
    .slice(0, Math.max(1, maximumClusters))
    .map(({ blueprint }) => ({
      id: blueprint.id,
      fingerprint: blueprint.fingerprint,
      title: blueprint.title,
      body: truncateUnicode(blueprint.body, 2_400),
      noteIds: [...blueprint.noteIds],
    }));
  return {
    root: {
      id: root.id,
      fingerprint: root.fingerprint,
      title: root.title,
      body: truncateUnicode(root.body, 5_000),
      stale: index.stale,
    },
    clusters: selected,
  };
}

function createOrReuseBlueprint(input: {
  id: string;
  level: number;
  noteIds: string[];
  childBlueprintIds: string[];
  fingerprint: string;
  generatedAt: string;
  digests: SpaceNoteDigest[];
  children: SpaceKnowledgeBlueprint[];
  previousById: ReadonlyMap<string, SpaceKnowledgeBlueprint>;
  rootName?: string;
  rootDescription?: string;
}): SpaceKnowledgeBlueprint {
  const previous = input.previousById.get(input.id);
  if (
    previous?.fingerprint === input.fingerprint &&
    previous.origin === "provider" &&
    previous.level === input.level &&
    sameOrderedValues(previous.noteIds, input.noteIds) &&
    sameOrderedValues(previous.childBlueprintIds, input.childBlueprintIds) &&
    Boolean(previous.title.trim()) &&
    Boolean(previous.body.trim())
  ) {
    return structuredClone(previous);
  }
  const concepts = unique(
    input.digests.length
      ? input.digests.flatMap(({ conceptLabels }) => conceptLabels)
      : input.children.flatMap(({ focusConcepts }) => focusConcepts),
  ).slice(0, MAX_BLUEPRINT_LABELS);
  const tensions = unique(
    input.digests.length
      ? input.digests.flatMap(({ relationshipHints }) => relationshipHints)
      : input.children.flatMap(({ tensions: values }) => values),
  ).slice(0, 12);
  const questions = unique(
    input.children.flatMap(({ openQuestions }) => openQuestions),
  ).slice(0, 12);
  const titles = input.digests.length
    ? input.digests.map(({ title }) => title)
    : input.children.map(({ title }) => title);
  const title = input.rootName
    ? `${input.rootName} — Space blueprint`
    : titles.slice(0, 2).join(" · ") || `Space cluster ${input.id}`;
  const bodyParts = input.digests.length
    ? input.digests.map(
        ({ title: noteTitle, summary, wholeBodySketch }) =>
          `${noteTitle}: ${summary || wholeBodySketch}`,
      )
    : input.children.map(
        ({ title: childTitle, body }) => `${childTitle}: ${body}`,
      );
  return {
    id: input.id,
    level: input.level,
    noteIds: [...input.noteIds],
    childBlueprintIds: [...input.childBlueprintIds],
    fingerprint: input.fingerprint,
    title,
    body: truncateUnicode(
      [input.rootDescription ?? "", ...bodyParts].filter(Boolean).join("\n\n"),
      MAX_BLUEPRINT_BODY_CHARS,
    ),
    focusConcepts: concepts,
    tensions,
    openQuestions: questions,
    generatedAt: input.generatedAt,
    origin: "local",
  };
}

function spaceKnowledgeIndexHasValidStructure(
  index: SpaceKnowledgeIndex | undefined,
): index is SpaceKnowledgeIndex {
  if (!index || index.schemaVersion !== 1) return false;
  const digestById = new Map<string, SpaceNoteDigest>();
  for (const digest of index.digests) {
    if (digestById.has(digest.noteId)) return false;
    digestById.set(digest.noteId, digest);
  }
  const blueprintById = new Map<string, SpaceKnowledgeBlueprint>();
  for (const blueprint of index.blueprints) {
    if (blueprintById.has(blueprint.id)) return false;
    if (
      blueprint.noteIds.length === 0 ||
      new Set(blueprint.noteIds).size !== blueprint.noteIds.length ||
      new Set(blueprint.childBlueprintIds).size !==
        blueprint.childBlueprintIds.length
    ) {
      return false;
    }
    blueprintById.set(blueprint.id, blueprint);
  }

  if (index.digests.length === 0) {
    return index.rootBlueprintId === null && index.blueprints.length === 0;
  }
  const root = index.rootBlueprintId
    ? blueprintById.get(index.rootBlueprintId)
    : undefined;
  if (!root || root.id !== "space-blueprint-root") return false;

  const leafMembership = new Set<string>();
  for (const blueprint of index.blueprints) {
    if (blueprint.childBlueprintIds.length === 0) {
      if (blueprint.level !== 0 || blueprint.noteIds.length > CLUSTER_TARGET_MAX) {
        return false;
      }
      const expectedFingerprint = stableKnowledgeHash(
        JSON.stringify(
          blueprint.noteIds.map((noteId) => {
            const digest = digestById.get(noteId);
            return digest ? [noteId, digest.contentFingerprint] : null;
          }),
        ),
      );
      if (
        blueprint.noteIds.some(
          (noteId) => !digestById.has(noteId) || leafMembership.has(noteId),
        ) ||
        blueprint.fingerprint !== expectedFingerprint
      ) {
        return false;
      }
      blueprint.noteIds.forEach((noteId) => leafMembership.add(noteId));
      continue;
    }

    const children = blueprint.childBlueprintIds.map((childId) =>
      blueprintById.get(childId),
    );
    if (
      children.some(
        (child) => !child || child.level >= blueprint.level,
      )
    ) {
      return false;
    }
    const resolvedChildren = children as SpaceKnowledgeBlueprint[];
    const expectedNoteIds = resolvedChildren.flatMap(({ noteIds }) => noteIds);
    if (
      new Set(expectedNoteIds).size !== expectedNoteIds.length ||
      (blueprint.id === index.rootBlueprintId
        ? !sameValueSet(blueprint.noteIds, expectedNoteIds)
        : !sameOrderedValues(blueprint.noteIds, expectedNoteIds))
    ) {
      return false;
    }
    if (blueprint.id !== index.rootBlueprintId) {
      const expectedFingerprint = stableKnowledgeHash(
        JSON.stringify(
          resolvedChildren.map(({ id, fingerprint }) => [id, fingerprint]),
        ),
      );
      if (blueprint.fingerprint !== expectedFingerprint) return false;
    }
  }

  const expectedNoteIds = index.digests.map(({ noteId }) => noteId);
  if (
    leafMembership.size !== expectedNoteIds.length ||
    expectedNoteIds.some((noteId) => !leafMembership.has(noteId)) ||
    !sameOrderedValues(root.noteIds, expectedNoteIds)
  ) {
    return false;
  }
  const reachable = new Set<string>();
  const visit = (blueprint: SpaceKnowledgeBlueprint): boolean => {
    if (reachable.has(blueprint.id)) return false;
    reachable.add(blueprint.id);
    return blueprint.childBlueprintIds.every((childId) => {
      const child = blueprintById.get(childId);
      return Boolean(child) && visit(child as SpaceKnowledgeBlueprint);
    });
  };
  return visit(root) && reachable.size === index.blueprints.length;
}

function sameOrderedValues(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameValueSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return values.size === left.length && right.every((value) => values.has(value));
}

function balancedGroups<T>(values: readonly T[], maximum: number): T[][] {
  if (values.length === 0) return [];
  const groupCount = Math.ceil(values.length / maximum);
  const base = Math.floor(values.length / groupCount);
  const remainder = values.length % groupCount;
  const groups: T[][] = [];
  let offset = 0;
  for (let index = 0; index < groupCount; index += 1) {
    const size = base + (index < remainder ? 1 : 0);
    groups.push(values.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

function blueprintId(level: number, index: number, noteIds: readonly string[]): string {
  return `space-blueprint-${level}-${index + 1}-${stableKnowledgeHash(
    noteIds.join("\u0000"),
  ).slice(0, 10)}`;
}

function isKnowledgeNote(note: Note): boolean {
  if (
    note.status === "archived" ||
    note.tags.includes("orion-link-pending") ||
    note.tags.includes("orion-link-draft") ||
    /<!--\s*orion-link-(?:pending|draft)\s*-->/i.test(note.body)
  ) {
    return false;
  }
  return `${plainText(note.summary)} ${plainText(note.body)}`.trim().length >= 24;
}

export function extractNoteHeadings(body: string): string[] {
  return [...body.matchAll(/^#{1,3}\s+(.+)$/gm)]
    .map((match) => cleanGeneratedProse(match[1]))
    .filter(Boolean)
    .slice(0, MAX_DIGEST_HEADINGS);
}

export function buildNoteWholeBodySketch(
  body: string,
  headings: readonly string[] = extractNoteHeadings(body),
): string {
  const plain = plainText(body);
  if (!plain) return "";
  if (plain.length <= MAX_DIGEST_SKETCH_CHARS) return plain;
  const segmentSize = 150;
  const positions = [0, 0.25, 0.5, 0.75, 1].map((ratio) =>
    Math.max(0, Math.min(plain.length - segmentSize, Math.round(plain.length * ratio))),
  );
  const segments = positions.map((position) =>
    sentenceBoundedSlice(plain, position, segmentSize),
  );
  return truncateUnicode(
    [...headings.slice(0, 8), ...unique(segments)].filter(Boolean).join(" … "),
    MAX_DIGEST_SKETCH_CHARS,
  );
}

function sentenceBoundedSlice(value: string, start: number, length: number): string {
  let from = start;
  let to = Math.min(value.length, start + length);
  if (from > 0) {
    const boundary = value.lastIndexOf(" ", from + 24);
    if (boundary >= Math.max(0, from - 40)) from = boundary + 1;
  }
  if (to < value.length) {
    const boundary = value.indexOf(" ", Math.max(from, to - 24));
    if (boundary > 0 && boundary <= to + 40) to = boundary;
  }
  return value.slice(from, to).trim();
}

function plainText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~`>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanGeneratedProse(value: string): string {
  return value
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[a-z0-9_-]*\n([\s\S]*?)```/gi, "$1")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function digestPacket(digest: SpaceNoteDigest): object {
  return {
    noteId: digest.noteId,
    noteVersion: digest.noteVersion,
    title: digest.title,
    aliases: digest.aliases,
    tags: digest.tags,
    summary: digest.summary,
    headings: digest.headings,
    wholeBodySketch: digest.wholeBodySketch,
    conceptLabels: digest.conceptLabels,
    relationshipHints: digest.relationshipHints,
    reference: digest.reference,
    bodyCharacters: digest.bodyCharacters,
    quality: digest.quality,
    qualityReason: digest.qualityReason,
  };
}

function blueprintPacket(blueprint: SpaceKnowledgeBlueprint): object {
  return {
    id: blueprint.id,
    level: blueprint.level,
    fingerprint: blueprint.fingerprint,
    title: blueprint.title,
    body: truncateUnicode(blueprint.body, 2_000),
    focusConcepts: blueprint.focusConcepts,
    tensions: blueprint.tensions,
    openQuestions: blueprint.openQuestions,
    noteIds: blueprint.noteIds,
  };
}

function requireBlueprint(
  index: SpaceKnowledgeIndex,
  blueprintId: string,
): SpaceKnowledgeBlueprint {
  const blueprint = index.blueprints.find(({ id }) => id === blueprintId);
  if (!blueprint) throw new Error(`Unknown Space blueprint: ${blueprintId}`);
  return blueprint;
}

function boundedBlueprintEffort(
  effort: AppSnapshot["settings"]["reasoningEffort"],
): AppSnapshot["settings"]["reasoningEffort"] {
  return effort === "high" || effort === "xhigh" || effort === "max"
    ? "medium"
    : effort;
}

function extractLabelCandidates(body: string, word: string): string[] {
  return unique(
    body
      .split(/\n|[.!?]\s+/)
      .filter((line) => line.toLocaleLowerCase().includes(word))
      .map((line) => line.trim())
      .filter(Boolean),
  ).slice(0, 12);
}

function extractQuestions(body: string): string[] {
  return unique(
    body
      .split(/(?<=\?)\s+/)
      .map((part) => part.trim())
      .filter((part) => part.endsWith("?")),
  ).slice(0, 12);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function truncateUnicode(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function normalizedTokens(value: string): ReadonlySet<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4),
  );
}

function scoreBlueprint(
  blueprint: SpaceKnowledgeBlueprint,
  index: SpaceKnowledgeIndex,
  matcher: ReadonlySet<string>,
): number {
  if (matcher.size === 0) return 0;
  const text = [
    blueprint.title,
    blueprint.body,
    ...blueprint.focusConcepts,
    ...index.digests
      .filter(({ noteId }) => blueprint.noteIds.includes(noteId))
      .flatMap(({ title, aliases, conceptLabels }) => [
        title,
        ...aliases,
        ...conceptLabels,
      ]),
  ]
    .join(" ")
    .normalize("NFKC")
    .toLocaleLowerCase();
  let score = 0;
  for (const token of matcher) {
    if (text.includes(token)) score += 1;
  }
  return score;
}
