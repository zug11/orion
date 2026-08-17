import type {
  AppSnapshot,
  ChatNoteAction,
  ChatRequest,
  ChatResult,
  Note,
  StudioMessage,
} from "../types";
import { slugifyTitle } from "../data/defaults";
import { reconcileConceptVocabulary } from "./concepts";
import { normalizeStudio } from "./studio";
import { truncateUnicode } from "./text";

export const MAX_CHAT_NOTE_ACTIONS = 3;
const MAX_CHAT_NOTE_TITLE_CHARS = 200;
const MAX_CHAT_NOTE_SUMMARY_CHARS = 1_000;
export const MAX_CHAT_NOTE_BODY_CHARS = 6_000;
export const MAX_CHAT_NOTE_ACTION_CONTENT_CHARS = 24_000;
const MAX_CHAT_NOTE_LABELS = 8;
const MAX_CHAT_NOTE_LABEL_CHARS = 120;

const NOTE_CREATION_PATTERNS = [
  /\b(?:create|make|draft|add|spawn)\s+(?:me\s+)?(?:an?\s+|some\s+|\d+\s+)?notes?\b/iu,
  /\bwrite\s+(?:me\s+)?(?:an?\s+|some\s+|\d+\s+)notes?\b/iu,
  /\b(?:save|capture|keep)\s+(?:(?:this|that)(?:\s+(?:reply|answer))?|it|your\s+(?:reply|answer)|the\s+(?:reply|answer))\s+as\s+(?:an?\s+)?note\b/iu,
  /\b(?:turn|convert)\s+(?:(?:this|that)(?:\s+(?:reply|answer))?|it|your\s+(?:reply|answer)|the\s+(?:reply|answer))\s+into\s+(?:an?\s+)?note\b/iu,
  /\b(?:put|store)\s+(?:(?:this|that)(?:\s+(?:reply|answer))?|it|your\s+(?:reply|answer)|the\s+(?:reply|answer))\s+(?:in|into|as)\s+(?:an?\s+)?note\b/iu,
  /\btake\s+(?:an?\s+)?note\s+(?:of|on|about)\b/iu,
] as const;

export interface ChatRequestToken {
  id: string;
  spaceId: string;
  generation: number;
}

export class ChatRequestRegistry {
  private readonly pending = new Map<string, ChatRequestToken>();
  private readonly generations = new Map<string, number>();

  start(spaceId: string, id: string): ChatRequestToken | null {
    if (this.pending.has(spaceId)) {
      return null;
    }
    const token = {
      id,
      spaceId,
      generation: this.generations.get(spaceId) ?? 0,
    };
    this.pending.set(spaceId, token);
    return token;
  }

  invalidate(spaceId: string): void {
    this.generations.set(
      spaceId,
      (this.generations.get(spaceId) ?? 0) + 1,
    );
  }

  isCurrent(token: ChatRequestToken): boolean {
    const current = this.pending.get(token.spaceId);
    return (
      current?.id === token.id &&
      current.generation === token.generation &&
      (this.generations.get(token.spaceId) ?? 0) === token.generation
    );
  }

  finish(token: ChatRequestToken): boolean {
    if (this.pending.get(token.spaceId)?.id !== token.id) {
      return false;
    }
    this.pending.delete(token.spaceId);
    return true;
  }
}

export function buildChatRequest(
  snapshot: AppSnapshot,
  prompt: string,
): ChatRequest {
  const studio = normalizeStudio(snapshot.studio);

  return {
    prompt: prompt.trim().slice(0, 8_000),
    workspaceName: snapshot.workspace.name,
    notes: snapshot.notes.slice(0, 80).map((note) => ({
      title: note.title,
      summary: note.summary.slice(0, 1_000),
      body: note.body.slice(0, 8_000),
    })),
    sources: snapshot.sources.slice(0, 30).map((source) => ({
      title: source.title,
      text: source.text.slice(0, 6_000),
    })),
    concepts: snapshot.concepts.slice(0, 120).map((concept) => ({
      label: concept.label,
      description: concept.description.slice(0, 1_000),
    })),
    history: studio.messages.slice(-12).map((message) => ({
      role: message.role,
      content: message.content.slice(0, 4_000),
    })),
    allowNoteActions: chatPromptAllowsNoteCreation(prompt),
    model: snapshot.settings.model,
    effort: snapshot.settings.reasoningEffort,
  };
}

