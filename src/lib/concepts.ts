import type { Concept, EntityId, Note } from "../types";

export const CONCEPT_COLORS = [
  "#8ea4ff",
  "#d695c2",
  "#7bc4aa",
  "#e6ad69",
  "#79b9d5",
  "#aa9ce3",
] as const;

export interface ConceptSeed {
  label: string;
  aliases?: readonly string[];
  description?: string;
  noteIds: readonly EntityId[];
  canonicalNoteId?: EntityId;
}

export interface ConceptVocabulary {
  notes: Note[];
  concepts: Concept[];
}

export interface RegisterConceptPhraseInput {
  phrase: string;
  noteIds: readonly EntityId[];
  description?: string;
}

/**
 * The editor-level link request. An empty destination list asks Orion to
 * create or reuse the named canonical wiki article. Non-empty destinations
 * preserve the advanced/manual branching behavior used by older vaults.
 */
export interface RegisterWikiLinkInput {
  phrase: string;
  destinationNoteIds: readonly EntityId[];
  description?: string;
}

export interface EnsureCanonicalConceptPhraseInput {
  phrase: string;
  candidateArticle: Note;
  description?: string;
}

export interface RegisterConceptPhraseResult extends ConceptVocabulary {
  conceptId: EntityId;
}

export function normalizeConceptPhrase(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[‘’]/g, "'")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export function isLinkablePhrase(value: string): boolean {
  const phrase = value.trim();
  if (phrase.length >= 3) {
    return true;
  }
  return /^[A-Z0-9]{2,6}$/.test(phrase);
}

export function findConceptByPhrase(
  concepts: readonly Concept[],
  phrase: string,
): Concept | undefined {
  const normalized = normalizeConceptPhrase(phrase);
  const active = concepts.filter((concept) => concept.autoLink);
  return (
    active.find(
      (concept) => normalizeConceptPhrase(concept.label) === normalized,
    ) ??
    active
      .filter((concept) =>
        concept.aliases.some(
          (alias) => normalizeConceptPhrase(alias) === normalized,
        ),
      )
      .sort(
        (left, right) =>
          Number(Boolean(right.canonicalNoteId)) -
          Number(Boolean(left.canonicalNoteId)),
      )[0]
  );
}

