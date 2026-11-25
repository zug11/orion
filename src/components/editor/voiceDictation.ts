import { type Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { Node } from "@tiptap/pm/model";
import type { WritingOrigin } from "../../types";
import { recordWritingOrigin } from "./writingOriginHistory";
import { newBoardId, newTicketId, type NoteBoard } from "../../lib/tickets";
import { parseDictationProposal, resolveDictationBoard, type DictationBlock,
  type DictationProposal, type DictationBoardTicket } from "../../lib/dictationCleanup";

export type VoiceDictationBlock = DictationBlock;

/** Dictation is one undoable insertion, separate from typing on either side. */
function insertDictationContent(editor: Editor, position: number, content: JSONContent | JSONContent[], origin?: WritingOrigin): boolean {
  const chain = editor.chain();
  // A retained background note must not move focus/scroll from the page the
  // person is currently using. Its original mapped cursor still owns insertion.
  if (!editor.view.dom.closest('[hidden]')) chain.focus();
  const inserted = chain
    .command(({ tr }) => { closeHistory(tr); return true; })
    .insertContentAt(position, content, {
      errorOnInvalidContent: true,
      applyInputRules: false,
      applyPasteRules: false,
    })
    .command(({ tr }) => { recordWritingOrigin(tr, origin); return true; })
    .run();
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr));
  return inserted;
}

