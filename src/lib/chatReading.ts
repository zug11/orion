import type {
  AppSnapshot, ChatCoverage, ChatEvidence, ChatReadRequest, ChatRequest,
  ChatResult, Note, Source, SpaceKnowledgeBlueprint, SpaceNoteDigest,
} from "../types";
import { buildChatRequest, normalizeChatNoteActions } from "./chat";
import { exactPassages } from "./assistant/context";
import { buildGenerationContext } from "./generationContext";
import { stableSnapshotVersion } from "./knowledgeOrchestration/context";
import {
  buildSpaceNoteDigests, getSpaceKnowledgeRoot, spaceKnowledgeIsCurrent,
  spaceNoteVersion,
} from "./spaceKnowledge";
import { truncateUnicode } from "./text";
import { resolveChatEvidenceMarkers } from "./chatCitations";
import { sourceEvidenceVersion } from "./evidenceVersions";
import { resolveWikiLinks } from "./wiki";
import {
  MAX_CHAT_EVIDENCE, MAX_CHAT_PASSAGE_CHARS,
  MAX_CHAT_READING_CONTEXT_BYTES,
  parseChatReadRequests, parseChatReadingContext,
} from "./chatReadingProtocol";

export const MAX_CHAT_READING_TURNS = 6;
export const CHAT_READING_DEADLINE_MS = 180_000;
const DIRECTORY_PAGE = 12;
const STOP_WORDS = new Set("a an and are as at be by can did do does for from how i in is it me my of on or our should that the their them these they this to was we what when where which who why with would you your".split(" "));

interface DirectoryEntry {
  kind: "note" | "source";
  id: string;
  title: string;
  summary: string;
  version: string;
  length: number;
}

export interface ChatReadingOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Resolves the captured Space, independent of the window's navigation. */
  currentSnapshot?: () => AppSnapshot | undefined;
}

type ChatDriver = (request: ChatRequest, signal?: AbortSignal) => Promise<ChatResult>;

function words(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])]
    .filter((word) => !STOP_WORDS.has(word)).slice(0, 40);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Chat was stopped. Your message is ready to send again.");
}

function sourceVersion(source: Source): string {
  return sourceEvidenceVersion(source);
}

/** A fresh, bounded working set replaces the previous packet on every turn. */
class ChatReadingSession {
  private readonly notes: Map<string, Note>;
  private readonly sources: Map<string, Source>;
  private readonly digests: Map<string, SpaceNoteDigest>;
  private readonly clusters: Map<string, SpaceKnowledgeBlueprint>;
  private readonly allowedNotes = new Set<string>();
  private readonly allowedSources = new Set<string>();
  private readonly allowedClusters = new Set<string>();
  private readonly openedNotes = new Set<string>();
  private readonly openedSources = new Set<string>();
  private readonly readKeys = new Set<string>();
  private directory: DirectoryEntry[] = [];
  private evidence: ChatEvidence[] = [];
  private nextEvidence = 1;
  private searches = 0;
  private partialText = false;
  private results: unknown[] = [];
  private readonly orientation: unknown;

  constructor(private readonly snapshot: AppSnapshot, private readonly query: string) {
    this.notes = new Map(snapshot.notes.map((note) => [note.id, note]));
    this.sources = new Map(snapshot.sources.map((source) => [source.id, source]));
    this.digests = new Map(buildSpaceNoteDigests(snapshot).map((digest) => [digest.noteId, digest]));
    const current = spaceKnowledgeIsCurrent(snapshot);
    const root = current ? getSpaceKnowledgeRoot(snapshot.spaceKnowledge) : undefined;
    this.clusters = new Map(current ? snapshot.spaceKnowledge?.blueprints.map((cluster) => [cluster.id, cluster]) : []);
    if (root) {
      this.allowedClusters.add(root.id);
      const children = root.childBlueprintIds.slice(0, 8).flatMap((id) => {
        const child = this.clusters.get(id);
        if (!child) return [];
        this.allowedClusters.add(id);
        return [this.clusterSummary(child)];
      });
      this.orientation = { root: this.clusterSummary(root, 1_800), children, complete: children.length === root.childBlueprintIds.length };
    } else {
      this.orientation = {
        fallback: true,
        text: truncateUnicode(snapshot.spaceOverview?.body ?? snapshot.workspace.description, 1_800),
        stale: Boolean(snapshot.spaceOverview?.stale || snapshot.spaceKnowledge?.stale),
      };
    }
    // Initial routing inherits the maintained hierarchy and whole-body digests.
    // No note body is placed in the model context until an exact read is requested.
    this.addDirectory(buildGenerationContext(snapshot, query, true).candidates.slice(0, DIRECTORY_PAGE).map((note) => this.noteEntry(note)));
    // A follow-up can reopen evidence from the preceding reply, but must read its
    // current content. Historical quotations do not become current evidence.
    const previous = snapshot.studio.messages.filter((message) => message.role === "assistant").slice(-1)[0];
    this.addDirectory((previous?.evidence ?? []).slice(0, 6).flatMap((item) => {
      const note = item.kind === "note" ? this.notes.get(item.entityId) : undefined;
      const source = item.kind === "source" ? this.sources.get(item.entityId) : undefined;
      return note ? [this.noteEntry(note)] : source ? [this.sourceEntry(source)] : [];
    }));
  }

