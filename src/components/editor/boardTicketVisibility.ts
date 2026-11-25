import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import { Plugin, PluginKey, Selection, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { parseTicketMarker, type Ticket } from '../../lib/tickets';

interface Entry { from: number; to: number; id: string; board: string; kind: 'board' | 'ticket' | 'list' | 'identity' }
const cache = new WeakMap<Node, Entry[]>();
/** Reuse immutable branches: editing ordinary prose does not rescan every task. */
function entries(node: Node): Entry[] {
  const cached = cache.get(node);
  if (cached) return cached;
  const result: Entry[] = [];
  node.forEach((child, offset) => {
    if (child.type.name === 'blockquote' || child.type.name === 'codeBlock') return;
    const kind = child.type.name === 'noteKanban' ? 'board' : child.type.name === 'taskItem' && child.attrs.ticketId ? 'ticket' : child.type.name === 'taskList' ? 'list' : null;
    if (kind) result.push({ from: offset, to: offset + child.nodeSize, kind, id: String(child.attrs.ticketId || child.attrs.boardId || ''), board: String(child.attrs.ticketBoard || '') });
    const unresolved = child.attrs.ticketUnresolvedMarkers;
    if (Array.isArray(unresolved)) for (const marker of unresolved) {
      const parsed = typeof marker === 'string' ? parseTicketMarker(marker) : null;
      if (parsed) result.push({ from: offset, to: offset + child.nodeSize, kind: 'identity', id: parsed.id, board: parsed.boardId });
    }
    for (const entry of entries(child)) result.push({ ...entry, from: entry.from + offset + 1, to: entry.to + offset + 1 });
  });
  cache.set(node, result); return result;
}
interface Presentation { decorations: DecorationSet; hidden: Entry[]; editing: string | null }
export const boardTicketVisibilityKey = new PluginKey<Presentation>('boardTicketVisibility');

function presentation(state: EditorState, editing: string | null, allowedBoard?: (id: string) => boolean): Presentation {
  const all = entries(state.doc), boards = new Map<string, number>(), tickets = new Map<string, number>();
  for (const entry of all) {
    const counts = entry.kind === 'board' ? boards : ['ticket', 'identity'].includes(entry.kind) ? tickets : null;
    if (counts) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  const active = editing && all.find(e => e.kind === 'ticket' && e.id === editing && state.selection.from > e.from && state.selection.to < e.to);
  const hidden = all.filter(e => e.kind === 'ticket' && boards.get(e.board) === 1 && tickets.get(e.id) === 1 && (!allowedBoard || allowedBoard(e.board)) &&
    !(active && e.from <= active.from && e.to >= active.to));
  const decorations = hidden.map(e => Decoration.node(e.from, e.to, { style: 'display: none', 'data-board-ticket-hidden': 'true', 'aria-hidden': 'true' }));
  for (const list of all.filter(e => e.kind === 'list')) {
    const node = state.doc.nodeAt(list.from)!;
    let allHidden = true;
    node.forEach((_child, offset) => { if (!hidden.some(e => e.from === list.from + 1 + offset)) allHidden = false; });
    if (allHidden) decorations.push(Decoration.node(list.from, list.to, { style: 'display: none', 'data-board-ticket-hidden': 'true', 'aria-hidden': 'true' }));
  }
  return { decorations: DecorationSet.create(state.doc, decorations), hidden, editing: active ? editing : null };
}

function visibleSelection(state: EditorState, hidden: Entry[], from: number, direction: number): Selection | null {
  let selection = Selection.near(state.doc.resolve(from), direction);
  for (let i = 0; i <= hidden.length; i++) {
    const containing = hidden.find(e => selection.from > e.from && selection.from < e.to);
    if (!containing) return selection;
    const next = direction > 0 ? containing.to : containing.from;
    if (next === 0 || next === state.doc.content.size) return null;
    selection = Selection.near(state.doc.resolve(next), direction);
  }
  return null;
}

/** Pure presentation; the authored tasks, Markdown and Undo history stay intact. */
export function boardTicketVisibility(allowedBoard?: (id: string) => boolean) {
  return new Plugin<Presentation>({
    key: boardTicketVisibilityKey,
    state: {
      init: (_, state) => presentation(state, null, allowedBoard),
      apply: (tr, previous, _old, state) => tr.docChanged || tr.selectionSet || tr.getMeta(boardTicketVisibilityKey)
        ? presentation(state, tr.getMeta(boardTicketVisibilityKey)?.editing ?? previous.editing, allowedBoard) : previous,
    },
    props: {
      decorations: state => boardTicketVisibilityKey.getState(state)?.decorations,
      handleKeyDown(view, event) {
        if (!['Backspace', 'Delete'].includes(event.key) || !view.state.selection.empty || event.metaKey || event.ctrlKey || event.altKey) return false;
        const { $from } = view.state.selection;
        const backward = event.key === 'Backspace';
        if (!$from.parent.isTextblock || (backward ? $from.parentOffset !== 0 : $from.parentOffset !== $from.parent.content.size)) return false;
        const hidden = boardTicketVisibilityKey.getState(view.state)?.hidden ?? [];
        const boundary = backward ? $from.before() : $from.after();
        const adjacent = hidden.find(e => backward ? e.to >= boundary - 1 && e.to <= boundary : e.from >= boundary && e.from <= boundary + 1);
        if (!adjacent) return false;
        const selection = visibleSelection(view.state, hidden, backward ? adjacent.from : adjacent.to, backward ? -1 : 1);
        if (selection) view.dispatch(view.state.tr.setSelection(selection));
        return true;
      },
    },
    appendTransaction(_transactions, old, state) {
      const hidden = boardTicketVisibilityKey.getState(state)?.hidden ?? [];
      if (!state.selection.empty || !hidden.some(e => state.selection.from > e.from && state.selection.from < e.to)) return null;
      const direction = state.selection.from < old.selection.from ? -1 : 1;
      const selection = visibleSelection(state, hidden, state.selection.from, direction) ?? visibleSelection(state, hidden, state.selection.from, -direction);
      return selection && !selection.eq(state.selection) ? state.tr.setSelection(selection).setMeta('addToHistory', false) : null;
    },
    view: view => {
      queueMicrotask(() => {
        if (view.isDestroyed) return;
        // Other plugins can append a trailing caret paragraph on first dispatch.
        // Opening the board must not publish an authored edit or an Undo entry.
        view.dispatch(view.state.tr.setMeta(boardTicketVisibilityKey, { refresh: true })
          .setMeta('preventUpdate', true).setMeta('addToHistory', false));
      });
      return {};
    },
  });
}

/** Opening a board card reveals just that original task for direct rich editing. */
export function editBoardTicket(editor: Editor, ticket: Ticket): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const found = entries(editor.state.doc).filter(e => e.kind === 'ticket' && e.id === ticket.id);
  if (found.length !== 1) return false;
  editor.view.dispatch(editor.state.tr.setMeta(boardTicketVisibilityKey, { editing: ticket.id })
    .setSelection(Selection.near(editor.state.doc.resolve(found[0].from + 2))).scrollIntoView());
  editor.view.focus(); return true;
}
