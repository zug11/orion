import type { AppSnapshot, ChatPromptSuggestion, Note, Source } from "../types";
import { isSelectedAIConfigured } from "./ai";
import { chatWithOrion } from "./storage";
import { workingTaskText } from "./taskWorkingView";
import { truncateUnicode } from "./text";
import {
  MAX_CHAT_SUGGESTION_CONTEXT_BYTES,
  parseChatSuggestionContext,
  parseChatSuggestionResult,
  type ChatSuggestionContext,
  type ChatSuggestionEvidence,
} from "./chatSuggestionsProtocol";

const MAX_INSPECTION_CHARS = 24_000;
const MAX_PASSAGE_CHARS = 2_000;
const STOP_WORDS = new Set("a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its me more my not of on or our she should so some than that the their them then there these they this those to was we were what when where which who why will with would you your".split(" "));
interface Candidate {
  kind: "note" | "source";
  entity: Note | Source;
  score: number;
  text: string;
}

function metadata(value: string, max = 300): string {
  return truncateUnicode(value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/g, " ").replace(/\s+/g, " ").trim(), max);
}

/** Filter before choosing passages: cached derivatives are never suggestion evidence. */
function workingProse(value: string): string {
  const original = truncateUnicode(value, MAX_INSPECTION_CHARS).replace(/<!--[^]*?(?:-->|$)/g, "\n");
  const originalLines = original.split(/\r?\n/);
  const lines = workingTaskText(original).split(/\r?\n/);
  const frontEnd = lines[0]?.trim() === "---"
    ? lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)$/.test(line.trim())) : 0;
  if (frontEnd < 0) return "";
  const visible: string[] = [];
  let pendingHeadings: Array<{ depth: number; text: string }> = [];
  let fence = "", fenceWidth = 0, exampleDepth = 0;
  let completedParentIndent: number | undefined;
  for (let index = frontEnd ? frontEnd + 1 : 0; index < lines.length; index++) {
    const line = lines[index], originalLine = originalLines[index];
    const marker = originalLine.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (marker) {
      if (!fence) { fence = marker[1][0]; fenceWidth = marker[1].length; }
      else if (marker[1][0] === fence && marker[1].length >= fenceWidth && !marker[2].trim()) fence = "";
      continue;
    }
    if (fence) continue;
    // Suggestion discovery treats a checked parent as a retired branch, including
    // unchecked descendants. Other working readers retain their existing semantics.
    const task = originalLine.match(/^(\s*)[-+*]\s+\[([ xX])\]\s+/);
    const indent = originalLine.length - originalLine.trimStart().length;
    if (task) {
      if (completedParentIndent !== undefined && indent > completedParentIndent) continue;
      completedParentIndent = task[2] === " " ? undefined : indent;
      if (completedParentIndent !== undefined) continue;
    } else if (completedParentIndent !== undefined) {
      if (originalLine.trim() && indent > completedParentIndent) continue;
      if (/^ {0,3}#{1,6}\s/.test(originalLine)) completedParentIndent = undefined;
    }
    if (/^\s*>|^(?: {4}|\t)/.test(line)) continue;
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      pendingHeadings = pendingHeadings.filter(item => item.depth < heading[1].length);
      if (exampleDepth && heading[1].length <= exampleDepth) exampleDepth = 0;
      if (/\b(?:examples?|samples?|templates?)\b/i.test(heading[2])) exampleDepth = heading[1].length;
    }
    if (exampleDepth) continue;
    if (heading) { pendingHeadings.push({ depth: heading[1].length, text: line }); continue; }
    if (!line.trim()) { if (visible.length && visible[visible.length - 1] !== "") visible.push(""); continue; }
    for (const pending of pendingHeadings) visible.push(pending.text);
    pendingHeadings = [];
    visible.push(line.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""));
  }
  return visible.join("\n").trim();
}

function terms(text: string): string[] {
  const counts = new Map<string, number>();
  for (const word of text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []) {
    if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([word]) => word);
}

