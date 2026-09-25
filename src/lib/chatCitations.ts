import type { ChatEvidence } from "../types";
import { isChatEvidence, MAX_CHAT_EVIDENCE, MAX_CHAT_PASSAGE_CHARS } from "./chatReadingProtocol";

const SAVED_PASSAGE_PREFIX = "orion-passage:v1:";
const MAX_ENCODED_PASSAGE_LENGTH = 32_000;
const MAX_SAVED_PASSAGE_BYTES = MAX_CHAT_EVIDENCE *
  (MAX_ENCODED_PASSAGE_LENGTH + MAX_CHAT_PASSAGE_CHARS * 8 + 600 * 16 + 1_024);
const EVIDENCE_KEYS = ["id", "kind", "entityId", "title", "version", "start", "end", "text", "offsetUnit"];

interface SavedPassageSection { body: string; footer: string; evidence: ChatEvidence[] }

/** Only the validated generated trailing section is excluded from editing. */
export function splitSavedChatPassages(markdown: string): SavedPassageSection {
  const marker = "\n\n## Cited passages\n\n";
  const start = markdown.lastIndexOf(marker);
  const unchanged = { body: markdown, footer: "", evidence: [] };
  if (start < 0) return unchanged;
  const footer = markdown.slice(start);
  const evidence = savedChatEvidence(footer);
  const paragraphs = footer.slice(marker.length).trimEnd().split("\n\n");
  if (!evidence.length || paragraphs.length !== evidence.length * 3) return unchanged;
  for (let index = 0; index < evidence.length; index += 1) {
    if (!paragraphs[index * 3].includes(`](#orion-passage-${evidence[index].id} "${SAVED_PASSAGE_PREFIX}`) ||
      !paragraphs[index * 3 + 1].split("\n").every((line) => line.startsWith("> ") || line === ">") ||
      !/^Original:[^\r\n]*$/.test(paragraphs[index * 3 + 2])) return unchanged;
  }
  return { body: markdown.slice(0, start), footer, evidence };
}

/** Keep original ordering and support Undo while an editor retains its footer. */
export function mergeSavedChatPassages(body: string, footer: string): string {
  if (!footer) return body;
  const section = splitSavedChatPassages(`Body${footer}`);
  if (!section.evidence.length) return body;
  const paragraphs = footer.slice("\n\n## Cited passages\n\n".length).trimEnd().split("\n\n");
  const kept = section.evidence.flatMap((item, index) => body.includes(`](#orion-passage-${item.id})`)
    ? [paragraphs.slice(index * 3, index * 3 + 3).join("\n\n")] : []);
  return kept.length ? `${body}\n\n## Cited passages\n\n${kept.join("\n\n")}` : body;
}

function isPortableEvidence(value: unknown): value is ChatEvidence {
  return isChatEvidence(value) && Object.keys(value).length === EVIDENCE_KEYS.length &&
    EVIDENCE_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    !/[\u0000-\u001f\u007f]/.test(value.entityId + value.title + value.version) &&
    !/[\uD800-\uDFFF]/u.test(value.entityId + value.title + value.version);
}

