import {
  normalizeConceptPhrase,
} from "./concepts";
import { truncateUnicode } from "./text";
import { deleteNoteFromSnapshot } from "./noteDeletion";
import { buildCompactOrganizerContext } from "./organizerContext";
import type {
  AppSnapshot,
  Note,
  OrganizeContentRequest,
  OrganizeContentResult,
  OrganizedWikiArticle,
} from "../types";

const MAX_ORIGIN_CHARS = 24_000;
const MAX_SELECTED_CONTEXT_CHARS = 12_000;
const MAX_SOURCE_CHARS = 56_000;
export const LINKED_ARTICLE_PROVIDER_TIMEOUT_MS = 240_000;
export const LINKED_ARTICLE_WATCHDOG_TIMEOUT_MS = 300_000;
const LINKED_ARTICLE_START_PROGRESS = 12;
const LINKED_ARTICLE_MAX_PENDING_PROGRESS = 94;

export type LinkedArticleJobStage =
  | "gathering"
  | "reading"
  | "writing"
  | "linking"
  | "complete"
  | "error";

export interface LinkedArticleJob {
  id: string;
  workspaceId: string;
  noteId: string;
  originNoteId: string;
  title: string;
  originTitle: string;
  progress: number;
  stage: LinkedArticleJobStage;
  instructions?: string;
  selectedContext?: string;
  error?: string;
}

/**
 * Owns one live request attempt per Space/article pair.
 *
 * Attempt ownership matters when a timed-out request is restarted: the older
 * promise may still settle later, but it must never clear or mutate the newer
 * attempt's queue state.
 */
export class LinkedArticleRequestRegistry {
  private readonly attempts = new Map<string, string>();

  begin(requestKey: string, attemptId: string): boolean {
    if (this.attempts.has(requestKey)) {
      return false;
    }
    this.attempts.set(requestKey, attemptId);
    return true;
  }

  has(requestKey: string): boolean {
    return this.attempts.has(requestKey);
  }

  owns(requestKey: string, attemptId: string): boolean {
    return this.attempts.get(requestKey) === attemptId;
  }

  finish(requestKey: string, attemptId: string): void {
    if (this.owns(requestKey, attemptId)) {
      this.attempts.delete(requestKey);
    }
  }

  cancel(requestKey: string): void {
    this.attempts.delete(requestKey);
  }
}

export function linkedArticleStageLabel(
  stage: LinkedArticleJobStage,
): string {
  switch (stage) {
    case "gathering":
      return "Gathering source context";
    case "reading":
      return "Reading this Space";
    case "writing":
      return "Writing wiki article";
    case "linking":
      return "Connecting related notes";
    case "complete":
      return "Article ready";
    case "error":
      return "Generation paused";
  }
}

export function linkedArticleStageForProgress(
  progress: number,
): LinkedArticleJobStage {
  if (progress < 28) return "gathering";
  if (progress < 52) return "reading";
  if (progress < 82) return "writing";
  if (progress < 100) return "linking";
  return "complete";
}

export function linkedArticleProgressForElapsed(
  elapsedMs: number,
  timeoutMs = LINKED_ARTICLE_PROVIDER_TIMEOUT_MS,
): number {
  const duration = Math.max(1, timeoutMs);
  const ratio = Math.min(1, Math.max(0, elapsedMs) / duration);
  return (
    LINKED_ARTICLE_START_PROGRESS +
    (LINKED_ARTICLE_MAX_PENDING_PROGRESS -
      LINKED_ARTICLE_START_PROGRESS) *
      ratio
  );
}

export async function waitForLinkedArticle<T>(
  request: Promise<T>,
  timeoutMs = LINKED_ARTICLE_WATCHDOG_TIMEOUT_MS,
  providerStarted: Promise<void> = Promise.resolve(),
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  const paused = new Promise<never>((_, reject) => {
    void providerStarted.then(() => {
      if (settled) return;
      timeout = setTimeout(() => {
        reject(
          new Error(
            `Orion paused this article after ${seconds} seconds without a response. Restart it, or delete the unfinished page.`,
          ),
        );
      }, timeoutMs);
    });
  });

  try {
    return await Promise.race([request, paused]);
  } finally {
    settled = true;
    if (timeout) clearTimeout(timeout);
  }
}

export function deleteLinkedArticleDraft(
  snapshot: AppSnapshot,
  job: LinkedArticleJob,
  now: string,
): { snapshot: AppSnapshot; deleted: boolean } {
  if (snapshot.workspace.id !== job.workspaceId) {
    return { snapshot, deleted: false };
  }
  const result = deleteNoteFromSnapshot(snapshot, job.noteId, now, {
    fallbackNoteId: job.originNoteId,
  });
  return { snapshot: result.snapshot, deleted: result.deleted };
}

export function isLinkedArticlePlaceholder(note: Note, phrase: string): boolean {
  const body = note.body.trim();
  const normalized = normalizeConceptPhrase(phrase);
  const hasMatchingTitle =
    normalizeConceptPhrase(note.title) === normalized;
  const normalizedBody = body
    .replace(/<!--\s*orion-link-pending\s*-->/gi, "")
    .replace(/<!--\s*orion-link-draft\s*-->/gi, "")
    .replace(/^>\s?/gm, "")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  const hasOnlyDraftMessage =
    /^Orion is (?:writing|drafting) this article from .+?, its sources, and the active Space\.?$/i.test(
      normalizedBody,
    );
  const isCurrentPlaceholder =
    hasMatchingTitle &&
    (note.tags.includes("orion-link-pending") ||
      note.tags.includes("orion-link-draft")) &&
    hasOnlyDraftMessage;
  const isLegacyPlaceholder =
    !body &&
    hasMatchingTitle &&
    [
      `A Space article for ${phrase}.`,
      `Orion is preparing a Space article for ${phrase}.`,
    ].some(
      (summary) =>
        normalizeConceptPhrase(note.summary) ===
        normalizeConceptPhrase(summary),
    );
  const isBlankWikiDraft =
    !body &&
    hasMatchingTitle &&
    note.kind === "wiki" &&
    !note.summary.trim();

  return (
    isCurrentPlaceholder ||
    isLegacyPlaceholder ||
    isBlankWikiDraft
  );
}

