import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { NoteStarterKit } from './NoteStarterKit';
import { NoteMarkdown } from './NoteMargins';
import { insertCalendarDate } from './NoteCalendar';
const editors: Editor[] = [];
function create(body = 'Meet /calendar afterwards.') {
  const editor = new Editor({ extensions: [NoteStarterKit.configure({ link: { protocols: ['orion-date'] } }), NoteMarkdown], content: body, contentType: 'markdown' });
  editors.push(editor); return editor;
}
afterEach(() => editors.splice(0).forEach(e => e.destroy()));
describe('calendar insertion', () => {
  it('inserts a portable fixed date inline in one undo and does not extend the date into subsequent typing', () => {
    const editor = create(), original = editor.state.doc;
    expect(insertCalendarDate(editor, '2026-11-20', { from: 6, to: 15 }, original)).toBe(true);
    expect(editor.getMarkdown()).toContain('[20 November 2026](orion-date://2026-11-20)');
    const reopened = create(editor.getMarkdown()); expect(reopened.getJSON()).toEqual(editor.getJSON());
    expect(editor.isActive('link')).toBe(false);
    editor.commands.undo(); expect(editor.state.doc.eq(original)).toBe(true);
  });
  it('rejects stale documents, invalid dates and changed commands', () => {
    const editor = create(), original = editor.state.doc;
    editor.commands.insertContent('changed');
    expect(insertCalendarDate(editor, '2026-11-20', { from: 6, to: 15 }, original)).toBe(false);
    const current = create(); expect(insertCalendarDate(current, '2026-02-30', { from: 6, to: 15 }, current.state.doc)).toBe(false);
    expect(insertCalendarDate(current, '2026-11-20', { from: 1, to: 5 }, current.state.doc)).toBe(false);
  });
});
