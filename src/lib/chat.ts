import type {
  AppSnapshot,
  ChatNoteAction,
  ChatRequest,
  ChatResult,
  ChatEvidence,
  Note,
  StudioMessage,
} from "../types";
import { slugifyTitle } from "../data/defaults";
import { reconcileConceptVocabulary } from "./concepts";
import { normalizeStudio } from "./studio";
import { withWritingOrigin } from "./writingOrigins";
import { touchChatThread } from "./chatThreads";
import { truncateUnicode } from "./text";
import { portableChatEvidence } from "./chatCitations";
import { normalizeSourceEvidenceVersions } from "./evidenceVersions";
import { isChatCoverage, isChatEvidence, MAX_CHAT_EVIDENCE } from "./chatReadingProtocol";

export const MAX_CHAT_NOTE_ACTIONS = 3;
const MAX_CHAT_NOTE_TITLE_CHARS = 200;
const MAX_CHAT_NOTE_SUMMARY_CHARS = 1_000;
export const MAX_CHAT_NOTE_BODY_CHARS = 6_000;
export const MAX_CHAT_NOTE_ACTION_CONTENT_CHARS = 24_000;
const MAX_CHAT_NOTE_LABELS = 8;
const MAX_CHAT_NOTE_LABEL_CHARS = 120;

const NOTE_QUANTITY = "(?:an?|some|a few|a couple of|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|[1-9]\\d*)";
const NEW_NOTE_OBJECT = `(?:${NOTE_QUANTITY}\\s+)?(?:(?:new|another|separate|additional)\\s+)?notes?\\b`;
const NOTE_REFERENCE = "(?:(?:this|that)(?:\\s+(?:reply|answer|research|findings?|results?))?|it|(?:your|the)\\s+(?:reply|answer|research|findings?|results?))";
const NOTE_CREATION_PATTERNS = [
  new RegExp(`^(?:create|make|draft|add|spawn|write|save)\\s+(?:me\\s+)?${NEW_NOTE_OBJECT}`, "iu"),
  new RegExp(`^(?:save|capture|keep)\\s+${NOTE_REFERENCE}\\s+as\\s+${NEW_NOTE_OBJECT}`, "iu"),
  new RegExp(`^(?:turn|convert)\\s+${NOTE_REFERENCE}\\s+into\\s+${NEW_NOTE_OBJECT}`, "iu"),
  new RegExp(`^(?:put|store)\\s+${NOTE_REFERENCE}\\s+(?:in|into|as)\\s+${NEW_NOTE_OBJECT}`, "iu"),
  /^take\s+(?:an?\s+)?note\s+(?:of|on|about)\b/iu,
];
const NOTE_WORKER_SUBJECT = `(?:(?:the|my|our|these|those|each|${NOTE_QUANTITY})\\s+)?(?:research\\s+)?(?:workers?|orbs?|agents?)\\s+(?:each\\s+)?(?:to\\s+)?`;
const NOTE_WORKER_REQUEST = new RegExp(`^(?:have|get|ask|tell|instruct|use|send|spawn|start|dispatch|launch|assign)\\s+${NOTE_WORKER_SUBJECT}`, "iu");