export function reconcileConceptVocabulary(
  inputNotes: readonly Note[],
  inputConcepts: readonly Concept[],
  seeds: readonly ConceptSeed[] = [],
): ConceptVocabulary {
  const notes = inputNotes.map(cloneNote);
  const noteById = new Map(notes.map((note) => [note.id, note]));
  const validNoteIds = new Set(noteById.keys());
  const concepts = inputConcepts.map((concept) => {
    const noteIds = unique([
      ...concept.noteIds.filter((noteId) => validNoteIds.has(noteId)),
      ...(concept.canonicalNoteId && validNoteIds.has(concept.canonicalNoteId)
        ? [concept.canonicalNoteId]
        : []),
    ]);
    const canonicalNote =
      concept.canonicalNoteId &&
      noteById.get(concept.canonicalNoteId);
    const stillCanonical =
      canonicalNote &&
      normalizeConceptPhrase(canonicalNote.title) ===
        normalizeConceptPhrase(concept.label);
    return {
      ...concept,
      aliases: unique(concept.aliases),
      noteIds,
      ...(stillCanonical
        ? { canonicalNoteId: canonicalNote.id }
        : { canonicalNoteId: undefined }),
    };
  });
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  const notesByTitle = new Map<string, Note[]>();
  for (const note of notes) {
    const titleKey = normalizeConceptPhrase(note.title);
    if (!isUsableTitle(note.title)) {
      continue;
    }
    const matchingNotes = notesByTitle.get(titleKey) ?? [];
    matchingNotes.push(note);
    notesByTitle.set(titleKey, matchingNotes);
  }

  for (const note of notes) {
    const title = note.title.trim();
    if (!isUsableTitle(title)) {
      note.conceptIds = unique(
        note.conceptIds.filter((conceptId) => conceptById.has(conceptId)),
      );
      continue;
    }

    const normalizedTitle = normalizeConceptPhrase(title);
    const sameTitleNotes = notesByTitle.get(normalizedTitle) ?? [note];
    const existingShared = concepts.find(
      (concept) =>
        normalizeConceptPhrase(concept.label) === normalizedTitle &&
        !concept.canonicalNoteId &&
        concept.noteIds.length > 1 &&
        concept.noteIds.includes(note.id),
    );
    if (existingShared) {
      note.conceptIds = unique([...note.conceptIds, existingShared.id]);
      continue;
    }
    if (sameTitleNotes.length > 1) {
      let shared: Concept | undefined = concepts.find(
        (concept) =>
          normalizeConceptPhrase(concept.label) === normalizedTitle &&
          concept.autoLink,
      );
      if (!shared) {
        shared = {
          id: uniqueConceptId(
            phraseConceptId(normalizedTitle),
            conceptById,
          ),
          label: title,
          aliases: [],
          description: `Notes titled “${title}”.`,
          noteIds: [],
          color: note.color ?? nextColor(concepts.length),
          autoLink: true,
        };
        concepts.push(shared);
        conceptById.set(shared.id, shared);
      }
      shared.noteIds = unique([
        ...shared.noteIds,
        ...sameTitleNotes.map((candidate) => candidate.id),
      ]);
      shared.canonicalNoteId = undefined;
      for (const matchingNote of sameTitleNotes) {
        matchingNote.conceptIds = unique([
          ...matchingNote.conceptIds,
          shared.id,
        ]);
      }
      continue;
    }

    const canonicalId = canonicalTitleConceptId(note.id);
    let canonical =
      concepts.find(
        (concept) =>
          concept.canonicalNoteId === note.id &&
          normalizeConceptPhrase(concept.label) ===
            normalizeConceptPhrase(title),
      ) ??
      concepts.find(
        (concept) =>
          normalizeConceptPhrase(concept.label) ===
            normalizeConceptPhrase(title) &&
          concept.noteIds.length === 1 &&
          concept.noteIds[0] === note.id,
      ) ??
      conceptById.get(canonicalId);

    if (!canonical) {
      canonical = {
        id: uniqueConceptId(canonicalId, conceptById),
        label: title,
        aliases: [],
        description: note.summary,
        noteIds: [note.id],
        canonicalNoteId: note.id,
        color: note.color ?? nextColor(concepts.length),
        autoLink: true,
      };
      concepts.push(canonical);
      conceptById.set(canonical.id, canonical);
    } else {
      const previousLabel = canonical.label.trim();
      canonical.label = title;
      canonical.aliases = unique([
        ...canonical.aliases,
        ...(previousLabel &&
        normalizeConceptPhrase(previousLabel) !==
          normalizeConceptPhrase(title)
          ? [previousLabel]
          : []),
      ]);
      canonical.description = note.summary || canonical.description;
      canonical.noteIds = [note.id];
      canonical.canonicalNoteId = note.id;
      canonical.autoLink = true;
      canonical.color = note.color ?? canonical.color;
    }

    note.conceptIds = unique([...note.conceptIds, canonical.id]);
  }

  const phraseSeeds = collectLocalPhraseSeeds(notes);
  for (const seed of [...phraseSeeds, ...seeds]) {
    upsertSeed(seed, concepts, conceptById, validNoteIds);
  }

  mergeDuplicateAutoLinkLabels(concepts);
  removeAliasesShadowedByLabels(concepts);

  const conceptIdsByNote = new Map<EntityId, EntityId[]>();
  for (const concept of concepts) {
    concept.noteIds = unique(
      concept.noteIds.filter((noteId) => validNoteIds.has(noteId)),
    );
    for (const noteId of concept.noteIds) {
      const ids = conceptIdsByNote.get(noteId) ?? [];
      ids.push(concept.id);
      conceptIdsByNote.set(noteId, ids);
    }
  }

  for (const note of notes) {
    note.conceptIds = unique([
      ...note.conceptIds.filter((conceptId) => conceptById.has(conceptId)),
      ...(conceptIdsByNote.get(note.id) ?? []),
    ]);
  }

  return {
    notes,
    concepts: concepts.filter(
      (concept) => concept.noteIds.length > 0 || concept.aliases.length > 0,
    ),
  };
}

