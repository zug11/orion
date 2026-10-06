// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NoteView } from './NoteView';
import type { Note } from '../types';

afterEach(cleanup);

it('reads document and selected paragraph margins without exposing metadata or breaking tasks', () => {
  const now = '2026-10-02T00:00:00.000Z';
  const note: Note = {
    id:'margins-reading',title:'Margins',slug:'margins',summary:'', aliases:[], tags:[], kind:'article',status:'ready',
    conceptIds:[],sourceIds:[],createdAt:now,updatedAt:now,
    body:'---\ncategory: draft\n---\n\n<!-- orion-document-margins:v1 10 15 -->\n\nA shaped paragraph. <!-- orion-paragraph-margins:v1 5 8 --> <!-- orion-text:v1 justify -->\n\nUnchanged paragraph.\n\n- [ ] Finish the draft. <!-- orion-paragraph-margins:v1 4 6 -->',
  };
  const onUpdateNote = vi.fn();
  const { container } = render(<NoteView note={note} notes={[note]} concepts={[]} sources={[]} onOpenNote={vi.fn()} onOpenConcept={vi.fn()}
    onUpdateNote={onUpdateNote} onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()}/>);
  expect(container.querySelector('.note-prose-content')).toHaveStyle({marginLeft:'10%',marginRight:'15%'});
  const paragraph = screen.getByText('A shaped paragraph.');
  expect(paragraph).toHaveStyle({marginLeft:'5%',marginRight:'8%'});
  expect(paragraph).toHaveAttribute('data-orion-justify','true');
  expect(screen.getByText('Unchanged paragraph.').style.marginLeft).toBe('');
  expect(container.textContent).not.toContain('orion-paragraph-margins');
  expect(container.textContent).not.toContain('orion-document-margins');
  const checkbox = screen.getByRole('checkbox', {name:'Complete Finish the draft.'});
  fireEvent.click(checkbox);
  expect(onUpdateNote.mock.calls[0][0].body).toContain('- [x] Finish the draft. <!-- orion-paragraph-margins:v1 4 6 -->');
  expect(onUpdateNote.mock.calls[0][0].body).toContain('<!-- orion-document-margins:v1 10 15 -->');
});
