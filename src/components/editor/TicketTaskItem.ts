import { ReactNodeViewRenderer } from '@tiptap/react';
import { TicketItemView } from './TicketItemView';
import { validCalendarDate } from '../../lib/calendarDate';
import { getExtensionField, type Node, type JSONContent, type MarkdownExtensionSpec } from '@tiptap/core';
import { validTicketStatus, validTicketUrgency, effectiveTicketStatus, parseTicketMarker, ticketMarker } from '../../lib/tickets';

/** Tickets remain real task items, including their checkbox, nesting and Markdown exports. */
export function withTickets(extension: Node) {
  return extension.extend({
    addNodeView() {
      const regular = this.parent?.();
      const card = ReactNodeViewRenderer(TicketItemView, {
        stopEvent: ({ event }) => event.target instanceof Element && Boolean(event.target.closest('[contenteditable="false"]')),
        update: ({ newNode, updateProps }) => { if (!newNode.attrs.ticketId) return false; updateProps(); return true; },
      });
      return props => {
        if (props.node.attrs.ticketId || !regular) return card(props);
        const view = regular(props), update = view.update?.bind(view);
        view.update = (...args) => args[0].attrs.ticketId ? false : update?.(...args) ?? false;
        return view;
      };
    },
    addAttributes() {
      return { ...this.parent?.(),
        ticketId: { default: null, keepOnSplit: false, parseHTML: el => el.getAttribute('data-ticket-id'), renderHTML: attrs => attrs.ticketId ? { 'data-ticket-id': attrs.ticketId } : {} },
        // Keep conflicting comments losslessly in Markdown without choosing a ticket
        // identity. This is editor-only recovery data, never visible HTML or prose.
        ticketUnresolvedMarkers: { default: null, keepOnSplit: false, rendered: false },
        ticketBoard: { default: '', keepOnSplit: false, parseHTML: el => el.getAttribute('data-ticket-board') || '', renderHTML: attrs => attrs.ticketBoard ? { 'data-ticket-board': attrs.ticketBoard } : {} },
        ticketUrgency: { default: '', keepOnSplit: false, parseHTML: el => validTicketUrgency(el.dataset.ticketUrgency) ? el.dataset.ticketUrgency : '', renderHTML: attrs => attrs.ticketUrgency ? { 'data-ticket-urgency': attrs.ticketUrgency } : {} },
        ticketDueDate: { default: '', keepOnSplit: false, parseHTML: el => validCalendarDate(el.dataset.ticketDue) ? el.dataset.ticketDue : '', renderHTML: attrs => attrs.ticketDueDate ? { 'data-ticket-due': attrs.ticketDueDate } : {} },
        ticketOrigin: { default: '', keepOnSplit: false, parseHTML: el => el.dataset.ticketOrigin === 'board' ? 'board' : '', renderHTML: attrs => attrs.ticketOrigin === 'board' ? { 'data-ticket-origin': 'board' } : {} },
        ticketStatus: { default: 'todo', keepOnSplit: false, parseHTML: el => validTicketStatus(el.getAttribute('data-ticket-status')) ? el.getAttribute('data-ticket-status') : 'todo', renderHTML: attrs => ({ 'data-ticket-status': effectiveTicketStatus(Boolean(attrs.checked), attrs.ticketStatus) }) },
      };
    },
    parseMarkdown(token, helpers) {
      const parse = getExtensionField<NonNullable<MarkdownExtensionSpec['parseMarkdown']>>(extension, 'parseMarkdown', this);
      // TaskItem's inline tokens contain only its first line; nested/continuation
      // blocks are parsed separately. Match the shared index's exactly-one rule.
      const markers = token.tokens?.flatMap(part => {
        const raw = part.raw ?? part.text ?? '';
        const meta = part.type === 'html' ? parseTicketMarker(raw) : null;
        return meta ? [{ raw, meta }] : [];
      }) ?? [];
      const meta = markers.length === 1 ? markers[0].meta : null;
      const tokens = token.tokens?.map(part => ({ ...part })).filter(part => {
        const parsed = part.type === 'html' ? parseTicketMarker(part.raw ?? part.text ?? '') : null;
        return !parsed;
      });
      const last = tokens?.[tokens.length - 1];
      if (markers.length && last?.type === 'text') { last.text = last.text?.trimEnd(); last.raw = last.raw?.trimEnd(); if (!last.text) tokens?.pop(); }
      const parsed = parse({ ...token, tokens, text: markers.length && !tokens?.length ? '' : token.text }, helpers);
      const apply = (node: JSONContent) => {
        if (node.type === 'taskItem' && meta) node.attrs = { ...node.attrs, ticketId: meta.id, ticketBoard: meta.boardId, ticketDueDate: meta.dueDate || '', ticketUrgency: meta.urgency || '', ticketOrigin: meta.origin || '', ticketStatus: effectiveTicketStatus(Boolean(node.attrs?.checked), meta.status) };
        else if (node.type === 'taskItem' && markers.length > 1) node.attrs = { ...node.attrs, ticketUnresolvedMarkers: markers.map(marker => marker.raw) };
      };
      (Array.isArray(parsed) ? parsed : [parsed]).forEach(apply); return parsed;
    },
    renderMarkdown(node, helpers, context) {
      const render = getExtensionField<NonNullable<MarkdownExtensionSpec['renderMarkdown']>>(extension, 'renderMarkdown', this);
      const result = render(node, helpers, context);
      const unresolved = node.attrs?.ticketUnresolvedMarkers;
      if (Array.isArray(unresolved) && unresolved.length > 1 && unresolved.every(value => typeof value === 'string' && parseTicketMarker(value))) {
        const lines = result.split('\n'); lines[0] = `${lines[0].trimEnd()} ${unresolved.join(' ')}`; return lines.join('\n');
      }
      if (!node.attrs?.ticketId) return result;
      const marker = ticketMarker({ id: node.attrs.ticketId, status: effectiveTicketStatus(Boolean(node.attrs.checked), node.attrs.ticketStatus), boardId: node.attrs.ticketBoard || '', dueDate: node.attrs.ticketDueDate || '', urgency: node.attrs.ticketUrgency || '', origin: node.attrs.ticketOrigin === 'board' ? 'board' : undefined });
      if (!marker) return result;
      const lines = result.split('\n'); lines[0] = `${lines[0].trimEnd()} ${marker}`; return lines.join('\n');
    },
  });
}
