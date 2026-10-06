import type { AppSnapshot, Note, Source } from "../types";

export interface ImageEvidence {
  id: string;
  kind: "note" | "source";
  entityId: string;
  title: string;
  version: string;
  passages: { start: number; end: number; text: string }[];
  offsetUnit: "utf16";
  fullTextLength: number;
  complete: boolean;
}

interface LiveOrigin { id: string; body: string }
interface Passage {
  recordKey: string;
  start: number;
  end: number;
  terms: Map<string, number>;
  headingTerms: Set<string>;
}
interface IndexedRecord {
  key: string;
  prefix: string;
  kind: "note" | "source";
  entityId: string;
  title: string;
  body: string;
  metadata: string;
  version: string;
  terms: Set<string>;
  passages: Passage[];
  allowance: number;
  termAllowance: number;
  metadataAllowance: number;
  limited: boolean;
  passagesLimited: boolean;
}
interface SpaceIndex {
  records: Map<string, IndexedRecord>;
  postings: Map<string, Set<Passage>>;
  metadataPostings: Map<string, Set<string>>;
  passageCount: number;
  limited: boolean;
}
interface RecordInput {
  kind: "note" | "source";
  entityId: string;
  title: string;
  body: string;
  metadata: string;
  searchMetadata: string;
}
interface SearchResult {
  evidence: ImageEvidence[];
  hasMore: boolean;
  coverage: { records: number; passages: number; limited: boolean };
}

const TARGET_PASSAGE = 1_000;
const MAX_PASSAGE = 1_200;
const OVERLAP = 80;
const MIN_PASSAGE_STEP = 800;
// These are local memory/work safeguards, never quotas on notes supplied to AI.
// Oversized records are sampled throughout their body, including the final passage.
const MAX_INDEX_PASSAGES = 32_000;
const MAX_RECORD_PASSAGES = 4_096;
const MAX_INDEX_RECORDS = 20_000;
const MAX_CACHED_SPACES = 2;
const MAX_QUERY_TERMS = 32;
const MAX_QUERY_CHARS = 32_000;
const MAX_EVIDENCE_CHARS = 64_000;
const MAX_METADATA_CHARS = 16_000;
const MAX_TERM_ASSOCIATIONS = 1_000_000;
const MAX_METADATA_ASSOCIATIONS = 128_000;
const STOP_WORDS = new Set(("a an and are as at be been being but by can could did do does for from had has have how i if in into is it its may of on or our should so than that the their them then there these they this those to was we were what when where which who why will with would you your").split(" "));

function terms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  // Every text window is bounded before tokenization; no whole-document regex.
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) {
    const token = match[0];
    if (token.length < 2 || token.length > 64 || STOP_WORDS.has(token)) continue;
    result.set(token, (result.get(token) ?? 0) + 1);
  }
  return result;
}
function sampleTerms<T>(values: Map<string, T>, allowance: number): Map<string, T> {
  if (values.size <= allowance) return values;
  const entries = [...values];
  return new Map(Array.from({ length: allowance }, (_, i) => entries[Math.floor(i * (entries.length - 1) / Math.max(1, allowance - 1))]));
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Image context search was cancelled.", "AbortError");
}
function checkpoints(signal: AbortSignal | undefined, current: () => boolean) {
  let last = performance.now();
  return async () => {
    abort(signal);
    if (!current()) throw new DOMException("Image context search was superseded.", "AbortError");
    if (performance.now() - last >= 8) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      last = performance.now();
      abort(signal);
      if (!current()) throw new DOMException("Image context search was superseded.", "AbortError");
    }
  };
}

