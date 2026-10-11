import type { JSONContent } from "@tiptap/core";

export const TABLE_CODE_JOIN = "<!-- orion-code-join -->";

/** CommonMark intentionally normalizes inline line endings. Import callers can
 * report that limitation; ordinary editor saves keep that existing behavior. */
export function canSerializeInlineCode(text: string, _inTable = false): boolean {
  return !/[\r\n]/.test(text);
}

/** Real content, unlike Tiptap's synthetic mark probe, determines the fence.
 * CommonMark strips one ASCII space from BOTH ends only when content is not
 * entirely ASCII spaces. Tabs and other whitespace are literal code text. */
export function serializeInlineCode(text: string, inTable = false): string {
  const normalized = text.replace(/\r\n?|\n/g, " ");
  if (!inTable) return codeSpan(normalized, false);
  // GFM removes one pipe escape after splitting cells. A literal odd run of
  // backslashes before a pipe cannot fit into ONE code span. Split exactly at
  // that pipe instead; HTML comments are invisible in portable Markdown. Our
  // read/export plugin merges only code/comment/code inside table ancestry.
  const parts: string[] = [];
  let start = 0;
  for (const match of normalized.matchAll(/(\\+)\|/g)) {
    if (match[1].length % 2 === 0) continue;
    const pipe = match.index! + match[1].length;
    parts.push(codeSpan(normalized.slice(start, pipe), true));
    start = pipe;
  }
  parts.push(codeSpan(normalized.slice(start), true));
  return parts.join(TABLE_CODE_JOIN);
}

function codeSpan(text: string, inTable: boolean): string {
  if (!text) return "";
  const fence = "`".repeat(longestRun(text, "`") + 1);
  const padding = text.startsWith("`") || text.endsWith("`")
    || (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text)) ? " " : "";
  const literal = inTable ? text.replace(/\|/g, "\\|") : text;
  return `${fence}${padding}${literal}${padding}${fence}`;
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === character ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

export function serializeFencedCode(text: string, language = ""): string {
  // Backticks are not permitted in a backtick fence's info string.
  const character = language.includes("`") ? "~" : "`";
  const fence = character.repeat(Math.max(3, longestRun(text, character) + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}

/** Protect literal code while the ordinary renderer handles every other node,
 * mark and metadata field. This is a per-call copy, never an editor/schema
 * mutation: sentinels cannot collide with ANY original text/attribute, and are
 * restored once, after table whitespace normalization and mark-boundary logic. */
export function serializeWithLiteralCode(document: JSONContent, serialize: (document: JSONContent) => string): string {
  const source = JSON.stringify(document);
  const occupied = new Set(Array.from(source.matchAll(/\uE000ORION(\d+):/g), (match) => Number(match[1])));
  let namespace = 0;
  while (occupied.has(namespace)) namespace += 1;
  const prefix = `\uE000ORION${namespace}:`;
  const replacements: string[] = [];
  const protect = (value: string) => `${prefix}${replacements.push(value) - 1}\uE001`;
  const copy = (node: JSONContent, inTable: boolean, inCodeBlock: boolean): JSONContent => {
    const table = inTable || node.type === "table";
    const block = inCodeBlock || node.type === "codeBlock";
    if (node.type === "text" && !block) {
      const code = node.marks?.some((mark) => mark.type === "code");
      if (code && node.text) {
        return { ...node, text: protect(serializeInlineCode(node.text, table)),
          marks: node.marks?.filter((mark) => mark.type !== "code") };
      }
      if (table && node.text?.includes("|")) {
        // Ordinary text backslashes are already doubled by the renderer.
        // Adding one escape here gives GFM the required odd run, including
        // when the original text had one or several backslashes before it.
        return { ...node, text: node.text.replace(/\|/g, () => protect("\\|")) };
      }
    }
    return node.content ? { ...node, content: node.content.map((child) => copy(child, table, block)) } : node;
  };
  const output = serialize(copy(document, false, false));
  const restored = new Set<number>();
  const result = output.replace(new RegExp(`${prefix}(\\d+)\uE001`, "g"), (_, index: string) => {
    const key = Number(index);
    if (restored.has(key) || replacements[key] === undefined) throw new Error("Literal code could not be serialized safely.");
    restored.add(key);
    return replacements[key];
  });
  if (restored.size !== replacements.length) throw new Error("Literal code could not be serialized safely.");
  return result;
}
