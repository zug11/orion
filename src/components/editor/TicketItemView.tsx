import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { closeHistory } from '@tiptap/pm/history';
import { effectiveTicketStatus, type TicketPatch } from '../../lib/tickets';
import { TicketCardControls, TicketDeleteButton } from '../Tickets';
import { deleteEditorTicketNode } from './NoteKanban';

/** Ticket prose remains directly editable. Only its small controls are outside the document. */
export function TicketItemView({ node, editor, getPos }: NodeViewProps) {
  const status = effectiveTicketStatus(node.attrs.checked, node.attrs.ticketStatus);
  const patch = (change: TicketPatch) => {
    if (editor.isDestroyed || !editor.isEditable) return false;
    const pos = getPos();
    if (typeof pos !== 'number') return false;
    const current = editor.state.doc.nodeAt(pos);
    const ticketId = node.attrs.ticketId;
    if (!current || current.type.name !== 'taskItem' || current.attrs.ticketId !== ticketId) return false;
    if (ticketId) {
      let matches = 0;
      editor.state.doc.descendants(candidate => {
        if (candidate.type.name === 'taskItem' && candidate.attrs.ticketId === ticketId) matches += 1;
      });
      if (matches !== 1) return false;
    } else if (current !== node) return false;
    // The live document can update before React commits new node-view props.
    // Resolve the same durable ticket and preserve its current prose/metadata.
    const next = change.status ?? effectiveTicketStatus(current.attrs.checked, current.attrs.ticketStatus);
    editor.view.dispatch(closeHistory(editor.state.tr).setNodeMarkup(pos, undefined, { ...current.attrs,
      checked: next === 'done', ticketStatus: next, ticketUrgency: change.urgency ?? current.attrs.ticketUrgency, ticketDueDate: change.dueDate ?? current.attrs.ticketDueDate }));
    editor.view.dispatch(closeHistory(editor.state.tr)); return true;
  };
  if (!node.attrs.ticketId) return <NodeViewWrapper as="li" data-type="taskItem" data-checked={Boolean(node.attrs.checked)}>
    <label contentEditable={false}><input type="checkbox" checked={Boolean(node.attrs.checked)} aria-label={`Task item checkbox for ${node.textContent || 'empty task item'}`} onChange={event => patch({ status: event.target.checked ? 'done' : 'todo' })}/><span/></label>
    <NodeViewContent as="div"/>
  </NodeViewWrapper>;
  return <NodeViewWrapper as="li" data-type="taskItem" data-ticket-id={node.attrs.ticketId} data-checked={Boolean(node.attrs.checked)} className="note-ticket-card">
    <div contentEditable={false} data-narration-ignore="true"><TicketDeleteButton title={node.firstChild?.textContent.trim() || 'ticket'} onDelete={() => {
      const pos = getPos();
      return typeof pos === 'number' && deleteEditorTicketNode(editor, pos, node);
    }}/></div>
    <NodeViewContent as="div" className="note-ticket-prose"/>
    <div contentEditable={false} data-narration-ignore="true"><TicketCardControls status={status} dueDate={node.attrs.ticketDueDate} urgency={node.attrs.ticketUrgency} onPatch={patch}/></div>
  </NodeViewWrapper>;
}
