import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  AlertTriangle,
  AudioLines,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  FileText,
  Files,
  Link2,
  LoaderCircle,
  PenLine,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "../lib/icons";
import { nanoid } from "nanoid";
import clsx from "clsx";
import {
  reconcileConceptVocabulary,
  existingCanonicalPhraseDestinations,
  normalizeConceptPhrase,
  type ConceptSeed,
} from "../lib/concepts";
import {
  detectSourceKind,
  IMPORT_ACCEPT,
  parseImportFiles,
} from "../lib/files";
import {
  isTauriRuntime,
  createFailoverKnowledgeDriver,
  createKnowledgeReadingCache,
  fetchWebPage,
  preflightKnowledgeProvider,
  organizeWithAI,
  recognizeDocumentText,
  transcribeMediaFiles,
  transcribeYouTube,
} from "../lib/storage";
import { partitionImportSourcesForSynthesis } from "../lib/importBatching";
import {
  buildCompactOrganizerContext,
  mergeGeneratedOrganizerArticles,
} from "../lib/organizerContext";
import {
  autoResumeBackoffMs,
  isTransientProviderFailure,
  shouldAutoResume,
} from "../lib/providerHealth";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "../lib/ai";
import { visibleNoteTags } from "../lib/noteMetadata";
import {
  buildLongDocumentSynthesis,
  longDocumentSectionInstructions,
  longDocumentSynthesisInstructions,
  mapLongDocumentSections,
  relevantExistingNotesForSynthesis,
  splitDocumentForParallelReading,
} from "../lib/longDocumentImport";
import { truncateUnicode } from "../lib/text";
import { transcriptToParsedImport } from "../lib/transcription";
import type {
  AppSnapshot,
  Concept,
  EntityId,
  Note,
  OrganizeContentResult,
  OrganizedNote,
  OrganizedWikiArticle,
  ParsedImport,
  Relationship,
  RelationshipKind,
  Source,
  TranscribedMedia,
  WhisperConfig,
} from "../types";
import type {
  KnowledgeResultProvenance,
  KnowledgeTelemetry,
} from "../lib/knowledgeOrchestration/protocol";
import {
  stableSnapshotVersion,
} from "../lib/knowledgeOrchestration/context";
import {
  createKnowledgeImportRunError,
  KnowledgeImportRunError,
  landFailedKnowledgeImport,
  runKnowledgeImportBatch,
  snapshotStillMatchesImportBase,
  type KnowledgeImportBatchResult,
  type KnowledgeImportDiagnostic,
} from "../lib/knowledgeOrchestration/import";
import type { FixedBlueprintImportCheckpoint } from "../lib/knowledgeOrchestration/blueprintImport";

const MAX_FILES = 12;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_AI_CHARS_PER_SOURCE = 60_000;
const MAX_MANUAL_CHARS_PER_SOURCE = 200_000;
const MAX_TOTAL_GENERATED_NOTES = 30;
const MAX_IMPORT_GUIDANCE_CHARS = 1_000;
const MEDIA_ACCEPT =
  ".flac,.m4a,.mp3,.mp4,.mpeg,.mpga,.ogg,.wav,.webm,audio/*,video/mp4,video/webm";
type ImportStage = "add" | "review" | "organizing" | "results";
type ImportMode = "ai" | "manual";
type ItemStatus = "parsing" | "ready" | "error";

export interface ImportItem {
  id: EntityId;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: ItemStatus;
  included: boolean;
  parsed?: ParsedImport;
  error?: string;
  dedupeKey?: string;
  preprocessLabel?: string;
}

export type ImportUrlKind = "youtube" | "webpage";

export interface ClassifiedImportUrl {
  kind: ImportUrlKind;
  url: string;
}

interface OrganizeIssue {
  itemId: EntityId;
  fileName: string;
  message: string;
  usedManualFallback: boolean;
}

export interface OrganizedSource {
  item: ImportItem;
  result?: OrganizeContentResult;
  provenance?: KnowledgeResultProvenance[];
}

interface OrganizeProgress {
  sourceIndex: number;
  sourceTotal: number;
  sourceTitle: string;
  phase: "source" | "sections" | "synthesis" | "orchestration";
  completedSections: number;
  sectionTotal: number;
  operationLabel?: string;
  detailLabel?: string;
  orchestrationStage?: "direct" | ImportPipelineStage;
}

type ImportPipelineStage = NonNullable<KnowledgeTelemetry["pipelineStage"]>;
type UserFacingImportStage = "direct" | ImportPipelineStage;

const INTERNAL_KNOWLEDGE_DIAGNOSTIC =
  /\b(?:assignments?|artifacts?(?:\s+ids?)?|blueprints?|parsers?|payloads?|schemas?|writer\s+slots?)\b|\b(?:artifact|assignment|output|reader|writer|slot)[:_-][a-z0-9][\w:.-]*/i;

const EMPTY_ORGANIZE_PROGRESS: OrganizeProgress = {
  sourceIndex: 0,
  sourceTotal: 0,
  sourceTitle: "",
  phase: "source",
  completedSections: 0,
  sectionTotal: 0,
};

export function progressFromKnowledgeTelemetry(
  telemetry: KnowledgeTelemetry,
  sourceTotal: number,
  sourceTitle: string,
): OrganizeProgress {
  const sourceSummaryTotal = telemetry.sourceSummaryTotal ?? 0;
  const sourceSummaryCompleted = telemetry.sourceSummaryCompleted ?? 0;
  const spaceSummaryTotal = telemetry.spaceSummaryTotal ?? 0;
  const spaceSummaryCompleted = telemetry.spaceSummaryCompleted ?? 0;
  const primitives = new Set(telemetry.currentPrimitives);
  const readingInParallel =
    sourceSummaryTotal > 0 ||
    spaceSummaryTotal > 0 ||
    telemetry.physicalWidth > 1 ||
    primitives.has("fan_out") ||
    primitives.has("re_expand");
  const orchestrationStage =
    telemetry.pipelineStage ??
    (telemetry.phase === "finalizing"
      ? "assembling"
      : readingInParallel
        ? "reading"
        : "direct");
  const combinedReadingTotal = sourceSummaryTotal + spaceSummaryTotal;
  const combinedReadingCompleted =
    sourceSummaryCompleted + spaceSummaryCompleted;
  const readingTotal = Math.max(
    telemetry.readingTotal ?? 0,
    combinedReadingTotal,
  );
  const readingCompleted = Math.min(
    readingTotal,
    Math.max(telemetry.readingCompleted ?? 0, combinedReadingCompleted),
  );
  const writingTotal = telemetry.writingTotal ?? telemetry.writeWidth;
  const writingCompleted = telemetry.writingCompleted ?? 0;
  const operationLabel =
    orchestrationStage === "reading-plan"
      ? "Orion is mapping what to look for"
      : orchestrationStage === "reading"
        ? "Orion is reading every part"
        : orchestrationStage === "writing-plan"
          ? "Orion is deciding what belongs together"
          : orchestrationStage === "writing"
            ? `Orion is preparing ${Math.max(writingTotal, 1)} connected ${writingTotal === 1 ? "note" : "notes"}`
            : orchestrationStage === "assembling"
              ? "Orion is connecting and checking the notes"
              : primitives.has("validate")
                ? "Checking sources and links"
                : primitives.has("re_evaluate")
                  ? "Revisiting a finding"
                  : "Orion is shaping your notes";
  const currentAccepted =
    telemetry.activeAssignments +
    telemetry.waitingAssignments +
    telemetry.completedAssignments +
    telemetry.failedAssignments;
  const parallelSummaryParts = [
    ...(sourceSummaryTotal > 0
      ? [`${sourceSummaryCompleted} of ${sourceSummaryTotal} section summaries ready`]
      : []),
    ...(spaceSummaryTotal > 0
      ? [`${spaceSummaryCompleted} of ${spaceSummaryTotal} Space readings ready`]
      : []),
  ];
  const synthesisSummaryLabel =
    sourceSummaryTotal > 0
      ? `${sourceSummaryCompleted} ${sourceSummaryCompleted === 1 ? "section summary" : "section summaries"} ready`
      : spaceSummaryTotal > 0
        ? `${spaceSummaryCompleted} ${spaceSummaryCompleted === 1 ? "Space reading" : "Space readings"} ready`
        : `${telemetry.completedAssignments} ${telemetry.completedAssignments === 1 ? "reading" : "readings"} ready`;
  const detailLabel =
    orchestrationStage === "reading-plan"
      ? "Using this Space to guide the reading"
      : orchestrationStage === "reading"
        ? readingTotal > 0
          ? `${Math.min(readingCompleted, readingTotal)} of ${readingTotal} readings ready`
          : `${parallelSummaryParts.length > 0 ? `${parallelSummaryParts.join(" · ")} · ` : ""}${telemetry.physicalWidth} ${telemetry.physicalWidth === 1 ? "reading" : "readings"} active`
        : orchestrationStage === "writing-plan"
          ? `${synthesisSummaryLabel} · planning what is relevant and new`
          : orchestrationStage === "writing"
            ? `${Math.min(writingCompleted, writingTotal)} of ${Math.max(writingTotal, 1)} ready`
            : orchestrationStage === "assembling"
              ? "Checking sources, links, and repeated material"
              : telemetry.completedAssignments > 0
                ? `${telemetry.completedAssignments} of ${Math.max(currentAccepted, telemetry.completedAssignments)} readings ready`
                : telemetry.physicalWidth > 0
                  ? "Reading the source in one pass"
                  : "Preparing the direct reading";
  return {
    sourceIndex: 0,
    sourceTotal,
    sourceTitle,
    phase: "orchestration",
    completedSections: telemetry.completedAssignments,
    sectionTotal: currentAccepted,
    operationLabel,
    detailLabel,
    orchestrationStage,
  };
}

export function orchestrationEyebrow(
  stage: OrganizeProgress["orchestrationStage"],
) {
  switch (stage) {
    case "reading-plan":
      return "Preparing the reading";
    case "reading":
      return "Reading in parallel";
    case "writing-plan":
      return "Planning the notes";
    case "writing":
      return "Writing in parallel";
    case "assembling":
      return "Final checks";
    default:
      return "Organizing";
  }
}

export function orchestrationReassurance(
  stage: OrganizeProgress["orchestrationStage"],
  hasSpaceOrientation = true,
) {
  switch (stage) {
    case "reading-plan":
      return hasSpaceOrientation
        ? "Across this Space is guiding what Orion looks for."
        : "Orion is preparing the source reading.";
    case "reading":
      return "Every planned part is read before note writing begins.";
    case "writing-plan":
      return "The completed readings become one coherent note plan.";
    case "writing":
      return "Connected notes are prepared together from the shared plan.";
    case "assembling":
      return "The final pass checks connections, sources, and repeated material.";
    default:
      return "Short imports skip unnecessary parallel reading.";
  }
}

interface GeneratedNoteContext {
  note: Note;
  contributions: Array<{
    sourceId: EntityId;
    organized: OrganizedNote | OrganizedWikiArticle;
  }>;
}

/**
 * `notes` and `concepts` are upsert collections. Existing canonical articles
 * keep their IDs while receiving merged source context and vocabulary.
 */
export interface ImportStudioApplyPayload {
  notes: Note[];
  sources: Source[];
  concepts: Concept[];
  relationships: Relationship[];
  baseSnapshotVersion?: string;
}

export interface ImportStudioProps {
  open: boolean;
  snapshot: AppSnapshot;
  onClose: () => void;
  onApply: (
    payload: ImportStudioApplyPayload,
  ) => void | Promise<void>;
}

const STAGES: ReadonlyArray<{
  id: ImportStage;
  shortLabel: string;
  label: string;
}> = [
  { id: "add", shortLabel: "01", label: "Add" },
  { id: "review", shortLabel: "02", label: "Review" },
  { id: "organizing", shortLabel: "03", label: "Organize" },
  { id: "results", shortLabel: "04", label: "Results" },
];

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return "Orion could not read this source.";
}

function reportKnowledgeImportDiagnostic(
  context: string,
  diagnostic: unknown,
) {
  console.warn(`[Orion import] ${context}`, diagnostic);
}

function isKnowledgeImportRunError(error: unknown): error is KnowledgeImportRunError {
  return (
    error instanceof KnowledgeImportRunError ||
    (error instanceof Error &&
      error.name === "KnowledgeImportRunError" &&
      "diagnostic" in error &&
      typeof error.diagnostic === "object" &&
      error.diagnostic !== null)
  );
}

