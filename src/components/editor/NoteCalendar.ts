import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { dateLabel, validCalendarDate } from '../../lib/calendarDate';

export function insertCalendarDate(editor: Editor, date: string, range: { from: number; to: number }, document: Node): boolean {
  if (editor.isDestroyed || !editor.isEditable || !validCalendarDate(date) || !editor.state.doc.eq(document)) return false;
  if (range.from < 0 || range.to > document.content.size || range.from > range.to || !/^\/(?:c|ca|cal|cale|calen|calend|calenda|calendar)?$/i.test(document.textBetween(range.from, range.to))) return false;
  const done = editor.chain().focus().command(({ tr }) => { closeHistory(tr); return true; }).insertContentAt(range, [
    { type: 'text', text: dateLabel(date), marks: [{ type: 'link', attrs: { href: `orion-date://${date}` } }] },
    { type: 'text', text: ' ', marks: [] },
  ]).unsetLink().run();
  if (done) editor.view.dispatch(closeHistory(editor.state.tr));
  return done;
}