export function registerConceptPhrase(
  inputNotes: readonly Note[],
  inputConcepts: readonly Concept[],
  input: RegisterConceptPhraseInput,
): RegisterConceptPhraseResult {
  const phrase = input.phrase.trim().replace(/\s+/g, " ");
  if (!isLinkablePhrase(phrase)) {
    throw new Error(
      "Link phrases need at least three characters, or a two-letter uppercase acronym.",
    );
  }

  const validNoteIds = new Set(inputNotes.map((note) => note.id));
  const targetNoteIds = unique(
    input.noteIds.filter((noteId) => validNoteIds.has(noteId)),
  );
  if (targetNoteIds.length === 0) {
    throw new Error("Choose at least one destination note.");
  }

  const normalized = normalizeConceptPhrase(phrase);
  const concepts = inputConcepts.map(cloneConcept);
  let concept = findConceptByPhrase(concepts, normalized);

  if (!concept) {
    const usedIds = new Map(concepts.map((candidate) => [candidate.id, candidate]));
    concept = {
      id: uniqueConceptId(phraseConceptId(normalized), usedIds),
      label: phrase,
      aliases: phraseVariants(phrase).filter(
        (variant) => normalizeConceptPhrase(variant) !== normalized,
      ),
      description:
        input.description?.trim() ||
        `A reusable Orion link for “${phrase}”.`,
      noteIds: targetNoteIds,
      canonicalNoteId:
        targetNoteIds.length === 1 ? targetNoteIds[0] : undefined,
      color:
        inputNotes.find((note) => note.id === targetNoteIds[0])?.color ??
        nextColor(concepts.length),
      autoLink: true,
    };
    concepts.push(concept);
  } else {
    concept.noteIds = unique([...concept.noteIds, ...targetNoteIds]);
    concept.autoLink = true;
    const canonicalNoteId = concept.canonicalNoteId;
    const canonicalNote = canonicalNoteId
      ? inputNotes.find((note) => note.id === canonicalNoteId)
      : undefined;
    if (
      concept.canonicalNoteId &&
      (!canonicalNote ||
        normalizeConceptPhrase(canonicalNote.title) !==
          normalizeConceptPhrase(concept.label))
    ) {
      concept.canonicalNoteId = undefined;
    }
  }

  const vocabulary = reconcileConceptVocabulary(inputNotes, concepts);
  return {
    ...vocabulary,
    conceptId: concept.id,
  };
}

export function ensureCanonicalConceptPhrase(
  inputNotes: readonly Note[],
  inputConcepts: readonly Concept[],
  input: EnsureCanonicalConceptPhraseInput,
): RegisterConceptPhraseResult {
  const phrase = input.phrase.trim().replace(/\s+/g, " ");
  if (!isLinkablePhrase(phrase)) {
    throw new Error(
      "Link phrases need at least three characters, or a two-letter uppercase acronym.",
    );
  }

  const current = reconcileConceptVocabulary(inputNotes, inputConcepts);
  const existingConcept = findConceptByPhrase(current.concepts, phrase);
  if (
    existingConcept &&
    existingConcept.noteIds.some((noteId) =>
      current.notes.some((note) => note.id === noteId),
    )
  ) {
    return {
      ...current,
      conceptId: existingConcept.id,
    };
  }

  const normalized = normalizeConceptPhrase(phrase);
  const exactTitleNotes = current.notes.filter(
    (note) => normalizeConceptPhrase(note.title) === normalized,
  );
  if (exactTitleNotes.length > 0) {
    return registerConceptPhrase(current.notes, current.concepts, {
      phrase,
      noteIds: exactTitleNotes.map((note) => note.id),
      description: input.description,
    });
  }

  const candidateArticle: Note = {
    ...input.candidateArticle,
    title: phrase,
    aliases: [...input.candidateArticle.aliases],
    tags: [...input.candidateArticle.tags],
    conceptIds: [...input.candidateArticle.conceptIds],
    sourceIds: [...input.candidateArticle.sourceIds],
  };
  return registerConceptPhrase(
    [candidateArticle, ...current.notes],
    current.concepts,
    {
      phrase,
      noteIds: [candidateArticle.id],
      description: input.description,
    },
  );
}

