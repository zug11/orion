import type { AppSnapshot, Note } from "../types";
import { localSearchTerms } from "./localSearch";
import { getNoteExcerptText } from "./noteExcerpts";
import { displayNoteTitle, editableNoteSubtitle, editableNoteTitle, visibleNoteTags } from "./noteMetadata";

export interface SpaceDiscoveryMatch {
  spaceId: string;
  noteId: string;
  noteTitle: string;
  snippet: string;
  score: number;
}

interface SearchPhrase {
  literal: RegExp;
  words?: RegExp;
  wordCount: number;
  bonus: number;
}

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Match complete words, with Unicode boundaries and literal punctuation (e.g. C++).
const wholeWords = (pattern: string, global = false) => new RegExp(
  `(^|[^\\p{L}\\p{M}\\p{N}])(${pattern})(?![\\p{L}\\p{M}\\p{N}])`, global ? "giu" : "iu",
);

function preparePhrases(query: string, alternatives: readonly string[]): SearchPhrase[] {
  const phrases: SearchPhrase[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of [query, ...alternatives.slice(0, 8)].entries()) {
    const value = raw.trim().slice(0, 600);
    const quoted = value.startsWith('"') && value.endsWith('"');
    const text = (quoted ? value.slice(1, -1) : value).trim().replace(/\s+/g, " ");
    const key = text.toLowerCase();
    if (text.length < 2 || seen.has(key) || !/[\p{L}\p{N}]/u.test(text)) continue;
    const plain = text.replace(/[^\p{L}\p{N} ]/gu, " ");
    const terms = localSearchTerms(plain);
    if (!terms.length && !quoted && !/^[\p{L}\p{N}][#+]+$/u.test(text)) continue;
    seen.add(key);
    const tryWords = !quoted && terms.length > 0 && (terms.length > 1 || terms[0] !== key) &&
      /^[\p{L}\p{N}\s,?!'’]+$/u.test(text);
    phrases.push({
      literal: wholeWords(text.split(" ").map(escapePattern).join("\\s+")),
      words: tryWords ? wholeWords(terms.map(escapePattern).join("|"), true) : undefined,
      wordCount: terms.length,
      bonus: (index === 0 ? 10 : 0) + 2 * Math.min(terms.length, 4),
    });
  }
  return phrases;
}

function matchPassage(text: string, phrase: SearchPhrase) {
  const exact = phrase.literal.exec(text);
  if (exact) return { at: exact.index + exact[1].length, score: 60 + phrase.bonus };
  if (!phrase.words) return;

  // Words in a long note must occur close enough together that the displayed
  // excerpt can actually explain the match. Keep only each term's latest offset.
  const recent = new Map<string, number>();
  let bestCount = 0, bestStart = 0;
  for (const hit of text.matchAll(phrase.words)) {
    const at = hit.index! + hit[1].length;
    recent.set(hit[2].toLowerCase(), at);
    for (const [term, offset] of recent) if (at + hit[2].length - offset > 124) recent.delete(term);
    if (recent.size > bestCount) {
      bestCount = recent.size;
      bestStart = Math.min(...recent.values());
      if (bestCount === phrase.wordCount) break;
    }
  }
  if (bestCount >= Math.min(phrase.wordCount, Math.max(2, Math.ceil(phrase.wordCount * 0.6)))) {
    return { at: bestStart, score: 18 + 30 * bestCount / phrase.wordCount + phrase.bonus };
  }
}

function excerpt(text: string, at: number): string {
  let from = Math.max(0, at - 36), to = Math.min(text.length, from + 200);
  if (from && /[\uDC00-\uDFFF]/.test(text[from])) from--;
  if (to < text.length && /[\uDC00-\uDFFF]/.test(text[to])) to++;
  return (from ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : "");
}

function matchNote(note: Note, spaceId: string, phrases: SearchPhrase[]): SpaceDiscoveryMatch | undefined {
  const title = editableNoteTitle(note);
  const fields: [string, number][] = [
    [title, 12], [editableNoteSubtitle(note), 5],
    ...[...note.aliases, ...visibleNoteTags(note)].map((label): [string, number] => [label, 6]),
    [getNoteExcerptText(note), 0],
  ];
  let best: SpaceDiscoveryMatch | undefined;
  let supporting: { score: number; snippet: string } | undefined;
  for (const [text, fieldWeight] of fields) {
    if (!text) continue;
    for (const phrase of phrases) {
      const hit = matchPassage(text, phrase);
      if (!hit) continue;
      const score = hit.score + fieldWeight;
      if (text !== title && (!supporting || score > supporting.score)) {
        supporting = { score, snippet: excerpt(text, hit.at) };
      }
      if (!best || score > best.score) {
        best = { spaceId, noteId: note.id, noteTitle: displayNoteTitle(note),
          snippet: excerpt(text, hit.at), score };
      }
    }
  }
  // The row already shows the note title. Prefer an independently matched
  // passage for the second line if the strongest signal was that title.
  if (best && best.snippet === best.noteTitle && supporting) best.snippet = supporting.snippet;
  return best;
}

/** Finds evidence locally and returns one real note per matching Space. */
export async function searchSpaceContents(spaces: readonly AppSnapshot[], query: string, alternatives: readonly string[],
  signal: AbortSignal): Promise<SpaceDiscoveryMatch[]> {
  signal.throwIfAborted();
  if (!query.trim()) return [];
  const phrases = preparePhrases(query, alternatives);
  if (!phrases.length) return [];
  const results: SpaceDiscoveryMatch[] = [];
  // Yield before touching note bodies and between batches so the name picker
  // can paint, take input and cancel even on a cold search of a large library.
  let nextYield = 0;
  for (const space of spaces) {
    let best: SpaceDiscoveryMatch | undefined;
    for (const note of space.notes) {
      if (performance.now() >= nextYield) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        signal.throwIfAborted();
        nextYield = performance.now() + 6;
      }
      const match = matchNote(note, space.workspace.id, phrases);
      if (match && (!best || match.score > best.score)) best = match;
    }
    if (best) results.push(best);
  }
  return results.sort((a, b) => b.score - a.score);
}
