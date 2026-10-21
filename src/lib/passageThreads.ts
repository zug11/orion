import { isCommentCursor, type CommentCursor } from "./commentCursor";
import { marked, type Token } from "marked";
import type { AppSnapshot, ChatEditProposal, Note, PassageAnchor, PassageThread, PassageThreadMessage } from "../types";
import type { VoiceSelection } from "./voiceSelection";
import { splitSavedChatPassages } from "./chatCitations";
import { spaceNoteVersion } from "./spaceKnowledge";
import { chatEditableBody, MAX_CHAT_EDIT_CHARS, validateChatEditPassage, validateChatEditTarget } from "./chatEdits";
import type { GeneratePassageReference } from "./generate";
import { workingTaskText } from "./taskWorkingView";

export const MAX_PASSAGE_THREADS = 32;
export const MAX_THREAD_MESSAGES = 30;
export const MAX_THREAD_TEXT = 12_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number) => typeof value === "string" && !!value.trim() && value.length <= max;
export function isPassageAnchor(value: unknown): value is PassageAnchor {
  return record(value) && (value.cursor === undefined || isCommentCursor(value.cursor)) && (value.scope === "note" ? value.quote === "" && value.text === "" : value.scope === undefined && text(value.quote, MAX_THREAD_TEXT) && text(value.text, MAX_THREAD_TEXT));
}
export function isPassageThreadMessage(value: unknown): value is PassageThreadMessage {
  return record(value) && (value.pending === undefined || typeof value.pending === "boolean") && text(value.id, 200) && ["user", "assistant"].includes(String(value.role)) &&
    text(value.content, MAX_THREAD_TEXT) && text(value.createdAt, 80) &&
    (value.createdNoteId === undefined || text(value.createdNoteId, 200)) &&
    (value.proposal === undefined || record(value.proposal) && ["addition", "rewrite"].includes(String(value.proposal.kind)) && text(value.proposal.text, MAX_THREAD_TEXT));
}
export function isPassageThreads(value: unknown): value is PassageThread[] {
  return Array.isArray(value) && value.length <= MAX_PASSAGE_THREADS &&
    value.every(t => record(t) && text(t.id, 200) && isPassageAnchor(t.anchor) &&
      ["proposed", "open", "resolved"].includes(String(t.state)) && text(t.createdAt, 80) && text(t.updatedAt, 80) &&
      Array.isArray(t.messages) && t.messages.length > 0 && t.messages.length <= MAX_THREAD_MESSAGES &&
      t.messages.every(isPassageThreadMessage) && new Set(t.messages.map(m => m.id)).size === t.messages.length) &&
    new Set(value.map(t => t.id)).size === value.length;
}
export function uniquePassageOffset(body: string, quote: string): number | undefined {
  const at = body.indexOf(quote);
  return quote && at >= 0 && body.indexOf(quote, at + 1) < 0 ? at : undefined;
}

/** Rendering text for an anchor only; never interpret HTML or execute content. */
export function passagePlainText(markdown: string): string {
  const inline = (tokens: Token[], blocks = false): string => tokens.map(token => {
    if (token.type === "space" || token.type === "br") return " ";
    if ("tokens" in token && Array.isArray(token.tokens)) return inline(token.tokens as Token[], token.type === "blockquote");
    if (token.type === "table") return [...token.header, ...token.rows.flat()].map(c => inline(c.tokens)).join(" ");
    if (token.type === "list") return token.items.map((item: { tokens: Token[] }) => inline(item.tokens, true)).join(" ");
    if ("text" in token && typeof token.text === "string") return token.text;
    return "";
  }).join(blocks ? " " : "");
  return inline(marked.lexer(markdown), true).replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}
export const normalizedPassage = (value: string) => value.replace(/\s+/g, " ").trim();

/** Return original UTF-16 boundaries after whitespace normalization. No guessed Markdown offsets. */
export function locatePassage(text: string, quote: string): { from: number; to: number } | undefined {
  let normalized = ""; const positions: number[] = [];
  for (const word of text.matchAll(/\S+/gu)) {
    if (normalized) { normalized += " "; positions.push(word.index! - 1); }
    for (let i = 0; i < word[0].length; i++) { normalized += word[0][i]; positions.push(word.index! + i); }
  }
  const target = normalizedPassage(quote), at = uniquePassageOffset(normalized, target);
  return at === undefined ? undefined : { from: positions[at], to: positions[at + target.length - 1] + 1 };
}

