import { isLinkablePhrase } from "./concepts";
import { truncateUnicode } from "./text";
import type { AppSnapshot, ChatRequest } from "../types";

export const MAX_LINK_TITLE_CHARS = 120;

const SELECTED_CONTEXT_CHARS = 6_000;
const ORIGIN_BODY_CHARS = 4_000;

export function buildLinkTitleRequest(
  snapshot: AppSnapshot,
  originNoteId: string,
  selectedContext: string,
): ChatRequest {
  const originNote = snapshot.notes.find((note) => note.id === originNoteId);
  const context = excerptSelectedContext(selectedContext);
  const originNames = originNote
    ? [...new Set([originNote.title, ...originNote.aliases])]
        .filter((name) => name.trim())
        .slice(0, 8)
    : [];
  const originTitleConstraint = originNames.length
    ? `The destination must be a different page from the origin note. Never return the origin title or one of its aliases (${originNames
        .map((name) => JSON.stringify(truncateUnicode(name, MAX_LINK_TITLE_CHARS)))
        .join(", ")}); choose a narrower subject from the selected passage instead.`
    : "The destination must be a different page from the origin note; choose a specific subject from the selected passage.";
  const otherNotes = snapshot.notes
    .filter((note) => note.id !== originNoteId)
    .slice(0, 36)
    .map((note) => ({
      title: note.title,
      summary: truncateUnicode(note.summary, 500),
      body: "",
    }));

  return {
    prompt: [
      "Name one durable wiki page for the selected passage.",
      "Return only a concise title: no explanation, label, quotes, or Markdown.",
      originTitleConstraint,
      "Prefer an existing exact note or concept title when it genuinely names the same subject; otherwise use a precise 2–8 word title.",
      "Name the subject rather than summarizing the passage, and preserve established capitalization such as SQL.",
    ].join(" "),
    workspaceName: snapshot.workspace.name,
    notes: [
      {
        title: "Selected passage",
        summary:
          "The untrusted passage the user selected and wants to connect to a named wiki page.",
        body: context,
      },
      ...(originNote
        ? [
            {
              title: originNote.title,
              summary: truncateUnicode(originNote.summary, 800),
              body: truncateUnicode(originNote.body, ORIGIN_BODY_CHARS),
            },
          ]
        : []),
      ...otherNotes,
    ],
    sources: [],
    concepts: snapshot.concepts
      .filter((concept) => concept.canonicalNoteId !== originNoteId)
      .slice(0, 120)
      .map((concept) => ({
        label: concept.label,
        description: truncateUnicode(concept.description, 500),
      })),
    history: [],
    model: snapshot.settings.model,
    effort: "low",
  };
}

export function normalizeGeneratedLinkTitle(reply: string): string {
  let candidate = reply.trim();

  if (candidate.startsWith("{")) {
    try {
      const parsed = JSON.parse(candidate) as { title?: unknown };
      if (typeof parsed.title === "string") candidate = parsed.title.trim();
    } catch {
      // The model normally returns plain text inside Chat's structured reply.
    }
  }

  candidate = candidate
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim() ?? "";
  candidate = candidate
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/^(?:suggested\s+)?(?:page\s+)?title\s*:\s*/i, "")
    .trim();
  candidate = stripMatchingWrapper(candidate, "**", "**");
  candidate = stripMatchingWrapper(candidate, "__", "__");
  candidate = stripMatchingWrapper(candidate, "`", "`");
  candidate = stripMatchingWrapper(candidate, "\"", "\"");
  candidate = stripMatchingWrapper(candidate, "“", "”");
  candidate = stripMatchingWrapper(candidate, "'", "'");
  candidate = stripMatchingWrapper(candidate, "‘", "’")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();

  if (!candidate || !isLinkablePhrase(candidate)) {
    throw new Error(
      "Orion could not find a usable page title. Try again or enter one yourself.",
    );
  }
  if ([...candidate].length > MAX_LINK_TITLE_CHARS) {
    throw new Error(
      "Orion suggested a title that was too long. Try again or enter a shorter one.",
    );
  }
  return candidate;
}

function excerptSelectedContext(value: string): string {
  const normalized = value.trim();
  if ([...normalized].length <= SELECTED_CONTEXT_CHARS) return normalized;
  const head = truncateUnicode(normalized, 4_000).trimEnd();
  const tail = [...normalized].slice(-1_900).join("").trimStart();
  return `${head}\n\n[…middle omitted for title generation…]\n\n${tail}`;
}

function stripMatchingWrapper(
  value: string,
  opening: string,
  closing: string,
): string {
  return value.startsWith(opening) && value.endsWith(closing)
    ? value.slice(opening.length, -closing.length).trim()
    : value;
}