function collectLocalPhraseSeeds(notes: readonly Note[]): ConceptSeed[] {
  const seedByPhrase = new Map<
    string,
    {
      label: string;
      aliases: Set<string>;
      noteIds: Set<EntityId>;
      descriptions: string[];
    }
  >();

  const add = (
    phrase: string,
    note: Note,
    description: string,
    aliases: readonly string[] = [],
  ) => {
    const label = phrase.trim().replace(/\s+/g, " ");
    if (!isLinkablePhrase(label)) {
      return;
    }
    const key = normalizeConceptPhrase(label);
    if (!key || key === normalizeConceptPhrase(note.title)) {
      return;
    }
    const current = seedByPhrase.get(key) ?? {
      label,
      aliases: new Set<string>(),
      noteIds: new Set<EntityId>(),
      descriptions: [],
    };
    current.noteIds.add(note.id);
    phraseVariants(label).forEach((variant) => current.aliases.add(variant));
    aliases.forEach((alias) => current.aliases.add(alias));
    if (description && !current.descriptions.includes(description)) {
      current.descriptions.push(description);
    }
    seedByPhrase.set(key, current);
  };

  for (const note of notes) {
    for (const alias of note.aliases) {
      add(alias, note, note.summary);
    }
  }

  return [...seedByPhrase.values()].map((seed) => ({
    label: seed.label,
    aliases: unique(
      [...seed.aliases].filter(
        (alias) =>
          normalizeConceptPhrase(alias) !==
          normalizeConceptPhrase(seed.label),
      ),
    ),
    description:
      seed.descriptions.length === 1
        ? seed.descriptions[0]
        : `A recurring idea across ${seed.noteIds.size} Orion notes.`,
    noteIds: [...seed.noteIds],
  }));
}

function upsertSeed(
  seed: ConceptSeed,
  concepts: Concept[],
  conceptById: Map<EntityId, Concept>,
  validNoteIds: ReadonlySet<EntityId>,
) {
  const label = seed.label.trim().replace(/\s+/g, " ");
  if (!isLinkablePhrase(label)) {
    return;
  }
  const noteIds = unique(
    seed.noteIds.filter((noteId) => validNoteIds.has(noteId)),
  );
  if (noteIds.length === 0) {
    return;
  }

  const normalized = normalizeConceptPhrase(label);
  let concept = concepts.find(
    (candidate) =>
      normalizeConceptPhrase(candidate.label) === normalized,
  );
  if (!concept && noteIds.length === 1) {
    const canonicalForTarget = concepts.find(
      (candidate) => candidate.canonicalNoteId === noteIds[0],
    );
    if (canonicalForTarget) {
      canonicalForTarget.aliases = unique([
        ...canonicalForTarget.aliases,
        label,
        ...(seed.aliases ?? []),
      ]).filter(
        (alias) =>
          normalizeConceptPhrase(alias) !==
          normalizeConceptPhrase(canonicalForTarget.label),
      );
      canonicalForTarget.description =
        canonicalForTarget.description || seed.description?.trim() || "";
      canonicalForTarget.autoLink = true;
      return;
    }
  }
  if (!concept) {
    const id = uniqueConceptId(phraseConceptId(normalized), conceptById);
    concept = {
      id,
      label,
      aliases: unique(seed.aliases ?? []).filter(
        (alias) => normalizeConceptPhrase(alias) !== normalized,
      ),
      description:
        seed.description?.trim() ||
        `A reusable Orion link for “${label}”.`,
      noteIds,
      canonicalNoteId:
        seed.canonicalNoteId && noteIds.includes(seed.canonicalNoteId)
          ? seed.canonicalNoteId
          : noteIds.length === 1
            ? noteIds[0]
            : undefined,
      color: nextColor(concepts.length),
      autoLink: true,
    };
    concepts.push(concept);
    conceptById.set(id, concept);
    return;
  }

  concept.noteIds = unique([...concept.noteIds, ...noteIds]);
  if (
    seed.canonicalNoteId &&
    concept.noteIds.includes(seed.canonicalNoteId)
  ) {
    concept.canonicalNoteId = seed.canonicalNoteId;
  } else if (
    concept.canonicalNoteId &&
    !concept.noteIds.includes(concept.canonicalNoteId)
  ) {
    concept.canonicalNoteId = undefined;
  }
  concept.aliases = unique([
    ...concept.aliases,
    ...(seed.aliases ?? []),
  ]).filter((alias) => normalizeConceptPhrase(alias) !== normalized);
  concept.description =
    concept.description || seed.description?.trim() || "";
  concept.autoLink = true;
}

