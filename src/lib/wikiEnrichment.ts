import { nanoid } from "nanoid";
import { slugifyTitle } from "../data/defaults";
import type {
  AppSnapshot,
  EntityId,
  Note,
  OrganizeContentRequest,
  OrganizeContentResult,
  OrganizedWikiArticle,
} from "../types";
import {
  normalizeConceptPhrase,
  reconcileConceptVocabulary,
  type ConceptSeed,
} from "./concepts";

const MAX_NOTE_CHARS = 48_000;
const MAX_EXISTING_NOTES = 80;

export interface WikiEnrichmentApplyResult {
  snapshot: AppSnapshot;
  updatedNoteIds: EntityId[];
  createdNoteIds: EntityId[];
}

export function hasSubstantiveKnowledgeNote(note: Note): boolean {
  if (note.kind === "wiki" || note.title.trim() === "Untitled note") {
    return false;
  }
  const plainBody = note.body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/[#>*_`~[\]()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${note.title.trim()} ${note.summary.trim()} ${plainBody}`.trim()
    .length >= 48;
}

export function buildWikiEnrichmentRequest(
  snapshot: AppSnapshot,
  note: Note,
): OrganizeContentRequest {
  const existingNotes = snapshot.settings.includeExistingNotesInAIContext
    ? [...snapshot.notes]
        .filter((candidate) => candidate.id !== note.id)
        .sort(
          (left, right) =>
            Number(right.kind === "wiki") - Number(left.kind === "wiki"),
        )
        .slice(0, MAX_EXISTING_NOTES)
        .map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          aliases: [...candidate.aliases],
          summary: candidate.summary,
          kind: candidate.kind,
          ...(candidate.kind === "wiki"
            ? { body: candidate.body.slice(0, 6_000) }
            : {}),
        }))
    : undefined;
  const task = [
    "Knowledge-refresh task: this is an already-saved project note, so return an empty notes array.",
    "Return a wikiArticles entry for every durable person, place, technology, method, organization, or idea in this note that gains meaningful new context.",
    "Include every supplied existing canonical wiki article that should be enriched by this note, even when that article already has a body. Also return a canonical article for a clearly important durable concept that does not exist yet.",
    "For each returned existing article, rewrite wikiArticles.body as a complete coherent revision that preserves worthwhile existing knowledge and cross-pollinates the new material into the sections where it naturally belongs. Never append a provenance section named “Context from”, “From the new note”, “From the imported material”, or similar.",
    "Infer concepts from meaning, relationships, and aliases rather than keyword frequency. Do not return generic topic words, unrelated articles, or concepts supported only by lexical overlap. Source-grounded details must come from this note. Use ordinary prose and never [[wiki-link]] brackets.",
  ].join(" ");
  const userInstructions = snapshot.settings.organizationInstructions
    .trim()
    .slice(0, 1_250);

  return {
    content: [
      `New note title: ${note.title}`,
      note.summary ? `New note summary: ${note.summary}` : "",
      `New note body:\n${note.body.slice(0, MAX_NOTE_CHARS)}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    sourceName: `New note: ${note.title}`,
    spaceName: snapshot.workspace.name,
    spaceDescription: snapshot.workspace.description,
    existingNotes,
    model: snapshot.settings.model,
    effort: snapshot.settings.reasoningEffort,
    organizationInstructions: [task, userInstructions]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function applyWikiEnrichmentResult(
  snapshot: AppSnapshot,
  originNote: Note,
  result: OrganizeContentResult,
  now: string,
): WikiEnrichmentApplyResult {
  const notes = snapshot.notes.map(cloneNote);
  const updatedNoteIds: EntityId[] = [];
  const createdNoteIds: EntityId[] = [];
  const articleNoteIdByTitle = new Map<string, EntityId>();
  const articles = uniqueArticles(result.wikiArticles);

  for (const article of articles) {
    const title = article.title.trim();
    if (!title) continue;

    const existing = resolveCanonicalArticle(
      { ...snapshot, notes },
      title,
    );
    if (existing) {
      const index = notes.findIndex((note) => note.id === existing.id);
      if (index < 0) continue;
      notes[index] = mergeNoteContext(
        notes[index],
        article,
        originNote,
        snapshot.workspace.name,
        now,
      );
      updatedNoteIds.push(existing.id);
      articleNoteIdByTitle.set(
        normalizeConceptPhrase(title),
        existing.id,
      );
      continue;
    }

    const noteId = `note-${nanoid(10)}`;
    const created: Note = {
      id: noteId,
      title,
      slug: uniqueSlug(title, notes),
      summary: article.summary.trim(),
      body: wikiArticleBody(article, snapshot.workspace.name),
      aliases: unique(article.aliases).slice(0, 16),
      tags: unique([...article.tags, "wiki-article", "ai-draft"]).slice(
        0,
        12,
      ),
      kind: "wiki",
      status: "draft",
      conceptIds: [],
      sourceIds: [...originNote.sourceIds],
      createdAt: now,
      updatedAt: now,
      color: "#8798ff",
    };
    notes.unshift(created);
    createdNoteIds.push(noteId);
    articleNoteIdByTitle.set(normalizeConceptPhrase(title), noteId);
  }

  const seeds: ConceptSeed[] = result.concepts.flatMap((concept) => {
    const noteId = articleNoteIdByTitle.get(
      normalizeConceptPhrase(concept.canonicalTitle),
    );
    if (!noteId) return [];
    return [
      {
        label: concept.label,
        aliases: concept.aliases,
        description: concept.description,
        noteIds: [noteId],
        canonicalNoteId: noteId,
      },
    ];
  });
  const vocabulary = reconcileConceptVocabulary(
    notes,
    snapshot.concepts,
    seeds,
  );

  return {
    snapshot: {
      ...snapshot,
      notes: vocabulary.notes,
      concepts: vocabulary.concepts,
      updatedAt: now,
    },
    updatedNoteIds: unique(updatedNoteIds),
    createdNoteIds: unique(createdNoteIds),
  };
}

function resolveCanonicalArticle(
  snapshot: AppSnapshot,
  title: string,
): Note | undefined {
  const key = normalizeConceptPhrase(title);
  const conceptMatches = snapshot.concepts
    .filter(
      (concept) =>
        normalizeConceptPhrase(concept.label) === key ||
        concept.aliases.some(
          (alias) => normalizeConceptPhrase(alias) === key,
        ),
    )
    .flatMap((concept) =>
      concept.canonicalNoteId ? [concept.canonicalNoteId] : [],
    );
  const canonicalIds = unique(conceptMatches);
  if (canonicalIds.length === 1) {
    return snapshot.notes.find((note) => note.id === canonicalIds[0]);
  }
  const exact = snapshot.notes.filter(
    (note) => normalizeConceptPhrase(note.title) === key,
  );
  return exact.length === 1 ? exact[0] : undefined;
}

function mergeNoteContext(
  note: Note,
  article: OrganizedWikiArticle,
  originNote: Note,
  spaceName: string,
  now: string,
): Note {
  const currentBody = note.body.trim();
  const isLinkPlaceholder =
    note.tags.includes("orion-link-draft") &&
    currentBody.includes("<!-- orion-link-draft -->");
  const body =
    article.body.trim() ||
    (!currentBody || isLinkPlaceholder
      ? wikiArticleBody(article, spaceName)
      : currentBody);

  return {
    ...note,
    summary:
      !note.summary.trim() ||
      note.summary.startsWith("Orion is preparing a Space article for ")
        ? article.summary.trim()
        : note.summary,
    body,
    aliases: unique([...note.aliases, ...article.aliases]).slice(0, 16),
    tags: unique([
      ...note.tags.filter((tag) => tag !== "orion-link-draft"),
      ...article.tags,
      "wiki-article",
      "ai-draft",
    ]).slice(0, 12),
    kind: "wiki",
    status: note.status === "archived" ? "archived" : "draft",
    sourceIds: unique([...note.sourceIds, ...originNote.sourceIds]),
    updatedAt: now,
  };
}

function wikiArticleBody(
  article: OrganizedWikiArticle,
  spaceName: string,
): string {
  if (article.body.trim()) {
    return article.body.trim();
  }
  const details = unique(article.sourceGroundedDetails)
    .map((detail) => `- ${detail}`)
    .join("\n");
  const uncertainties = unique(article.uncertainties)
    .map((uncertainty) => `- ${uncertainty}`)
    .join("\n");
  return [
    "## Overview",
    article.overview.trim(),
    `## In ${spaceName.trim() || "this Space"}`,
    article.spaceRelevance.trim(),
    details ? "## Details" : "",
    details,
    uncertainties ? "## Uncertainties" : "",
    uncertainties,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function uniqueArticles(
  articles: readonly OrganizedWikiArticle[],
): OrganizedWikiArticle[] {
  const seen = new Set<string>();
  return articles.filter((article) => {
    const key = normalizeConceptPhrase(article.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueSlug(title: string, notes: readonly Note[]): string {
  const base = slugifyTitle(title) || "article";
  const reserved = new Set(notes.map((note) => note.slug));
  let slug = base;
  let suffix = 2;
  while (reserved.has(slug)) {
    slug = `${base}-${suffix}`;
    suffix += 1;
  }
  return slug;
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

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