// Two 32-bit halves of FNV-1a, matching Orion's non-cryptographic equality hashes.
function hashPart(value: string, state = { high: 0xcbf29ce4, low: 0x84222325 }) {
  for (let i = 0; i < value.length; i += 1) {
    state.low ^= value.charCodeAt(i);
    const low = state.low * 0x1b3;
    state.high = (state.high * 0x1b3 + state.low * 0x100) >>> 0;
    state.low = low >>> 0;
  }
  return state;
}
function hashText(value: string): string {
  const hash = hashPart(value);
  return `${hash.high.toString(16).padStart(8, "0")}${hash.low.toString(16).padStart(8, "0")}`;
}
async function bodyVersion(body: string, checkpoint: () => Promise<void>): Promise<string> {
  const hash = { high: 0xcbf29ce4, low: 0x84222325 };
  for (let offset = 0; offset < body.length; offset += 65_536) {
    hashPart(body.slice(offset, offset + 65_536), hash);
    await checkpoint();
  }
  return `${hash.high.toString(16).padStart(8, "0")}${hash.low.toString(16).padStart(8, "0")}`;
}
function safeStart(body: string, offset: number): number {
  return offset > 0 && /[\uDC00-\uDFFF]/.test(body[offset] ?? "") ? offset - 1 : offset;
}
function safeEnd(body: string, offset: number): number {
  return offset < body.length && /[\uD800-\uDBFF]/.test(body[offset - 1] ?? "") ? offset - 1 : offset;
}
function recordKey(kind: "note" | "source", id: string) { return `${kind}:${id}`; }
function evidencePrefix(kind: "note" | "source", id: string) {
  return `${kind}:${id.length <= 120 ? id : `hash-${hashText(id)}`}:`;
}
function passageId(record: IndexedRecord, start: number, end: number) { return `${record.prefix}${start}-${end}`; }

function conceptMetadata(snapshot: AppSnapshot): Map<string, string[]> {
  const byNote = new Map<string, string[]>();
  const notesByConcept = new Map<string, string[]>();
  for (const note of snapshot.notes) for (const id of note.conceptIds) {
    const ids = notesByConcept.get(id) ?? [];
    ids.push(note.id);
    notesByConcept.set(id, ids);
  }
  for (const concept of snapshot.concepts) {
    const labels = [concept.label, ...concept.aliases];
    for (const id of new Set([...concept.noteIds, ...(concept.canonicalNoteId ? [concept.canonicalNoteId] : []), ...(notesByConcept.get(concept.id) ?? [])])) {
      const known = byNote.get(id) ?? [];
      known.push(...labels);
      byNote.set(id, known);
    }
  }
  return byNote;
}
function inputRecord(kind: "note" | "source", value: Note | Source, concepts: Map<string, string[]>, origin?: LiveOrigin): RecordInput {
  if (kind === "note") {
    const note = value as Note;
    const labels = concepts.get(note.id) ?? [];
    return { kind, entityId: note.id, title: note.title,
      body: origin?.id === note.id ? origin.body : note.body,
      metadata: JSON.stringify({ title: note.title, aliases: note.aliases, sourceIds: note.sourceIds, conceptIds: note.conceptIds, concepts: labels }),
      searchMetadata: [note.title, ...note.aliases, ...labels].join("\n") };
  }
  const source = value as Source;
  return { kind, entityId: source.id, title: source.title, body: source.text,
    metadata: JSON.stringify({ title: source.title, kind: source.kind, sourceUrl: source.sourceUrl, fileName: source.fileName, importedAt: source.importedAt, noteIds: source.noteIds }),
    searchMetadata: source.title };
}

/** Fairly allocate local index memory. Short records retain all passages; long
 * records share the remaining capacity, independently of sidebar/import order. */