function mergeDuplicateAutoLinkLabels(concepts: Concept[]) {
  const groups = new Map<string, Concept[]>();
  for (const concept of concepts) {
    if (!concept.autoLink) {
      continue;
    }
    const key = normalizeConceptPhrase(concept.label);
    if (!key) {
      continue;
    }
    const group = groups.get(key) ?? [];
    group.push(concept);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    const [winner, ...duplicates] = [...group].sort(
      (left, right) =>
        Number(Boolean(right.canonicalNoteId)) -
          Number(Boolean(left.canonicalNoteId)) ||
        right.noteIds.length - left.noteIds.length,
    );
    winner.noteIds = unique(group.flatMap((concept) => concept.noteIds));
    winner.aliases = unique(group.flatMap((concept) => concept.aliases));
    const canonicalIds = unique(
      group.flatMap((concept) =>
        concept.canonicalNoteId ? [concept.canonicalNoteId] : [],
      ),
    );
    if (canonicalIds.length === 1) {
      winner.canonicalNoteId = canonicalIds[0];
    } else if (winner.noteIds.length > 1) {
      winner.canonicalNoteId = undefined;
    }
    for (const duplicate of duplicates) {
      duplicate.autoLink = false;
    }
  }
}

function removeAliasesShadowedByLabels(concepts: Concept[]) {
  const labelOwners = new Map<string, EntityId>();
  for (const concept of concepts) {
    const key = normalizeConceptPhrase(concept.label);
    if (key && !labelOwners.has(key)) {
      labelOwners.set(key, concept.id);
    }
  }
  for (const concept of concepts) {
    concept.aliases = unique(concept.aliases).filter((alias) => {
      const owner = labelOwners.get(normalizeConceptPhrase(alias));
      return !owner || owner === concept.id;
    });
  }
}

function phraseVariants(phrase: string): string[] {
  const variants = new Set<string>();
  if (/[‐‑‒–—−-]/.test(phrase)) {
    variants.add(phrase.replace(/[‐‑‒–—−-]+/g, " "));
  }
  if (/[‘’']/.test(phrase)) {
    variants.add(phrase.replace(/[‘’]/g, "'"));
    variants.add(phrase.replace(/'/g, "’"));
  }
  return [...variants].filter(Boolean);
}

function canonicalTitleConceptId(noteId: EntityId): EntityId {
  return `concept_title_${noteId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function phraseConceptId(normalizedPhrase: string): EntityId {
  let hash = 2_166_136_261;
  for (let index = 0; index < normalizedPhrase.length; index += 1) {
    hash ^= normalizedPhrase.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `concept_phrase_${(hash >>> 0).toString(36)}`;
}

function uniqueConceptId(
  preferred: EntityId,
  conceptById: ReadonlyMap<EntityId, Concept>,
): EntityId {
  if (!conceptById.has(preferred)) {
    return preferred;
  }
  let suffix = 2;
  while (conceptById.has(`${preferred}_${suffix}`)) {
    suffix += 1;
  }
  return `${preferred}_${suffix}`;
}

function isUsableTitle(title: string): boolean {
  return (
    isLinkablePhrase(title) &&
    normalizeConceptPhrase(title) !== "untitled note"
  );
}

function nextColor(index: number): string {
  return CONCEPT_COLORS[index % CONCEPT_COLORS.length];
}

function cloneNote(note: Note): Note {
  return {
    ...note,
    aliases: [...note.aliases],
    tags: [...note.tags],
    conceptIds: [...note.conceptIds],
    sourceIds: [...note.sourceIds],
  };
}

function cloneConcept(concept: Concept): Concept {
  return {
    ...concept,
    aliases: [...concept.aliases],
    noteIds: [...concept.noteIds],
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
