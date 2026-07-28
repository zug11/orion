import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
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
  CirclePlay,
  FileText,
  Files,
  LoaderCircle,
  PenLine,
  Plus,
  Sparkles,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { nanoid } from "nanoid";
import clsx from "clsx";
import {
  reconcileConceptVocabulary,
  type ConceptSeed,
} from "../lib/concepts";
import { IMPORT_ACCEPT, parseImportFiles } from "../lib/files";
import {
  isTauriRuntime,
  organizeWithAI,
  transcribeMediaFiles,
  transcribeYouTube,
} from "../lib/storage";
import { transcriptToParsedImport } from "../lib/transcription";
import type {
  AppSnapshot,
  Concept,
  EntityId,
  Note,
  NoteKind,
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
const MAX_TOTAL_GENERATED_NOTES = 30;
const MEDIA_ACCEPT =
  ".flac,.m4a,.mp3,.mp4,.mpeg,.mpga,.ogg,.wav,.webm,audio/*,video/mp4,video/webm";
type ImportStage = "add" | "review" | "organizing" | "results";
type ImportMode = "ai" | "manual";
type ItemStatus = "parsing" | "ready" | "error";

interface ImportItem {
  id: EntityId;
  fileName: string;
  mimeType: string;
  byteSize: number;
  status: ItemStatus;
  included: boolean;
  parsed?: ParsedImport;
  error?: string;
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

function inferNoteKind(note: OrganizedNote): NoteKind {
  const tags = new Set(note.tags.map(normalize));
  if (tags.has("person") || tags.has("people")) {
    return "person";
  }
  if (tags.has("place") || tags.has("location")) {
    return "place";
  }
  if (tags.has("project")) {
    return "project";
  }
  if (tags.has("idea") || tags.has("concept")) {
    return "idea";
  }
  if (note.links.length >= 5) {
    return "hub";
  }
  return "article";
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
    details ? "## From the imported material" : "",
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
  sourceTitle: string,
  spaceName: string,
  now: string,
): Note {
  const marker = `<!-- orion-source:${sourceId} -->`;
  const details = unique(article.sourceGroundedDetails)
    .map((detail) => `- ${detail}`)
    .join("\n");
  const supplement = [
    marker,
    `## Context from ${sourceTitle}`,
    article.spaceRelevance.trim(),
    details,
  ]
    .filter(Boolean)
    .join("\n\n");
  const currentBody = note.body.trim();
  const body = !currentBody
    ? wikiArticleBody(article, spaceName)
    : currentBody.includes(marker)
      ? currentBody
      : `${currentBody}\n\n${supplement}`;
  return {
    ...note,
    summary: note.summary.trim() || article.summary.trim(),
    body,
    aliases: unique([...note.aliases, ...article.aliases]).slice(0, 16),
    tags: unique([
      ...note.tags,
      ...article.tags,
      "wiki-article",
      "ai-draft",
    ]).slice(0, 12),
    kind: "wiki",
    sourceIds: unique([...note.sourceIds, sourceId]),
    updatedAt: now,
  };
}

export function buildImportPayload(
  organizedSources: readonly OrganizedSource[],
  snapshot: AppSnapshot,
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
      .filter((concept) => normalize(concept.label) === key)
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
          kind: inferNoteKind(organized),
          status: "draft",
          conceptIds: [],
          sourceIds: [sourceId],
          createdAt: now,
          updatedAt: now,
        },
      });
    });

    for (const article of result?.wikiArticles.slice(0, 8) ?? []) {
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
          parsed.title,
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
            status: "draft",
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
            parsed.title,
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
  const rawId = useId().replace(/:/g, "");
  const titleId = `import-studio-title-${rawId}`;
  const descriptionId = `import-studio-description-${rawId}`;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<ImportStage>("add");
  const [items, setItems] = useState<ImportItem[]>([]);
  const [pastedTitle, setPastedTitle] = useState("Pasted notes");
  const [pastedText, setPastedText] = useState("");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [transcribing, setTranscribing] = useState<
    "media" | "youtube" | null
  >(null);
  const [transcriptionError, setTranscriptionError] = useState("");
  const [mode, setMode] = useState<ImportMode>(
    snapshot.settings.apiKeyConfigured ? "ai" : "manual",
  );
  const [dragActive, setDragActive] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [organizeIssues, setOrganizeIssues] = useState<OrganizeIssue[]>([]);
  const [result, setResult] = useState<ImportStudioApplyPayload | null>(null);
  const [applyError, setApplyError] = useState("");
  const [applying, setApplying] = useState(false);

  const reset = () => {
    setStage("add");
    setItems([]);
    setPastedTitle("Pasted notes");
    setPastedText("");
    setYoutubeUrl("");
    setTranscribing(null);
    setTranscriptionError("");
    setMode(snapshot.settings.apiKeyConfigured ? "ai" : "manual");
    setDragActive(false);
    setProgressIndex(0);
    setProgressLabel("");
    setOrganizeIssues([]);
    setResult(null);
    setApplyError("");
    setApplying(false);
  };

  useEffect(() => {
    if (!open) {
      reset();
      return undefined;
    }

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
    if (!open) return undefined;

    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        stage !== "organizing" &&
        !applying
      ) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("keydown", handleEscape);
    };
  }, [applying, onClose, open, stage]);

  const readyItems = useMemo(
    () =>
      items.filter(
        (item) =>
          item.status === "ready" && item.included && Boolean(item.parsed),
      ),
    [items],
  );
  const parsing =
    items.some((item) => item.status === "parsing") ||
    transcribing !== null;
  const totalBytes = readyItems.reduce(
    (total, item) => total + item.byteSize,
    0,
  );
  const totalWords = readyItems.reduce(
    (total, item) => total + wordCount(item.parsed?.text ?? ""),
    0,
  );
  const activeStageIndex = STAGES.findIndex(({ id }) => id === stage);

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) {
      return;
    }

    const existingKeys = new Set(
      items.map((item) => `${item.fileName}:${item.byteSize}`),
    );
    const availableSlots = Math.max(0, MAX_FILES - items.length);
    const candidates = files.slice(0, availableSlots);
    const additions: ImportItem[] = candidates.map((file) => {
      const duplicate = existingKeys.has(`${file.name}:${file.size}`);
      const tooLarge = file.size > MAX_FILE_BYTES;

      return {
        id: `import_${nanoid(12)}`,
        fileName: file.name,
        mimeType: file.type,
        byteSize: file.size,
        status: duplicate || tooLarge ? "error" : "parsing",
        included: !duplicate && !tooLarge,
        error: duplicate
          ? "This file is already in the import queue."
          : tooLarge
            ? `Files must be smaller than ${formatBytes(MAX_FILE_BYTES)}.`
            : undefined,
      };
    });

    setItems((current) => [...current, ...additions]);

    await Promise.all(
      candidates.map(async (file, index) => {
        const item = additions[index];
        if (item.status === "error") {
          return;
        }

        try {
          const [parsed] = await parseImportFiles([file]);
          setItems((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    status: "ready",
                    parsed,
                    fileName: parsed.fileName,
                    mimeType: parsed.mimeType,
                    byteSize: parsed.byteSize,
                  }
                : candidate,
            ),
          );
        } catch (error) {
          setItems((current) =>
            current.map((candidate) =>
              candidate.id === item.id
                ? {
                    ...candidate,
                    status: "error",
                    included: false,
                    error: errorMessage(error),
                  }
                : candidate,
            ),
          );
        }
      }),
    );
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void addFiles(files);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    void addFiles(Array.from(event.dataTransfer.files));
  };

  const addPastedText = () => {
    const text = pastedText.trim();
    if (!text) {
      return;
    }
    const safeTitle = pastedTitle.trim() || "Pasted notes";
    const filename = `${slugBase(safeTitle)}.txt`;
    const file = new File([text], filename, {
      type: "text/plain;charset=utf-8",
    });
    setPastedText("");
    void addFiles([file]);
  };

  const whisperConfig = (): WhisperConfig => ({
    language: snapshot.settings.whisperLanguage || undefined,
  });

  const addTranscripts = (transcripts: readonly TranscribedMedia[]) => {
    if (transcripts.length === 0) {
      return;
    }
    setItems((current) => {
      const existingKeys = new Set(
        current.map((item) => `${item.fileName}:${item.byteSize}`),
      );
      const availableSlots = Math.max(0, MAX_FILES - current.length);
      return [
        ...current,
        ...transcripts.slice(0, availableSlots).map((transcript) => {
          const parsed = transcriptToParsedImport(transcript);
          const duplicate = existingKeys.has(
            `${parsed.fileName}:${parsed.byteSize}`,
          );
          existingKeys.add(`${parsed.fileName}:${parsed.byteSize}`);
          return {
            id: `import_${nanoid(12)}`,
            fileName: parsed.fileName,
            mimeType: parsed.mimeType,
            byteSize: parsed.byteSize,
            status: duplicate ? ("error" as const) : ("ready" as const),
            included: !duplicate,
            parsed: duplicate ? undefined : parsed,
            error: duplicate
              ? "This transcript is already in the import queue."
              : undefined,
          };
        }),
      ];
    });
  };

  const runMediaTranscription = async (browserFiles?: readonly File[]) => {
    setTranscribing("media");
    setTranscriptionError("");
    try {
      const transcripts = await transcribeMediaFiles(
        whisperConfig(),
        browserFiles,
      );
      addTranscripts(transcripts);
    } catch (error) {
      setTranscriptionError(errorMessage(error));
    } finally {
      setTranscribing(null);
    }
  };

  const chooseMedia = () => {
    if (isTauriRuntime()) {
      void runMediaTranscription();
    } else {
      mediaInputRef.current?.click();
    }
  };

  const handleMediaInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (files.length > 0) {
      void runMediaTranscription(files);
    }
  };

  const runYouTubeTranscription = async () => {
    if (!youtubeUrl.trim()) {
      return;
    }
    setTranscribing("youtube");
    setTranscriptionError("");
    try {
      const transcript = await transcribeYouTube(
        youtubeUrl.trim(),
        whisperConfig(),
      );
      addTranscripts([transcript]);
      setYoutubeUrl("");
    } catch (error) {
      setTranscriptionError(errorMessage(error));
    } finally {
      setTranscribing(null);
    }
  };

  const removeItem = (itemId: EntityId) => {
    setItems((current) => current.filter((item) => item.id !== itemId));
  };

  const toggleItem = (itemId: EntityId) => {
    setItems((current) =>
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
      mode === "ai" && snapshot.settings.apiKeyConfigured ? "ai" : "manual";
    setStage("organizing");
    setProgressIndex(0);
    setOrganizeIssues([]);
    setApplyError("");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });

    const organizedSources: OrganizedSource[] = [];
    const issues: OrganizeIssue[] = [];
    const existingNotes = snapshot.settings.includeExistingNotesInAIContext
      ? snapshot.notes.slice(0, 80).map((note) => ({
          id: note.id,
          title: note.title,
          aliases: [...note.aliases],
          summary: note.summary,
          kind: note.kind,
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
          organizationInstructions:
            snapshot.settings.organizationInstructions,
        });
        if (organized.notes.length === 0) {
          throw new Error("The organizer did not return any notes.");
        }
        organizedSources.push({ item, result: organized });
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
    const payload = buildImportPayload(organizedSources, snapshot);
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
      onClose();
    } catch (error) {
      setApplyError(errorMessage(error));
    } finally {
      setApplying(false);
    }
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") {
      return;
    }

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
              <Sparkles size={16} strokeWidth={1.8} />
            </span>
            <div>
              <span className="import-studio__eyebrow">Orion workflow</span>
              <h2 id={titleId}>Import Studio</h2>
            </div>
          </div>
          <p id={descriptionId}>
            Turn loose source material into reviewable, connected wiki notes.
          </p>
          <button
            className="import-studio__close"
            type="button"
            aria-label="Close Import Studio"
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

              <div className="import-studio__input-grid">
                <div
                  className={clsx(
                    "import-studio__dropzone",
                    dragActive && "import-studio__dropzone--active",
                  )}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                      setDragActive(false);
                    }
                  }}
                  onDrop={handleDrop}
                >
                  <span className="import-studio__drop-icon" aria-hidden="true">
                    <UploadCloud size={25} strokeWidth={1.5} />
                  </span>
                  <strong>Drop files into Orion</strong>
                  <p>
                    Markdown, text, PDF, DOCX, JSON, CSV, TSV, or HTML.
                  </p>
                  <button
                    className="button soft"
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Files aria-hidden="true" size={15} />
                    Choose files
                  </button>
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
                </div>

                <div className="import-studio__paste">
                  <div className="import-studio__paste-heading">
                    <span className="import-studio__paste-icon" aria-hidden="true">
                      <PenLine size={16} strokeWidth={1.7} />
                    </span>
                    <div>
                      <strong>Or paste text</strong>
                      <span>Notes, transcripts, research, fragments</span>
                    </div>
                  </div>
                  <label className="import-studio__field">
                    <span>Source name</span>
                    <input
                      type="text"
                      value={pastedTitle}
                      maxLength={100}
                      onChange={(event) => setPastedTitle(event.target.value)}
                    />
                  </label>
                  <label className="import-studio__field">
                    <span>Content</span>
                    <textarea
                      value={pastedText}
                      rows={5}
                      placeholder="Paste something worth remembering…"
                      onChange={(event) => setPastedText(event.target.value)}
                    />
                  </label>
                  <button
                    className="button ghost import-studio__paste-add"
                    type="button"
                    disabled={!pastedText.trim()}
                    onClick={addPastedText}
                  >
                    <Plus aria-hidden="true" size={15} />
                    Add to queue
                  </button>
                </div>
              </div>

              <div className="import-studio__transcription">
                <div className="import-studio__transcription-heading">
                  <span className="import-studio__transcription-mark">
                    <AudioLines size={17} />
                  </span>
                  <span>
                    <strong>Transcribe into the same note workflow</strong>
                    <small>
                      Orion’s bundled Whisper model transcribes locally, then
                      turns the result into notes, concepts, and intelligent
                      links.
                    </small>
                  </span>
                  <em>On-device</em>
                </div>
                <div className="import-studio__transcription-grid">
                  <div className="import-studio__media-source">
                    <span>
                      <strong>Audio or video</strong>
                      <small>
                        MP3, MP4, M4A, WAV, WebM, OGG, FLAC, or MPEG · up to 2 GB
                      </small>
                    </span>
                    <button
                      className="button soft compact"
                      type="button"
                      disabled={
                        transcribing !== null || items.length >= MAX_FILES
                      }
                      onClick={chooseMedia}
                    >
                      {transcribing === "media" ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <AudioLines size={14} />
                      )}
                      {transcribing === "media"
                        ? "Transcribing…"
                        : "Choose media"}
                    </button>
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
                    className="import-studio__youtube-source"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runYouTubeTranscription();
                    }}
                  >
                    <CirclePlay size={16} aria-hidden="true" />
                    <input
                      type="url"
                      value={youtubeUrl}
                      placeholder="Paste a YouTube video link"
                      aria-label="YouTube video URL"
                      onChange={(event) => {
                        setYoutubeUrl(event.target.value);
                        setTranscriptionError("");
                      }}
                    />
                    <button
                      className="button soft compact"
                      type="submit"
                      disabled={
                        !youtubeUrl.trim() ||
                        transcribing !== null ||
                        items.length >= MAX_FILES
                      }
                    >
                      {transcribing === "youtube" ? (
                        <LoaderCircle size={14} className="spin" />
                      ) : (
                        <CirclePlay size={14} />
                      )}
                      {transcribing === "youtube"
                        ? "Downloading…"
                        : "Transcribe"}
                    </button>
                  </form>
                </div>
                <div className="import-studio__transcription-foot">
                  <span>
                    Whisper base · multilingual · bundled with Orion
                  </span>
                  <span>
                    YouTube media is deleted immediately after transcription.
                  </span>
                </div>
                {transcriptionError && (
                  <p className="import-studio__transcription-error" role="alert">
                    <AlertTriangle size={14} />
                    {transcriptionError}
                  </p>
                )}
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
                            {item.fileName} · {formatBytes(item.byteSize)}
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
                    disabled={!snapshot.settings.apiKeyConfigured}
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
                      <strong>Import as drafts</strong>
                      <small>
                        One local draft per source, ready for you to shape.
                      </small>
                    </span>
                    <span className="import-studio__mode-radio" aria-hidden="true" />
                  </button>

                  {!snapshot.settings.apiKeyConfigured && (
                    <div className="import-studio__key-note">
                      <AlertTriangle aria-hidden="true" size={15} />
                      <span>
                        No API key is configured. Your sources stay local and
                        will be imported as editable drafts.
                      </span>
                    </div>
                  )}

                  {mode === "ai" && snapshot.settings.apiKeyConfigured && (
                    <div className="import-studio__privacy-note">
                      <Sparkles aria-hidden="true" size={14} />
                      Selected source text will be sent to OpenAI using your
                      configured key.
                    </div>
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
                  <Sparkles size={21} strokeWidth={1.6} />
                </span>
                <span className="import-studio__orbit import-studio__orbit--one" />
                <span className="import-studio__orbit import-studio__orbit--two" />
                <i className="import-studio__star import-studio__star--one" />
                <i className="import-studio__star import-studio__star--two" />
                <i className="import-studio__star import-studio__star--three" />
              </div>
              <span className="import-studio__eyebrow">
                {mode === "ai" ? "Finding structure" : "Preparing local drafts"}
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
                    Project notes and canonical wiki articles stay as drafts
                    until you refine them.
                  </p>
                </div>
              </div>

              <div className="import-studio__result-stats">
                <span>
                  <strong>
                    {result.notes.filter((note) => note.kind !== "wiki").length}
                  </strong>
                  Notes
                </span>
                <span>
                  <strong>
                    {result.notes.filter((note) => note.kind === "wiki").length}
                  </strong>
                  Wiki articles
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
                          " Orion preserved it as a manual draft instead."}
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
                        <i>
                          {note.kind === "wiki" ? "Wiki article" : note.kind}
                        </i>
                      </span>
                      <p>{note.summary}</p>
                      <span className="import-studio__result-tags">
                        {note.tags.slice(0, 4).map((tag) => (
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
                {mode === "ai" && snapshot.settings.apiKeyConfigured ? (
                  <>
                    <Sparkles aria-hidden="true" size={15} />
                    Organize with AI
                  </>
                ) : (
                  <>
                    <PenLine aria-hidden="true" size={15} />
                    Create drafts
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