function waitForAutoResumeBackoff(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function diagnosticStageLabel(
  stage: KnowledgeImportDiagnostic["stage"],
): string {
  switch (stage) {
    case "reading-plan":
      return "Preparing the reading";
    case "reading":
      return "Reading source material";
    case "writing-plan":
      return "Planning the notes";
    case "writing":
      return "Writing the notes";
    case "assembling":
      return "Final checks";
    default:
      return "Direct import";
  }
}

function diagnosticProgressText(
  diagnostic: KnowledgeImportDiagnostic,
): string {
  if (diagnostic.stage === "reading" && diagnostic.totalReadings > 0) {
    return `${diagnostic.completedReadings} of ${diagnostic.totalReadings} completed readings retained`;
  }
  if (
    (diagnostic.stage === "writing" || diagnostic.stage === "assembling") &&
    diagnostic.totalWrites > 0
  ) {
    return `${diagnostic.completedWrites} of ${diagnostic.totalWrites} completed notes retained`;
  }
  if (diagnostic.stage === "writing-plan" && diagnostic.completedReadings > 0) {
    return `${diagnostic.completedReadings} completed readings retained`;
  }
  return diagnostic.resumable
    ? "Completed work is retained for Resume"
    : "A fresh retry will start from the source";
}

export function knowledgeImportFailureMessage(
  error: unknown,
  stage: UserFacingImportStage,
): string {
  const diagnostic = errorMessage(error);
  if (/This Space changed while Orion was reading/i.test(diagnostic)) {
    return "This Space changed while Orion was reading, so these notes were not applied.";
  }

  switch (stage) {
    case "reading-plan":
      return "Orion could not finish preparing the reading.";
    case "reading":
      return "Orion could not finish reading every part of this import.";
    case "writing-plan":
      return "Orion finished the reading but could not complete the note plan.";
    case "writing":
      return "Orion finished the reading but could not complete every planned note.";
    case "assembling":
      return "Orion prepared the notes but could not finish the final checks.";
    default:
      return "Orion could not finish shaping these notes.";
  }
}

function userFacingKnowledgeWarning(
  warning: string,
  stage: UserFacingImportStage,
): string {
  if (!INTERNAL_KNOWLEDGE_DIAGNOSTIC.test(warning)) return warning;

  reportKnowledgeImportDiagnostic("A hidden pipeline warning was reported", warning);
  if (stage === "reading-plan" || stage === "reading") {
    return "Orion completed the import after narrowing part of the reading.";
  }
  if (stage === "writing-plan" || stage === "writing") {
    return "Orion completed the import with a smaller set of connected notes.";
  }
  if (stage === "assembling") {
    return "Orion completed the import after resolving a note consistency issue.";
  }
  return "Orion completed the import with a minor quality warning.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  }
  if (bytes >= 1_073_741_824) {
    return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  }
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function slugBase(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "untitled";
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

export function classifyImportUrl(value: string): ClassifiedImportUrl {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid webpage or YouTube URL.");
  }
  if (
    url.protocol !== "https:" ||
    Boolean(url.username) ||
    Boolean(url.password)
  ) {
    throw new Error("Use a standard https webpage or YouTube URL.");
  }
  const host = url.hostname.toLocaleLowerCase().replace(/\.$/, "");
  if (
    !host ||
    host === "localhost" ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    host.startsWith("[") ||
    [
      ".localhost",
      ".local",
      ".internal",
      ".lan",
      ".home",
      ".test",
      ".invalid",
      ".example",
    ].some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error("Orion can only import public webpages.");
  }
  url.hash = "";
  if (YOUTUBE_HOSTS.has(host)) {
    if (!url.pathname || url.pathname === "/") {
      throw new Error("Paste a link to a specific YouTube video.");
    }
    return { kind: "youtube", url: url.toString() };
  }
  return { kind: "webpage", url: url.toString() };
}

export function settleImportItem(
  items: readonly ImportItem[],
  itemId: EntityId,
  outcome:
    | { parsed: ParsedImport }
    | { error: string },
): ImportItem[] {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return items as ImportItem[];
  return items.map((item) => {
    if (item.id !== itemId) return item;
    if ("error" in outcome) {
      return {
        ...item,
        status: "error",
        included: false,
        parsed: undefined,
        error: outcome.error,
        preprocessLabel: undefined,
      };
    }
    return {
      ...item,
      status: "ready",
      included: true,
      parsed: outcome.parsed,
      fileName: outcome.parsed.fileName,
      mimeType: outcome.parsed.mimeType,
      byteSize: outcome.parsed.byteSize,
      error: undefined,
      preprocessLabel: undefined,
    };
  });
}

export function replaceImportItem(
  items: readonly ImportItem[],
  itemId: EntityId,
  replacements: readonly ImportItem[],
  limit = MAX_FILES,
): ImportItem[] {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return items as ImportItem[];
  const capacity = Math.max(0, limit - (items.length - 1));
  return [
    ...items.slice(0, index),
    ...replacements.slice(0, capacity),
    ...items.slice(index + 1),
  ];
}

export function pastedTextToParsedImport(
  title: string,
  body: string,
): ParsedImport {
  const safeTitle = title.trim() || "Pasted notes";
  const text = body.trim();
  return {
    title: safeTitle,
    fileName: `${slugBase(safeTitle)}.txt`,
    mimeType: "text/plain;charset=utf-8",
    format: "text",
    byteSize: new TextEncoder().encode(text).byteLength,
    text,
    warnings: [],
  };
}

function uniqueSlug(title: string, reserved: Set<string>): string {
  const base = slugBase(title);
  let candidate = base;
  let suffix = 2;
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  reserved.add(candidate);
  return candidate;
}

function cleanPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function manualSummary(text: string): string {
  const plain = cleanPlainText(text);
  if (plain.length <= 190) {
    return plain || "Imported source ready for review.";
  }
  return `${plain.slice(0, 189).trimEnd()}…`;
}

function manualOrganizedNote(parsed: ParsedImport): OrganizedNote {
  const body = parsed.text.slice(0, MAX_MANUAL_CHARS_PER_SOURCE).trim();
  const needsHeading = !/^#\s+/m.test(body);

  return {
    title: parsed.title || "Untitled import",
    summary: manualSummary(body),
    body: `${needsHeading ? `# ${parsed.title}\n\n` : ""}${body}`.trim(),
    tags: unique(["imported", parsed.format]),
    aliases: [],
    links: [],
  };
}

export function buildImportOrganizationInstructions(
  importGuidance: string,
): string {
  const guidance = truncateUnicode(
    importGuidance.trim(),
    MAX_IMPORT_GUIDANCE_CHARS,
  );
  return [
    guidance
      ? `User guidance for this import batch:\n${guidance}`
      : "",
    "Import-refresh requirement: return every existing reference article this source can meaningfully enrich. Rewrite each returned wikiArticles.body as one coherent integrated article, preserving worthwhile existing knowledge and weaving new material into the relevant explanation; never append provenance or change-log sections. Return new definitional reference articles only for genuinely durable concepts, never a relabelled or paraphrased copy of the imported project note. Infer concepts from meaning, roles, relationships, and aliases rather than keyword frequency. Preserve explicit actions as Markdown '- [ ]' tasks in the relevant project note only; never copy tasks into wikiArticles and do not invent work.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function contentPreview(text: string, length = 150): string {
  const plain = cleanPlainText(text);
  if (plain.length <= length) {
    return plain;
  }
  return `${plain.slice(0, length - 1).trimEnd()}…`;
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

function mergeWikiArticle(
  note: Note,
  article: OrganizedWikiArticle,
  sourceId: EntityId,
  spaceName: string,
  now: string,
): Note {
  const currentBody = note.body.trim();
  const body =
    article.body.trim() ||
    (!currentBody ? wikiArticleBody(article, spaceName) : currentBody);
  return {
    ...note,
    summary: note.summary.trim() || article.summary.trim(),
    body,
    aliases: unique([...note.aliases, ...article.aliases]).slice(0, 16),
    tags: unique([
      ...note.tags,
      ...article.tags,
    ]).slice(0, 12),
    kind: "wiki",
    sourceIds: unique([...note.sourceIds, sourceId]),
    updatedAt: now,
  };
}

export function buildImportPayload(
  organizedSources: readonly OrganizedSource[],
  snapshot: AppSnapshot,
  importGuidance = "",
): ImportStudioApplyPayload {
  const now = new Date().toISOString();
  const reservedSlugs = new Set(snapshot.notes.map((note) => note.slug));
  const sources: Source[] = [];
  const sourceIdByItemId = new Map<EntityId, EntityId>();
  const generatedContexts: GeneratedNoteContext[] = [];
  const wikiContextByTitle = new Map<string, GeneratedNoteContext>();
  let newNoteCount = 0;

  const reserveNewNote = () => {
    if (newNoteCount >= MAX_TOTAL_GENERATED_NOTES) {
      throw new Error(
        `Orion prepared more than ${MAX_TOTAL_GENERATED_NOTES} new notes. Narrow this import or split it into smaller batches.`,
      );
    }
    newNoteCount += 1;
  };

  const resolveExistingWikiArticle = (title: string) => {
    const key = normalize(title);
    const canonical = snapshot.concepts
      .filter(
        (concept) =>
          normalize(concept.label) === key ||
          concept.aliases.some((alias) => normalize(alias) === key),
      )
      .map((concept) =>
        concept.canonicalNoteId
          ? snapshot.notes.find(
              (note) => note.id === concept.canonicalNoteId,
            )
          : undefined,
      )
      .filter((note): note is Note => Boolean(note));
    if (canonical.length === 1) {
      return canonical[0];
    }
    const exact = snapshot.notes.filter(
      (note) => normalize(note.title) === key,
    );
    return exact.length === 1 ? exact[0] : undefined;
  };

  for (const { item } of organizedSources) {
    const parsed = item.parsed;
    if (!parsed) {
      continue;
    }
    const sourceId = `source_${nanoid(12)}`;
    const source: Source = {
      id: sourceId,
      title: parsed.title,
      kind: parsed.format,
      importedAt: now,
      fileName: parsed.fileName,
      mimeType: parsed.mimeType,
      byteSize: parsed.byteSize,
      sourceUrl: parsed.sourceUrl,
      ...(importGuidance.trim()
        ? {
            importGuidance: truncateUnicode(
              importGuidance.trim(),
              MAX_IMPORT_GUIDANCE_CHARS,
            ),
          }
        : {}),
      text: parsed.text,
      noteIds: [],
    };
    sources.push(source);
    sourceIdByItemId.set(item.id, sourceId);
  }

  const sourceIdsForOutput = (
    organizedSource: OrganizedSource,
    kind: KnowledgeResultProvenance["kind"],
    title: string,
  ): EntityId[] => {
    const matchingProvenance = organizedSource.provenance?.filter(
      (entry) =>
        entry.kind === kind && normalize(entry.title) === normalize(title),
    );
    if (organizedSource.provenance !== undefined) {
      if (matchingProvenance?.length !== 1) {
        throw new Error(`Orion could not resolve source provenance for “${title}”.`);
      }
      if (matchingProvenance[0].sourceIds.length === 0) {
        throw new Error(`Orion returned empty source provenance for “${title}”.`);
      }
      const resolved = matchingProvenance[0].sourceIds.map((itemId) => {
        const sourceId = sourceIdByItemId.get(itemId);
        if (!sourceId) {
          throw new Error(
            `Orion returned source provenance outside this import for “${title}”.`,
          );
        }
        return sourceId;
      });
      return unique(resolved);
    }
    const ownSourceId = sourceIdByItemId.get(organizedSource.item.id);
    return ownSourceId ? [ownSourceId] : [];
  };

  const attachNoteToSources = (
    noteId: EntityId,
    sourceIds: readonly EntityId[],
  ) => {
    for (const source of sources) {
      if (sourceIds.includes(source.id)) {
        source.noteIds = unique([...source.noteIds, noteId]);
      }
    }
  };

  for (const organizedSource of organizedSources) {
    const { item, result } = organizedSource;
    const parsed = item.parsed;
    if (!parsed) continue;
    const fallbackSourceId = sourceIdByItemId.get(item.id);
    if (!fallbackSourceId) continue;
    const organizedNotes = result ? result.notes : [manualOrganizedNote(parsed)];

    organizedNotes.forEach((organized) => {
      reserveNewNote();
      const sourceIds = result
        ? sourceIdsForOutput(organizedSource, "note", organized.title)
        : [fallbackSourceId];
      const noteId = `note_${nanoid(12)}`;
      attachNoteToSources(noteId, sourceIds);
      generatedContexts.push({
        contributions: sourceIds.map((sourceId) => ({ sourceId, organized })),
        note: {
          id: noteId,
          title: organized.title.trim() || parsed.title,
          slug: uniqueSlug(organized.title || parsed.title, reservedSlugs),
          summary:
            organized.summary.trim() || manualSummary(organized.body),
          body: organized.body.trim(),
          aliases: unique(organized.aliases).slice(0, 12),
          tags: unique(organized.tags).slice(0, 10),
          kind: "article",
          status: "ready",
          conceptIds: [],
          sourceIds,
          createdAt: now,
          updatedAt: now,
        },
      });
    });

    const organizedArticles = result ? result.wikiArticles : [];
    for (const article of organizedArticles) {
      const title = article.title.trim();
      const key = normalize(title);
      if (!key) {
        continue;
      }
      let context = wikiContextByTitle.get(key);
      const sourceIds = sourceIdsForOutput(
        organizedSource,
        "wikiArticle",
        article.title,
      );
      if (context) {
        for (const sourceId of sourceIds) {
          context.note = mergeWikiArticle(
            context.note,
            article,
            sourceId,
            snapshot.workspace.name,
            now,
          );
          context.contributions.push({ sourceId, organized: article });
        }
      } else {
        const existing = resolveExistingWikiArticle(title);
        if (!existing) reserveNewNote();
        const noteId = existing?.id ?? `note_${nanoid(12)}`;
        const base: Note =
          existing ?? {
            id: noteId,
            title,
            slug: uniqueSlug(title, reservedSlugs),
            summary: article.summary.trim(),
            body: "",
            aliases: [],
            tags: [],
            kind: "wiki",
            status: "ready",
            conceptIds: [],
            sourceIds: [],
            createdAt: now,
            updatedAt: now,
          };
        let note = base;
        const contributions: GeneratedNoteContext["contributions"] = [];
        for (const sourceId of sourceIds) {
          note = mergeWikiArticle(
            note,
            article,
            sourceId,
            snapshot.workspace.name,
            now,
          );
          contributions.push({ sourceId, organized: article });
        }
        context = { note, contributions };
        generatedContexts.push(context);
        wikiContextByTitle.set(key, context);
      }
      attachNoteToSources(context.note.id, sourceIds);
    }
  }

  const allNotesById = new Map(snapshot.notes.map((note) => [note.id, note]));
  generatedContexts.forEach(({ note }) => allNotesById.set(note.id, note));
  const allNotes = [...allNotesById.values()];
  const targetsByPhrase = new Map<string, Note[]>();
  allNotes.forEach((note) => {
      [note.title, ...note.aliases].forEach((phrase) => {
        const key = normalize(phrase);
        if (key) {
          const targets = targetsByPhrase.get(key) ?? [];
          if (!targets.some((target) => target.id === note.id)) {
            targets.push(note);
          }
          targetsByPhrase.set(key, targets);
        }
      });
    });
  const targetForTitle = (title: string) => {
    const targets = targetsByPhrase.get(normalize(title)) ?? [];
    const exact = targets.filter((note) => normalize(note.title) === normalize(title));
    if (exact.length === 1) return exact[0];
    if (targets.length === 1) {
      return targets[0];
    }
    const exactWiki = targets.filter(
      (note) =>
        note.kind === "wiki" &&
        normalize(note.title) === normalize(title),
    );
    return exactWiki.length === 1 ? exactWiki[0] : undefined;
  };

  const conceptSeeds: ConceptSeed[] = organizedSources.flatMap(({ result }) =>
    (result?.concepts ?? []).flatMap((concept) => {
      const canonical = targetForTitle(concept.canonicalTitle);
      if (!canonical) {
        return [];
      }
      for (const phrase of [concept.label, ...concept.aliases]) {
        if (allNotes.some((note) => note.id !== canonical.id &&
          normalizeConceptPhrase(note.title) === normalizeConceptPhrase(phrase))) {
          throw new Error(`Orion cannot redirect the note title “${phrase}” to “${canonical.title}”.`);
        }
        if (existingCanonicalPhraseDestinations(snapshot, phrase).some((ownerId) => ownerId !== canonical.id)) {
          throw new Error(`Orion cannot redirect the established link phrase “${phrase}” to “${canonical.title}”.`);
        }
      }
      return [
        {
          label: concept.label,
          aliases: concept.aliases,
          description: concept.description,
          noteIds: [canonical.id],
          canonicalNoteId: canonical.id,
        },
      ];
    }),
  );

  const vocabulary = reconcileConceptVocabulary(
    allNotes,
    snapshot.concepts,
    conceptSeeds,
  );
  const reconciledNotes = new Map(
    vocabulary.notes.map((note) => [note.id, note]),
  );

  const relationships: Relationship[] = [];
  const relationshipKeys = new Set<string>();
  const addRelationship = (
    fromNoteId: EntityId,
    toNoteId: EntityId,
    sourceId: EntityId,
    context: string,
    strength: number,
    kind: RelationshipKind = "related",
  ) => {
    if (fromNoteId === toNoteId || !context.trim()) {
      return;
    }
    const pair = `${fromNoteId}>${toNoteId}`;
    const key = `${pair}:${kind}`;
    if (kind === "related" && relationships.some((relationship) =>
      relationship.fromNoteId === fromNoteId && relationship.toNoteId === toNoteId && relationship.kind !== "related")) return;
    if (kind !== "related") {
      const genericIndex = relationships.findIndex((relationship) =>
        relationship.fromNoteId === fromNoteId && relationship.toNoteId === toNoteId && relationship.kind === "related");
      if (genericIndex >= 0) relationships.splice(genericIndex, 1);
      relationshipKeys.delete(`${pair}:related`);
    }
    if (relationshipKeys.has(key)) {
      return;
    }
    relationshipKeys.add(key);
    relationships.push({
      id: `relationship_${nanoid(12)}`,
      fromNoteId,
      toNoteId,
      kind,
      label: kind === "related" ? "related to" : kind === "conflicts" ? "conflicts with" : kind,
      strength,
      sourceId,
      context: context.trim(),
    });
  };

  generatedContexts.forEach(({ note, contributions }) => {
    contributions.forEach(({ sourceId, organized }) => {
      organized.links.forEach((link) => {
        const target = targetForTitle(link.targetTitle);
        if (target) {
          addRelationship(
            note.id,
            target.id,
            sourceId,
            link.context,
            0.78,
          );
        }
      });
    });
  });

  organizedSources.forEach(({ item, result }) => {
    if (!item.parsed || !result) {
      return;
    }
    const sourceId = sourceIdByItemId.get(item.id);
    if (!sourceId) {
      return;
    }
    result.concepts.forEach((concept) => {
      const canonical = targetForTitle(concept.canonicalTitle);
      if (!canonical) {
        return;
      }
      concept.relatedTitles.forEach((title) => {
        const related = targetForTitle(title);
        if (related) {
          addRelationship(
            canonical.id,
            related.id,
            sourceId,
            concept.description,
            0.82,
          );
        }
      });
    });
    result.suggestedConnections.forEach((connection) => {
      const from = targetForTitle(connection.fromTitle);
      const to = targetForTitle(connection.toTitle);
      if (from && to) {
        addRelationship(
          from.id,
          to.id,
          sourceId,
          connection.reason,
          0.64,
          connection.kind ?? "related",
        );
      }
    });
  });

  return {
    notes: generatedContexts.map(
      ({ note }) => reconciledNotes.get(note.id) ?? note,
    ),
    sources,
    concepts: vocabulary.concepts,
    relationships,
  };
}

export function ImportStudio({
  open,
  snapshot,
  onClose,
  onApply,
}: ImportStudioProps) {
  const aiConfigured = isSelectedAIConfigured(snapshot.settings);
  const aiProviderName = selectedAIProviderName(snapshot.settings);
  const rawId = useId().replace(/:/g, "");
  const titleId = `import-studio-title-${rawId}`;
  const descriptionId = `import-studio-description-${rawId}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pasteDialogRef = useRef<HTMLFormElement>(null);
  const pasteBodyRef = useRef<HTMLTextAreaElement>(null);
  const fileChoiceDialogRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<ImportItem[]>([]);
  const reviewedImportIdsRef = useRef<Set<string> | null>(null);
  const organizedImportIdsRef = useRef<Set<string>>(new Set());
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const organizeAbortRef = useRef<AbortController | null>(null);
  const autoResumeAttemptRef = useRef(0);
  const importCheckpointBatchIndexRef = useRef(0);
  const retainedKnowledgeSegmentsRef = useRef<
    Array<{
      items: readonly ImportItem[];
      knowledge: KnowledgeImportBatchResult;
    }>
  >([]);
  const organizeProgressFrameRef = useRef<number | null>(null);
  const pendingOrganizeProgressRef = useRef<OrganizeProgress | null>(null);
  const latestOrchestrationStageRef = useRef<UserFacingImportStage>("direct");
  const workspaceIdRef = useRef(snapshot.workspace.id);
  const [stage, setStage] = useState<ImportStage>("add");
  const [items, setItems] = useState<ImportItem[]>([]);
  const [pastedTitle, setPastedTitle] = useState("");
  const [pastedText, setPastedText] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [fileChoiceOpen, setFileChoiceOpen] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [mode, setMode] = useState<ImportMode>(
    aiConfigured ? "ai" : "manual",
  );
  const [importGuidance, setImportGuidance] = useState("");
  const [organizeProgress, setOrganizeProgress] = useState<OrganizeProgress>(
    EMPTY_ORGANIZE_PROGRESS,
  );
  const [organizeIssues, setOrganizeIssues] = useState<OrganizeIssue[]>([]);
  const [importDiagnostic, setImportDiagnostic] =
    useState<KnowledgeImportDiagnostic | null>(null);
  const [importCheckpoint, setImportCheckpoint] =
    useState<FixedBlueprintImportCheckpoint | null>(null);
  const [result, setResult] = useState<ImportStudioApplyPayload | null>(null);
  const [resultBaseSnapshotVersion, setResultBaseSnapshotVersion] = useState<
    string | null
  >(null);
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);

  const clearImportRecovery = () => {
    setImportDiagnostic(null);
    setImportCheckpoint(null);
    retainedKnowledgeSegmentsRef.current = [];
  };

  const updateItems = (
    updater: (current: ImportItem[]) => ImportItem[],
  ) => {
    const previous = itemsRef.current;
    const reviewed = reviewedImportIdsRef.current;
    const next = updater(previous).map((item) =>
      reviewed && !reviewed.has(item.id) && item.included
        ? { ...item, included: false }
        : item,
    );
    // A background extraction completing outside this selection must not
    // invalidate the active run's accepted segments or retry checkpoint.
    if (!reviewed || previous.some((item) => reviewed.has(item.id) &&
        next.find(({ id }) => id === item.id) !== item)) clearImportRecovery();
    itemsRef.current = next;
    setItems(next);
  };

  const scheduleOrganizeProgress = (progress: OrganizeProgress) => {
    pendingOrganizeProgressRef.current = progress;
    if (organizeProgressFrameRef.current !== null) return;
    organizeProgressFrameRef.current = window.requestAnimationFrame(() => {
      organizeProgressFrameRef.current = null;
      const pending = pendingOrganizeProgressRef.current;
      pendingOrganizeProgressRef.current = null;
      if (pending) setOrganizeProgress(pending);
    });
  };

  const reset = (remainingItems: ImportItem[] = []) => {
    organizeAbortRef.current?.abort(
      new Error("The knowledge import was cancelled."),
    );
    organizeAbortRef.current = null;
    if (organizeProgressFrameRef.current !== null) {
      window.cancelAnimationFrame(organizeProgressFrameRef.current);
      organizeProgressFrameRef.current = null;
    }
    pendingOrganizeProgressRef.current = null;
    latestOrchestrationStageRef.current = "direct";
    autoResumeAttemptRef.current = 0;
    importCheckpointBatchIndexRef.current = 0;
    retainedKnowledgeSegmentsRef.current = [];
    setStage("add");
    reviewedImportIdsRef.current = null;
    organizedImportIdsRef.current = new Set();
    itemsRef.current = remainingItems;
    setItems(remainingItems);
    setPastedTitle("");
    setPastedText("");
    setPasteOpen(false);
    setPasteError("");
    setFileChoiceOpen(false);
    setImportUrl("");
    setUrlError("");
    setMode(aiConfigured ? "ai" : "manual");
    setImportGuidance("");
    setOrganizeProgress(EMPTY_ORGANIZE_PROGRESS);
    setOrganizeIssues([]);
    setImportDiagnostic(null);
    setImportCheckpoint(null);
    setResult(null);
    setResultBaseSnapshotVersion(null);
    setApplyError("");
    setApplying(false);
  };

  useEffect(() => {
    if (!open) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() =>
      dialogRef.current?.focus(),
    );

    return () => {
      cancelAnimationFrame(focusFrame);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (workspaceIdRef.current === snapshot.workspace.id) return;
    workspaceIdRef.current = snapshot.workspace.id;
    reset();
  }, [snapshot.workspace.id]);

  useEffect(
    () => () => {
      organizeAbortRef.current?.abort(
        new Error("The knowledge import was cancelled."),
      );
      if (organizeProgressFrameRef.current !== null) {
        window.cancelAnimationFrame(organizeProgressFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!open || (!pasteOpen && !fileChoiceOpen)) return undefined;
    const frame = requestAnimationFrame(() => {
      if (pasteOpen) {
        pasteBodyRef.current?.focus();
      } else {
        fileChoiceDialogRef.current
          ?.querySelector<HTMLElement>("button")
          ?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [fileChoiceOpen, open, pasteOpen]);

  useEffect(() => {
    if (!open) return undefined;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        stage !== "organizing" &&
        !applying
      ) {
        if (pasteOpen) {
          setPasteOpen(false);
        } else if (fileChoiceOpen) {
          setFileChoiceOpen(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [applying, fileChoiceOpen, onClose, open, pasteOpen, stage]);

  const readyItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.status === "ready" && item.included && Boolean(item.parsed),
      ),
    [items],
  );
  const parsing = items.some((item) => item.status === "parsing");
  const totalBytes = readyItems.reduce(
    (total, item) => total + item.byteSize,
    0,
  );
  const totalWords = readyItems.reduce(
    (total, item) => total + wordCount(item.parsed?.text ?? ""),
    0,
  );
  const activeStageIndex = STAGES.findIndex(({ id }) => id === stage);

  const queueKey = (fileName: string, byteSize: number) =>
    `file:${normalize(fileName)}:${byteSize}`;

  const addDocumentFiles = async (files: readonly File[]) => {
    if (files.length === 0) {
      return;
    }

    const existingKeys = new Set(
      itemsRef.current.map(
        (item) => item.dedupeKey ?? queueKey(item.fileName, item.byteSize),
      ),
    );
    const availableSlots = Math.max(0, MAX_FILES - itemsRef.current.length);
    const candidates = files.slice(0, availableSlots);
    const additions: ImportItem[] = candidates.map((file) => {
      const dedupeKey = queueKey(file.name, file.size);
      const duplicate = existingKeys.has(dedupeKey);
      const tooLarge = file.size > MAX_FILE_BYTES;
      existingKeys.add(dedupeKey);

      return {
        id: `import_${nanoid(12)}`,
        fileName: file.name,
        mimeType: file.type,
        byteSize: file.size,
        status: duplicate || tooLarge ? "error" : "parsing",
        included: !duplicate && !tooLarge,
        dedupeKey,
        preprocessLabel: duplicate || tooLarge
          ? undefined
          : detectSourceKind(file.name, file.type) === "image"
            ? "Recognizing text locally…"
            : "Reading document…",
        error: duplicate
          ? "This file is already in the import queue."
          : tooLarge
            ? `Files must be smaller than ${formatBytes(MAX_FILE_BYTES)}.`
            : undefined,
      };
    });

    updateItems((current) => [...current, ...additions]);

    await Promise.all(
      candidates.map(async (file, index) => {
        const item = additions[index];
        if (item.status === "error") {
          return;
        }

        try {
          const [parsed] = await parseImportFiles(
            [file],
            async (document, options) => {
              updateItems((current) =>
                current.map((currentItem) =>
                  currentItem.id === item.id
                    ? {
                        ...currentItem,
                        preprocessLabel: options?.pageNumbers?.length
                          ? `Repairing ${options.pageNumbers.length.toLocaleString("en-US")} PDF ${options.pageNumbers.length === 1 ? "page" : "pages"} locally…`
                          : "Recognizing text locally…",
                      }
                    : currentItem,
                ),
              );
              return recognizeDocumentText(document, options);
            },
          );
          updateItems((current) =>
            settleImportItem(current, item.id, { parsed }),
          );
        } catch (error) {
          updateItems((current) =>
            settleImportItem(current, item.id, {
              error: errorMessage(error),
            }),
          );
        }
      }),
    );
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void addDocumentFiles(files);
  };

  const addPastedText = () => {
    const text = pastedText.trim();
    if (!text) {
      setPasteError("Paste some text to add it to the queue.");
      return;
    }
    if (itemsRef.current.length >= MAX_FILES) {
      setPasteError(`The queue can hold up to ${MAX_FILES} sources.`);
      return;
    }
    const parsed = pastedTextToParsedImport(pastedTitle, text);
    const dedupeKey = `paste:${normalize(parsed.title)}:${parsed.byteSize}:${normalize(parsed.text.slice(0, 160))}`;
    const duplicate = itemsRef.current.some(
      (item) => item.dedupeKey === dedupeKey,
    );
    updateItems((current) => [
      ...current,
      {
        id: `import_${nanoid(12)}`,
        fileName: parsed.fileName,
        mimeType: parsed.mimeType,
        byteSize: parsed.byteSize,
        status: duplicate ? "error" : "ready",
        included: !duplicate,
        parsed: duplicate ? undefined : parsed,
        dedupeKey,
        error: duplicate
          ? "This pasted text is already in the import queue."
          : undefined,
      },
    ]);
    setPastedTitle("");
    setPastedText("");
    setPasteError("");
    setPasteOpen(false);
  };

  const whisperConfig = (): WhisperConfig => ({
    language: snapshot.settings.whisperLanguage || undefined,
  });

  const replaceWithTranscripts = (
    itemId: EntityId,
    transcripts: readonly TranscribedMedia[],
  ) => {
    updateItems((current) => {
      const placeholder = current.find((item) => item.id === itemId);
      if (!placeholder) return current;
      if (transcripts.length === 0) {
        return current.filter((item) => item.id !== itemId);
      }
      const existingKeys = new Set(
        current
          .filter((item) => item.id !== itemId)
          .map(
            (item) =>
              item.dedupeKey ?? queueKey(item.fileName, item.byteSize),
          ),
      );
      const capacity = Math.max(0, MAX_FILES - (current.length - 1));
      const accepted = transcripts.slice(0, capacity);
      const omitted = transcripts.length - accepted.length;
      const replacements = accepted.map((transcript, index) => {
        const initialParsed = transcriptToParsedImport(transcript);
        const parsed =
          omitted > 0 && index === accepted.length - 1
            ? {
                ...initialParsed,
                warnings: [
                  ...initialParsed.warnings,
                  `${omitted} additional media ${omitted === 1 ? "file was" : "files were"} not added because the queue can hold up to ${MAX_FILES} sources.`,
                ],
              }
            : initialParsed;
        const dedupeKey =
          index === 0 && placeholder.dedupeKey
            ? placeholder.dedupeKey
            : queueKey(parsed.fileName, parsed.byteSize);
        const duplicate = existingKeys.has(dedupeKey);
        existingKeys.add(dedupeKey);
        return {
          id: index === 0 ? itemId : `import_${nanoid(12)}`,
          fileName: parsed.fileName,
          mimeType: parsed.mimeType,
          byteSize: parsed.byteSize,
          status: duplicate ? ("error" as const) : ("ready" as const),
          included: !duplicate,
          parsed: duplicate ? undefined : parsed,
          dedupeKey,
          error: duplicate
            ? "This transcript is already in the import queue."
            : undefined,
        };
      });
      return replaceImportItem(current, itemId, replacements);
    });
  };

  const runMediaTranscription = async (browserFiles?: readonly File[]) => {
    if (itemsRef.current.length >= MAX_FILES) return;
    const fileCount = browserFiles?.length ?? 0;
    const displayName =
      fileCount === 1
        ? browserFiles?.[0]?.name ?? "Audio or video"
        : fileCount > 1
          ? `${fileCount} media files`
          : "Audio or video";
    const byteSize =
      browserFiles?.reduce((total, file) => total + file.size, 0) ?? 0;
    const itemId = `import_${nanoid(12)}`;
    const dedupeKey =
      fileCount === 1 && browserFiles?.[0]
        ? queueKey(browserFiles[0].name, browserFiles[0].size)
        : undefined;
    const duplicate = Boolean(
      dedupeKey &&
        itemsRef.current.some((item) => item.dedupeKey === dedupeKey),
    );
    updateItems((current) => [
      ...current,
      {
        id: itemId,
        fileName: displayName,
        mimeType: browserFiles?.[0]?.type ?? "audio/video",
        byteSize,
        status: duplicate ? "error" : "parsing",
        included: false,
        dedupeKey,
        preprocessLabel: duplicate
          ? undefined
          : fileCount > 0
            ? "Transcribing locally…"
            : "Choose media, then Orion will transcribe it locally…",
        error: duplicate
          ? "This media file is already in the import queue."
          : undefined,
      },
    ]);
    if (duplicate) return;
    try {
      const transcripts = await transcribeMediaFiles(
        whisperConfig(),
        browserFiles,
      );
      replaceWithTranscripts(itemId, transcripts);
    } catch (error) {
      updateItems((current) =>
        settleImportItem(current, itemId, {
          error: errorMessage(error),
        }),
      );
    }
  };

  const chooseMedia = () => {
    setFileChoiceOpen(false);
    if (isTauriRuntime()) {
      void runMediaTranscription();
    } else {
      window.requestAnimationFrame(() => mediaInputRef.current?.click());
    }
  };

  const chooseDocuments = () => {
    setFileChoiceOpen(false);
    window.requestAnimationFrame(() => fileInputRef.current?.click());
  };

  const handleMediaInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) {
      void runMediaTranscription(files);
    }
  };

  const queueUrl = async () => {
    let classified: ClassifiedImportUrl;
    try {
      classified = classifyImportUrl(importUrl);
    } catch (error) {
      setUrlError(errorMessage(error));
      return;
    }
    if (itemsRef.current.length >= MAX_FILES) {
      setUrlError(`The queue can hold up to ${MAX_FILES} sources.`);
      return;
    }
    const dedupeKey = `url:${classified.url}`;
    const duplicate = itemsRef.current.some(
      (item) => item.dedupeKey === dedupeKey,
    );
    const itemId = `import_${nanoid(12)}`;
    const host = new URL(classified.url).hostname.replace(/^www\./i, "");
    updateItems((current) => [
      ...current,
      {
        id: itemId,
        fileName:
          classified.kind === "youtube" ? "YouTube video" : host,
        mimeType:
          classified.kind === "youtube" ? "video/youtube" : "text/html",
        byteSize: 0,
        status: duplicate ? "error" : "parsing",
        included: false,
        dedupeKey,
        preprocessLabel: duplicate
          ? undefined
          : classified.kind === "youtube"
            ? "Downloading, transcribing locally, then deleting media…"
            : "Fetching readable webpage text…",
        error: duplicate
          ? "This URL is already in the import queue."
          : undefined,
      },
    ]);
    setImportUrl("");
    setUrlError("");
    if (duplicate) return;
    try {
      const parsed =
        classified.kind === "youtube"
          ? transcriptToParsedImport(
              await transcribeYouTube(classified.url, whisperConfig()),
            )
          : await fetchWebPage(classified.url);
      updateItems((current) =>
        settleImportItem(current, itemId, { parsed }),
      );
    } catch (error) {
      updateItems((current) =>
        settleImportItem(current, itemId, {
          error: errorMessage(error),
        }),
      );
    }
  };

  const removeItem = (itemId: EntityId) => {
    updateItems((current) =>
      current.filter((item) => item.id !== itemId),
    );
  };

  const toggleItem = (itemId: EntityId) => {
    reviewedImportIdsRef.current?.add(itemId);
    updateItems((current) =>
      current.map((item) =>
        item.id === itemId && item.status === "ready"
          ? { ...item, included: !item.included }
          : item,
      ),
    );
  };

  const organize = async (
    resumeCheckpoint?: FixedBlueprintImportCheckpoint,
  ) => {
    const selected = readyItems;
    if (selected.length === 0) {
      return;
    }
    organizedImportIdsRef.current = new Set(selected.map(({ id }) => id));

    const importSnapshot = snapshotRef.current;
    const effectiveMode: ImportMode =
      mode === "ai" && aiConfigured ? "ai" : "manual";
    setStage("organizing");
    setOrganizeProgress({
      ...EMPTY_ORGANIZE_PROGRESS,
      sourceTotal: selected.length,
    });
    setOrganizeIssues([]);
    setImportDiagnostic(null);
    if (!resumeCheckpoint) {
      setImportCheckpoint(null);
      autoResumeAttemptRef.current = 0;
      importCheckpointBatchIndexRef.current = 0;
    }
    setApplyError("");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    const organizedSources: OrganizedSource[] = [];
    const issues: OrganizeIssue[] = [];
    const baseTaskInstructions =
      buildImportOrganizationInstructions(importGuidance);
    let existingNotes = buildCompactOrganizerContext(importSnapshot, {
      matchText: [
        importGuidance,
        ...selected.flatMap((item) =>
          item.parsed
            ? [item.parsed.title, item.parsed.text]
            : [item.fileName],
        ),
      ].join("\n"),
    });

    if (effectiveMode === "ai" && isTauriRuntime()) {
      const controller = new AbortController();
      organizeAbortRef.current?.abort(
        new Error("A newer knowledge import replaced this run."),
      );
      organizeAbortRef.current = controller;
      latestOrchestrationStageRef.current = "direct";
      setOrganizeProgress({
        ...EMPTY_ORGANIZE_PROGRESS,
        sourceTotal: selected.length,
        sourceTitle:
          selected.length === 1
            ? selected[0].parsed?.title ?? selected[0].fileName
            : `${selected.length} sources`,
        phase: "orchestration",
        operationLabel: "Orion is shaping your notes",
        detailLabel: "Preparing the direct reading",
        orchestrationStage: "direct",
      });
      // One oversized selection becomes several bounded knowledge runs.
      // Partitioning is deterministic and order-preserving; a source too
      // large for any batch stays alone so the run explains it directly.
      const batches = partitionImportSourcesForSynthesis(
        selected,
        (item) => item.parsed?.text ?? "",
      );
      const batchProgressTitle = (
        batchItems: readonly ImportItem[],
        batchIndex: number,
      ) => {
        const base =
          batchItems.length === 1
            ? batchItems[0].parsed?.title ?? batchItems[0].fileName
            : `${batchItems.length} sources`;
        return batches.length > 1
          ? `${base} · batch ${batchIndex + 1} of ${batches.length}`
          : base;
      };
      const knowledgeSourcesFor = (batchItems: readonly ImportItem[]) =>
        batchItems.flatMap((item) =>
          item.parsed ? [{ sourceId: item.id, parsed: item.parsed }] : [],
        );
      const emptyResult: OrganizeContentResult = {
        notes: [],
        wikiArticles: [],
        concepts: [],
        suggestedConnections: [],
      };
      const presentKnowledgeResults = (
        segments: ReadonlyArray<{
          items: readonly ImportItem[];
          knowledge: KnowledgeImportBatchResult;
        }>,
      ) => {
        const batchSources: OrganizedSource[] = segments.flatMap(
          ({ items: segmentItems, knowledge }) =>
            segmentItems.map((item, index) => ({
              item,
              result: index === 0 ? knowledge.organized : emptyResult,
              ...(index === 0 ? { provenance: knowledge.provenance } : {}),
            })),
        );
        const payload = buildImportPayload(
          batchSources,
          importSnapshot,
          importGuidance,
        );
        const baseSnapshotVersion = segments[0].knowledge.baseSnapshotVersion;
        setOrganizeIssues(
          unique(
            segments.flatMap(({ knowledge }) =>
              knowledge.warnings.map((message) =>
                userFacingKnowledgeWarning(
                  message,
                  latestOrchestrationStageRef.current,
                ),
              ),
            ),
          ).map((message) => ({
            itemId: selected[0].id,
            fileName: selected[0].fileName,
            message,
            usedManualFallback: false,
          })),
        );
        setResult({
          ...payload,
          baseSnapshotVersion,
        });
        setResultBaseSnapshotVersion(baseSnapshotVersion);
        const failedIndex = segments.findIndex(
          ({ knowledge }) => knowledge.landing,
        );
        const failure = segments[failedIndex]?.knowledge.landing;
        if (failure) {
          retainedKnowledgeSegmentsRef.current = [...segments];
          importCheckpointBatchIndexRef.current = failedIndex;
          setImportDiagnostic(failure.diagnostic);
          setImportCheckpoint(failure.checkpoint ?? null);
        } else {
          clearImportRecovery();
        }
        setStage("results");
      };
      const completedSegments: Array<{
        items: readonly ImportItem[];
        knowledge: KnowledgeImportBatchResult;
      }> = [];
      let activeBatchIndex = 0;
      try {
        let preflight = await preflightKnowledgeProvider(
          importSnapshot.settings.model,
        );
        for (
          let attempt = 0;
          !preflight.ok &&
          isTransientProviderFailure(preflight.message) &&
          attempt < 2 &&
          !controller.signal.aborted;
          attempt += 1
        ) {
          scheduleOrganizeProgress({
            ...EMPTY_ORGANIZE_PROGRESS,
            sourceTotal: selected.length,
            phase: "orchestration",
            operationLabel: "Orion is reconnecting to your AI provider",
            detailLabel: `Retrying the connection · attempt ${attempt + 2} of 3`,
            orchestrationStage: "direct",
          });
          const waited = await waitForAutoResumeBackoff(
            autoResumeBackoffMs(attempt),
            controller.signal,
          );
          if (!waited || controller.signal.aborted) break;
          preflight = await preflightKnowledgeProvider(
            importSnapshot.settings.model,
          );
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!preflight.ok) {
          throw new Error(preflight.message);
        }
        const driver = createFailoverKnowledgeDriver(importSnapshot.settings);
        const resumeBatchIndex = resumeCheckpoint
          ? Math.min(importCheckpointBatchIndexRef.current, batches.length - 1)
          : 0;
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          activeBatchIndex = batchIndex;
          const batchItems = batches[batchIndex];
          const retained = retainedKnowledgeSegmentsRef.current.find(
            (segment) =>
              !segment.knowledge.landing &&
              snapshotStillMatchesImportBase(
                importSnapshot,
                segment.knowledge.baseSnapshotVersion,
              ) &&
              segment.items.length === batchItems.length &&
              segment.items.every((item, index) => item === batchItems[index]),
          );
          if (retained) {
            completedSegments.push(retained);
            continue;
          }
          const batchSources = knowledgeSourcesFor(batchItems);
          const batchTitle = batchProgressTitle(batchItems, batchIndex);
          let checkpoint =
            batchIndex === resumeBatchIndex ? resumeCheckpoint : undefined;
          latestOrchestrationStageRef.current = "direct";
          scheduleOrganizeProgress({
            ...EMPTY_ORGANIZE_PROGRESS,
            sourceTotal: batchItems.length,
            sourceTitle: batchTitle,
            phase: "orchestration",
            operationLabel: "Orion is shaping your notes",
            detailLabel: "Preparing the direct reading",
            orchestrationStage: "direct",
          });
          for (;;) {
            try {
              const knowledge = await runKnowledgeImportBatch({
                snapshot: importSnapshot,
                sources: batchSources,
                importGuidance,
                model: importSnapshot.settings.model,
                effort: importSnapshot.settings.reasoningEffort,
                driver,
                readingCache: createKnowledgeReadingCache(),
                routingCache: createKnowledgeReadingCache(),
                signal: controller.signal,
                onTelemetry: (telemetry) => {
                  if (organizeAbortRef.current !== controller) return;
                  const progress = progressFromKnowledgeTelemetry(
                    telemetry,
                    batchItems.length,
                    batchTitle,
                  );
                  latestOrchestrationStageRef.current =
                    progress.orchestrationStage ?? "direct";
                  scheduleOrganizeProgress(progress);
                },
                resume: checkpoint,
              });
              if (
                !snapshotStillMatchesImportBase(
                  snapshotRef.current,
                  knowledge.baseSnapshotVersion,
                )
              ) {
                throw new Error(
                  "This Space changed while Orion was reading, so the knowledge run was not applied.",
                );
              }
              completedSegments.push({ items: batchItems, knowledge });
              break;
            } catch (error) {
              if (controller.signal.aborted) {
                throw error;
              }
              const runError = isKnowledgeImportRunError(error)
                ? error
                : createKnowledgeImportRunError(
                    error,
                    `import:${Date.now().toString(36)}`,
                    importSnapshot.settings.model,
                    undefined,
                    latestOrchestrationStageRef.current,
                  );
              reportKnowledgeImportDiagnostic(
                `Run ${runError.diagnostic.runId} paused during ${runError.diagnostic.stage}`,
                runError.originalError,
              );
              if (
                runError.diagnostic.resumable &&
                runError.checkpoint &&
                shouldAutoResume(
                  runError.diagnostic.code,
                  autoResumeAttemptRef.current,
                )
              ) {
                const attempt = autoResumeAttemptRef.current;
                autoResumeAttemptRef.current = attempt + 1;
                scheduleOrganizeProgress({
                  ...EMPTY_ORGANIZE_PROGRESS,
                  sourceTotal: batchItems.length,
                  sourceTitle: batchTitle,
                  phase: "orchestration",
                  operationLabel: "Orion is recovering this import",
                  detailLabel: "Resuming from the saved progress in a moment",
                  orchestrationStage: latestOrchestrationStageRef.current,
                });
                const waited = await waitForAutoResumeBackoff(
                  autoResumeBackoffMs(attempt),
                  controller.signal,
                );
                if (!waited || controller.signal.aborted) {
                  throw error;
                }
                checkpoint = runError.checkpoint;
                continue;
              }
              // Auto-resume is exhausted or ineligible: preserve this batch
              // with its diagnostic and recovery action. Cancellation and a
              // changed Space never land; they use the paused path below.
              const landed = landFailedKnowledgeImport(
                runError,
                batchSources,
                importSnapshot,
              );
              if (
                landed &&
                snapshotStillMatchesImportBase(
                  snapshotRef.current,
                  landed.baseSnapshotVersion,
                )
              ) {
                reportKnowledgeImportDiagnostic(
                  `Run ${landed.runId} landed at tier ${landed.landing?.tier ?? 2}`,
                  runError.originalError,
                );
                completedSegments.push({
                  items: batchItems,
                  knowledge: landed,
                });
                break;
              }
              throw runError;
            }
          }
        }
        activeBatchIndex = batches.length;
        presentKnowledgeResults(completedSegments);
        return;
      } catch (error) {
        if (organizeAbortRef.current !== controller ||
            snapshotRef.current.workspace.id !== importSnapshot.workspace.id) return;
        if (controller.signal.aborted) {
          setStage("review");
          setOrganizeIssues([]);
          return;
        }
        const alreadyReported = isKnowledgeImportRunError(error);
        const runError = alreadyReported
          ? error
          : createKnowledgeImportRunError(
              error,
              `import:${Date.now().toString(36)}`,
              importSnapshot.settings.model,
              undefined,
              latestOrchestrationStageRef.current,
            );
        if (!alreadyReported) {
          reportKnowledgeImportDiagnostic(
            `Run ${runError.diagnostic.runId} paused during ${runError.diagnostic.stage}`,
            runError.originalError,
          );
        }
        // A failure before any provider work — the preflight — still lands:
        // every batch that has not completed lands together while completed
        // batches keep their real results. After the last batch there is
        // nothing left to land, so an assembly failure pauses visibly below.
        const remainingItems = batches.slice(activeBatchIndex).flat();
        if (remainingItems.length > 0) {
          const landed = landFailedKnowledgeImport(
            runError,
            knowledgeSourcesFor(remainingItems),
            importSnapshot,
          );
          if (
            landed &&
            snapshotStillMatchesImportBase(
              snapshotRef.current,
              landed.baseSnapshotVersion,
            )
          ) {
            reportKnowledgeImportDiagnostic(
              `Run ${landed.runId} landed at tier ${landed.landing?.tier ?? 2}`,
              runError.originalError,
            );
            try {
              presentKnowledgeResults([
                ...completedSegments,
                { items: remainingItems, knowledge: landed },
              ]);
              return;
            } catch (landedPresentError) {
              reportKnowledgeImportDiagnostic(
                "The landed batch results could not be combined",
                landedPresentError,
              );
            }
          }
        }
        const baseSnapshotVersion = stableSnapshotVersion(importSnapshot);
        const payload = buildImportPayload(
          selected.map((item) => ({ item })),
          importSnapshot,
          importGuidance,
        );
        importCheckpointBatchIndexRef.current = activeBatchIndex;
        setImportDiagnostic(runError.diagnostic);
        setImportCheckpoint(runError.checkpoint ?? null);
        setOrganizeIssues(
          selected.map((item) => ({
            itemId: item.id,
            fileName: item.fileName,
            message: runError.diagnostic.summary,
            usedManualFallback: true,
          })),
        );
        setResult({ ...payload, baseSnapshotVersion });
        setResultBaseSnapshotVersion(baseSnapshotVersion);
        setStage("results");
        return;
      } finally {
        if (organizeAbortRef.current === controller) {
          organizeAbortRef.current = null;
        }
      }
    }

    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      const parsed = item.parsed;
      if (!parsed) {
        continue;
      }

      setOrganizeProgress({
        sourceIndex: index,
        sourceTotal: selected.length,
        sourceTitle: parsed.title,
        phase: "source",
        completedSections: 0,
        sectionTotal: 0,
      });

      if (effectiveMode === "manual") {
        organizedSources.push({ item });
        continue;
      }

      try {
        const sections = splitDocumentForParallelReading(parsed.text);
        let organized: OrganizeContentResult;
        if (sections.length > 1) {
          setOrganizeProgress({
            sourceIndex: index,
            sourceTotal: selected.length,
            sourceTitle: parsed.title,
            phase: "sections",
            completedSections: 0,
            sectionTotal: sections.length,
          });
          const sectionOutcomes = await mapLongDocumentSections(
            sections,
            async (section) => {
              const sectionResult = await organizeWithAI({
                content: section.content,
                sourceName: `${parsed.fileName} · section ${section.index + 1} of ${section.total}`,
                spaceName: importSnapshot.workspace.name,
                spaceDescription: importSnapshot.workspace.description,
                model: importSnapshot.settings.model,
                effort: importSnapshot.settings.reasoningEffort,
                taskInstructions: longDocumentSectionInstructions(
                  parsed.title,
                  section,
                  baseTaskInstructions,
                ),
                organizationInstructions:
                  importSnapshot.settings.organizationInstructions,
              });
              if (sectionResult.notes.length === 0) {
                throw new Error(
                  `Section ${section.index + 1} returned no reading notes.`,
                );
              }
              return sectionResult;
            },
            (completed, total) => {
              setOrganizeProgress({
                sourceIndex: index,
                sourceTotal: selected.length,
                sourceTitle: parsed.title,
                phase: "sections",
                completedSections: completed,
                sectionTotal: total,
              });
            },
          );
          const successfulSections = sectionOutcomes.filter(
            ({ value }) => Boolean(value),
          ).length;
          if (successfulSections === 0) {
            const firstFailure = sectionOutcomes.find(({ error }) => error)?.error;
            throw new Error(
              `Orion could not read any section of this long document. ${errorMessage(firstFailure)}`,
            );
          }
          const synthesis = buildLongDocumentSynthesis(
            parsed.title,
            sectionOutcomes,
          );
          setOrganizeProgress({
            sourceIndex: index,
            sourceTotal: selected.length,
            sourceTitle: parsed.title,
            phase: "synthesis",
            completedSections: successfulSections,
            sectionTotal: sections.length,
          });
          organized = await organizeWithAI({
            content: synthesis,
            sourceName: parsed.fileName,
            spaceName: importSnapshot.workspace.name,
            spaceDescription: importSnapshot.workspace.description,
            existingNotes: relevantExistingNotesForSynthesis(
              existingNotes,
              synthesis,
            ),
            model: importSnapshot.settings.model,
            effort: importSnapshot.settings.reasoningEffort,
            taskInstructions: longDocumentSynthesisInstructions(
              parsed.title,
              successfulSections,
              sections.length,
              baseTaskInstructions,
            ),
            organizationInstructions:
              importSnapshot.settings.organizationInstructions,
          });
          for (const outcome of sectionOutcomes) {
            if (!outcome.error) continue;
            issues.push({
              itemId: item.id,
              fileName: item.fileName,
              message: `Section ${outcome.section.index + 1} of ${sections.length} could not be read (${errorMessage(outcome.error)}). Orion synthesized the remaining ${successfulSections} sections.`,
              usedManualFallback: false,
            });
          }
        } else {
          const content = parsed.text.slice(0, MAX_AI_CHARS_PER_SOURCE);
          organized = await organizeWithAI({
            content,
            sourceName: parsed.fileName,
            spaceName: importSnapshot.workspace.name,
            spaceDescription: importSnapshot.workspace.description,
            existingNotes,
            model: importSnapshot.settings.model,
            effort: importSnapshot.settings.reasoningEffort,
            taskInstructions: baseTaskInstructions,
            organizationInstructions:
              importSnapshot.settings.organizationInstructions,
          });
        }
        if (organized.notes.length === 0) {
          throw new Error("The organizer did not return any notes.");
        }
        organizedSources.push({ item, result: organized });
        existingNotes = mergeGeneratedOrganizerArticles(
          existingNotes,
          organized.wikiArticles,
        );
        if (
          sections.length <= 1 &&
          parsed.text.length > MAX_AI_CHARS_PER_SOURCE
        ) {
          issues.push({
            itemId: item.id,
            fileName: item.fileName,
            message:
              "This source was trimmed for AI organization; the full text is still preserved in Sources.",
            usedManualFallback: false,
          });
        }
      } catch (error) {
        organizedSources.push({ item });
        issues.push({
          itemId: item.id,
          fileName: item.fileName,
          message: errorMessage(error),
          usedManualFallback: true,
        });
      }
    }

    setOrganizeProgress({
      sourceIndex: selected.length,
      sourceTotal: selected.length,
      sourceTitle: "Connecting your notes",
      phase: "synthesis",
      completedSections: 0,
      sectionTotal: 0,
    });
    const payload = buildImportPayload(
      organizedSources,
      importSnapshot,
      effectiveMode === "ai" ? importGuidance : "",
    );
    setOrganizeIssues(issues);
    const baseSnapshotVersion = stableSnapshotVersion(importSnapshot);
    setResult({ ...payload, baseSnapshotVersion });
    setResultBaseSnapshotVersion(baseSnapshotVersion);
    setStage("results");
  };

  const applyResult = async () => {
    if (!result || result.notes.length === 0) {
      return;
    }

    setApplying(true);
    setApplyError("");
    try {
      if (
        resultBaseSnapshotVersion &&
        stableSnapshotVersion(snapshotRef.current) !== resultBaseSnapshotVersion
      ) {
        throw new Error(
          "This Space changed after Orion finished reading. Return to Review so Orion can use the current notes safely.",
        );
      }
      await onApply({
        baseSnapshotVersion: result.baseSnapshotVersion,
        notes: result.notes.map((note) => ({
          ...note,
          aliases: [...note.aliases],
          tags: [...note.tags],
          conceptIds: [...note.conceptIds],
          sourceIds: [...note.sourceIds],
        })),
        sources: result.sources.map((source) => ({
          ...source,
          noteIds: [...source.noteIds],
        })),
        concepts: result.concepts.map((concept) => ({
          ...concept,
          aliases: [...concept.aliases],
          noteIds: [...concept.noteIds],
        })),
        relationships: result.relationships.map((relationship) => ({
          ...relationship,
        })),
      });
      const appliedIds = organizedImportIdsRef.current;
      reset(itemsRef.current.filter(({ id }) => !appliedIds.has(id))
        .map((item) => item.status === "ready" ? { ...item, included: true } : item));
      onClose();
    } catch (error) {
      setApplyError(errorMessage(error));
    } finally {
      setApplying(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab") {
      return;
    }
    event.stopPropagation();

    const dialog = event.currentTarget;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((element) => !element.hidden);
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) {
    return null;
  }

  const canClose = stage !== "organizing" && !applying;
  const sourceProgress =
    organizeProgress.sourceIndex >= organizeProgress.sourceTotal
      ? 1
      : organizeProgress.phase === "sections" &&
          organizeProgress.sectionTotal > 0
        ? (organizeProgress.completedSections /
            organizeProgress.sectionTotal) *
          0.82
        : organizeProgress.phase === "synthesis"
          ? 0.9
          : 0.08;
  const progressPercent =
    organizeProgress.sourceTotal > 0
      ? organizeProgress.sourceIndex >= organizeProgress.sourceTotal
        ? 100
        : Math.round(
            ((organizeProgress.sourceIndex + sourceProgress) /
              organizeProgress.sourceTotal) *
              100,
          )
      : 0;
  const manualFallbackCount = organizeIssues.reduce(
    (count, { usedManualFallback }) => count + Number(usedManualFallback),
    0,
  );

  return (
    <div
      className="import-studio__backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && canClose) {
          onClose();
        }
      }}
    >
      <div
        className="import-studio"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="import-studio__header">
          <div className="import-studio__brand">
            <span className="import-studio__brand-mark" aria-hidden="true">
              <Files size={16} strokeWidth={1.8} />
            </span>
            <div>
              <span className="import-studio__eyebrow">Add knowledge</span>
              <h2 id={titleId}>Import</h2>
            </div>
          </div>
          <p id={descriptionId}>
            Turn loose source material into reviewable, connected wiki notes.
          </p>
          <button
            className="import-studio__close"
            type="button"
            aria-label="Close import"
            disabled={!canClose}
            onClick={onClose}
          >
            <X aria-hidden="true" size={18} strokeWidth={1.7} />
          </button>
        </header>

        <ol className="import-studio__steps" aria-label="Import progress">
          {STAGES.map((item, index) => {
            const complete = index < activeStageIndex;
            const active = item.id === stage;
            return (
              <li
                className={clsx(
                  "import-studio__step",
                  active && "import-studio__step--active",
                  complete && "import-studio__step--complete",
                )}
                key={item.id}
                aria-current={active ? "step" : undefined}
              >
                <span>
                  {complete ? (
                    <Check aria-hidden="true" size={12} strokeWidth={2.2} />
                  ) : (
                    item.shortLabel
                  )}
                </span>
                {item.label}
              </li>
            );
          })}
        </ol>

        <div className="import-studio__body">
          {stage === "add" && (
            <section
              className="import-studio__stage import-studio__stage--add"
              aria-labelledby={`${titleId}-add`}
            >
              <div className="import-studio__stage-heading">
                <div>
                  <span className="import-studio__eyebrow">Bring anything</span>
                  <h3 id={`${titleId}-add`}>Gather your source material</h3>
                </div>
                <span className="import-studio__limit">
                  Up to {MAX_FILES} files · {formatBytes(MAX_FILE_BYTES)} each
                </span>
              </div>

              <div className="import-studio__unified-intake">
                <div className="import-studio__intake-card">
                  <span className="import-studio__drop-icon" aria-hidden="true">
                    <Files size={25} strokeWidth={1.5} />
                  </span>
                  <div className="import-studio__intake-copy">
                    <strong>Files, images, audio, or video</strong>
                    <p>
                      Documents and images are read locally. Media is
                      transcribed on-device with Orion’s bundled Whisper model.
                    </p>
                  </div>
                  <div className="import-studio__intake-actions">
                    <button
                      className="button soft"
                      type="button"
                      disabled={items.length >= MAX_FILES}
                      onClick={() => setFileChoiceOpen(true)}
                    >
                      <Files aria-hidden="true" size={15} />
                      Choose files, images, or media
                    </button>
                    <button
                      className="button ghost"
                      type="button"
                      disabled={items.length >= MAX_FILES}
                      onClick={() => {
                        setPasteError("");
                        setPasteOpen(true);
                      }}
                    >
                      <PenLine aria-hidden="true" size={15} />
                      Paste text
                    </button>
                  </div>
                  <small className="import-studio__intake-note">
                    Documents up to {formatBytes(MAX_FILE_BYTES)} · media up to
                    2 GB · originals never leave your Mac unless you later
                    choose AI organization
                  </small>
                  <input
                    className="import-studio__file-input"
                    ref={fileInputRef}
                    type="file"
                    accept={IMPORT_ACCEPT}
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={handleFileInput}
                  />
                  <input
                    className="import-studio__file-input"
                    ref={mediaInputRef}
                    type="file"
                    accept={MEDIA_ACCEPT}
                    multiple
                    tabIndex={-1}
                    aria-hidden="true"
                    onChange={handleMediaInput}
                  />
                </div>

                <form
                  className="import-studio__url-source"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void queueUrl();
                  }}
                >
                  <Link2 size={16} aria-hidden="true" />
                  <div className="import-studio__url-copy">
                    <label htmlFor={`${titleId}-url`}>Webpage or YouTube</label>
                    <small>
                      Webpages become readable source text. YouTube audio is
                      deleted as soon as local transcription finishes.
                    </small>
                  </div>
                  <input
                    id={`${titleId}-url`}
                    type="url"
                    value={importUrl}
                    placeholder="https://…"
                    aria-label="Webpage or YouTube URL"
                    onChange={(event) => {
                      setImportUrl(event.target.value);
                      setUrlError("");
                    }}
                  />
                  <button
                    className="button soft compact"
                    type="submit"
                    disabled={!importUrl.trim() || items.length >= MAX_FILES}
                  >
                    <Plus aria-hidden="true" size={14} />
                    Add URL
                  </button>
                  {urlError && (
                    <p className="import-studio__url-error" role="alert">
                      <AlertTriangle size={14} aria-hidden="true" />
                      {urlError}
                    </p>
                  )}
                </form>
              </div>

              {items.length > 0 && (
                <div className="import-studio__queue">
                  <div className="import-studio__queue-heading">
                    <strong>Import queue</strong>
                    <span>
                      {items.length} {items.length === 1 ? "source" : "sources"}
                    </span>
                  </div>
                  <div className="import-studio__queue-list">
                    {items.map((item) => (
                      <div
                        className={clsx(
                          "import-studio__queue-item",
                          item.status === "error" &&
                            "import-studio__queue-item--error",
                        )}
                        key={item.id}
                      >
                        <span className="import-studio__file-mark" aria-hidden="true">
                          {item.status === "parsing" ? (
                            <LoaderCircle
                              className="import-studio__spinner"
                              size={16}
                            />
                          ) : item.status === "error" ? (
                            <AlertTriangle size={16} />
                          ) : (
                            <FileText size={16} />
                          )}
                        </span>
                        <span className="import-studio__queue-copy">
                          <strong>{item.parsed?.title || item.fileName}</strong>
                          <span>
                            {item.preprocessLabel ??
                              `${item.fileName} · ${formatBytes(item.byteSize)}`}
                          </span>
                          {item.error && <em>{item.error}</em>}
                          {item.parsed?.warnings.map((warning) => (
                            <em key={warning}>{warning}</em>
                          ))}
                        </span>
                        <button
                          className="import-studio__icon-button"
                          type="button"
                          aria-label={`Remove ${item.fileName}`}
                          onClick={() => removeItem(item.id)}
                        >
                          <Trash2 aria-hidden="true" size={15} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}

          {stage === "review" && (
            <section
              className="import-studio__stage import-studio__stage--review"
              aria-labelledby={`${titleId}-review`}
            >
              <div className="import-studio__stage-heading">
                <div>
                  <span className="import-studio__eyebrow">Before the stars move</span>
                  <h3 id={`${titleId}-review`}>Review what Orion will import</h3>
                </div>
                <div className="import-studio__review-summary">
                  <span>{formatBytes(totalBytes)}</span>
                  <span>{totalWords.toLocaleString()} words</span>
                </div>
              </div>

              <div className="import-studio__review-grid">
                <div className="import-studio__source-review">
                  {items.map((item) => {
                    const ready = item.status === "ready" && Boolean(item.parsed);
                    return (
                      <div
                        className={clsx(
                          "import-studio__review-item",
                          item.included && ready &&
                            "import-studio__review-item--included",
                          item.status === "error" &&
                            "import-studio__review-item--error",
                        )}
                        key={item.id}
                      >
                        <button
                          className="import-studio__check"
                          type="button"
                          role="checkbox"
                          aria-checked={item.included && ready}
                          aria-label={`${item.included ? "Exclude" : "Include"} ${item.fileName}`}
                          disabled={!ready}
                          onClick={() => toggleItem(item.id)}
                        >
                          {item.included && ready && (
                            <Check aria-hidden="true" size={13} />
                          )}
                        </button>
                        <span className="import-studio__review-copy">
                          <span className="import-studio__review-title">
                            <strong>{item.parsed?.title || item.fileName}</strong>
                            {item.parsed && <i>{item.parsed.format}</i>}
                          </span>
                          {item.parsed && (
                            <span>{contentPreview(item.parsed.text)}</span>
                          )}
                          {item.status === "parsing" && <span>{item.preprocessLabel ?? "Preparing locally…"} You can import the ready sources now.</span>}
                          {item.error && <em>{item.error}</em>}
                          {item.parsed?.warnings.map((warning) => (
                            <em key={warning}>{warning}</em>
                          ))}
                        </span>
                        <span className="import-studio__review-size">
                          {formatBytes(item.byteSize)}
                        </span>
                        <button
                          className="import-studio__icon-button import-studio__review-remove"
                          type="button"
                          aria-label={`Remove ${item.fileName}`}
                          onClick={() => removeItem(item.id)}
                        >
                          <Trash2 aria-hidden="true" size={15} />
                        </button>
                      </div>
                    );
                  })}
                </div>

                <aside className="import-studio__mode-panel">
                  <span className="import-studio__eyebrow">Organization mode</span>
                  <button
                    className={clsx(
                      "import-studio__mode",
                      mode === "ai" && "import-studio__mode--selected",
                    )}
                    type="button"
                    disabled={!aiConfigured}
                    onClick={() => {
                      clearImportRecovery();
                      setMode("ai");
                    }}
                  >
                    <span className="import-studio__mode-icon" aria-hidden="true">
                      <Bot size={18} />
                    </span>
                    <span>
                      <strong>Organize with AI</strong>
                      <small>
                        Split concepts, create aliases, and suggest connections.
                      </small>
                    </span>
                    <span className="import-studio__mode-radio" aria-hidden="true" />
                  </button>
                  <button
                    className={clsx(
                      "import-studio__mode",
                      mode === "manual" && "import-studio__mode--selected",
                    )}
                    type="button"
                    onClick={() => {
                      clearImportRecovery();
                      setMode("manual");
                    }}
                  >
                    <span className="import-studio__mode-icon" aria-hidden="true">
                      <PenLine size={18} />
                    </span>
                    <span>
                      <strong>Import locally</strong>
                      <small>
                        One editable note per source, ready for you to shape.
                      </small>
                    </span>
                    <span className="import-studio__mode-radio" aria-hidden="true" />
                  </button>

                  {!aiConfigured && (
                    <div className="import-studio__key-note">
                      <AlertTriangle aria-hidden="true" size={15} />
                      <span>
                        No API key is configured. Your sources stay local and
                        will become editable notes without leaving your Mac.
                      </span>
                    </div>
                  )}

                  {mode === "ai" && aiConfigured && (
                    <>
                      <label className="import-studio__guidance">
                        <span>
                          Guide this import <em>Optional</em>
                        </span>
                        <small>
                          Tell Orion what matters most, what to preserve, or how
                          the notes should be shaped.
                        </small>
                        <textarea
                          value={importGuidance}
                          maxLength={MAX_IMPORT_GUIDANCE_CHARS}
                          rows={4}
                          aria-label="Guide this import"
                          placeholder="For example: Focus on the central argument and its strongest criticisms. Preserve useful examples, connect it with ideas already in this Space, and keep any explicit next steps as to-dos."
                          onChange={(event) => {
                            clearImportRecovery();
                            setImportGuidance(event.target.value);
                          }}
                        />
                        <i>
                          Leave this blank and Orion will use its normal judgement.
                        </i>
                      </label>
                      <div className="import-studio__privacy-note">
                        <Bot aria-hidden="true" size={14} />
                        Selected source text will be sent to {aiProviderName} using your
                        configured key.
                      </div>
                    </>
                  )}
                </aside>
              </div>
            </section>
          )}

          {stage === "organizing" && (
            <section
              className="import-studio__stage import-studio__stage--organizing"
              aria-labelledby={`${titleId}-organizing`}
              aria-live="polite"
            >
              <div className="import-studio__organizing-visual" aria-hidden="true">
                <span className="import-studio__organizing-core">
                  <Bot size={21} strokeWidth={1.6} />
                </span>
                <span className="import-studio__orbit import-studio__orbit--one" />
                <span className="import-studio__orbit import-studio__orbit--two" />
              </div>
              <span className="import-studio__eyebrow">
                {mode !== "ai"
                  ? "Preparing local notes"
                  : organizeProgress.phase === "orchestration"
                    ? orchestrationEyebrow(
                        organizeProgress.orchestrationStage,
                      )
                  : organizeProgress.phase === "sections"
                    ? "Reading in parallel"
                    : organizeProgress.phase === "synthesis"
                      ? "Distilling the complete reading"
                      : "Finding structure"}
              </span>
              <h3 id={`${titleId}-organizing`}>
                {mode !== "ai"
                  ? "Orion is preparing your sources"
                  : organizeProgress.phase === "orchestration"
                    ? organizeProgress.operationLabel ?? "Orion is shaping your notes"
                  : organizeProgress.phase === "sections"
                    ? "Orion is reading this document in parallel"
                    : organizeProgress.phase === "synthesis"
                      ? "Orion is shaping the complete reading"
                      : "Orion is mapping your material"}
              </h3>
              <p className="import-studio__progress-source">
                <strong>
                  {organizeProgress.sourceTitle || "Reading source material"}
                </strong>
                <span>
                  {organizeProgress.phase === "orchestration" &&
                  organizeProgress.sourceTotal > 1
                    ? `${organizeProgress.sourceTotal} source batch`
                    : `${Math.min(
                        organizeProgress.sourceIndex + 1,
                        organizeProgress.sourceTotal,
                      )} of ${organizeProgress.sourceTotal}`}
                </span>
              </p>
              {organizeProgress.phase === "orchestration" ? (
                <p className="import-studio__progress-detail">
                  <span>{organizeProgress.operationLabel}</span>
                  <span>{organizeProgress.detailLabel}</span>
                </p>
              ) : organizeProgress.sectionTotal > 0 ? (
                <p className="import-studio__progress-detail">
                  <span>
                    {organizeProgress.phase === "synthesis"
                      ? `Distilling ${organizeProgress.sectionTotal} sections`
                      : `Reading ${organizeProgress.sectionTotal} sections`}
                  </span>
                  <span>
                    {organizeProgress.phase === "synthesis"
                      ? "Writing connected notes"
                      : `Section ${Math.min(
                          organizeProgress.completedSections + 1,
                          organizeProgress.sectionTotal,
                        )} of ${organizeProgress.sectionTotal}`}
                  </span>
                </p>
              ) : null}
              <div
                className={clsx("import-studio__progress", {
                  "import-studio__progress--indeterminate":
                    organizeProgress.phase === "orchestration",
                })}
                role="progressbar"
                aria-valuemin={0}
                {...(organizeProgress.phase === "orchestration"
                  ? { "aria-label": organizeProgress.operationLabel }
                  : { "aria-valuemax": 100, "aria-valuenow": progressPercent })}
              >
                <span
                  {...(organizeProgress.phase === "orchestration"
                    ? {}
                    : { style: { width: `${progressPercent}%` } })}
                />
              </div>
              <small>
                {organizeProgress.phase === "orchestration"
                  ? orchestrationReassurance(
                      organizeProgress.orchestrationStage,
                      snapshot.settings.includeExistingNotesInAIContext &&
                        snapshot.notes.length > 0,
                    )
                  : "Keep this window open while the import completes."}
              </small>
              {organizeProgress.phase === "orchestration" && (
                <button
                  className="button ghost import-studio__cancel-run"
                  type="button"
                  onClick={() =>
                    organizeAbortRef.current?.abort(
                      new Error("The knowledge import was cancelled."),
                    )
                  }
                >
                  Cancel
                </button>
              )}
            </section>
          )}

          {stage === "results" && result && (
            <section
              className="import-studio__stage import-studio__stage--results"
              aria-labelledby={`${titleId}-results`}
            >
              <div
                className={clsx(
                  "import-studio__result-hero",
                  importDiagnostic && "import-studio__result-hero--paused",
                )}
              >
                <span className="import-studio__result-mark" aria-hidden="true">
                  {importDiagnostic ? (
                    <RefreshCw size={22} strokeWidth={1.6} />
                  ) : (
                    <CheckCircle2 size={24} strokeWidth={1.6} />
                  )}
                </span>
                <div>
                  <span className="import-studio__eyebrow">
                    {importDiagnostic ? "Import paused" : "Ready for your atlas"}
                  </span>
                  <h3 id={`${titleId}-results`}>
                    {importDiagnostic
                      ? importDiagnostic.summary
                      : `${result.notes.length} ${
                          result.notes.length === 1 ? "note" : "notes"
                        } prepared`}
                  </h3>
                  <p>
                    {importDiagnostic
                      ? diagnosticProgressText(importDiagnostic)
                      : "Orion shaped your source material into connected notes that can keep evolving with this Space."}
                  </p>
                </div>
              </div>

              {importDiagnostic && (
                <section
                  className="import-studio__diagnostic"
                  aria-label="Import diagnostic"
                  role="alert"
                >
                  <div className="import-studio__diagnostic-heading">
                    <span>
                      <small>Stopped during</small>
                      <strong>{diagnosticStageLabel(importDiagnostic.stage)}</strong>
                    </span>
                    <i>{importDiagnostic.code.replace(/-/g, " ")}</i>
                  </div>
                  <p>{importDiagnostic.technicalDetail}</p>
                  <div className="import-studio__diagnostic-progress">
                    {importDiagnostic.totalReadings > 0 && (
                      <span>
                        <strong>{importDiagnostic.completedReadings}</strong>
                        <small>of {importDiagnostic.totalReadings} readings retained</small>
                      </span>
                    )}
                    {importDiagnostic.totalWrites > 0 && (
                      <span>
                        <strong>{importDiagnostic.completedWrites}</strong>
                        <small>of {importDiagnostic.totalWrites} notes retained</small>
                      </span>
                    )}
                    <span>
                      <strong>{importDiagnostic.resumable ? "Resume" : "Retry"}</strong>
                      <small>
                        {importDiagnostic.resumable
                          ? "continues from the saved checkpoint"
                          : "starts a fresh knowledge run"}
                      </small>
                    </span>
                  </div>
                  <details>
                    <summary>
                      Technical details
                      <ChevronDown aria-hidden="true" size={14} />
                    </summary>
                    <dl>
                      <div>
                        <dt>Run</dt>
                        <dd>{importDiagnostic.runId}</dd>
                      </div>
                      <div>
                        <dt>Model</dt>
                        <dd>{importDiagnostic.model}</dd>
                      </div>
                      <div>
                        <dt>Recorded</dt>
                        <dd>{new Date(importDiagnostic.occurredAt).toLocaleString()}</dd>
                      </div>
                    </dl>
                  </details>
                  <p className="import-studio__diagnostic-preservation">
                    Your complete source text is preserved in this import. You can
                    retry, or keep the available notes and sources as they are.
                  </p>
                </section>
              )}

              <div className="import-studio__result-stats">
                <span>
                  <strong>{result.notes.length}</strong>
                  Notes
                </span>
                <span>
                  <strong>{result.relationships.length}</strong>
                  Connections
                </span>
                <span>
                  <strong>{result.sources.length}</strong>
                  Sources
                </span>
              </div>

              {!importDiagnostic && organizeIssues.length > 0 && (
                <div className="import-studio__issues">
                  <div className="import-studio__issues-heading">
                    <AlertTriangle aria-hidden="true" size={15} />
                    <strong>Import notes</strong>
                  </div>
                  {organizeIssues.map((issue) => (
                    <p key={`${issue.itemId}:${issue.message}`}>
                      <strong>{issue.fileName}</strong>
                      <span>{issue.message}</span>
                    </p>
                  ))}
                  {manualFallbackCount > 0 && (
                    <p className="import-studio__preservation-note">
                      <span>
                        {manualFallbackCount === 1
                          ? "The complete source remains in Sources. Orion also created an editable preview note."
                          : "The complete sources remain in Sources. Orion also created editable preview notes."}
                      </span>
                    </p>
                  )}
                </div>
              )}

              <div className="import-studio__result-list">
                {result.notes.map((note, index) => (
                  <article className="import-studio__result-note" key={note.id}>
                    <span className="import-studio__result-index">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div>
                      <span className="import-studio__result-title">
                        <strong>{note.title}</strong>
                      </span>
                      <p>{note.summary}</p>
                      <span className="import-studio__result-tags">
                        {visibleNoteTags(note).slice(0, 4).map((tag) => (
                          <i key={tag}>{tag}</i>
                        ))}
                        {note.aliases.length > 0 && (
                          <small>
                            {note.aliases.length}{" "}
                            {note.aliases.length === 1 ? "alias" : "aliases"}
                          </small>
                        )}
                      </span>
                    </div>
                  </article>
                ))}
              </div>

              {applyError && (
                <div className="import-studio__apply-error" role="alert">
                  <AlertTriangle aria-hidden="true" size={15} />
                  {applyError}
                </div>
              )}
            </section>
          )}
        </div>

        {fileChoiceOpen && (
          <div
            className="import-studio__nested-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setFileChoiceOpen(false);
              }
            }}
          >
            <div
              ref={fileChoiceDialogRef}
              className="import-studio__nested-sheet import-studio__file-choice"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${titleId}-file-choice`}
              tabIndex={-1}
              onKeyDown={handleDialogKeyDown}
            >
              <header className="import-studio__nested-header">
                <div>
                  <span className="import-studio__eyebrow">Add to queue</span>
                  <h3 id={`${titleId}-file-choice`}>Choose a source</h3>
                </div>
                <button
                  className="import-studio__icon-button"
                  type="button"
                  aria-label="Close file choices"
                  onClick={() => setFileChoiceOpen(false)}
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </header>
              <div className="import-studio__file-choice-grid">
                <button type="button" onClick={chooseDocuments}>
                  <FileText size={20} aria-hidden="true" />
                  <span>
                    <strong>Documents &amp; images</strong>
                    <small>
                      PDF, DOCX, Markdown, data, PNG/JPEG screenshots, or HEIC
                      whiteboard photos
                    </small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
                <button type="button" onClick={chooseMedia}>
                  <AudioLines size={20} aria-hidden="true" />
                  <span>
                    <strong>Audio or video</strong>
                    <small>
                      MP3, MP4, M4A, WAV, WebM, OGG, FLAC, or MPEG
                    </small>
                  </span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              </div>
              <p className="import-studio__nested-note">
                Media follows the native picker so even very large recordings
                never pass through renderer IPC.
              </p>
            </div>
          </div>
        )}

        {pasteOpen && (
          <div
            className="import-studio__nested-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setPasteOpen(false);
              }
            }}
          >
            <form
              ref={pasteDialogRef}
              className="import-studio__nested-sheet import-studio__paste-sheet"
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${titleId}-paste`}
              tabIndex={-1}
              onKeyDown={handleDialogKeyDown}
              onSubmit={(event) => {
                event.preventDefault();
                addPastedText();
              }}
            >
              <header className="import-studio__nested-header">
                <div>
                  <span className="import-studio__eyebrow">Direct source</span>
                  <h3 id={`${titleId}-paste`}>Paste text</h3>
                </div>
                <button
                  className="import-studio__icon-button"
                  type="button"
                  aria-label="Close pasted text"
                  onClick={() => setPasteOpen(false)}
                >
                  <X aria-hidden="true" size={16} />
                </button>
              </header>
              <div className="import-studio__paste-sheet-body">
                <label className="import-studio__field">
                  <span>Title <em>Optional</em></span>
                  <input
                    type="text"
                    value={pastedTitle}
                    maxLength={100}
                    placeholder="Pasted notes"
                    onChange={(event) => {
                      setPastedTitle(event.target.value);
                      setPasteError("");
                    }}
                  />
                </label>
                <label className="import-studio__field">
                  <span>Text</span>
                  <textarea
                    ref={pasteBodyRef}
                    value={pastedText}
                    rows={12}
                    placeholder="Paste something worth remembering…"
                    onChange={(event) => {
                      setPastedText(event.target.value);
                      setPasteError("");
                    }}
                  />
                </label>
                {pasteError && (
                  <p className="import-studio__paste-error" role="alert">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {pasteError}
                  </p>
                )}
              </div>
              <footer className="import-studio__nested-actions">
                <button
                  className="button ghost"
                  type="button"
                  onClick={() => setPasteOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="button primary"
                  type="submit"
                  disabled={!pastedText.trim()}
                >
                  <Plus size={15} aria-hidden="true" />
                  Add to queue
                </button>
              </footer>
            </form>
          </div>
        )}

        <footer className="import-studio__footer">
          <span className="import-studio__footer-note">
            {stage === "add" && items.length === 0
              ? "Nothing is imported until you review it."
              : stage === "add" && parsing
                ? `${readyItems.length} ready · other sources are still preparing`
              : stage === "review"
                ? `${readyItems.length} selected ${readyItems.length === 1 ? "source" : "sources"}`
                : stage === "results" && result
                  ? "Concepts with existing IDs will be safely updated."
                  : stage === "add"
                    ? `${readyItems.length} ${readyItems.length === 1 ? "source is" : "sources are"} ready to review.`
                    : "Original sources are preserved while Orion prepares your notes."}
          </span>

          <div className="import-studio__footer-actions">
            {stage === "review" && (
              <button
                className="button ghost"
                type="button"
                onClick={() => { reviewedImportIdsRef.current = null; setStage("add"); }}
              >
                <ArrowLeft aria-hidden="true" size={15} />
                Back
              </button>
            )}

            {stage === "add" && (
              <button
                className="button primary"
                type="button"
                disabled={readyItems.length === 0}
                onClick={() => {
                  reviewedImportIdsRef.current = new Set(readyItems.map(({ id }) => id));
                  updateItems((current) => current);
                  setStage("review");
                }}
              >
                Review sources
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            )}

            {stage === "review" && (
              <button
                className="button primary"
                type="button"
                disabled={readyItems.length === 0}
                onClick={() => void organize()}
              >
                {mode === "ai" && aiConfigured ? (
                  <>
                    <Bot aria-hidden="true" size={15} />
                    Organize with AI
                  </>
                ) : (
                  <>
                    <PenLine aria-hidden="true" size={15} />
                    Create notes
                  </>
                )}
              </button>
            )}

            {stage === "results" && result && (
              <>
                <button
                  className="button ghost"
                  type="button"
                  disabled={applying}
                  onClick={() => {
                    clearImportRecovery();
                    setStage("review");
                  }}
                >
                  <ArrowLeft aria-hidden="true" size={15} />
                  Adjust import
                </button>
                <button
                  className={clsx(
                    "button",
                    importDiagnostic ? "ghost" : "primary",
                  )}
                  type="button"
                  disabled={applying || result.notes.length === 0}
                  onClick={() => void applyResult()}
                >
                  {applying ? (
                    <LoaderCircle
                      className="import-studio__spinner"
                      aria-hidden="true"
                      size={15}
                    />
                  ) : (
                    <Check aria-hidden="true" size={15} />
                  )}
                  {applying
                    ? "Adding to Orion…"
                    : importDiagnostic
                      ? "Keep preview"
                      : "Add to Orion"}
                </button>
                {importDiagnostic && (
                  <button
                    className="button primary"
                    type="button"
                    disabled={applying}
                    onClick={() =>
                      void organize(
                        importDiagnostic.resumable
                          ? importCheckpoint ?? undefined
                          : undefined,
                      )
                    }
                  >
                    <RefreshCw aria-hidden="true" size={15} />
                    {importDiagnostic.resumable ? "Resume import" : "Retry import"}
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