export function applyChatResult(
  snapshot: AppSnapshot,
  prompt: string,
  result: ChatResult,
  now: string,
  messageIdFactory: () => string,
  noteIdFactory: () => string = messageIdFactory,
): AppSnapshot {
  const studio = normalizeStudio(snapshot.studio);
  const noteActions = chatPromptAllowsNoteCreation(prompt)
    ? normalizeChatNoteActions(result.noteActions)
    : [];
  const createdNotes = noteActions.map((action) =>
    chatNoteFromAction(action, now, noteIdFactory()),
  );
  const createdNoteIds = createdNotes.map((note) => note.id);
  const messages: StudioMessage[] = [
    ...studio.messages,
    {
      id: messageIdFactory(),
      role: "user",
      content: prompt.trim(),
      cardIds: [],
      contextCardIds: [],
      createdAt: now,
    },
    {
      id: messageIdFactory(),
      role: "assistant",
      content: result.reply.trim(),
      cardIds: [],
      contextCardIds: [],
      ...(createdNoteIds.length > 0 ? { createdNoteIds } : {}),
      createdAt: now,
    },
  ];
  const vocabulary = reconcileConceptVocabulary(
    [...createdNotes, ...snapshot.notes],
    snapshot.concepts,
  );

  return {
    ...snapshot,
    notes: vocabulary.notes,
    concepts: vocabulary.concepts,
    studio: {
      ...studio,
      messages,
    },
    updatedAt: now,
  };
}

export function saveChatReplyAsNote(
  snapshot: AppSnapshot,
  messageId: string,
  now: string,
  noteId: string,
): AppSnapshot {
  const studio = normalizeStudio(snapshot.studio);
  const message = studio.messages.find(
    (candidate) => candidate.id === messageId && candidate.role === "assistant",
  );
  if (
    !message ||
    message.createdNoteIds?.some((id) =>
      snapshot.notes.some((note) => note.id === id),
    )
  ) {
    return snapshot;
  }

  const action = chatActionFromReply(message.content);
  const note = chatNoteFromAction(action, now, noteId);
  const vocabulary = reconcileConceptVocabulary(
    [note, ...snapshot.notes],
    snapshot.concepts,
  );
  return {
    ...snapshot,
    notes: vocabulary.notes,
    concepts: vocabulary.concepts,
    studio: {
      ...studio,
      messages: studio.messages.map((candidate) =>
        candidate.id === messageId
          ? { ...candidate, createdNoteIds: [noteId] }
          : candidate,
      ),
    },
    updatedAt: now,
  };
}

export function normalizeChatNoteActions(
  value: unknown,
): ChatNoteAction[] {
  if (!Array.isArray(value)) return [];
  const actions: ChatNoteAction[] = [];
  let totalContentCharacters = 0;
  for (const candidate of value.slice(0, MAX_CHAT_NOTE_ACTIONS)) {
    if (!isChatNoteAction(candidate)) continue;
    const action = {
      title: candidate.title.trim(),
      summary: candidate.summary.trim(),
      body: candidate.body.trim(),
      tags: normalizeLabels(candidate.tags),
      aliases: normalizeLabels(candidate.aliases),
    };
    const actionCharacters = chatActionCharacterCount(action);
    if (
      totalContentCharacters + actionCharacters >
      MAX_CHAT_NOTE_ACTION_CONTENT_CHARS
    ) {
      continue;
    }
    totalContentCharacters += actionCharacters;
    actions.push(action);
  }
  return actions;
}