function encodeEvidence(evidence: ChatEvidence): string {
  const bytes = new TextEncoder().encode(JSON.stringify(evidence));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Link titles are inert data. Never accept a payload from the URL itself. */
export function savedChatEvidenceFromLink(href: string | undefined, title: string | undefined): ChatEvidence | undefined {
  if (!/^#orion-passage-e[1-9]\d{0,3}$/.test(href ?? "") || !title?.startsWith(SAVED_PASSAGE_PREFIX)) return;
  const encoded = title.slice(SAVED_PASSAGE_PREFIX.length);
  if (!encoded || encoded.length > MAX_ENCODED_PASSAGE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(encoded)) return;
  try {
    const bytes = Uint8Array.from(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")), (character) => character.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (isPortableEvidence(value) && href === `#orion-passage-${value.id}`) return value;
  } catch { /* Invalid or edited metadata is ordinary untrusted note text. */ }
}

/** Discover only standalone generated passage labels, never fenced examples. */
export function savedChatEvidence(markdown: string): ChatEvidence[] {
  const evidence: ChatEvidence[] = [];
  const prose = markdown.replace(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[ \t]*(?=\n|$)|$)/g, "");
  const pattern = /^\[((?:\\.|[^\]\\\n])*)\]\((#orion-passage-e[1-9]\d{0,3}) "(orion-passage:v1:[A-Za-z0-9_-]+)"\)[ \t]*$/gm;
  let bytes = 0;
  for (const match of prose.matchAll(pattern)) {
    if (evidence.length === MAX_CHAT_EVIDENCE) break;
    bytes += match[0].length;
    if (bytes > MAX_SAVED_PASSAGE_BYTES) break;
    const item = savedChatEvidenceFromLink(match[2], match[3]);
    if (item && !evidence.some((existing) => existing.id === item.id)) evidence.push(item);
  }
  return evidence;
}

function literalMarkdown(value: string): string {
  // A saved quote is text, including any Markdown, HTML or image instructions.
  // Character references also prevent GFM from autolinking quoted URLs and
  // swallowing the backslash escapes around surrounding Markdown punctuation.
  return value.replace(/[\\`*_{}\[\]<>()!#|~+\-.:\/&]/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function resolveChatEvidenceMarkers(markdown: string, evidence: ChatEvidence[], cited = new Map<string, ChatEvidence>()): string {
  if (/\]\(\s*(?:orion[^: ]*:\/\/|#orion-evidence-|#orion-passage-)/i.test(markdown)) {
    throw new Error("Use only the supplied evidence markers for Orion citations.");
  }
  return markdown.replace(/\[\[(e\d+)\]\]/g, (_marker, id: string) => {
    const item = evidence.find((candidate) => candidate.id === id);
    if (!item) throw new Error("The answer cited a passage outside the current evidence. Recheck its citations.");
    cited.set(id, item);
    return `[${[...cited.keys()].indexOf(id) + 1}](#orion-evidence-${id})`;
  });
}

/** Host-only conversion after action validation: exact quotes remain portable. */
export function portableChatEvidence(markdown: string, evidence: readonly ChatEvidence[]): string {
  const cited = new Map<string, ChatEvidence>();
  // A provider cannot mint historical evidence by copying a generated section.
  // Only this host conversion may attach a snapshot from the supplied evidence.
  const prose = markdown.replace(/\[((?:\\.|[^\]\\\n])*)\]\(#orion-passage-e\d+(?: "[^"\n]*")?\)/g, "$1");
  const body = prose.replace(/\[[^\]]*\]\(#orion-evidence-(e\d+)\)|\[\[(e\d+)\]\]/g, (_match, anchorId: string | undefined, markerId: string | undefined) => {
    const id = anchorId ?? markerId!;
    const item = evidence.slice(0, MAX_CHAT_EVIDENCE).find((candidate) => candidate.id === id && isPortableEvidence(candidate));
    if (!item) return "";
    cited.set(id, item);
    return `[${[...cited.keys()].indexOf(id) + 1}](#orion-passage-${id})`;
  });
  if (!cited.size) return body;
  const passages = [...cited.values()].map((item, index) => {
    const encoded = encodeEvidence(item);
    if (encoded.length > MAX_ENCODED_PASSAGE_LENGTH) throw new Error("The cited passage is too large to keep safely.");
    return `[Passage ${index + 1}: ${literalMarkdown(item.title)}](#orion-passage-${item.id} "${SAVED_PASSAGE_PREFIX}${encoded}")\n\n` +
      item.text.split("\n").map((line) => `> ${literalMarkdown(line)}`).join("\n") +
      `\n\nOriginal: [${literalMarkdown(item.title)}](orion-${item.kind}://${encodeURIComponent(item.entityId)})`;
  }).join("\n\n");
  if (new TextEncoder().encode(passages).length > MAX_SAVED_PASSAGE_BYTES) throw new Error("The cited passages are too large to keep safely.");
  return `${body}\n\n## Cited passages\n\n${passages}`;
}
