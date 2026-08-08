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
  FileText,
  Files,
  Link2,
  LoaderCircle,
  PenLine,
  Plus,
  Trash2,
  X,
} from "../lib/icons";
import { nanoid } from "nanoid";
import clsx from "clsx";
import {
  reconcileConceptVocabulary,
  type ConceptSeed,
} from "../lib/concepts";
import {
  detectSourceKind,
  IMPORT_ACCEPT,
  parseImportFiles,
} from "../lib/files";
import {
  isTauriRuntime,
  fetchWebPage,
  organizeWithAI,
  recognizeDocumentText,
  transcribeMediaFiles,
  transcribeYouTube,
} from "../lib/storage";
import {
  isSelectedAIConfigured,
  selectedAIProviderName,
} from "../lib/ai";
import { visibleNoteTags } from "../lib/noteMetadata";
import { truncateUnicode } from "../lib/text";
import { transcriptToParsedImport } from "../lib/transcription";
import type {
  AppSnapshot,
  Concept,
  EntityId,
  ExistingNoteContext,
  Note,
  OrganizeContentResult,
  OrganizedNote,
  OrganizedWikiArticle,
  ParsedImport,
  Relationship,
  Source,
  TranscribedMedia,
  WhisperConfig,
} from "../types";

const MAX_FILES = 12;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_AI_CHARS_PER_SOURCE = 60_000;
const MAX_MANUAL_CHARS_PER_SOURCE = 200_000;
const MAX_NOTES_PER_SOURCE = 8;
const MAX_WIKI_ARTICLES_PER_SOURCE = 20;
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

interface OrganizedSource {
  item: ImportItem;
  result?: OrganizeContentResult;
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

  return "Orion could not read this source.";
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

  for (const { item, result } of organizedSources) {
    const parsed = item.parsed;
    if (!parsed) {
      continue;
    }

    const sourceId = `source_${nanoid(12)}`;
    const organizedNotes =
      result?.notes.length
        ? result.notes.slice(0, MAX_NOTES_PER_SOURCE)
        : [manualOrganizedNote(parsed)];
    const sourceNoteIds: EntityId[] = [];

    organizedNotes.forEach((organized) => {
      if (generatedContexts.length >= MAX_TOTAL_GENERATED_NOTES) {
        return;
      }
      const noteId = `note_${nanoid(12)}`;
      sourceNoteIds.push(noteId);
      generatedContexts.push({
        contributions: [{ sourceId, organized }],
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
          sourceIds: [sourceId],
          createdAt: now,
          updatedAt: now,
        },
      });
    });

    for (const article of
      result?.wikiArticles.slice(0, MAX_WIKI_ARTICLES_PER_SOURCE) ?? []) {
      const title = article.title.trim();
      const key = normalize(title);
      if (!key) {
        continue;
      }
      let context = wikiContextByTitle.get(key);
      if (context) {
        context.note = mergeWikiArticle(
          context.note,
          article,
          sourceId,
          snapshot.workspace.name,
          now,
        );
        context.contributions.push({ sourceId, organized: article });
      } else {
        const existing = resolveExistingWikiArticle(title);
        if (!existing && generatedContexts.length >= MAX_TOTAL_GENERATED_NOTES) {
          continue;
        }
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
        context = {
          note: mergeWikiArticle(
            base,
            article,
            sourceId,
            snapshot.workspace.name,
            now,
          ),
          contributions: [{ sourceId, organized: article }],
        };
        generatedContexts.push(context);
        wikiContextByTitle.set(key, context);
      }
      sourceNoteIds.push(context.note.id);
    }

