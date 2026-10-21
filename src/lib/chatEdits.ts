import type { AppSnapshot, ChatEditProposal, ChatEvidence, ChatNoteEdit, ChatRequest, ChatEditMode } from "../types";
import protocol from "./chatEditsProtocol.json";
import { splitMarkdownFrontmatter } from "./markdown";
import { splitSavedChatPassages } from "./chatCitations";
import { splitTrailingReferences } from "./sourceCitations";

export interface ChatEditApplication { id: string; proposal: ChatEditProposal }
export interface ChatEditorChange { id: string; baseMarkdown: string; nextMarkdown: string; mode?: ChatEditMode }

export const CHAT_EDIT_INSTRUCTIONS = [protocol.automaticInstructions, protocol.instructions, protocol.rewriteInstructions].join("\n\n");
export const CHAT_EDIT_INTENT_SCHEMA = protocol.intentSchema;
export function parseChatEditIntent(value: unknown): "none" | ChatEditMode {
  if (value === undefined) return "none";
  if (value !== "none" && value !== "focused" && value !== "rewrite") throw new Error("Chat returned an invalid editing intent.");
  return value;
}
export const CHAT_EDIT_SCHEMA = protocol.schema;
export const CHAT_REWRITE_SCHEMA = protocol.rewriteSchema;
export const MAX_CHAT_EDIT_CHARS = 6_000;
export const MAX_CHAT_REWRITE_CHARS = 24_000;

export function chatRequestAllowsEdits(request: ChatRequest): boolean {
  return request.mode === "chat-reading" && typeof request.editNoteId === "string" &&
    request.editNoteId.length > 0 && request.editNoteId.length <= 200 && request.allowNoteActions !== true;
}

export function parseChatNoteEdits(value: unknown): ChatNoteEdit[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("Chat returned too many text changes.");
  let count = 0;
  return value.map(item => {
    if (!item || typeof item !== "object" || Object.keys(item).sort().join(",") !== "after,before" ||
      typeof item.before !== "string" || !item.before.trim() || typeof item.after !== "string" ||
      [item.before, item.after].some(text => [...text].length > MAX_CHAT_EDIT_CHARS || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|<!--\s*\/?orion-/iu.test(text))) {
      throw new Error("Chat returned an invalid text change.");
    }
    if (/\[\[e\d+\]\]/u.test(item.after)) throw new Error("Text changes cannot contain temporary Chat citations.");
    count += [...item.before].length + [...item.after].length;
    if (count > 24_000) throw new Error("Chat's text changes exceeded their limit.");
    if (item.before === item.after) throw new Error("Chat proposed an unchanged passage.");
    return { before: item.before, after: item.after };
  });
}

export function applyChatTextEdits(body: string, edits: ChatNoteEdit[]): string {
  const validated = parseChatNoteEdits(edits);
  const { prefix, content } = splitMarkdownFrontmatter(body);
  const editableEnd = prefix.length + splitSavedChatPassages(splitTrailingReferences(content).body).body.length;
  const comments = [...body.matchAll(/<!--[\s\S]*?(?:-->|$)/g)].map(match => ({ start: match.index, end: match.index + match[0].length }));
  const ranges = validated.map(edit => {
    const start = body.indexOf(edit.before);
    if (start < prefix.length || start < 0 || body.indexOf(edit.before, start + 1) !== -1) {
      throw new Error("The proposed passage is missing or ambiguous. Ask Chat to regenerate the changes.");
    }
    if (start + edit.before.length > editableEnd || comments.some(range => start < range.end && start + edit.before.length > range.start)) {
      throw new Error("Chat can edit authored text, but cannot change note metadata or retained evidence.");
    }
    return { ...edit, start, end: start + edit.before.length };
  }).sort((a, b) => a.start - b.start);
  if (ranges.some((range, index) => index > 0 && range.start < ranges[index - 1].end)) {
    throw new Error("The proposed text changes overlap. Ask Chat to regenerate them.");
  }
  let next = body;
  for (const range of ranges.reverse()) next = next.slice(0, range.start) + range.after + next.slice(range.end);
  const authored = splitSavedChatPassages(splitTrailingReferences(splitMarkdownFrontmatter(next).content).body).body;
  if (!authored.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim()) throw new Error("Chat cannot clear the entire note.");
  if (splitMarkdownFrontmatter(next).prefix !== prefix) throw new Error("Chat cannot change note frontmatter.");
  return next;
}