export function chatPromptAllowsNoteCreation(prompt: string): boolean {
  const normalized = prompt
    .replace(/[’‘]/g, "'")
    .replace(/\bdon't\b/giu, "do not")
    .replace(/\bdont\b/giu, "do not")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /\b(?:do\s+not|don't|never)\s+(?:[^.!?]{0,40}\s)?(?:create|make|draft|add|spawn|write|save|capture|keep|turn|convert|put|store)\b/iu.test(
      normalized,
    ) ||
    /\b(?:should|why|how|when|whether)\b[^.!?]{0,100}\b(?:create|make|save|capture|keep|write)\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  return NOTE_CREATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isChatNoteAction(value: unknown): value is ChatNoteAction {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !["title", "summary", "body", "tags", "aliases"].includes(key),
    ) ||
    typeof record.title !== "string" ||
    !record.title.trim() ||
    !hasAtMostCodePoints(
      record.title.trim(),
      MAX_CHAT_NOTE_TITLE_CHARS,
    ) ||
    typeof record.summary !== "string" ||
    !hasAtMostCodePoints(
      record.summary.trim(),
      MAX_CHAT_NOTE_SUMMARY_CHARS,
    ) ||
    typeof record.body !== "string" ||
    !record.body.trim() ||
    !hasAtMostCodePoints(record.body.trim(), MAX_CHAT_NOTE_BODY_CHARS) ||
    hasUnsafeChatNoteText(record.title) ||
    hasUnsafeChatNoteText(record.summary) ||
    hasUnsafeChatNoteText(record.body) ||
    !isBoundedLabelArray(record.tags) ||
    !isBoundedLabelArray(record.aliases) ||
    record.tags.some(
      (tag) => RESERVED_CHAT_NOTE_TAGS.has(tag.trim().toLocaleLowerCase()),
    )
  ) {
    return false;
  }
  return true;
}

function isBoundedLabelArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CHAT_NOTE_LABELS &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.trim().length > 0 &&
        hasAtMostCodePoints(item.trim(), MAX_CHAT_NOTE_LABEL_CHARS) &&
        !hasUnsafeChatNoteText(item),
    )
  );
}

function normalizeLabels(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()))];
}

const RESERVED_CHAT_NOTE_TAGS = new Set([
  "ai-draft",
  "wiki-article",
  "orion-link-draft",
  "orion-link-pending",
]);

function hasUnsafeChatNoteText(value: string): boolean {
  return /[^\P{Cc}\n\t]/u.test(value) || /<!--\s*orion-/iu.test(value);
}

function chatActionCharacterCount(action: ChatNoteAction): number {
  return [
    action.title,
    action.summary,
    action.body,
    ...action.tags,
    ...action.aliases,
  ].reduce((total, item) => total + [...item].length, 0);
}

function chatNoteFromAction(
  action: ChatNoteAction,
  now: string,
  id: string,
): Note {
  return {
    id,
    title: action.title,
    slug: slugifyTitle(action.title) || `chat-note-${id}`,
    summary: action.summary || summarizeMarkdown(action.body),
    body: action.body,
    aliases: action.aliases,
    tags: action.tags,
    kind: "article",
    status: "ready",
    conceptIds: [],
    sourceIds: [],
    createdAt: now,
    updatedAt: now,
    color: "#8798ff",
  };
}

function chatActionFromReply(reply: string): ChatNoteAction {
  const trimmed = reply
    .replace(/<!--\s*orion-[\s\S]*?-->/giu, "")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim() || "Saved from Orion Chat.";
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? "Chat note";
  const plainFirstLine = firstLine
    .replace(/^#{1,6}\s+/, "")
    .replace(/[*_`~\[\]]/g, "")
    .trim();
  const title = truncateAtWord(plainFirstLine || "Chat note", 120);
  return {
    title,
    summary: summarizeMarkdown(trimmed),
    body: trimmed,
    tags: [],
    aliases: [],
  };
}

function summarizeMarkdown(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateAtWord(plain || "Saved from Orion Chat.", 280);
}

function truncateAtWord(value: string, maxChars: number): string {
  const bounded = truncateUnicode(value, maxChars);
  if (bounded === value) return value;
  const boundary = bounded.lastIndexOf(" ");
  return `${(boundary > bounded.length / 2
    ? bounded.slice(0, boundary)
    : bounded
  ).trim()}…`;
}

function hasAtMostCodePoints(value: string, maxCodePoints: number): boolean {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maxCodePoints) return false;
  }
  return true;
}
