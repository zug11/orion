import { Lexer } from "marked";
import { NOTE_BLOCK_CLOSE, NOTE_BLOCK_OPEN } from "./noteBlocks";

export const MAX_IMPORT_NOTE_CHARACTERS = 200_000;
export const IMPORT_NOTE_TRUNCATION_NOTICE =
  "This note contains a shortened excerpt. The complete imported text is preserved in its source in Sources.";

export interface ImportNoteExcerpt {
  text: string;
  truncated: boolean;
}

/**
 * Keep an exact prefix ending at a complete top-level Markdown unit. The source
 * record is independent and must retain the full input. A single oversized
 * paragraph, table, list, fence or Orion frame is omitted, never reconstructed.
 */
export function importNoteExcerpt(
  source: string,
  limit = MAX_IMPORT_NOTE_CHARACTERS,
): ImportNoteExcerpt {
  const maximum = Math.max(0, Math.floor(limit));
  if (source.length <= maximum) return { text: source, truncated: false };

  // One extra code unit prevents the clipped final token from being accepted as
  // complete. Bound lexing even when a source contains megabytes of one block.
  const prefix = source.slice(0, maximum + 1);
  const normalized = prefix.replace(/\r\n?/g, "\n");
  // Marked normalizes line endings. Map token ends back to the original input so
  // CRLF imports keep their exact text and still obey the UTF-16 storage budget.
  const originalOffsets = new Uint32Array(normalized.length + 1);
  for (let original = 0, normalizedOffset = 0; original < prefix.length;) {
    original += prefix[original] === "\r" && prefix[original + 1] === "\n" ? 2 : 1;
    originalOffsets[++normalizedOffset] = original;
  }

  // Frontmatter is one unit even though a plain Markdown lexer sees horizontal
  // rules and headings. Do not leave its opening delimiter in a shortened note.
  const frontmatter = /^---[ \t]*\n/.test(normalized)
    ? /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(normalized)
    : null;
  const frontmatterEnd = /^---[ \t]*\n/.test(normalized)
    ? frontmatter?.[0].length ?? normalized.length
    : 0;
  let position = 0;
  let safeEnd = 0;
  let frameDepth = 0;
  let tableMetadataPending = false;
  for (const token of Lexer.lex(normalized, { gfm: true })) {
    // Fail closed if a future lexer changes its raw-source accounting.
    if (!normalized.startsWith(token.raw, position)) break;
    position += token.raw.length;
    const originalEnd = originalOffsets[position];
    if (originalEnd === undefined || originalEnd > maximum) break;
    // The last token may be unfinished even if the lexer omits trailing spaces.
    if (position === normalized.length) break;

    if (token.type === "html") {
      for (const line of token.raw.split("\n")) {
        if (line === NOTE_BLOCK_OPEN) frameDepth += 1;
        else if (line === NOTE_BLOCK_CLOSE && frameDepth) frameDepth -= 1;
      }
      if (/^<!-- orion-table:v1 [^\n]* -->\n*$/u.test(token.raw)) {
        tableMetadataPending = true;
      }
    } else if (token.type !== "space") {
      tableMetadataPending = false;
    }

    if (!frameDepth && !tableMetadataPending && position >= frontmatterEnd) {
      safeEnd = originalEnd;
    }
  }
  return { text: source.slice(0, safeEnd).trimEnd(), truncated: true };
}
