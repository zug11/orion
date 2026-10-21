import type { Node as PMNode } from '@tiptap/pm/model';

/** Bounded authored neighbours; never a raw editor offset persisted across reloads. */
export interface CommentCursor { before: string; after: string }
export function isCommentCursor(value: unknown): value is CommentCursor {
  if (!value || typeof value !== 'object') return false;
  const cursor = value as CommentCursor;
  return typeof cursor.before === 'string' && cursor.before.length <= 256 && typeof cursor.after === 'string' && cursor.after.length <= 256;
}
export function commentTextMap(doc: PMNode) {
  let text = ''; const positions: number[] = []; let blocks = 0;
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      if (blocks++) { positions[text.length] ??= pos; text += '\n'; }
      positions[text.length] = pos + 1;
    }
    if (node.isText) for (let i = 0; i < node.text!.length; i++) {
      positions[text.length] = pos + i; text += node.text![i]; positions[text.length] = pos + i + 1;
    }
  });
  return { text, positions };
}
export function captureCommentCursor(doc: PMNode, position: number): CommentCursor {
  const { text, positions } = commentTextMap(doc);
  const at = positions.findIndex(pos => pos >= position);
  const offset = at < 0 ? text.length : at;
  return { before: text.slice(Math.max(0, offset - 256), offset), after: text.slice(offset, offset + 256) };
}
export function resolveCommentCursor(text: string, cursor: CommentCursor): number | undefined {
  const unique = (value: string) => {
    const at = text.indexOf(value);
    return value && at >= 0 && text.indexOf(value, at + 1) < 0 ? at : undefined;
  };
  const joined = unique(cursor.before + cursor.after);
  if (joined !== undefined) return joined + cursor.before.length;
  // Markdown represents empty paragraphs with non-breaking spaces and can
  // coalesce blank separators. Match authored words through that presentation
  // difference, retaining the cursor inside the intervening whitespace run.
  const normalized = (value: string) => value.replace(/\s+/gu, ' ').trim();
  const target = normalized(cursor.before + cursor.after);
  if (target) {
    let plain = ''; const positions: number[] = [];
    for (const word of text.matchAll(/\S+/gu)) {
      if (plain) { positions.push(word.index! - 1); plain += ' '; }
      for (let i = 0; i < word[0].length; i++) { positions.push(word.index! + i); plain += word[0][i]; }
    }
    const at = plain.indexOf(target);
    if (at >= 0 && plain.indexOf(target, at + 1) < 0) {
      const boundary = at + normalized(cursor.before).length;
      let offset = positions[boundary] ?? text.length;
      const leading = cursor.before.match(/\s*$/u)![0].length;
      const trailing = cursor.after.match(/^\s*/u)![0].length;
      if (leading || trailing) {
        let start = offset, end = offset;
        while (start > 0 && /\s/u.test(text[start - 1])) start--;
        while (end < text.length && /\s/u.test(text[end])) end++;
        offset = start + Math.min(leading, end - start);
      }
      return offset;
    }
  } else if (!text.trim()) return Math.min(cursor.before.length, text.length);
  const before = unique(cursor.before), after = unique(cursor.after);
  // A changed neighbour may leave the other side intact. Never guess between duplicates.
  if (before !== undefined && after !== undefined) return before + cursor.before.length <= after ? before + cursor.before.length : undefined;
  if (before !== undefined) return before + cursor.before.length;
  if (after !== undefined) return after;
  if (!cursor.before && !cursor.after) return 0;
  return undefined;
}
