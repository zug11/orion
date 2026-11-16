import { validCalendarDate } from '../../lib/calendarDate';
import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { closeHistory } from '@tiptap/pm/history';
import { Fragment, Slice, Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { boardTicketVisibility } from './boardTicketVisibility';
import { KanbanBoard, useTickets } from '../Tickets';
import { validTicketUrgency, boardMarker, effectiveTicketStatus, newBoardId, newTicketId, parseBoardMarker, parseTicketMarker, type Ticket, type TicketPatch, type TicketStatus } from '../../lib/tickets';
import { MAX_INFERRED_TICKETS, ticketTitleKey, validTicketTitle } from '../../lib/ticketInference';
import { changeTicketBlock } from '../../lib/ticketDetails';

const boardPresence = new WeakMap<ProseMirrorNode, boolean>();
const ticketPresence = new WeakMap<ProseMirrorNode, boolean>();
export function containsNoteTicket(node: ProseMirrorNode): boolean {
  const known = ticketPresence.get(node); if (known !== undefined) return known;
  let found = node.type.name === 'taskItem' && Boolean(node.attrs.ticketId);
  node.forEach(child => { if (!found) found = containsNoteTicket(child); });
  ticketPresence.set(node, found); return found;
}
/** A normal keystroke only checks changed branches, never the whole document. */
export function containsNoteBoard(node: ProseMirrorNode): boolean {
  const known = boardPresence.get(node);
  if (known !== undefined) return known;
  let found = node.type.name === 'noteKanban';
  node.forEach(child => { if (!found) found = containsNoteBoard(child); });
  boardPresence.set(node, found);
  return found;
}

/** Pasted copies are new work; assignments within the copied board travel together. */
export function copyWorkIdentities(slice: Slice): Slice {
  const boards = new Map<string, string>();
  slice.content.descendants(node => {
    if (node.type.name === 'noteKanban') boards.set(node.attrs.boardId, newBoardId());
  });
  function copy(fragment: Fragment): Fragment {
    return Fragment.fromArray(fragment.content.map(node => {
      const attrs = node.type.name === 'noteKanban' ? { ...node.attrs, boardId: boards.get(node.attrs.boardId) }
        : node.type.name === 'taskItem' && node.attrs.ticketId ? { ...node.attrs, ticketId: newTicketId(), ticketBoard: boards.get(node.attrs.ticketBoard) ?? node.attrs.ticketBoard }
        : node.attrs;
      return node.isText ? node : node.type.create(attrs, copy(node.content), node.marks);
    }));
  }
  return new Slice(copy(slice.content), slice.openStart, slice.openEnd);
}

function BoardView({ node, updateAttributes }: NodeViewProps) {
  const workspace = useTickets();
  const board = { id: String(node.attrs.boardId), title: String(node.attrs.title), noteId: workspace.work.boards.find(b => b.id === node.attrs.boardId)?.noteId ?? '' };
  return <NodeViewWrapper className="note-kanban" contentEditable={false} data-narration-ignore="true">
    <header><input className="note-kanban-title" aria-label="Kanban board name" value={board.title} maxLength={140} onChange={e => updateAttributes({ title: e.target.value })} onBlur={e => { if (!e.target.value.trim()) updateAttributes({ title: 'Untitled board' }); }}/></header>
    <KanbanBoard board={board} workspace={workspace}/>
  </NodeViewWrapper>;
}
export const NoteKanban = Node.create({
  name: 'noteKanban', group: 'block', atom: true, selectable: true,
  addOptions() { return { allowedBoard: undefined as ((id: string) => boolean) | undefined }; },
  addAttributes() { return {
    boardId: { default: '', parseHTML: el => el.dataset.orionBoard || '', renderHTML: attrs => ({ 'data-orion-board': attrs.boardId }) },
    title: { default: 'Untitled board', parseHTML: el => el.dataset.boardTitle || 'Untitled board', renderHTML: attrs => ({ 'data-board-title': attrs.title }) },
  }; },
  parseHTML() { return [{ tag: 'section[data-orion-board]' }]; },
  renderHTML({ HTMLAttributes }) { return ['section', mergeAttributes(HTMLAttributes), String(HTMLAttributes['data-board-title'] || 'Board')]; },
  markdownTokenizer: {
    name: 'noteKanban', level: 'block',
    start: source => { const m=/(?:^|\n)<!-- orion-kanban:v1 /.exec(source);return m ? m.index+(m[0].startsWith('\n')?1:0) : -1; },
    tokenize(source) { const line=source.split(/\r?\n/,1)[0]; const board=parseBoardMarker(line);if(!board)return;return { type:'noteKanban',raw:line+(source.slice(line.length).startsWith('\r\n')?'\r\n':source.slice(line.length).startsWith('\n')?'\n':''),board }; },
  },
  parseMarkdown(token) { const board=token.board as { id:string;title:string };return { type:'noteKanban',attrs:{ boardId:board.id,title:board.title } }; },
  renderMarkdown(node) { return boardMarker({id:String(node.attrs?.boardId),title:String(node.attrs?.title ?? '').trim() || 'Untitled board'}); },
  addNodeView() { return ReactNodeViewRenderer(BoardView, {
    stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('.kanban-workspace,input')),
  }); },
  addProseMirrorPlugins() { return [new Plugin({ props: { transformPasted: copyWorkIdentities } }), boardTicketVisibility(this.options.allowedBoard)]; },
});