function passageAllowances(inputs: RecordInput[]): number[] {
  let remaining = MAX_INDEX_PASSAGES;
  const desired = inputs.map((item, index) => ({ index, count: Math.min(MAX_RECORD_PASSAGES, Math.max(1, Math.ceil(item.body.length / MIN_PASSAGE_STEP))) }))
    .sort((a, b) => a.count - b.count || a.index - b.index);
  const result: number[] = [];
  desired.forEach((item, position) => {
    const allowance = Math.min(item.count, Math.floor(remaining / (desired.length - position)));
    result[item.index] = allowance;
    remaining -= allowance;
  });
  return result;
}
function* ranges(body: string, allowance: number): Generator<{ start: number; end: number }> {
  if (!body.length || allowance < 1) return;
  const estimated = Math.ceil(body.length / MIN_PASSAGE_STEP);
  if (estimated > allowance) {
    // Even coverage keeps document tails discoverable at the resource ceiling.
    for (let index = 0; index < allowance; index += 1) {
      const start = safeStart(body, allowance === 1 ? 0 : Math.floor(index * Math.max(0, body.length - TARGET_PASSAGE) / (allowance - 1)));
      yield { start, end: safeEnd(body, Math.min(body.length, start + TARGET_PASSAGE)) };
    }
    return;
  }
  let start = 0;
  while (start < body.length) {
    let end = Math.min(body.length, start + TARGET_PASSAGE);
    if (end < body.length) {
      const ceiling = Math.min(body.length, start + MAX_PASSAGE);
      // Search only this bounded window. lastIndexOf on the entire body would
      // repeatedly rescan long paragraph-free prefixes and become quadratic.
      const window = body.slice(start, ceiling);
      const paragraph = window.lastIndexOf("\n\n");
      const line = paragraph >= 920 ? paragraph + 2 : window.lastIndexOf("\n") + 1;
      if (line >= 920) end = start + line;
      else {
        const space = window.lastIndexOf(" ", TARGET_PASSAGE);
        if (space >= 920) end = start + space + 1;
      }
    }
    end = safeEnd(body, end);
    yield { start, end };
    if (end === body.length) return;
    start = safeStart(body, Math.max(start + 1, end - OVERLAP));
  }
}
async function indexRecord(input: RecordInput, allowance: number, termAllowance: number, metadataAllowance: number, spaceId: string, checkpoint: () => Promise<void>, previous?: IndexedRecord): Promise<IndexedRecord> {
  const key = recordKey(input.kind, input.entityId);
  const bodyHash = previous?.body === input.body ? previous.version.split(":").pop()! : await bodyVersion(input.body, checkpoint);
  const metadataText = input.searchMetadata.length <= MAX_METADATA_CHARS ? input.searchMetadata
    : `${input.searchMetadata.slice(0, MAX_METADATA_CHARS / 2)}\n${input.searchMetadata.slice(-MAX_METADATA_CHARS / 2)}`;
  const metadataTerms = terms(metadataText);
  const record: IndexedRecord = { key, prefix: evidencePrefix(input.kind, input.entityId), kind: input.kind,
    entityId: input.entityId, title: input.title, body: input.body, metadata: input.metadata,
    version: `image:${hashText(spaceId)}:${hashText(input.metadata)}:${bodyHash}`,
    terms: new Set(sampleTerms(metadataTerms, metadataAllowance).keys()),
    passages: [], allowance, termAllowance, metadataAllowance,
    passagesLimited: Math.ceil(input.body.length / MIN_PASSAGE_STEP) > allowance,
    limited: Math.ceil(input.body.length / MIN_PASSAGE_STEP) > allowance || input.searchMetadata.length > MAX_METADATA_CHARS || metadataTerms.size > metadataAllowance };
  if (previous?.body === input.body && previous.allowance === allowance && previous.termAllowance === termAllowance) {
    record.passagesLimited = previous.passagesLimited;
    record.limited ||= previous.passagesLimited;
    record.passages = previous.passages;
    return record;
  }
  let heading = "";
  for (const range of ranges(input.body, allowance)) {
    const text = input.body.slice(range.start, range.end);
    const headings = [...text.matchAll(/(?:^|\n)#{1,6}\s+([^\n]{1,200})/g)];
    if (headings.length) heading = headings[headings.length - 1][1];
    const bodyTerms = terms(text);
    const headingTerms = terms(heading);
    const headingAllowance = Math.max(4, Math.floor(termAllowance / 4));
    record.passagesLimited ||= bodyTerms.size > termAllowance || headingTerms.size > headingAllowance;
    record.limited ||= record.passagesLimited;
    record.passages.push({ recordKey: key, ...range, terms: sampleTerms(bodyTerms, termAllowance), headingTerms: new Set(sampleTerms(headingTerms, headingAllowance).keys()) });
    await checkpoint();
  }
  return record;
}

/** A local, ephemeral, Space-scoped passage index. Unchanged records retain
 * tokenized passages; only changed records update inverted postings. No provider
 * call, persisted vault change, fixed note shortlist or body-prefix pool. */
export class ImageSearchIndex {
  private spaces = new Map<string, SpaceIndex>();
  private activeSpaceId: string | undefined;
  private generation = 0;

  async prepare(snapshot: AppSnapshot, origin?: LiveOrigin, signal?: AbortSignal): Promise<void> {
    const generation = ++this.generation;
    this.activeSpaceId = undefined;
    const checkpoint = checkpoints(signal, () => this.generation === generation);
    await checkpoint();
    const spaceId = snapshot.workspace.id;
    const previous = this.spaces.get(spaceId);
    const concepts = conceptMetadata(snapshot);
    const all = [
      ...snapshot.notes.map((note) => inputRecord("note", note, concepts, origin)),
      ...snapshot.sources.map((source) => inputRecord("source", source, concepts)),
    ];
    // Only pathological record counts reach this cap; sampling includes the end
    // and is disclosed separately from query/evidence truncation.
    const inputs = all.length <= MAX_INDEX_RECORDS ? all : Array.from({ length: MAX_INDEX_RECORDS }, (_, i) => all[Math.floor(i * (all.length - 1) / (MAX_INDEX_RECORDS - 1))]);
    const allowances = passageAllowances(inputs);
    const termAllowance = Math.min(512, Math.max(1, Math.floor(MAX_TERM_ASSOCIATIONS / Math.max(1, allowances.reduce((sum, value) => sum + value, 0)))));
    const metadataAllowance = Math.min(512, Math.max(1, Math.floor(MAX_METADATA_ASSOCIATIONS / Math.max(1, inputs.length))));
    const records = new Map<string, IndexedRecord>();
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const old = previous?.records.get(recordKey(input.kind, input.entityId));
      records.set(recordKey(input.kind, input.entityId), old && old.body === input.body && old.metadata === input.metadata && old.allowance === allowances[index] && old.termAllowance === termAllowance && old.metadataAllowance === metadataAllowance
        ? old : await indexRecord(input, allowances[index], termAllowance, metadataAllowance, spaceId, checkpoint, old));
      await checkpoint();
    }
    const postings = new Map(previous?.postings);
    const metadataPostings = new Map(previous?.metadataPostings);
    const touched = new Set<string>();
    const metadataTouched = new Set<string>();
    const mutablePosting = (term: string) => {
      if (!touched.has(term)) { postings.set(term, new Set(postings.get(term))); touched.add(term); }
      return postings.get(term)!;
    };
    const mutableMetadata = (term: string) => {
      if (!metadataTouched.has(term)) { metadataPostings.set(term, new Set(metadataPostings.get(term))); metadataTouched.add(term); }
      return metadataPostings.get(term)!;
    };
    for (const old of previous?.records.values() ?? []) if (records.get(old.key) !== old) {
      for (const passage of old.passages) {
        for (const term of new Set([...passage.terms.keys(), ...passage.headingTerms])) mutablePosting(term).delete(passage);
        await checkpoint();
      }
      for (const term of old.terms) mutableMetadata(term).delete(old.key);
    }
    for (const record of records.values()) if (previous?.records.get(record.key) !== record) {
      for (const passage of record.passages) {
        for (const term of new Set([...passage.terms.keys(), ...passage.headingTerms])) mutablePosting(term).add(passage);
        await checkpoint();
      }
      for (const term of record.terms) mutableMetadata(term).add(record.key);
    }
    for (const term of touched) if (!postings.get(term)?.size) postings.delete(term);
    for (const term of metadataTouched) if (!metadataPostings.get(term)?.size) metadataPostings.delete(term);
    await checkpoint();
    this.spaces.delete(spaceId);
    this.spaces.set(spaceId, { records, postings, metadataPostings,
      passageCount: [...records.values()].reduce((sum, record) => sum + record.passages.length, 0),
      limited: all.length > inputs.length || [...records.values()].some((record) => record.limited) });
    while (this.spaces.size > MAX_CACHED_SPACES) this.spaces.delete(this.spaces.keys().next().value!);
    this.activeSpaceId = spaceId;
  }

  async search(query: string, options: { characterBudget: number; excludeIds?: ReadonlySet<string>; signal?: AbortSignal }): Promise<SearchResult> {
    const generation = this.generation;
    const checkpoint = checkpoints(options.signal, () => this.generation === generation);
    await checkpoint();
    const index = this.activeSpaceId ? this.spaces.get(this.activeSpaceId) : undefined;
    if (!index) throw new Error("Prepare the active Space before searching image context.");
    const coverage = { records: index.records.size, passages: index.passageCount, limited: index.limited };
    let remaining = Number.isFinite(options.characterBudget) ? Math.max(0, Math.min(MAX_EVIDENCE_CHARS, Math.floor(options.characterBudget))) : 0;
    const queryTerms = [...terms(query.slice(0, MAX_QUERY_CHARS)).keys()].slice(0, MAX_QUERY_TERMS);
    if (!remaining || !queryTerms.length) return { evidence: [], hasMore: false, coverage };
    const scored = new Map<Passage, number>();
    for (const term of queryTerms) {
      const bodyMatches = index.postings.get(term);
      const weight = 1 + Math.log(1 + index.passageCount / (1 + (bodyMatches?.size ?? 0)));
      let processed = 0;
      for (const passage of bodyMatches ?? []) {
        const occurrences = passage.terms.get(term) ?? 0;
        scored.set(passage, (scored.get(passage) ?? 0) + weight * (occurrences ? 1 + Math.log(occurrences) : 0.5) + (passage.headingTerms.has(term) ? weight : 0));
        if (++processed % 128 === 0) await checkpoint();
      }
      for (const key of index.metadataPostings.get(term) ?? []) {
        for (const passage of index.records.get(key)!.passages) {
          scored.set(passage, (scored.get(passage) ?? 0) + weight * 2.5);
          if (++processed % 128 === 0) await checkpoint();
        }
      }
      await checkpoint();
    }
    const normalizedQuery = query.trim().toLowerCase();
    const phrase = normalizedQuery.length >= 3 && normalizedQuery.length <= 160 ? normalizedQuery : undefined;
    const ranked: { passage: Passage; score: number }[] = [];
    for (const [passage, score] of scored) {
      const record = index.records.get(passage.recordKey)!;
      ranked.push({ passage, score: score + (phrase && record.body.slice(passage.start, passage.end).toLowerCase().includes(phrase) ? queryTerms.length * 3 : 0) });
      if (ranked.length % 128 === 0) await checkpoint();
    }
    ranked.sort((a, b) => b.score - a.score || a.passage.recordKey.localeCompare(b.passage.recordKey) || a.passage.start - b.passage.start);
    await checkpoint();

    const excluded = new Map<string, { start: number; end: number }[]>();
    const seenText = new Set<string>();
    const prefixes = new Map([...index.records.values()].map((record) => [record.prefix, record]));
    for (const id of options.excludeIds ?? []) {
      const match = /^(.*:)(\d+)-(\d+)$/.exec(id);
      if (!match) continue;
      const record = prefixes.get(match[1]);
      const start = Number(match[2]); const end = Number(match[3]);
      if (!record || end <= start || end > record.body.length) continue;
      excluded.set(record.key, [...(excluded.get(record.key) ?? []), { start, end }]);
      seenText.add(record.body.slice(start, end).replace(/\s+/g, " ").trim());
    }
    const evidence: ImageEvidence[] = [];
    let hasMore = false;
    const unread = (start: number, end: number, read: { start: number; end: number }[]) => {
      let parts = [{ start, end }];
      for (const used of read) parts = parts.flatMap((part) => used.start >= part.end || used.end <= part.start ? [part] : [
        ...(used.start > part.start ? [{ start: part.start, end: used.start }] : []),
        ...(used.end < part.end ? [{ start: used.end, end: part.end }] : []),
      ]);
      return parts;
    };
    const relevant = (record: IndexedRecord, passage: Passage, start: number, end: number) => {
      if (queryTerms.some((term) => record.terms.has(term) || passage.headingTerms.has(term))) return end > start;
      const visibleTerms = terms(record.body.slice(start, end));
      return queryTerms.some((term) => visibleTerms.has(term));
    };
    candidates: for (let i = 0; i < ranked.length; i += 1) {
      if (i % 128 === 0) await checkpoint();
      const passage = ranked[i].passage;
      const record = index.records.get(passage.recordKey)!;
      const parts = unread(passage.start, passage.end, excluded.get(record.key) ?? []);
      for (const part of parts) {
        if (!relevant(record, passage, part.start, part.end)) continue;
        const fullText = record.body.slice(part.start, part.end);
        const duplicateKey = fullText.replace(/\s+/g, " ").trim();
        if (!duplicateKey || seenText.has(duplicateKey)) continue;
        if (remaining <= 0) { hasMore = true; break candidates; }
        let start = part.start; let end = part.end;
        if (end - start > remaining) {
          const lower = fullText.toLowerCase();
          const firstMatch = queryTerms.map((term) => lower.indexOf(term)).filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? 0;
          start = safeStart(record.body, Math.min(end - remaining, start + Math.max(0, firstMatch - Math.floor(remaining / 3))));
          end = safeEnd(record.body, Math.min(part.end, start + remaining));
          // A one-unit budget may land on a surrogate pair; return no broken text.
          if (end <= start) { hasMore = true; continue; }
        }
        const text = record.body.slice(start, end);
        evidence.push({ id: passageId(record, start, end), kind: record.kind, entityId: record.entityId,
          title: record.title.slice(0, safeEnd(record.title, Math.min(240, record.title.length))), version: record.version, passages: [{ start, end, text }],
          offsetUnit: "utf16", fullTextLength: record.body.length, complete: start === 0 && end === record.body.length });
        seenText.add(text.replace(/\s+/g, " ").trim());
        remaining -= text.length;
        excluded.set(record.key, [...(excluded.get(record.key) ?? []), { start, end }]);
        if (unread(part.start, part.end, [{ start, end }]).some((rest) => relevant(record, passage, rest.start, rest.end))) hasMore = true;
      }
    }
    await checkpoint();
    return { evidence, hasMore, coverage };
  }

  evidenceCurrent(evidence: ImageEvidence, snapshot: AppSnapshot, origin?: LiveOrigin): boolean {
    const index = this.spaces.get(snapshot.workspace.id);
    const record = index?.records.get(recordKey(evidence.kind, evidence.entityId));
    if (!record || record.version !== evidence.version) return false;
    const value = evidence.kind === "note" ? snapshot.notes.find((note) => note.id === evidence.entityId) : snapshot.sources.find((source) => source.id === evidence.entityId);
    if (!value) return false;
    const input = inputRecord(evidence.kind, value, conceptMetadata(snapshot), origin);
    return input.body === record.body && input.metadata === record.metadata && evidence.passages.length > 0 && evidence.passages.every((part) =>
      Number.isInteger(part.start) && Number.isInteger(part.end) && part.start >= 0 && part.end > part.start &&
      part.end <= record.body.length && record.body.slice(part.start, part.end) === part.text);
  }

  clear(): void {
    this.generation += 1;
    this.activeSpaceId = undefined;
    this.spaces.clear();
  }
}
