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
import { buildCompactOrganizerContext } from "./organizerContext";

const MAX_NOTE_CHARS = 48_000;
const TASK_LINE = /^\s*[-+*]\s+\[[ xX]\]\s+(.+?)\s*$/;
const COMPANION_TITLE_WORDS = new Set([
  "agenda",
  "checklist",
  "journal",
  "list",
  "log",
  "note",
  "notes",
  "overview",
  "plan",
  "summary",
  "task",
  "tasks",
  "todo",
  "todos",
]);
const TITLE_GLUE_WORDS = new Set(["a", "an", "go", "my", "our", "the"]);
const CONTENT_STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "article",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "note",
  "notes",
  "that",
  "the",
  "their",
  "this",
  "through",
  "was",
  "were",
  "wiki",
  "with",
]);

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
  const existingNotes = buildCompactOrganizerContext(snapshot, {
    focusNoteIds: [note.id],
    excludeNoteIds: [note.id],
    matchText: [note.title, note.summary, note.body].join("\n"),
  });
  const task = [
    "Knowledge-refresh task: this is an already-saved project note, so return an empty notes array.",
    "Return a wikiArticles entry for every durable person, place, technology, method, organization, or idea in this note that gains meaningful new context.",
    "The supplied existing notes are compact directory records, not opened article bodies. Use them to reuse canonical titles and avoid duplicates, but do not return or rewrite a bodyless existing article. Return a new canonical article only for a clearly important durable subject, never for a relabelled version, summary, plan, list, checklist, or paraphrase of this source note.",
    "Never append a provenance section named “Context from”, “From the new note”, “From the imported material”, or similar.",
    "Keep every action and Markdown task in this project note; never copy its task list into a wiki article. Infer concepts from meaning, relationships, and aliases rather than keyword frequency. Do not return generic topic words, unrelated articles, or concepts supported only by lexical overlap. Source-grounded details must come from this note. Use ordinary prose and never [[wiki-link]] brackets.",
  ].join(" ");
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
    taskInstructions: task,
    organizationInstructions: snapshot.settings.organizationInstructions,
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

    const preparedArticle = withoutDerivedTasks(article, originNote);
    const existing = resolveCanonicalArticle(
      { ...snapshot, notes },
      title,
    );
    if (existing) {
      // An automatic refresh can enrich a dedicated canonical article, but it
      // must never reinterpret or overwrite the project note that triggered it
      // (or another ordinary human-authored note with a matching title).
      if (existing.id === originNote.id || existing.kind !== "wiki") {
        continue;
      }
      const index = notes.findIndex((note) => note.id === existing.id);
      if (index < 0) continue;
      notes[index] = mergeNoteContext(
        notes[index],
        preparedArticle,
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

    if (isRedundantCompanionArticle(article, originNote)) {
      continue;
    }

    const noteId = `note-${nanoid(10)}`;
    const created: Note = {
      id: noteId,
      title,
      slug: uniqueSlug(title, notes),
      summary: preparedArticle.summary.trim(),
      body: wikiArticleBody(preparedArticle, snapshot.workspace.name),
      aliases: unique(preparedArticle.aliases).slice(0, 16),
      tags: unique(preparedArticle.tags).slice(0, 12),
      kind: "wiki",
      status: "ready",
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
    (note.tags.includes("orion-link-pending") ||
      note.tags.includes("orion-link-draft")) &&
    (currentBody.includes("<!-- orion-link-pending -->") ||
      currentBody.includes("<!-- orion-link-draft -->"));
  const body =
    article.body.trim() ||
    (!currentBody || isLinkPlaceholder
      ? wikiArticleBody(article, spaceName)
      : currentBody);

  return {
    ...note,
    summary:
      !note.summary.trim() ||
      note.summary.startsWith("Orion is preparing a Space article for ") ||
      note.summary.startsWith("Orion is writing a Space article for ")
        ? article.summary.trim()
        : note.summary,
    body,
    aliases: unique([...note.aliases, ...article.aliases]).slice(0, 16),
    tags: unique([
      ...note.tags.filter(
        (tag) =>
          tag !== "orion-link-pending" &&
          tag !== "orion-link-draft" &&
          tag !== "ai-draft" &&
          tag !== "wiki-article",
      ),
      ...article.tags,
    ]).slice(0, 12),
    kind: "wiki",
    status: note.status === "archived" ? "archived" : "ready",
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

function withoutDerivedTasks(
  article: OrganizedWikiArticle,
  originNote: Note,
): OrganizedWikiArticle {
  const originTasks = markdownTaskFingerprints(originNote.body);
  if (originTasks.size === 0) {
    return article;
  }

  return {
    ...article,
    body: removeMatchingTaskLines(article.body, originTasks),
    sourceGroundedDetails: article.sourceGroundedDetails.filter(
      (detail) => !originTasks.has(taskFingerprint(detail)),
    ),
  };
}

function isRedundantCompanionArticle(
  article: OrganizedWikiArticle,
  originNote: Note,
): boolean {
  if (
    normalizeConceptPhrase(article.title) ===
    normalizeConceptPhrase(originNote.title)
  ) {
    return true;
  }

  if (looksLikeRelabelledCompanion(article.title, originNote.title)) {
    return true;
  }

  const originTasks = markdownTaskFingerprints(originNote.body);
  if (originTasks.size > 0) {
    const copiedTask = [
      ...markdownTaskFingerprints(article.body),
      ...article.sourceGroundedDetails.map(taskFingerprint),
    ].some((task) => originTasks.has(task));
    if (copiedTask) {
      return true;
    }
  }

  return isNearTextDuplicate(
    `${originNote.title}\n${originNote.summary}\n${originNote.body}`,
    `${article.title}\n${article.summary}\n${article.body}`,
  );
}

function looksLikeRelabelledCompanion(
  articleTitle: string,
  originTitle: string,
): boolean {
  const articleTokens = words(articleTitle);
  if (!articleTokens.some((word) => COMPANION_TITLE_WORDS.has(word))) {
    return false;
  }
  const articleSubject = articleTokens.filter(
    (word) =>
      !COMPANION_TITLE_WORDS.has(word) && !TITLE_GLUE_WORDS.has(word),
  );
  if (articleSubject.length === 0) {
    return true;
  }
  const originTokens = new Set(
    words(originTitle).filter((word) => !TITLE_GLUE_WORDS.has(word)),
  );
  return articleSubject.every((word) => originTokens.has(word));
}

function markdownTaskFingerprints(markdown: string): Set<string> {
  const tasks = new Set<string>();
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const task = line.match(TASK_LINE)?.[1];
    if (task) tasks.add(taskFingerprint(task));
  }
  return tasks;
}

function removeMatchingTaskLines(
  markdown: string,
  originTasks: ReadonlySet<string>,
): string {
  const lines = markdown.split(/\r?\n/);
  let inFence = false;
  const withoutTasks = lines.filter((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return true;
    }
    if (inFence) return true;
    const task = line.match(TASK_LINE)?.[1];
    return !task || !originTasks.has(taskFingerprint(task));
  });
  const withoutEmptyHeadings = withoutTasks.filter((line, index) => {
    if (!/^#{1,6}\s+\S/.test(line)) return true;
    let next = index + 1;
    while (next < withoutTasks.length && !withoutTasks[next].trim()) {
      next += 1;
    }
    return (
      next < withoutTasks.length &&
      !/^#{1,6}\s+\S/.test(withoutTasks[next])
    );
  });
  return withoutEmptyHeadings.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function taskFingerprint(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/[`*_~]/g, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isNearTextDuplicate(left: string, right: string): boolean {
  const leftTokens = contentTokens(left);
  const rightTokens = contentTokens(right);
  if (leftTokens.size < 6 || rightTokens.size < 6) {
    return false;
  }
  let shared = 0;
  leftTokens.forEach((token) => {
    if (rightTokens.has(token)) shared += 1;
  });
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  const larger = Math.max(leftTokens.size, rightTokens.size);
  return shared / smaller >= 0.82 && larger / smaller <= 1.5;
}

function contentTokens(value: string): Set<string> {
  return new Set(
    words(value).filter(
      (word) => word.length > 2 && !CONTENT_STOP_WORDS.has(word),
    ),
  );
}

function words(value: string): string[] {
  return (
    value
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
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