/** The chosen window may start well beyond the opening paragraph. */
function passage(text: string, query: readonly string[]): string {
  const paragraphs = text.split(/\n\s*\n/).filter(item => item.trim());
  let best = "", bestScore = -1;
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    const lower = paragraph.toLocaleLowerCase();
    // An oversized paragraph can still yield a substantive window around a query hit.
    const hit = query.map(word => lower.indexOf(word)).filter(offset => offset >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = paragraph.length > MAX_PASSAGE_CHARS && hit > 500 ? Math.max(0, paragraph.lastIndexOf(" ", hit - 300)) : 0;
    let window = truncateUnicode(paragraph.slice(start), MAX_PASSAGE_CHARS);
    for (let next = index + 1; next < paragraphs.length; next++) {
      const joined = `${window}\n\n${paragraphs[next]}`;
      if ([...joined].length > MAX_PASSAGE_CHARS) break;
      window = joined;
    }
    const words = new Set(terms(window));
    const score = query.filter(word => words.has(word)).length * 5
      + Number(/\?/.test(window)) * 2 + Number(/^\s*[-+*]\s+\[ \]/m.test(window)) * 3
      + Math.min([...window].length / MAX_PASSAGE_CHARS, 1);
    if (score > bestScore) { best = window; bestScore = score; }
  }
  return best;
}

function noteNeighbors(snapshot: AppSnapshot, anchor: Note | undefined): Map<string, number> {
  const scores = new Map<string, number>();
  if (!anchor) return scores;
  const add = (id: string, amount: number) => scores.set(id, (scores.get(id) ?? 0) + amount);
  for (const relation of snapshot.relationships) {
    if (relation.fromNoteId === anchor.id) add(relation.toNoteId, 300);
    if (relation.toNoteId === anchor.id) add(relation.fromNoteId, 300);
  }
  const concepts = new Set(anchor.conceptIds);
  for (const concept of snapshot.concepts) {
    if (concepts.has(concept.id) || concept.noteIds.includes(anchor.id) || concept.canonicalNoteId === anchor.id) {
      for (const id of concept.noteIds) add(id, 120);
      if (concept.canonicalNoteId) add(concept.canonicalNoteId, 120);
    }
  }
  for (const note of snapshot.notes) {
    if (note.conceptIds.some(id => concepts.has(id))) add(note.id, 120);
    if (note.sourceIds.some(id => anchor.sourceIds.includes(id))) add(note.id, 160);
    if (note.tags.some(tag => anchor.tags.includes(tag))) add(note.id, 60);
  }
  return scores;
}