export function buildLinkedArticleRequest(
  snapshot: AppSnapshot,
  originNote: Note,
  phrase: string,
  customInstructions = "",
  selectedContext = "",
): OrganizeContentRequest {
  const directSources = originNote.sourceIds
    .map((sourceId) =>
      snapshot.sources.find((source) => source.id === sourceId),
    )
    .filter((source): source is AppSnapshot["sources"][number] =>
      Boolean(source),
    );
  const sourceSections: string[] = [];
  let sourceBudget = MAX_SOURCE_CHARS;
  for (const source of directSources) {
    if (sourceBudget <= 0) break;
    const excerpt = source.text.slice(0, sourceBudget).trim();
    if (!excerpt) continue;
    sourceSections.push(`### ${source.title}\n${excerpt}`);
    sourceBudget -= excerpt.length;
  }

  const linkedTask = [
    `Linked-article task: create exactly one canonical wiki article titled “${phrase}”.`,
    `The article was requested from the note “${originNote.title}”. Ground its source-specific details in that note and its direct sources, then explain why the subject matters in the Space “${snapshot.workspace.name}”.`,
    "This is a user-created link page, so write a definitional wiki article rather than an import summary. Return the requested article in wikiArticles and a matching canonical concept. Its body must be one coherent, ready-to-read article: weave source context into the relevant explanation instead of adding sections named “Context from”, “From the linked source”, or other provenance/change-log headings. Do not create unrelated project notes or unrelated wiki articles. Use ordinary readable prose, never [[wiki-link]] brackets. Clearly preserve uncertainty when the supplied material is incomplete.",
  ].join(" ");
  const pageInstructions = truncateUnicode(customInstructions.trim(), 1_250);
  const focusedContext = truncateUnicode(
    selectedContext.trim(),
    MAX_SELECTED_CONTEXT_CHARS,
  );

  return {
    content: [
      `Linked phrase: ${phrase}`,
      `Origin note: ${originNote.title}`,
      originNote.summary
        ? `Origin summary: ${originNote.summary}`
        : "",
      focusedContext
        ? `Selected context for this link (give this passage special weight while keeping the article coherent):\n${focusedContext}`
        : "",
      `Origin note body:\n${originNote.body.slice(0, MAX_ORIGIN_CHARS)}`,
      sourceSections.length
        ? `Direct source material:\n\n${sourceSections.join("\n\n")}`
        : "Direct source material: none attached; rely on the origin note and bounded Space context.",
    ]
      .filter(Boolean)
      .join("\n\n"),
    sourceName: `Link created in ${originNote.title}`,
    spaceName: snapshot.workspace.name,
    spaceDescription: snapshot.workspace.description,
    existingNotes: buildCompactOrganizerContext(snapshot, {
      focusNoteIds: [originNote.id],
      excludeNoteIds: [originNote.id],
      matchText: [
        phrase,
        pageInstructions,
        focusedContext,
        originNote.title,
        originNote.summary,
        originNote.body,
      ].join("\n"),
    }),
    model: snapshot.settings.model,
    effort: snapshot.settings.reasoningEffort,
    timeoutMs: LINKED_ARTICLE_PROVIDER_TIMEOUT_MS,
    taskInstructions: [
      linkedTask,
      pageInstructions
        ? `User instruction for this specific page:\n${pageInstructions}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    organizationInstructions: snapshot.settings.organizationInstructions,
  };
}

export function applyLinkedArticleResult(
  note: Note,
  result: OrganizeContentResult,
  phrase: string,
  spaceName: string,
  now: string,
): Note {
  const normalizedPhrase = normalizeConceptPhrase(phrase);
  const article =
    result.wikiArticles.find(
      (candidate) =>
        normalizeConceptPhrase(candidate.title) === normalizedPhrase,
    ) ?? result.wikiArticles[0];
  const organizedNote =
    result.notes.find(
      (candidate) =>
        normalizeConceptPhrase(candidate.title) === normalizedPhrase,
    ) ?? result.notes[0];

  if (!article && !organizedNote) {
    throw new Error("Orion did not return an article for this link.");
  }

  const summary =
    article?.summary.trim() ||
    organizedNote?.summary.trim() ||
    note.summary;
  const body = article
    ? article.body.trim() || linkedWikiArticleBody(article, spaceName)
    : organizedNote?.body.trim() || note.body;
  const aliases = unique([
    ...note.aliases,
    ...(article?.aliases ?? organizedNote?.aliases ?? []),
  ]).filter(
    (alias) =>
      normalizeConceptPhrase(alias) !== normalizeConceptPhrase(note.title),
  );
  const tags = unique([
    ...note.tags.filter(
      (tag) =>
        tag !== "orion-link-pending" &&
        tag !== "orion-link-draft" &&
        tag !== "wiki-article" &&
        tag !== "ai-draft",
    ),
    ...(article?.tags ?? organizedNote?.tags ?? []),
  ]);

  return {
    ...note,
    title: phrase,
    summary,
    body,
    aliases: aliases.slice(0, 16),
    tags: tags.slice(0, 12),
    kind: "wiki",
    status: "ready",
    updatedAt: now,
  };
}

function linkedWikiArticleBody(
  article: OrganizedWikiArticle,
  spaceName: string,
): string {
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

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