function noteCreationCommand(clause: string): string {
  let text = clause.trim();
  for (let pass = 0; pass < 3; pass++) {
    text = text.replace(/^(?:(?:please|okay|ok|hey|actually|well|so|also|and|now|then|next|separately)[,\s]+)+/iu, "")
      .replace(/^(?:can|could|would|will) you\s+/iu, "");
    const desire = /^(?:i (?:want|need|would like)|i'd like)\s+(?:(?:you to|to)\s+)?/iu;
    if (desire.test(text)) text = text.replace(desire, "").replace(new RegExp(`^${NOTE_WORKER_SUBJECT}`, "iu"), "");
    text = text.replace(NOTE_WORKER_REQUEST, "");
  }
  return text;
}

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

  /** Release a cancelled conversation immediately, without allowing its late
   * completion to clear a replacement request in the same Space. */
  cancel(spaceId: string): void {
    this.invalidate(spaceId);
    this.pending.delete(spaceId);
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
    const current = this.pending.get(token.spaceId);
    if (current?.id !== token.id || current.generation !== token.generation) {
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
  let historyBudget = 12_000;
  const history = studio.messages.slice(-12).reverse().map((message) => {
    const content = truncateUnicode(message.content, Math.min(2_000, historyBudget));
    historyBudget -= [...content].length;
    return { role: message.role, content };
  }).filter((message) => message.content).reverse();

  return {
    prompt: truncateUnicode(prompt.trim(), 8_000),
    workspaceName: snapshot.workspace.name,
    // The reading coordinator discovers and opens evidence incrementally.
    notes: [],
    sources: [],
    concepts: [],
    history,
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
  passage?: StudioMessage["passage"],
  threadId?: string,
): AppSnapshot {
  const normalized = normalizeStudio(snapshot.studio);
  const studio = threadId ? touchChatThread(normalized, threadId, prompt, now) : normalized;
  const evidence = normalizeSourceEvidenceVersions((result.evidence ?? []).filter(isChatEvidence).filter((item) =>
    item.kind === "web" || (item.kind === "note" ? snapshot.notes : snapshot.sources).some((entity) => entity.id === item.entityId),
  ).slice(0, MAX_CHAT_EVIDENCE), snapshot.sources);
  const noteActions = chatPromptAllowsNoteCreation(prompt)
    ? normalizeChatNoteActions(result.noteActions)
    : [];
  const createdNotes = noteActions.map((action) =>
    attachChatSourceIds(chatNoteFromAction({ ...action, body: portableChatEvidence(action.body, evidence) }, now, noteIdFactory()), evidence, snapshot),
  );
  const createdNoteIds = createdNotes.map((note) => note.id);
  const messages: StudioMessage[] = [
    ...studio.messages,
    {
      id: messageIdFactory(),
      role: "user",
      ...(threadId ? { threadId } : {}),
      content: prompt.trim(),
      cardIds: [],
      contextCardIds: [],
      createdAt: now,
    },
    {
      id: messageIdFactory(),
      role: "assistant",
      ...(threadId ? { threadId } : {}),
      ...(passage ? { passage } : {}),
      content: result.reply.trim(),
      cardIds: [],
      contextCardIds: [],
      ...(createdNoteIds.length > 0 ? { createdNoteIds } : {}),
      ...(evidence.length ? { evidence } : {}),
      ...(isChatCoverage(result.coverage) ? { coverage: result.coverage } : {}),
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
    sources: attachChatSourceNotes(snapshot, createdNotes),
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
  const evidence = normalizeSourceEvidenceVersions((message.evidence ?? []).filter(isChatEvidence).slice(0, MAX_CHAT_EVIDENCE), snapshot.sources);
  action.body = portableChatEvidence(action.body, evidence);
  const note = attachChatSourceIds(chatNoteFromAction(action, now, noteId), evidence, snapshot);
  const vocabulary = reconcileConceptVocabulary(
    [note, ...snapshot.notes],
    snapshot.concepts,
  );
  return {
    ...snapshot,
    notes: vocabulary.notes,
    concepts: vocabulary.concepts,
    sources: attachChatSourceNotes(snapshot, [note]),
    studio: {
      ...studio,
      messages: studio.messages.map((candidate) =>
        candidate.id === messageId
          ? { ...candidate, ...(evidence.length ? { evidence } : {}), createdNoteIds: [noteId] }
          : candidate,
      ),
    },
    updatedAt: now,
  };
}

function attachChatSourceIds(note: Note, evidence: readonly ChatEvidence[], snapshot: AppSnapshot): Note {
  const sourceIds = [...new Set(evidence.filter((item) => item.kind === "source" &&
    snapshot.sources.some((source) => source.id === item.entityId) &&
    note.body.includes(`](orion-source://${encodeURIComponent(item.entityId)})`),
  ).map((item) => item.entityId))];
  return { ...note, sourceIds };
}

function attachChatSourceNotes(snapshot: AppSnapshot, notes: Note[]) {
  if (!notes.length) return snapshot.sources;
  return snapshot.sources.map((source) => {
    const linked = notes.filter((note) => note.sourceIds.includes(source.id));
    return linked.length ? { ...source, noteIds: [...new Set([...source.noteIds, ...linked.map((note) => note.id)])] } : source;
  });
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
    // Authored examples and quoted reference text cannot authorize a write.
    // Keep surrounding commands, including a quoted title after "create a note".
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/`[^`\n]*(?:`|$)/gmu, " ")
    .replace(/^\s*>[^\n]*/gmu, " ")
    .replace(/"[^"]*(?:"|$)|“[^”]*(?:”|$)/gu, " ")
    .replace(/(^|[\s([{])['‘][\s\S]*?['’](?=$|[\s)\]},.!?])/gu, "$1 ")
    .replace(/[’‘]/g, "'")
    .replace(/\bdon't\b/giu, "do not")
    .replace(/\bdont\b/giu, "do not")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /\b(?:do\s+not|don't|never)\s+(?:[^.!?]{0,40}\s)?(?:create|make|draft|add|spawn|write|save|capture|keep|turn|convert|put|store)\b/iu.test(
      normalized,
    )
  ) {
    return false;
  }
  return normalized.split(/[.!?;]+/u).some(clause => {
    const command = noteCreationCommand(clause);
    if (NOTE_CREATION_PATTERNS.some(pattern => pattern.test(command))) return true;
    // Preserve a compound imperative such as "research the contract and create
    // a note", without granting writes to "explain how to create a note".
    if (!/^(?:research|read|review|investigate|find|compare|analy[sz]e|summari[sz]e|look\s+(?:up|into))\b/iu.test(command)) return false;
    return command.split(/\s+(?:and(?:\s+then)?|then)\s+/iu).slice(1)
      .some(part => NOTE_CREATION_PATTERNS.some(pattern => pattern.test(noteCreationCommand(part))));
  });
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
  "orion-generate-pending",
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

export function chatNoteFromAction(
  action: ChatNoteAction,
  now: string,
  id: string,
): Note {
  return withWritingOrigin<Note>({
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
  }, "orion-ai");
}

function chatActionFromReply(reply: string): ChatNoteAction {
  const trimmed = reply
    .replace(/<!--\s*orion-[\s\S]*?-->/giu, "")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim() || "Saved from Orion Chat.";
  const firstLine = trimmed.split(/\r?\n/).find((line) => line.trim()) ?? "Chat note";
  const plainFirstLine = chatProse(firstLine)
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
  const plain = chatProse(markdown)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\[\]()!-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateAtWord(plain || "Saved from Orion Chat.", 280);
}

function chatProse(markdown: string): string {
  return markdown
    .replace(/[ \t]*\[[^\]]*\]\(#orion-evidence-e\d+\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
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