export function insertVoiceTranscriptAt(
  editor: Editor,
  position: number,
  transcript: string,
  origin?: WritingOrigin,
): boolean {
  const normalized = transcript.trim().replace(/\s+/g, " ");
  if (!normalized || editor.isDestroyed || !Number.isFinite(position)) return false;

  const insertionPosition = Math.min(
    Math.max(0, Math.trunc(position)),
    editor.state.doc.content.size,
  );
  const before = editor.state.doc.textBetween(
    Math.max(0, insertionPosition - 1),
    insertionPosition,
  );
  const after = editor.state.doc.textBetween(
    insertionPosition,
    Math.min(editor.state.doc.content.size, insertionPosition + 1),
  );
  const leadingSpace = Boolean(
    before &&
      !/[\s([{\u201c\u2018"']/.test(before) &&
      !/^[,.;:!?\u2026)\]}]/.test(normalized),
  );
  const trailingSpace = Boolean(
    after &&
      !/[\s.,!?;:)\]}'\u201d\u2019]/.test(after) &&
      !/[([{\u201c\u2018"']$/.test(normalized),
  );

  return insertDictationContent(editor, insertionPosition, {
    type: "text",
    text: `${leadingSpace ? " " : ""}${normalized}${trailingSpace ? " " : ""}`,
  }, origin);
}

/** Provider output has no markup authority: only literal text and these blocks. */
export function insertCleanedVoiceTranscriptAt(
  editor: Editor,
  position: number,
  blocks: readonly VoiceDictationBlock[],
  origin?: WritingOrigin,
): boolean {
  if (editor.isDestroyed || blocks.length === 0 || !Number.isFinite(position) ||
      blocks.some(block => !["paragraph", "bullet", "todo"].includes(block.kind) || !block.text.trim())) return false;
  if (blocks.length === 1 && blocks[0].kind === "paragraph") {
    return insertVoiceTranscriptAt(editor, position, blocks[0].text, origin);
  }

  const content: JSONContent[] = [];
  for (const block of blocks) {
    const paragraph: JSONContent = {
      type: "paragraph",
      content: [{ type: "text", text: block.text.trim() }],
    };
    if (block.kind === "paragraph") {
      content.push(paragraph);
      continue;
    }
    const listType = block.kind === "todo" ? "taskList" : "bulletList";
    const item: JSONContent = {
      type: block.kind === "todo" ? "taskItem" : "listItem",
      ...(block.kind === "todo" ? { attrs: { checked: false } } : {}),
      content: [paragraph],
    };
    const previous = content[content.length - 1];
    if (previous?.type === listType) previous.content!.push(item);
    else content.push({ type: listType, content: [item] });
  }
  // Validate the complete insertion before dispatching; an unavailable list
  // extension must leave the existing note and selection intact.
  try {
    for (const node of content) editor.schema.nodeFromJSON(node).check();
  } catch {
    return false;
  }
  return insertDictationContent(editor, Math.min(Math.max(0, Math.trunc(position)), editor.state.doc.content.size), content, origin);
}

/** Materialize all structures in one transaction. Provider IDs and markup never
 * enter the document; existing board assignment is a local unambiguous lookup. */
export function insertStructuredVoiceTranscriptAt(
  editor: Editor, position: number, proposal: DictationProposal, original: string,
  boards: readonly NoteBoard[], document: Node, origin?: WritingOrigin,
): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.state.doc.eq(document) ||
      !Number.isInteger(position) || position < 0 || position > document.content.size) return false;
  let parsed: DictationProposal;
  try { parsed = parseDictationProposal(proposal, original); } catch { return false; }
  const content: JSONContent[] = [];
  const paragraph = (text: string): JSONContent => ({ type: "paragraph",
    ...(text ? { content: [{ type: "text", text }] } : {}) });
  const newBoards = new Map<object, string>();
  for (const block of parsed.blocks) if (block.kind === "kanban") newBoards.set(block, newBoardId());
  // A spoken name must identify one unique board across existing and new
  // boards. Otherwise preserve the ticket without an assignment.
  const destinations = [...boards, ...parsed.blocks.flatMap(block => block.kind === "kanban"
    ? [{ id: newBoards.get(block)!, title: block.text }] : [])];
  function appendItem(text: string, task: boolean, attrs?: Record<string, unknown>) {
    const listType = task ? "taskList" : "bulletList";
    const item = { type: task ? "taskItem" : "listItem", content: [paragraph(text)],
      ...(task ? { attrs: { checked: false, ...attrs } } : {}) };
    const previous = content[content.length - 1];
    if (previous?.type === listType) previous.content!.push(item);
    else content.push({ type: listType, content: [item] });
    return item;
  }
  function appendTicket(ticket: DictationBoardTicket, boardId: string) {
    const item=appendItem(ticket.text, true, { ticketId: newTicketId(), ticketStatus: "todo", ticketBoard: boardId,
      ticketDueDate: ticket.dueDate, ticketUrgency: ticket.urgency });
    if(ticket.checklist?.length)item.content.push({type:'taskList',content:ticket.checklist.map(child=>({type:'taskItem',attrs:{checked:false},content:[paragraph(child.text)]}))});
  }
  if (parsed.blocks.some(block => block.kind === "ticket" || block.kind === "kanban" && block.tickets.length) &&
      !editor.schema.nodes.taskItem?.spec.attrs?.ticketId) return false;
  for (const block of parsed.blocks) {
    if (block.kind === "paragraph") content.push(paragraph(block.text));
    else if (block.kind === "bullet" || block.kind === "todo") appendItem(block.text, block.kind === "todo");
    else if (block.kind === "ticket") appendTicket(block, resolveDictationBoard(block.boardName, destinations));
    else if (block.kind === "kanban") {
      const boardId = newBoards.get(block)!;
      content.push({ type: "noteKanban", attrs: { boardId, title: block.text } });
      for (const ticket of block.tickets) appendTicket(ticket, boardId);
    } else if (block.kind === "table") {
      if (block.text) content.push(paragraph(block.text));
      const row = (cells: string[], header: boolean): JSONContent => ({ type: "tableRow", content: cells.map(text => ({
        type: header ? "tableHeader" : "tableCell", content: [paragraph(text)],
      })) });
      content.push({ type: "table", content: [row(block.columns, true), ...block.rows.map(cells => row(cells, false))] });
    }
  }
  // Full schema validation before the first mutation: unsupported structures
  // fall back to faithful text without leaving half a board or table behind.
  try { for (const node of content) editor.schema.nodeFromJSON(node).check(); } catch { return false; }
  return insertDictationContent(editor, position, content, origin);
}

/** Optional immediate recovery, only while the inserted document is unchanged.
 * Later edits always win; the complete transcript also remains in Sources. */
export function restoreOriginalDictation(
  editor: Editor, before: Node, after: Node, position: number, original: string, removedOrigin?: WritingOrigin,
): boolean {
  if (editor.isDestroyed || !editor.isEditable || !editor.state.doc.eq(after) ||
      !Number.isInteger(position) || position < 0 || position > before.content.size) return false;
  const normalized = original.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  const left = before.textBetween(Math.max(0, position - 1), position);
  const right = before.textBetween(position, Math.min(before.content.size, position + 1));
  const leading = left && !/[\s([{\u201c\u2018"']/.test(left) && !/^[,.;:!?\u2026)\]}]/.test(normalized);
  const trailing = right && !/[\s.,!?;:)\]}'\u201d\u2019]/.test(right) && !/[([{\u201c\u2018"']$/.test(normalized);
  const tr = closeHistory(editor.state.tr).replaceWith(0, after.content.size, before.content)
    .insertText(`${leading ? " " : ""}${normalized}${trailing ? " " : ""}`, position);
  editor.view.dispatch(recordWritingOrigin(tr, removedOrigin, false));
  editor.view.dispatch(closeHistory(editor.state.tr));
  editor.view.focus();
  return true;
}
