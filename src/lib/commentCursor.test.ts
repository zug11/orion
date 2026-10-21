import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { expect, it } from 'vitest';
import { captureCommentCursor, commentTextMap, resolveCommentCursor, isCommentCursor } from './commentCursor';
it('retains an exact empty-line position between passages, including on reload and insertion above', () => {
  const editor = new Editor({ extensions:[StarterKit], content:'<p>First.</p><p></p><p></p><p>Last.</p>' });
  const map = commentTextMap(editor.state.doc);
  expect(map.text).toBe('First.\n\n\nLast.');
  const cursor = captureCommentCursor(editor.state.doc, map.positions[8]);
  expect(resolveCommentCursor(map.text, JSON.parse(JSON.stringify(cursor)))).toBe(8);
  expect(resolveCommentCursor('New.\n' + map.text, cursor)).toBe(13);
  editor.destroy();
});
it('rejects ambiguous locations and invalid persisted cursors', () => {
  expect(resolveCommentCursor('same words same words', {before:'same ',after:'words'})).toBeUndefined();
  expect(isCommentCursor({before:3,after:''})).toBe(false);
  expect(isCommentCursor({before:'x'.repeat(257),after:''})).toBe(false);
  expect(isCommentCursor({before:'',after:''})).toBe(true);
});
it('keeps the insertion point at the end of its paragraph, rather than after the next boundary', () => {
  const editor = new Editor({extensions:[StarterKit],content:'<p>First.</p><p>Last.</p>'});
  const map = commentTextMap(editor.state.doc);
  const cursor = captureCommentCursor(editor.state.doc, 7);
  expect(cursor).toEqual({before:'First.',after:'\nLast.'});
  expect(map.positions[resolveCommentCursor(map.text, cursor)!]).toBe(7);
  editor.destroy();
});
it('keeps a marker before newly typed text at its insertion point', () => {
  expect(resolveCommentCursor('Before new text after', {before:'Before ',after:'after'})).toBe(7);
});
it('resolves saved empty paragraphs in reading view without sending their comments to the bottom', () => {
  const cursor = {before:'\n',after:'\ndsads\n\n'};
  expect(resolveCommentCursor('\u00a0\ndsads\n\u00a0',cursor)).toBe(1);
  expect(resolveCommentCursor('dsads',cursor)).toBe(0);
});