  private clusterSummary(cluster: SpaceKnowledgeBlueprint, width = 600) {
    return {
      id: cluster.id, title: truncateUnicode(cluster.title, 200),
      summary: truncateUnicode(cluster.body, width),
      noteCount: cluster.noteIds.length, childCount: cluster.childBlueprintIds.length,
    };
  }

  private noteEntry(note: Note): DirectoryEntry {
    const digest = this.digests.get(note.id);
    return {
      kind: "note", id: note.id, title: truncateUnicode(note.title, 200),
      summary: truncateUnicode(digest?.wholeBodySketch ?? note.summary, 360),
      version: digest?.noteVersion ?? spaceNoteVersion(note), length: note.body.length,
    };
  }

  private sourceEntry(source: Source): DirectoryEntry {
    return {
      kind: "source", id: source.id, title: truncateUnicode(source.title, 200),
      summary: "Preserved original source; open exact passages for evidence.",
      version: sourceVersion(source), length: source.text.length,
    };
  }

  private addDirectory(entries: DirectoryEntry[]) {
    for (const entry of entries) {
      (entry.kind === "note" ? this.allowedNotes : this.allowedSources).add(entry.id);
    }
    const merged = new Map(this.directory.map((entry) => [`${entry.kind}:${entry.id}`, entry]));
    for (const entry of entries) {
      const key = `${entry.kind}:${entry.id}`;
      merged.delete(key);
      merged.set(key, entry);
    }
    this.directory = [...merged.values()].slice(-24);
  }