/** Add beside the board in the ordinary document, in one Undo, without stealing form focus. */
export function insertBoardTickets(editor: Editor, boardId: string, titles: string[], status: TicketStatus = 'todo', deduplicate = false, dueDate = ''): boolean {
  if (dueDate && !validCalendarDate(dueDate)) return false;
  if (editor.isDestroyed || !editor.isEditable || !titles.length || titles.length > MAX_INFERRED_TICKETS || !titles.every(validTicketTitle)) return false;
  const boards: number[] = [];
  const existing = new Set<string>();
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'noteKanban' && node.attrs.boardId === boardId) boards.push(pos + node.nodeSize);
    if (node.type.name === 'taskItem') existing.add(ticketTitleKey(node.firstChild?.textContent ?? ''));
  });
  if (boards.length !== 1) return false;
  const unique = deduplicate ? titles.filter(title => { const key = ticketTitleKey(title); if (!key || existing.has(key)) return false; existing.add(key); return true; }) : titles;
  if (!unique.length) return false;
  const list = editor.schema.nodeFromJSON({ type: 'taskList', content: unique.map(title => ({ type: 'taskItem',
    attrs: { checked: status === 'done', ticketId: newTicketId(), ticketStatus: status, ticketBoard: boardId, ticketDueDate: dueDate },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: title.trim() }] }],
  })) });
  editor.view.dispatch(closeHistory(editor.state.tr).insert(boards[0], list));
  editor.view.dispatch(closeHistory(editor.state.tr));
  return true;
}

export function insertWorkItem(editor: Editor, kind: 'ticket'|'kanban', title: string, range: {from:number;to:number}, boardId='', dueDate=''): boolean {
  if(dueDate && !validCalendarDate(dueDate))return false;
  if(!editor.isEditable||editor.isDestroyed||!title.trim()||editor.isActive('table'))return false;
  const content=kind==='kanban'
    ? {type:'noteKanban',attrs:{boardId:newBoardId(),title:title.trim().slice(0,140)}}
    : {type:'taskList',content:[{type:'taskItem',attrs:{checked:false,ticketId:newTicketId(),ticketStatus:'todo',ticketBoard:boardId,ticketDueDate:dueDate},content:[{type:'paragraph',content:[{type:'text',text:title.trim().slice(0,140)}]}]}]};
  const done=editor.chain().focus().command(({tr})=>{closeHistory(tr);return true}).insertContentAt(range,[content,{type:'paragraph'}]).run();
  if(done)editor.view.dispatch(closeHistory(editor.state.tr));
  return done;
}
/** Board changes to the open note are real editor transactions and retain Undo. */
export function patchEditorTicket(editor: Editor, ticket: Ticket, patch: TicketPatch): boolean {
  if (patch.detail) return Object.keys(patch).length === 1 && patchEditorTicketDetails(editor, ticket, patch.detail);
  if(patch.urgency !== undefined && !validTicketUrgency(patch.urgency))return false;
  if(patch.dueDate && !validCalendarDate(patch.dueDate))return false;
  if(!editor.isEditable||editor.isDestroyed||!ticket.durable)return false;
  const positions:number[]=[];
  editor.state.doc.descendants((node,pos)=>{if(node.type.name==='taskItem'&&node.attrs.ticketId===ticket.id)positions.push(pos)});
  if(positions.length!==1)return false;
  const pos=positions[0],node=editor.state.doc.nodeAt(pos)!;
  if(node.firstChild?.textContent.trim()!==ticket.title.trim() || node.attrs.ticketBoard !== ticket.boardId || (node.attrs.ticketDueDate || '') !== (ticket.dueDate || '') || (node.attrs.ticketUrgency || '') !== (ticket.urgency || '') ||
    effectiveTicketStatus(node.attrs.checked, node.attrs.ticketStatus) !== ticket.status)return false;
  const status=patch.status??ticket.status;
  editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(pos,undefined,{...node.attrs,checked:status==='done',ticketStatus:status,ticketBoard:patch.boardId??ticket.boardId,ticketDueDate:patch.dueDate??ticket.dueDate??'',ticketUrgency:patch.urgency??ticket.urgency??''}));
  editor.view.dispatch(closeHistory(editor.state.tr));return true;
}