    sources.push({
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
      noteIds: unique(sourceNoteIds),
    });
    sourceIdByItemId.set(item.id, sourceId);
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
  ) => {
    if (fromNoteId === toNoteId) {
      return;
    }
    const key = `${fromNoteId}>${toNoteId}:related`;
    if (relationshipKeys.has(key)) {
      return;
    }
    relationshipKeys.add(key);
    relationships.push({
      id: `relationship_${nanoid(12)}`,
      fromNoteId,
      toNoteId,
      kind: "related",
      label: "related to",
      strength,
      sourceId,
      context: context.trim() || "Suggested during import.",
    });
  };

  generatedContexts.forEach(({ note, contributions }) => {
    contributions.forEach(({ sourceId, organized }) => {
      organized.links.slice(0, 16).forEach((link) => {
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
      concept.relatedTitles.slice(0, 16).forEach((title) => {
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
    result.suggestedConnections.slice(0, 18).forEach((connection) => {
      const from = targetForTitle(connection.fromTitle);
      const to = targetForTitle(connection.toTitle);
      if (from && to) {
        addRelationship(
          from.id,
          to.id,
          sourceId,
          connection.reason,
          0.64,
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
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [organizeIssues, setOrganizeIssues] = useState<OrganizeIssue[]>([]);
  const [result, setResult] = useState<ImportStudioApplyPayload | null>(null);
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);

  const updateItems = (
    updater: (current: ImportItem[]) => ImportItem[],
  ) => {
    const next = updater(itemsRef.current);
    itemsRef.current = next;
    setItems(next);
  };

  const reset = () => {
    setStage("add");
    itemsRef.current = [];
    setItems([]);
    setPastedTitle("");
    setPastedText("");
    setPasteOpen(false);
    setPasteError("");
    setFileChoiceOpen(false);
    setImportUrl("");
    setUrlError("");
    setMode(aiConfigured ? "ai" : "manual");
    setImportGuidance("");
    setProgressIndex(0);
    setProgressLabel("");
    setOrganizeIssues([]);
    setResult(null);
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
            async (document) => {
              updateItems((current) =>
                current.map((currentItem) =>
                  currentItem.id === item.id
                    ? {
                        ...currentItem,
                        preprocessLabel: "Recognizing text locally…",
                      }
                    : currentItem,
                ),
              );
              return recognizeDocumentText(document);
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
    updateItems((current) =>
      current.map((item) =>
        item.id === itemId && item.status === "ready"
          ? { ...item, included: !item.included }
          : item,
      ),
    );
  };

  const organize = async () => {
    const selected = readyItems;
    if (selected.length === 0) {
      return;
    }

    const effectiveMode: ImportMode =
      mode === "ai" && aiConfigured ? "ai" : "manual";
    setStage("organizing");
    setProgressIndex(0);
    setOrganizeIssues([]);
    setApplyError("");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    const organizedSources: OrganizedSource[] = [];
    const issues: OrganizeIssue[] = [];
    const existingNotes: ExistingNoteContext[] | undefined =
      snapshot.settings.includeExistingNotesInAIContext
      ? [...snapshot.notes]
          .sort(
            (left, right) =>
              Number(right.kind === "wiki") -
              Number(left.kind === "wiki"),
          )
          .slice(0, 80)
          .map((note) => ({
            id: note.id,
            title: note.title,
            aliases: [...note.aliases],
            summary: note.summary,
            reference: note.kind === "wiki",
            ...(note.kind === "wiki"
              ? { body: note.body.slice(0, 6_000) }
              : {}),
          }))
      : undefined;

    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index];
      const parsed = item.parsed;
      if (!parsed) {
        continue;
      }

      setProgressIndex(index);
      setProgressLabel(parsed.title);

      if (effectiveMode === "manual") {
        organizedSources.push({ item });
        continue;
      }

      try {
        const content = parsed.text.slice(0, MAX_AI_CHARS_PER_SOURCE);
        const organized = await organizeWithAI({
          content,
          sourceName: parsed.fileName,
          spaceName: snapshot.workspace.name,
          spaceDescription: snapshot.workspace.description,
          existingNotes,
          model: snapshot.settings.model,
          effort: snapshot.settings.reasoningEffort,
          taskInstructions:
            buildImportOrganizationInstructions(importGuidance),
          organizationInstructions:
            snapshot.settings.organizationInstructions,
        });
        if (organized.notes.length === 0) {
          throw new Error("The organizer did not return any notes.");
        }
        organizedSources.push({ item, result: organized });
        if (existingNotes) {
          for (const article of organized.wikiArticles) {
            const key = normalize(article.title);
            const revisedBody =
              article.body.trim() ||
              wikiArticleBody(article, snapshot.workspace.name);
            const existingIndex = existingNotes.findIndex(
              (note) =>
                normalize(note.title) === key ||
                note.aliases.some((alias) => normalize(alias) === key),
            );
            if (existingIndex >= 0) {
              existingNotes[existingIndex] = {
                ...existingNotes[existingIndex],
                summary:
                  article.summary.trim() ||
                  existingNotes[existingIndex].summary,
                reference: true,
                body: revisedBody,
              };
            } else {
              if (existingNotes.length >= 80) {
                existingNotes.pop();
              }
              existingNotes.push({
                id: `pending-wiki:${key}`,
                title: article.title.trim(),
                aliases: [...article.aliases],
                summary: article.summary.trim(),
                reference: true,
                body: revisedBody,
              });
            }
          }
        }
        if (parsed.text.length > MAX_AI_CHARS_PER_SOURCE) {
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

    setProgressIndex(selected.length);
    setProgressLabel("Connecting your notes");
    const payload = buildImportPayload(
      organizedSources,
      snapshot,
      effectiveMode === "ai" ? importGuidance : "",
    );
    setOrganizeIssues(issues);
    setResult(payload);
    setStage("results");
  };

  const applyResult = async () => {
    if (!result || result.notes.length === 0) {
      return;
    }

    setApplying(true);
    setApplyError("");
    try {
      await onApply({
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
      reset();
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
  const progressPercent =
    readyItems.length > 0
      ? Math.round((progressIndex / readyItems.length) * 100)
      : 0;

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
                    onClick={() => setMode("ai")}
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
                    onClick={() => setMode("manual")}
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
                          onChange={(event) =>
                            setImportGuidance(event.target.value)
                          }
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
                {mode === "ai" ? "Finding structure" : "Preparing local notes"}
              </span>
              <h3 id={`${titleId}-organizing`}>
                {mode === "ai"
                  ? "Orion is mapping your material"
                  : "Orion is preparing your sources"}
              </h3>
              <p>
                {progressLabel || "Reading source material"} ·{" "}
                {Math.min(progressIndex + 1, readyItems.length)} of{" "}
                {readyItems.length}
              </p>
              <div
                className="import-studio__progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
              >
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              <small>Keep this window open while the import completes.</small>
            </section>
          )}

          {stage === "results" && result && (
            <section
              className="import-studio__stage import-studio__stage--results"
              aria-labelledby={`${titleId}-results`}
            >
              <div className="import-studio__result-hero">
                <span className="import-studio__result-mark" aria-hidden="true">
                  <CheckCircle2 size={24} strokeWidth={1.6} />
                </span>
                <div>
                  <span className="import-studio__eyebrow">Ready for your atlas</span>
                  <h3 id={`${titleId}-results`}>
                    {result.notes.length}{" "}
                    {result.notes.length === 1 ? "page" : "pages"} found
                  </h3>
                  <p>
                    Orion shaped your source material into connected notes that
                    can keep evolving with this Space.
                  </p>
                </div>
              </div>

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

              {organizeIssues.length > 0 && (
                <div className="import-studio__issues">
                  <div className="import-studio__issues-heading">
                    <AlertTriangle aria-hidden="true" size={15} />
                    <strong>Import notes</strong>
                  </div>
                  {organizeIssues.map((issue) => (
                    <p key={`${issue.itemId}:${issue.message}`}>
                      <strong>{issue.fileName}</strong>
                      <span>
                        {issue.message}
                        {issue.usedManualFallback &&
                          " Orion preserved it as an editable local note instead."}
                      </span>
                    </p>
                  ))}
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
              : stage === "review"
                ? `${readyItems.length} selected ${readyItems.length === 1 ? "source" : "sources"}`
                : stage === "results" && result
                  ? "Concepts with existing IDs will be safely updated."
                  : "Working source by source to keep the result bounded."}
          </span>

          <div className="import-studio__footer-actions">
            {stage === "review" && (
              <button
                className="button ghost"
                type="button"
                onClick={() => setStage("add")}
              >
                <ArrowLeft aria-hidden="true" size={15} />
                Back
              </button>
            )}

            {stage === "add" && (
              <button
                className="button primary"
                type="button"
                disabled={readyItems.length === 0 || parsing}
                onClick={() => setStage("review")}
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
                  onClick={() => setStage("review")}
                >
                  <ArrowLeft aria-hidden="true" size={15} />
                  Adjust import
                </button>
                <button
                  className="button primary"
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
                  {applying ? "Adding to Orion…" : "Add to Orion"}
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