export function passageAnchorFromSelection(snapshot: AppSnapshot, selection: VoiceSelection): PassageAnchor {
  const note = snapshot.notes.find(n => n.id === selection.noteId);
  if (selection.spaceId !== snapshot.workspace.id || !note || spaceNoteVersion(note) !== selection.version) {
    throw new Error("This highlighted passage changed. Select its current text again.");
  }
  const body = chatEditableBody(note.body).body;
  if (!selection.text.trim() || selection.text.length > MAX_THREAD_TEXT) throw new Error("Select a shorter passage for this thread.");
  if (uniquePassageOffset(body, selection.text) !== undefined) return { quote: selection.text, text: selection.text };
  // Formatted selections may have no literal Markdown counterpart. Anchor the
  // unique containing authored block rather than manufacturing source offsets.
  const candidates = marked.lexer(body).filter(token => token.type !== "space" && token.raw.length <= MAX_THREAD_TEXT &&
    normalizedPassage(passagePlainText(token.raw)).includes(normalizedPassage(selection.text)));
  if (candidates.length !== 1 || uniquePassageOffset(body, candidates[0].raw.trim()) === undefined) {
    throw new Error("This passage cannot be anchored uniquely. Highlight a larger paragraph or block.");
  }
  const quote = candidates[0].raw.trim();
  return { quote, text: passagePlainText(quote) };
}
export function passageIsCurrent(note: Note, anchor: PassageAnchor): boolean {
  return anchor.scope === "note" || uniquePassageOffset(chatEditableBody(note.body).body, anchor.quote) !== undefined;
}
/** Retained evidence stays on the discussion, outside authored prose and prompts. */
export function passageCommentText(content: string): string {
  return splitSavedChatPassages(content).body
    .replace(/\[[^\]]*\]\(#orion-(?:passage|evidence)-e\d+\)/g, "").trim();
}
export function threadEditProposal(snapshot: AppSnapshot, noteId: string, anchor: PassageAnchor, content: string, kind: "addition" | "rewrite"): ChatEditProposal {
  const note = snapshot.notes.find(n => n.id === noteId);
  if (!note || !passageIsCurrent(note, anchor)) throw new Error("The original passage changed. Reattach this thread before applying changes.");
  if (anchor.scope === "note") throw new Error("Highlight a passage and attach this comment before proposing a text change.");
  content = passageCommentText(content);
  if (!text(content, MAX_THREAD_TEXT)) throw new Error("The proposed text is empty or too long.");
  let quote = anchor.quote;
  if (kind === "addition") {
    const body = chatEditableBody(note.body).body;
    const start = uniquePassageOffset(body, quote)!;
    let offset = 0;
    const block = marked.lexer(body).find(token => {
      const here = offset; offset += token.raw.length;
      return token.type !== "space" && here <= start && offset >= start + quote.length;
    });
    if (!block || uniquePassageOffset(body, block.raw.trim()) === undefined) throw new Error("Select a unique complete block before adding text.");
    quote = block.raw.trim();
  }
  const after = kind === "addition" ? quote + "\n\n" + content : content;
  if ([quote, after].some(value => [...value].length > MAX_CHAT_EDIT_CHARS)) {
    throw new Error("This change is too long for a passage edit. Use a shorter comment or passage, or choose Generate article.");
  }
  const proposal: ChatEditProposal = { spaceId: snapshot.workspace.id, noteId, title: note.title, baseBody: note.body,
    mode: "focused", edits: [{ before: quote, after }] };
  validateChatEditTarget(snapshot, proposal);
  return proposal;
}


export interface PassageChatTarget { spaceId: string; noteId: string; threadId: string; draft: string; key: string }

export type PassageThreadAction =
  | { kind: "open-chat"; draft: string }
  | { kind: "delete" } | { kind: "edit-comment"; text: string }
  | { kind: "accept" } | { kind: "discard" } | { kind: "resolve" } | { kind: "reattach" }
  | { kind: "reply"; text: string; signal: AbortSignal }
  | { kind: "addition"; messageId: string; signal: AbortSignal }
  | { kind: "rewrite"; messageId: string; signal: AbortSignal }
  | { kind: "create"; messageId: string };
export type PassageThreadHandler = (noteId: string, threadId: string, action: PassageThreadAction) => Promise<void>;
export type PassageCommentTarget = (VoiceSelection | { scope: "note"; spaceId: string; noteId: string; version: string }) & { cursor?: CommentCursor };
export type PassageCommentHandler = (selection: PassageCommentTarget, content: string, threadId: string) => Promise<void>;

/** A human opening annotation is visible; later user prompts remain contextual history. */
export function passageComments(thread: PassageThread): PassageThreadMessage[] {
  return thread.messages.filter((message, index) => message.role === "assistant" || index === 0 && !message.pending);
}

/** Local metadata only. A stable draft ID makes a failed save safely retryable. */
export function addHumanPassageComment(snapshot: AppSnapshot, selection: PassageCommentTarget, content: string, id: string, now: string): AppSnapshot {
  const note = snapshot.notes.find(item => item.id === selection.noteId);
  const comment = content.trim();
  if (selection.spaceId !== snapshot.workspace.id || !note) throw new Error("Return to the original Space and note to save this comment.");
  if (!text(comment, MAX_THREAD_TEXT) || !text(id, 200)) throw new Error("Write a comment of at most 12,000 characters.");
  const existing = note.discussionThreads?.find(thread => thread.id === id);
  if (existing) {
    if (existing.messages[0]?.role !== "user" || existing.messages[0].content !== comment) throw new Error("This comment was already saved with different text. Reopen it from the passage.");
    return snapshot;
  }
  if (spaceNoteVersion(note) !== selection.version) throw new Error("This note changed. Reopen the comment before saving.");
  const anchor: PassageAnchor = "scope" in selection ? { scope: "note", quote: "", text: "" } : passageAnchorFromSelection(snapshot, selection);
  if (selection.cursor) {
    if (!isCommentCursor(selection.cursor)) throw new Error("The comment position is invalid. Place your cursor again.");
    anchor.cursor = selection.cursor;
  }
  const thread: PassageThread = { id, anchor, state: "open", createdAt: now, updatedAt: now,
    messages: [{ id: `${id}-comment`, role: "user", content: comment, createdAt: now }] };
  const threads = [...note.discussionThreads ?? [], thread];
  if (!isPassageThreads(threads)) throw new Error("This note has reached its passage comment limit.");
  return { ...snapshot, notes: snapshot.notes.map(item => item.id === note.id ? { ...item, discussionThreads: threads, updatedAt: now } : item), updatedAt: now };
}

/** Capture the chosen comment, never its portable citation footer or another conversation. */
export function passageArticleReference(snapshot: AppSnapshot, note: Note, thread: PassageThread, messageId: string): GeneratePassageReference {
  const message = passageComments(thread).find(item => item.id === messageId && !item.pending);
  if (!snapshot.notes.includes(note) || !note.discussionThreads?.includes(thread) || thread.state !== "open" || !message || !passageIsCurrent(note, thread.anchor)) {
    throw new Error("Accept or reattach this comment before creating an article.");
  }
  if (!passageIsCurrent({ ...note, body: workingTaskText(note.body) }, thread.anchor)) {
    throw new Error("This passage contains completed work. Select a current passage for the article.");
  }
  const comment = workingTaskText(passageCommentText(message.content)).trim();
  if (!comment) throw new Error("This comment has no text to develop.");
  return { spaceId: snapshot.workspace.id, noteId: note.id, threadId: thread.id, messageId,
    noteTitle: note.title, noteVersion: spaceNoteVersion(note), passage: thread.anchor.text, comment };
}

/** Reject proposed scope expansion even before the normal document review. */
export function validatePassageRewrite(proposal: ChatEditProposal, anchor: PassageAnchor): void {
  validateChatEditPassage(proposal, anchor.quote);
}
export function reviewPassageComment(thread: PassageThread, accept: boolean): PassageThread | undefined {
  if (accept) return { ...thread, state: "open", messages: thread.messages.map(({ pending: _pending, ...message }) => message) };
  const kept = thread.messages.some(message => message.pending) ? thread.messages.filter(message => !message.pending) : [];
  return kept.length ? { ...thread, state: "open", messages: kept } : undefined;
}

/** Both comment surfaces read the same bounded history, never an unrelated Space chat. */
export function passageConversationSnapshot(snapshot: AppSnapshot, thread: PassageThread, includeHistory: boolean): AppSnapshot {
  return { ...snapshot, studio: { ...snapshot.studio, messages: includeHistory ? thread.messages.filter(message => !message.pending).map(message => {
    const saved = splitSavedChatPassages(message.content);
    return { id: message.id, role: message.role, createdAt: message.createdAt, content: saved.body.replace(/#orion-passage-(e\d+)/g, "#orion-evidence-$1"),
      evidence: saved.evidence, cardIds: [], contextCardIds: [] };
  }) : [] } };
}