/** A detail operation replaces only this exact, unchanged task node, in one Undo. */
function patchEditorTicketDetails(editor: Editor, ticket: Ticket, change: NonNullable<TicketPatch['detail']>): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.markdown || !ticket.rawBlock || !ticket.durable) return false;
  const replacement = changeTicketBlock(ticket, change);
  if (replacement === null) return false;
  const normalize = (value: string) => {
    const indent = value.match(/^[ \t]*/)?.[0] ?? '';
    return value.split(/\r?\n/).map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  };
  try {
    const read = (markdown: string) => {
      const doc = ProseMirrorNode.fromJSON(editor.schema, editor.markdown!.parse(normalize(markdown)));
      const nodes: ProseMirrorNode[] = [];
      doc.descendants(node => { if (node.type.name === 'taskItem' && node.attrs.ticketId === ticket.id) nodes.push(node); });
      return nodes.length === 1 ? nodes[0] : undefined;
    };
    const before = read(ticket.rawBlock), after = read(replacement);
    if (!before || !after) return false;
    const positions: number[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'taskItem' && node.attrs.ticketId === ticket.id) positions.push(pos);
      if (Array.isArray(node.attrs.ticketUnresolvedMarkers)) for (const marker of node.attrs.ticketUnresolvedMarkers) if (parseTicketMarker(marker)?.id === ticket.id) positions.push(pos);
    });
    if (positions.length !== 1) return false;
    const pos = positions[0], current = editor.state.doc.nodeAt(pos);
    if (!current?.eq(before)) return false;
    editor.view.dispatch(closeHistory(editor.state.tr).replaceWith(pos, pos + current.nodeSize, after));
    editor.view.dispatch(closeHistory(editor.state.tr));
    return true;
  } catch { return false; }
}

/** Remove exactly the confirmed task subtree, cleaning up only its empty list. */
export function deleteEditorTicketNode(editor: Editor, pos: number, expected: ProseMirrorNode): boolean {
  if (editor.isDestroyed || !editor.isEditable || expected.type.name !== 'taskItem' || !expected.attrs.ticketId) return false;
  if (!Number.isInteger(pos) || pos < 0 || pos >= editor.state.doc.content.size) return false;
  const current = editor.state.doc.nodeAt(pos);
  if (!current || !current.eq(expected)) return false;
  let matches = 0;
  editor.state.doc.descendants(node => {
    if (node.type.name === 'taskItem' && node.attrs.ticketId === expected.attrs.ticketId) matches += 1;
    const unresolved = node.attrs.ticketUnresolvedMarkers;
    if (Array.isArray(unresolved)) matches += unresolved.filter(marker => typeof marker === 'string' && parseTicketMarker(marker)?.id === expected.attrs.ticketId).length;
  });
  if (matches !== 1) return false;
  const resolved = editor.state.doc.resolve(pos);
  const onlyItem = resolved.parent.type.name === 'taskList' && resolved.parent.childCount === 1;
  const from = onlyItem ? resolved.before() : pos;
  const to = onlyItem ? resolved.after() : pos + current.nodeSize;
  editor.view.dispatch(closeHistory(editor.state.tr).delete(from, to).scrollIntoView());
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.view.focus();
  return true;
}

/** Board deletion preserves current editor state and is a single Undo step. */
export function deleteEditorTicket(editor: Editor, ticket: Ticket): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.markdown || !ticket.durable || !ticket.rawBlock) return false;
  // Normalize Markdown syntax through the same parser as the editor. Equivalent
  // list indentation or emphasis must not falsely reject an unchanged card.
  const indent = ticket.rawBlock.match(/^[ \t]*/)?.[0] ?? '';
  const block = ticket.rawBlock.split(/\r?\n/).map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  let expected: ProseMirrorNode | undefined;
  try {
    const parsed = ProseMirrorNode.fromJSON(editor.schema, editor.markdown.parse(block));
    const candidates: ProseMirrorNode[] = [];
    parsed.descendants(node => { if (node.type.name === 'taskItem' && node.attrs.ticketId === ticket.id) candidates.push(node); });
    if (candidates.length !== 1) return false;
    expected = candidates[0];
  } catch { return false; }
  const positions: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && node.attrs.ticketId === ticket.id) positions.push(pos);
  });
  if (positions.length !== 1) return false;
  const pos = positions[0];
  return deleteEditorTicketNode(editor, pos, expected);
}
