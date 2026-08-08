import type {
  AppSnapshot,
  EntityId,
  OrganizeContentRequest,
  OrganizeContentResult,
  SpaceOverview,
} from "../types";

const MAX_NOTES = 64;
const MAX_SOURCES = 24;
const MAX_NOTE_BODY_CHARS = 1_100;
const MAX_SOURCE_TEXT_CHARS = 500;

/**
 * Overview eligibility is intentionally broader than wiki-enrichment
 * eligibility. Finished reference articles are part of a Space's knowledge,
 * while empty notes, archived notes, and in-flight linked pages are not.
 */
export function hasSubstantiveOverviewNote(
  note: AppSnapshot["notes"][number],
): boolean {
  if (
    note.status === "archived" ||
    note.tags.includes("orion-link-pending") ||
    note.tags.includes("orion-link-draft") ||
    /<!--\s*orion-link-(?:pending|draft)\s*-->/i.test(note.body)
  ) {
    return false;
  }
  const content = `${note.summary.trim()} ${plainText(note.body)}`.trim();
  return content.length >= 24;
}

export function markSpaceOverviewStale(snapshot: AppSnapshot): AppSnapshot {
  if (!snapshot.spaceOverview || snapshot.spaceOverview.stale) {
    return snapshot;
  }
  return {
    ...snapshot,
    spaceOverview: { ...snapshot.spaceOverview, stale: true },
  };
}

/**
 * Captures only knowledge that can change an overview. The renderer uses this
 * to discard an AI response if notes or sources changed while it was running.
 */
export function spaceKnowledgeFingerprint(snapshot: AppSnapshot): string {
  return JSON.stringify({
    workspace: [snapshot.workspace.name, snapshot.workspace.description],
    generation: [
      snapshot.settings.model,
      snapshot.settings.reasoningEffort,
      snapshot.settings.organizationInstructions,
    ],
    notes: [...snapshot.notes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((note) => [
        note.id,
        note.updatedAt,
        note.title,
        note.summary.length,
        note.body.length,
        note.aliases.length,
        note.tags.length,
        note.conceptIds.length,
        note.sourceIds.length,
      ]),
    sources: [...snapshot.sources]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((source) => [
        source.id,
        source.importedAt,
        source.title,
        source.text.length,
        source.noteIds.length,
      ]),
    concepts: [...snapshot.concepts]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((concept) => [
        concept.id,
        concept.label,
        concept.description,
        concept.noteIds,
      ]),
  });
}

export function buildSpaceOverviewRequest(
  snapshot: AppSnapshot,
): OrganizeContentRequest {
  const eligibleNotes = snapshot.notes.filter(hasSubstantiveOverviewNote);
  const eligibleNoteIds = new Set(eligibleNotes.map((note) => note.id));
  const notes = [...eligibleNotes]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_NOTES)
    .map((note) => {
      const body = plainText(note.body).slice(0, MAX_NOTE_BODY_CHARS);
      return [
        `## ${note.title}`,
        note.summary.trim(),
        body && body !== note.summary.trim() ? body : "",
      ]
        .filter(Boolean)
        .join("\n");
    });
  const sources = [...snapshot.sources]
    .sort((left, right) => right.importedAt.localeCompare(left.importedAt))
    .slice(0, MAX_SOURCES)
    .map(
      (source) =>
        `- ${source.title}: ${plainText(source.text).slice(0, MAX_SOURCE_TEXT_CHARS)}`,
    );
  const concepts = [...snapshot.concepts]
    .filter((concept) =>
      concept.noteIds.some((noteId) => eligibleNoteIds.has(noteId)),
    )
    .sort((left, right) => right.noteIds.length - left.noteIds.length)
    .slice(0, 40)
    .map((concept) => concept.label);
  const previous = snapshot.spaceOverview
    ? [
        "Previous overview (preserve its title unless the Space's centre has materially changed):",
        snapshot.spaceOverview.title,
        snapshot.spaceOverview.body,
      ].join("\n")
    : "";

  return {
    content: [
      `Space: ${snapshot.workspace.name}`,
      snapshot.workspace.description,
      concepts.length ? `Prominent concepts: ${concepts.join(", ")}` : "",
      notes.length ? `Notes:\n\n${notes.join("\n\n")}` : "No notes yet.",
      sources.length ? `Sources:\n${sources.join("\n")}` : "",
      previous,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 80_000),
    sourceName: `${snapshot.workspace.name} Space overview`,
    spaceName: snapshot.workspace.name,
    spaceDescription: snapshot.workspace.description,
    model: snapshot.settings.model,
    effort: snapshot.settings.reasoningEffort,
    timeoutMs: 90_000,
    taskInstructions:
      "Space-overview task: return exactly one entry in notes and return empty wikiArticles, concepts, and suggestedConnections arrays. Write it as a compact note in its own right. The note title must be a concise, editorial headline that captures the Space's live intellectual centre, not a generic label such as ‘Space summary’; it may be long enough to wrap naturally across two or three lines. The body must be a cohesive orientation of roughly five to eight compact paragraphs (usually 450–700 words): explain the central material, the most meaningful relationships, tensions or open questions, and the direction of current work. It is an overview, not a source inventory or change log. Never use headings named ‘Context from’, never invent facts, and never use [[wiki-link]] brackets. Preserve a worthwhile prior title unless the Space's centre has genuinely shifted.",
    organizationInstructions:
      snapshot.settings.organizationInstructions,
  };
}