/** Bounded, read-only, Space-local subject material for provider-written prompts. */
export function getChatSuggestionContext(
  snapshot: AppSnapshot,
  options: { focusNoteId?: string; previousPrompts?: readonly string[] } = {},
): ChatSuggestionContext | null {
  const recent = [...snapshot.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const requestedFocus = snapshot.notes.find(note => note.id === options.focusNoteId);
  const focusText = requestedFocus ? workingProse(requestedFocus.body) : "";
  const focus = focusText ? requestedFocus : undefined;
  const anchor = focus ?? recent[0];
  const neighbors = noteNeighbors(snapshot, anchor);
  const rankedNotes = recent.map((note, index) => ({ note, score: note.id === focus?.id ? 10_000 : (neighbors.get(note.id) ?? 0) + 30 / (index + 1) }))
    .sort((a, b) => a.note.id === focus?.id ? -1 : b.note.id === focus?.id ? 1 : b.score - a.score).slice(0, 24);
  const candidates: Candidate[] = [];
  for (const { note, score } of rankedNotes) {
    const text = note.id === focus?.id ? focusText : workingProse(note.body);
    if (text) candidates.push({ kind: "note", entity: note, score, text });
    if (candidates.length === 8) break;
  }
  const recentSources = [...snapshot.sources].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
  const rankedSources = recentSources.map((source, index) => ({ source, score: (anchor && (anchor.sourceIds.includes(source.id) || source.noteIds.includes(anchor.id)) ? 250 : 0) + 25 / (index + 1) }))
    .sort((a, b) => b.score - a.score).slice(0, 12);
  let sourceCount = 0;
  for (const { source, score } of rankedSources) {
    const text = workingProse(source.text);
    if (text) { candidates.push({ kind: "source", entity: source, score, text }); sourceCount++; }
    if (sourceCount === 4) break;
  }
  const substantive = candidates.sort((a, b) => a.kind === "note" && a.entity.id === focus?.id ? -1 : b.kind === "note" && b.entity.id === focus?.id ? 1 : b.score - a.score);
  if (!substantive.length) return null;
  const query = terms(focusText || substantive[0].text);
  const evidence: ChatSuggestionEvidence[] = [];
  const selected = substantive.slice(0, 8);
  // Keep source evidence available alongside notes when recent material is otherwise dominant.
  if (selected.every(item => item.kind === "note")) {
    const source = substantive.find(item => item.kind === "source");
    if (source) selected[Math.min(selected.length, 7)] = source;
  }
  for (const candidate of selected) {
    const text = passage(candidate.text, query);
    if (!text.trim()) continue;
    evidence.push({ id: `s${evidence.length + 1}`, kind: candidate.kind, entityId: candidate.entity.id, title: metadata(candidate.entity.title), text });
  }
  const seenDirectoryIds = new Set<string>();
  const context: ChatSuggestionContext = {
    spaceId: snapshot.workspace.id,
    spaceName: metadata(snapshot.workspace.name),
    attachedNoteId: focus?.id ?? null,
    evidence,
    directory: substantive.filter(item => {
      if (seenDirectoryIds.has(item.entity.id)) return false;
      seenDirectoryIds.add(item.entity.id); return true;
    }).slice(0, 12).map(item => ({ id: item.entity.id, title: metadata(item.entity.title) })),
    previousPrompts: (options.previousPrompts ?? []).filter(item => item.trim()).slice(-8).map(item => truncateUnicode(item, 260)),
  };
  const bytes = () => new TextEncoder().encode(JSON.stringify(context)).length;
  while (bytes() > MAX_CHAT_SUGGESTION_CONTEXT_BYTES && context.evidence.length > 1) context.evidence.pop();
  while (bytes() > MAX_CHAT_SUGGESTION_CONTEXT_BYTES && context.directory.length) context.directory.pop();
  while (bytes() > MAX_CHAT_SUGGESTION_CONTEXT_BYTES && context.previousPrompts.length) context.previousPrompts.shift();
  if (!context.evidence.length) return null;
  try { return parseChatSuggestionContext(JSON.stringify(context)); } catch { return null; }
}

/** Exact packet identity; refreshed prompts deliberately do not change its identity. */
export function getChatSuggestionContextKey(context: ChatSuggestionContext): string {
  const { previousPrompts: _previousPrompts, ...knowledge } = context;
  return JSON.stringify(knowledge);
}

export async function generateChatSuggestions(
  snapshot: AppSnapshot,
  context: ChatSuggestionContext,
  signal?: AbortSignal,
): Promise<ChatPromptSuggestion[]> {
  if (signal?.aborted) throw new DOMException("Suggestion generation was cancelled.", "AbortError");
  if (!isSelectedAIConfigured(snapshot.settings)) throw new Error("Add a key for the selected provider to get suggestions.");
  const validated = parseChatSuggestionContext(JSON.stringify(context));
  const current = getChatSuggestionContext(snapshot, { focusNoteId: validated.attachedNoteId ?? undefined, previousPrompts: validated.previousPrompts });
  if (!current || getChatSuggestionContextKey(current) !== getChatSuggestionContextKey(validated)) {
    throw new Error("This Space changed before suggestions could be generated.");
  }
  const result = await chatWithOrion({
    mode: "chat-suggestions",
    prompt: "Suggest useful, specific next questions grounded in the supplied Space evidence.",
    workspaceName: validated.spaceName,
    notes: [], sources: [], concepts: [], history: [], allowNoteActions: false,
    suggestionContext: JSON.stringify(validated),
    model: snapshot.settings.model,
    effort: snapshot.settings.reasoningEffort,
  }, signal);
  if (signal?.aborted) throw new DOMException("Suggestion generation was cancelled.", "AbortError");
  return parseChatSuggestionResult({ suggestions: result.suggestions }, validated).suggestions!;
}