export function validateChatEditTarget(snapshot: AppSnapshot, proposal: ChatEditProposal): void {
  const note = snapshot.notes.find(item => item.id === proposal.noteId);
  if (snapshot.workspace.id !== proposal.spaceId || !note) throw new Error("This edit belongs to a different or unavailable note.");
  if (note.body !== proposal.baseBody) throw new Error("This note has changed. Ask Chat to regenerate the edits.");
  chatProposalBody(proposal);
}

export function createChatEditProposal(snapshot: AppSnapshot, noteId: string | undefined,
  edits: ChatNoteEdit[], evidence: readonly ChatEvidence[]): ChatEditProposal | undefined {
  if (!noteId || !edits.length) return undefined;
  const note = snapshot.notes.find(note => note.id === noteId);
  if (!note) throw new Error("The note being edited is no longer in this Space.");
  for (const edit of edits) {
    if (!evidence.some(item => item.kind === "note" && item.entityId === noteId && note.body.slice(item.start, item.end) === item.text && item.text.includes(edit.before))) {
      throw new Error("Read the exact current-note passage before proposing its replacement.");
    }
  }
  applyChatTextEdits(note.body, edits);
  return { spaceId: snapshot.workspace.id, noteId, title: note.title, baseBody: note.body, mode: "focused", edits };
}

/** A discussion can only revise its captured passage, even after broader reads. */
export function validateChatEditPassage(proposal: ChatEditProposal, quote: string): void {
  const uniqueOffset = (text: string) => {
    const at = proposal.baseBody.indexOf(text);
    return text && at >= 0 && proposal.baseBody.indexOf(text, at + 1) < 0 ? at : undefined;
  };
  const start = uniqueOffset(quote);
  // Missing mode has always meant focused in the shared edit/review contract.
  if (start === undefined || proposal.mode === "rewrite" || !proposal.edits.length || proposal.edits.some(edit => {
    const at = uniqueOffset(edit.before);
    return at === undefined || at < start || at + edit.before.length > start + quote.length;
  })) throw new Error("The suggested rewrite extended beyond this passage. Keep every change inside the attached passage and leave surrounding text unchanged.");
}

/** Keep frontmatter and generated evidence outside the model's replacement. */
export function chatEditableBody(body: string): { prefix: string; body: string; suffix: string } {
  const document = splitMarkdownFrontmatter(body);
  const authored = splitSavedChatPassages(splitTrailingReferences(document.content).body).body;
  return { prefix: document.prefix, body: authored, suffix: document.content.slice(authored.length) };
}

export function parseChatRewrite(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || [...value].length > MAX_CHAT_REWRITE_CHARS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\[\[e\d+\]\]/u.test(value)) throw new Error("Chat returned an invalid full rewrite.");
  return value;
}

export function chatProposalBody(proposal: ChatEditProposal): string {
  if (proposal.mode !== "rewrite") return applyChatTextEdits(proposal.baseBody, proposal.edits);
  const original = chatEditableBody(proposal.baseBody);
  const replacement = parseChatRewrite(proposal.rewrite);
  if (!replacement?.trim() || splitMarkdownFrontmatter(replacement).prefix || chatEditableBody(replacement).suffix ||
    !replacement.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim()) throw new Error("A full rewrite must contain the complete note text.");
  const comments = (text: string) => text.match(/<!--[\s\S]*?(?:-->|$)/g) ?? [];
  if (JSON.stringify(comments(original.body)) !== JSON.stringify(comments(replacement))) throw new Error("The rewrite changed protected formatting metadata. Ask Chat to try again.");
  if (replacement === original.body) throw new Error("The rewrite did not change the note.");
  return original.prefix + replacement + original.suffix;
}

export function createChatRewriteProposal(snapshot: AppSnapshot, noteId: string, rewrite: unknown): ChatEditProposal {
  const note = snapshot.notes.find(item => item.id === noteId);
  if (!note) throw new Error("The note being edited is no longer in this Space.");
  const proposal: ChatEditProposal = { spaceId: snapshot.workspace.id, noteId, title: note.title, baseBody: note.body,
    mode: "rewrite", rewrite: parseChatRewrite(rewrite), edits: [] };
  chatProposalBody(proposal);
  return proposal;
}