export function applySpaceOverviewResult(
  snapshot: AppSnapshot,
  result: OrganizeContentResult,
  generatedAt: string,
): SpaceOverview {
  const generated = result.notes[0];
  if (!generated?.title.trim() || !generated.body.trim()) {
    throw new Error("Orion did not return a usable Space overview.");
  }
  const title = cleanOverviewProse(generated.title).trim().slice(0, 140);
  const body = cleanOverviewProse(generated.body).trim().slice(0, 8_000);
  if (!title || !body) {
    throw new Error("Orion did not return a usable Space overview.");
  }
  const relatedNoteIds = relatedNotesForOverview(snapshot, `${title}\n${body}`);
  return { title, body, relatedNoteIds, generatedAt, stale: false };
}

export function buildLocalSpaceOverview(snapshot: AppSnapshot): SpaceOverview {
  const eligibleNotes = snapshot.notes.filter(hasSubstantiveOverviewNote);
  const eligibleNoteIds = new Set(eligibleNotes.map((note) => note.id));
  const recent = [...eligibleNotes]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 4);
  const concepts = [...snapshot.concepts]
    .filter((concept) =>
      concept.noteIds.some((noteId) => eligibleNoteIds.has(noteId)),
    )
    .sort((left, right) => right.noteIds.length - left.noteIds.length)
    .slice(0, 3);
  const title =
    concepts.length >= 2
      ? `${concepts[0].label} and ${concepts[1].label}`
      : concepts.length === 1
        ? `Around ${concepts[0].label}`
        : recent[0]?.title || snapshot.workspace.name;
  const noteNames = recent.map((note) => note.title);
  const noteOrientations = recent
    .map((note) => {
      const summary = plainText(note.summary);
      const body = plainText(note.body);
      const bodyAddsContext =
        body && (!summary || !normalize(body).includes(normalize(summary)));
      const detail = [summary, bodyAddsContext ? body : ""]
        .filter(Boolean)
        .join(" ")
        .slice(0, 520)
        .trim();
      return detail ? `${note.title}. ${detail}` : "";
    })
    .filter(Boolean);
  const body = recent.length
    ? [
        `This Space currently brings together ${eligibleNotes.length} ${eligibleNotes.length === 1 ? "note" : "notes"}. Recent work moves through ${joinNatural(noteNames)}.`,
        ...noteOrientations,
        concepts.length
          ? `Across the material, its most established threads include ${joinNatural(concepts.map((concept) => concept.label))}. These provide the clearest routes into the Space as it continues to evolve.`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "As notes and sources gather here, Orion will keep a living orientation to this Space.";

  return {
    title,
    body,
    relatedNoteIds: recent.map((note) => note.id),
    generatedAt: snapshot.updatedAt,
    stale: Boolean(snapshot.spaceOverview?.stale),
  };
}

function relatedNotesForOverview(
  snapshot: AppSnapshot,
  overview: string,
): EntityId[] {
  const normalizedOverview = normalize(overview);
  const matches = snapshot.notes
    .filter(hasSubstantiveOverviewNote)
    .map((note) => ({
      id: note.id,
      updatedAt: note.updatedAt,
      score: [note.title, ...note.aliases].reduce(
        (score, phrase) =>
          normalize(phrase) && normalizedOverview.includes(normalize(phrase))
            ? score + Math.max(1, phrase.trim().split(/\s+/).length)
            : score,
        0,
      ),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || right.updatedAt.localeCompare(left.updatedAt),
    )
    .slice(0, 8)
    .map((candidate) => candidate.id);
  if (matches.length > 0) {
    return matches;
  }
  return [...snapshot.notes]
    .filter(hasSubstantiveOverviewNote)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 5)
    .map((note) => note.id);
}

function stripWikiBrackets(value: string): string {
  return value.replace(/\[\[([^\]]+)\]\]/g, "$1");
}

function cleanOverviewProse(value: string): string {
  return stripWikiBrackets(value)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[a-z0-9_-]*\n([\s\S]*?)```/gi, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+] |\d+[.)] )/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/gm, "$1$2")
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(
      /<\/?(?:p|br|strong|em|span|div|ul|ol|li|h[1-6]|blockquote)(?:\s[^>]*)?>/gi,
      "",
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainText(value: string): string {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~[\]()|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function joinNatural(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