  async search(query: string, start: number, signal: AbortSignal) {
    const tokens = words(query);
    const ranked: Array<{ kind: "note" | "source"; id: string; score: number }> = [];
    let scanned = 0;
    for (const [kind, records] of [["note", this.notes.values()], ["source", this.sources.values()]] as const) {
      for (const value of records) {
        if (scanned++ % 128 === 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (signal.aborted) throw abortReason(signal);
        }
        const title = [value.title, ...("aliases" in value ? value.aliases : [])].join(" ").toLocaleLowerCase();
        const body = ("body" in value ? value.body : value.text).toLocaleLowerCase();
        const score = tokens.reduce((n, word) => n + (title.includes(word) ? 12 : body.includes(word) ? 2 : 0), 0);
        if (score > 0) ranked.push({ kind, id: value.id, score });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const page = ranked.slice(start, start + DIRECTORY_PAGE).map((item) => item.kind === "note"
      ? this.noteEntry(this.notes.get(item.id)!) : this.sourceEntry(this.sources.get(item.id)!));
    this.addDirectory(page);
    this.searches += 1;
    return { operation: "search", query, matches: ranked.length, returned: page.map(({ kind, id }) => ({ kind, id })), nextStart: start + page.length < ranked.length ? start + page.length : null,
      coverage: "Local lexical search across all current-Space note and source bodies; no semantic completeness claim." };
  }

  private openText(kind: "note" | "source", id: string, query: string, start: number | null) {
    const value = kind === "note" ? this.notes.get(id) : this.sources.get(id);
    const allowed = kind === "note" ? this.allowedNotes : this.allowedSources;
    if (!value || !allowed.has(id)) throw new Error("That item was not discovered in this Space. Search for it first.");
    const body = "body" in value ? value.body : value.text;
    let passages;
    if (start === null) {
      passages = exactPassages(body, query || this.query, MAX_CHAT_PASSAGE_CHARS);
    } else {
      if (start > body.length) throw new Error("That text offset is outside the item.");
      // Offsets always refer to the untouched UTF-16 body, never a summary.
      if (start > 0 && /[\uDC00-\uDFFF]/.test(body[start] ?? "")) start -= 1;
      let end = Math.min(body.length, start + MAX_CHAT_PASSAGE_CHARS);
      if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
      passages = [{ start, end, text: body.slice(start, end) }];
    }
    const version = kind === "note" ? spaceNoteVersion(value as Note) : sourceVersion(value as Source);
    const opened: string[] = [];
    for (const passage of passages) {
      if (!passage.text) continue;
      let evidence = this.evidence.find((item) => item.kind === kind && item.entityId === id && item.start === passage.start && item.end === passage.end);
      if (!evidence) {
        evidence = { id: `e${this.nextEvidence++}`, kind, entityId: id, title: truncateUnicode(value.title, 300), version, ...passage, offsetUnit: "utf16" };
        this.evidence.push(evidence);
      } else {
        this.evidence = this.evidence.filter((item) => item !== evidence);
        this.evidence.push(evidence);
      }
      opened.push(evidence.id);
    }
    this.evidence = this.evidence.slice(-MAX_CHAT_EVIDENCE);
    (kind === "note" ? this.openedNotes : this.openedSources).add(id);
    if (passages.reduce((n, passage) => n + passage.text.length, 0) < body.length) this.partialText = true;
    if (kind === "note") {
      this.addDirectory((value as Note).sourceIds.flatMap((sourceId) => {
        const source = this.sources.get(sourceId);
        return source ? [this.sourceEntry(source)] : [];
      }).slice(0, DIRECTORY_PAGE));
    }
    return { operation: kind, id, evidenceIds: opened, length: body.length, nextStart: passages.slice(-1)[0]?.end === body.length ? null : passages.slice(-1)[0]?.end ?? null };
  }

  private openCluster(id: string, start: number) {
    const cluster = this.clusters.get(id);
    if (!cluster || !this.allowedClusters.has(id)) throw new Error("That cluster is unavailable. Use local search instead.");
    const children = cluster.childBlueprintIds.slice(start, start + DIRECTORY_PAGE).flatMap((childId) => {
      const child = this.clusters.get(childId);
      if (!child) return [];
      this.allowedClusters.add(childId);
      return [this.clusterSummary(child)];
    });
    const notes = cluster.noteIds.slice(start, start + DIRECTORY_PAGE).flatMap((noteId) => {
      const note = this.notes.get(noteId);
      return note ? [this.noteEntry(note)] : [];
    });
    this.addDirectory(notes);
    const size = Math.max(cluster.noteIds.length, cluster.childBlueprintIds.length);
    return { operation: "cluster", cluster: this.clusterSummary(cluster), children, noteIds: notes.map((note) => note.id), nextStart: start + DIRECTORY_PAGE < size ? start + DIRECTORY_PAGE : null };
  }

  private related(id: string, start: number) {
    const note = this.notes.get(id);
    if (!note || !this.allowedNotes.has(id)) throw new Error("That note was not discovered in this Space.");
    const relatedIds = new Set<string>();
    for (const link of resolveWikiLinks(note.body, this.snapshot.notes, this.snapshot.concepts)) {
      link.noteIds.forEach((noteId) => relatedIds.add(noteId));
    }
    for (const concept of this.snapshot.concepts) {
      if (note.conceptIds.includes(concept.id) || concept.noteIds.includes(id) || concept.canonicalNoteId === id) {
        concept.noteIds.forEach((noteId) => relatedIds.add(noteId));
        if (concept.canonicalNoteId) relatedIds.add(concept.canonicalNoteId);
      }
    }
    for (const relation of this.snapshot.relationships) {
      if (relation.fromNoteId === id) relatedIds.add(relation.toNoteId);
      if (relation.toNoteId === id) relatedIds.add(relation.fromNoteId);
    }
    relatedIds.delete(id);
    const related = [...relatedIds].flatMap((noteId) => {
      const target = this.notes.get(noteId);
      return target ? [this.noteEntry(target)] : [];
    });
    const sources = note.sourceIds.flatMap((sourceId) => {
      const source = this.sources.get(sourceId);
      return source ? [this.sourceEntry(source)] : [];
    });
    const all = [...sources, ...related];
    const page = all.slice(start, start + DIRECTORY_PAGE);
    this.addDirectory(page);
    return { operation: "related", id, items: page.map(({ kind, id: entityId }) => ({ kind, id: entityId })), nextStart: start + page.length < all.length ? start + page.length : null,
      note: "Links and shared concepts route reading; they are not support for a claim." };
  }

  async read(requests: ChatReadRequest[], signal: AbortSignal, onProgress?: (message: string) => void) {
    this.results = [];
    let progress = false;
    for (const request of requests) {
      if (signal.aborted) throw abortReason(signal);
      const key = JSON.stringify(request);
      if (this.readKeys.has(key)) {
        this.results.push({ operation: request.kind, error: "This exact read was already returned. Use another query or offset, or answer." });
        continue;
      }
      this.readKeys.add(key);
      onProgress?.(request.kind === "search" ? "Finding relevant material" : request.kind === "related" ? "Following connections" : "Reading supporting passages");
      try {
        this.results.push(request.kind === "search" ? await this.search(request.query, request.start ?? 0, signal)
          : request.kind === "cluster" ? this.openCluster(request.id, request.start ?? 0)
            : request.kind === "related" ? this.related(request.id, request.start ?? 0)
              : this.openText(request.kind, request.id, request.query, request.start));
        progress = true;
      } catch (error) {
        if (signal.aborted) throw abortReason(signal);
        this.results.push({ operation: request.kind, error: error instanceof Error ? error.message : "This read was unavailable." });
      }
    }
    return progress;
  }

  coverage(budgetLimited = false): ChatCoverage {
    return { availableNotes: this.notes.size, availableSources: this.sources.size, openedNotes: this.openedNotes.size,
      openedSources: this.openedSources.size, searches: this.searches,
      limited: budgetLimited || this.partialText || this.openedNotes.size < this.notes.size || this.openedSources.size < this.sources.size };
  }

  packet(finalizing: boolean, correction?: string): string {
    const serialize = () => JSON.stringify({
      finalizing,
      orientation: this.orientation,
      directory: this.directory,
      results: this.results,
      evidence: this.evidence,
      coverage: this.coverage(finalizing),
      ...(correction ? { correction } : {}),
    });
    let packet = serialize();
    // Bound encoded bytes too: CJK and emoji must not overflow the transport.
    while (new TextEncoder().encode(packet).length > MAX_CHAT_READING_CONTEXT_BYTES) {
      if (this.results.length) this.results.shift();
      else if (this.directory.length > 4) this.directory.shift();
      else if (this.evidence.length > 1) this.evidence.shift();
      else break;
      this.partialText = true;
      packet = serialize();
    }
    parseChatReadingContext(packet);
    return packet;
  }

  finish(result: ChatResult, limited: boolean): ChatResult {
    const cited = new Map<string, ChatEvidence>();
    const reply = resolveChatEvidenceMarkers(result.reply, this.evidence, cited);
    const noteActions = normalizeChatNoteActions(result.noteActions);
    // Validate/register each citation now. Expand markers and append retained
    // quotes only after the model's original action passes the host firewall.
    for (const action of noteActions) resolveChatEvidenceMarkers(action.body, this.evidence, cited);
    return { reply, ...(noteActions.length ? { noteActions } : {}),
      evidence: [...cited.values()], coverage: this.coverage(limited) };
  }
}

export async function runChatReading(
  snapshot: AppSnapshot, prompt: string, driver: ChatDriver, options: ChatReadingOptions = {},
): Promise<ChatResult> {
  const frozen = structuredClone(snapshot);
  const version = stableSnapshotVersion(frozen);
  const assertCurrent = () => {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    if (options.currentSnapshot) {
      const current = options.currentSnapshot();
      if (!current || stableSnapshotVersion(current) !== version) {
        throw new Error("This Space changed while Chat was reading. Send the question again to use its current knowledge.");
      }
    }
  };
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("Chat was stopped. Your message is ready to send again."));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Chat reached its reading time limit. Try a narrower question.")), CHAT_READING_DEADLINE_MS);
  try {
    assertCurrent();
    const request = buildChatRequest(frozen, prompt);
    const previousQuestion = frozen.studio.messages.filter((message) => message.role === "user").slice(-1)[0]?.content ?? "";
    const query = truncateUnicode(`${request.prompt}\n${previousQuestion.slice(0, 400)}`, 600);
    const session = new ChatReadingSession(frozen, query);
    options.onProgress?.("Finding relevant material");
    await session.search(query, 0, controller.signal);
    let noProgress = 0;
    let correction: string | undefined;
    for (let turn = 0; turn < MAX_CHAT_READING_TURNS; turn += 1) {
      assertCurrent();
      const finalizing = turn === MAX_CHAT_READING_TURNS - 1 || noProgress >= 2;
      options.onProgress?.(finalizing ? "Writing an answer" : "Considering the evidence");
      const result = await driver({ ...request, mode: "chat-reading", readingContext: session.packet(finalizing, correction) }, controller.signal);
      assertCurrent();
      try {
        const reads = parseChatReadRequests(result.readRequests ?? []);
        if (reads.length) {
          if (finalizing) throw new Error("Chat could not finish within its reading budget. Try a narrower question.");
          // Reading never grants a write. Ignore any accompanying prose/actions.
          const progress = await session.read(reads, controller.signal, options.onProgress);
          noProgress = progress ? 0 : noProgress + 1;
          correction = undefined;
          continue;
        }
        if (!result.reply.trim()) throw new Error("Chat returned no answer. Answer with the available evidence or explain the gap.");
        return session.finish({ ...result, noteActions: request.allowNoteActions ? result.noteActions : undefined }, finalizing);
      } catch (error) {
        if (controller.signal.aborted || finalizing) throw error;
        correction = error instanceof Error ? error.message : "The response was invalid. Use the supplied reading and citation contract.";
        noProgress += 1;
      }
    }
    throw new Error("Chat could not complete its answer. Try a narrower question.");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
