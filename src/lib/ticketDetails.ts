import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { parseTicketMarker, type Ticket } from './tickets';

type MdNode = { type: string; value?: string; checked?: boolean | null; children?: MdNode[]; position?: { start: { offset: number }; end: { offset: number } } };
export interface InferredTicketDetails { description?: string; checklist?: string[] }
export type TicketDetailChange =
  | { kind: 'fillMissing'; fields: InferredTicketDetails }
  | { kind: 'title'; text: string }
  | { kind: 'description'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'check'; index: number; checked: boolean }
  | { kind: 'rename'; index: number; text: string }
  | { kind: 'remove'; index: number }
  | { kind: 'move'; index: number; direction: -1 | 1 };
export interface TicketChecklistItem { text: string; checked: boolean; depth: number; hasChildren: boolean; canMoveUp: boolean; canMoveDown: boolean }
const parser = unified().use(remarkParse).use(remarkGfm);
const plain = (node: MdNode): string => node.type === 'html' ? '' : node.value ?? node.children?.map(plain).join('') ?? '';
const literal = (text: string) => text.replace(/[\\`*_[\]<>#~!+|.-]/g, '\\$&');
const validText = (text: string, limit: number) => text.length <= limit && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);

/** Literal paragraphs and ordinary unchecked child tasks, relative to the marker line. */
export function ticketDetailSuffix({ description, checklist }: InferredTicketDetails, newline = '\n') {
  const blocks: string[] = [];
  if (description) blocks.push('  ' + literal(description));
  if (checklist?.length) blocks.push(checklist.map(step => '  - [ ] ' + literal(step)).join(newline));
  return blocks.map(block => newline + newline + block).join('');
}

function parseUncached(ticket: Ticket) {
  if (!ticket.rawBlock) return null;
  const indent = ticket.rawBlock.match(/^[ \t]*/)?.[0] ?? '';
  const body = ticket.rawBlock.split('\n').map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n');
  const tree = parser.parse(body) as MdNode;
  const root = tree.children?.[0]?.type === 'list' ? tree.children[0].children?.[0] : undefined;
  if (!root || root.type !== 'listItem' || typeof root.checked !== 'boolean') return null;
  const first = root.children?.[0];
  if (!first || first.type !== 'paragraph') return null;
  const markers = first.children?.filter(n => n.type === 'html' && parseTicketMarker(n.value ?? '')) ?? [];
  if (ticket.durable ? markers.length !== 1 || parseTicketMarker(markers[0].value ?? '')?.id !== ticket.id : markers.length !== 0) return null;
  const children = root.children ?? [];
  const description: MdNode[] = [];
  for (const child of children.slice(1)) { if (child.type === 'list') break; description.push(child); }
  const rows: Array<{ node: MdNode; parent: MdNode; depth: number }> = [];
  const visit = (list: MdNode, depth: number) => {
    for (const node of list.children ?? []) {
      const paragraph = node.children?.[0];
      // A nested explicit ticket is independent work, not a subtask of this ticket.
      if (paragraph?.children?.some(n => n.type === 'html' && parseTicketMarker(n.value ?? ''))) continue;
      if (typeof node.checked === 'boolean') rows.push({ node, parent: list, depth });
      for (const child of node.children ?? []) if (child.type === 'list') visit(child, depth + 1);
    }
  };
  for (const child of children.slice(1)) if (child.type === 'list') visit(child, 0);
  return { body, indent, root, first, marker: markers[0], description, rows };
}
const parsedCache = new WeakMap<Ticket, ReturnType<typeof parseUncached>>();
function parse(ticket: Ticket) {
  if (parsedCache.has(ticket)) return parsedCache.get(ticket)!;
  const result = parseUncached(ticket); parsedCache.set(ticket, result); return result;
}

export function ticketDetails(ticket: Ticket, includePlainTask = false) {
  if (!ticket.durable && !includePlainTask) return null;
  const parsed = parse(ticket);
  if (!parsed) return null;
  const { description, rows, body } = parsed;
  const checklist: TicketChecklistItem[] = rows.map(({ node, parent, depth }) => {
    const siblings = parent.children ?? [], index = siblings.indexOf(node);
    const movable = (other?: MdNode) => Boolean(other && rows.some(row => row.node === other));
    return { text: plain(node.children?.[0] ?? node).trim(), checked: Boolean(node.checked), depth,
      hasChildren: (node.children?.length ?? 0) > 1, canMoveUp: movable(siblings[index - 1]), canMoveDown: movable(siblings[index + 1]) };
  });
  return {
    additionalMarkdown: parsed.root.children?.slice(1).filter(node=>!description.includes(node) && !(node.type==='list'&&node.children?.some(child=>typeof child.checked==='boolean'))).map(node=>body.slice(node.position!.start.offset,node.position!.end.offset)).join('\n\n') ?? '',
    description: description.map(n => body.slice(n.position!.start.offset, n.position!.end.offset)).join('\n\n'),
    descriptionText: description.map(plain).join('\n\n'),
    // Rich or structural content is preserved and remains editable in its note.
    descriptionEditable: description.every(n => n.type === 'paragraph' && n.children?.every(child => ['text', 'break'].includes(child.type))),
    checklist, completed: checklist.filter(item => item.checked).length,
  };
}

/** Edit only the captured task subtree. No independent checklist persistence. */
export function changeTicketBlock(ticket: Ticket, change: TicketDetailChange): string | null {
  const parsed = parse(ticket);
  if (!ticket.durable || !parsed?.marker) return null;
  const { body, indent, first, marker, description, rows, root } = parsed;
  const newline = body.includes('\r\n') ? '\r\n' : '\n';
  const replace = (start: number, end: number, value: string) => body.slice(0, start) + value + body.slice(end);
  let next: string;
  if ('text' in change && (!validText(change.text, change.kind === 'description' ? 20_000 : 1000) || change.kind !== 'description' && (!change.text.trim() || /[\r\n]/.test(change.text)))) return null;
  if (change.kind === 'fillMissing') {
    const fields = change.fields;
    const singleLine = (text: string, limit: number) => validText(text, limit) && !/[\r\n\t]/.test(text);
    if (fields.description && !singleLine(fields.description, 1000) || fields.checklist &&
        (fields.checklist.length > 32 || !fields.checklist.every(step => step.trim() && singleLine(step, 300)))) return null;
    const at = first.position!.end.offset;
    const listAt = description[description.length - 1]?.position?.end.offset ?? at;
    const addDescription = description.length ? '' : ticketDetailSuffix({ description: fields.description }, newline);
    const addChecklist = rows.length ? '' : ticketDetailSuffix({ checklist: fields.checklist }, newline);
    next = body.slice(0, at) + addDescription + body.slice(at, listAt) + addChecklist + body.slice(listAt);
  } else if (change.kind === 'title') {
    if (change.text.length > 1000) return null;
    next = replace(first.position!.start.offset, first.position!.end.offset, `${literal(change.text.trim())} ${marker.value}`);
  } else if (change.kind === 'description') {
    if (!ticketDetails(ticket)?.descriptionEditable) return null;
    const content = change.text.trim().split(/\r?\n\s*\r?\n/).filter(Boolean).map(p => p.split(/\r?\n/).map(literal).join(newline)).join(newline + newline);
    const offset = first.position!.end.offset;
    const end = description[description.length - 1]?.position!.end.offset ?? offset;
    next = replace(offset, end, content ? newline + newline + content.split(newline).map(line => line ? `  ${line}` : '').join(newline) : '');
  } else if (change.kind === 'add') {
    const list = root.children?.find(child => child.type === 'list' && child.children?.every(item => typeof item.checked === 'boolean'));
    const offset = list?.position!.end.offset ?? root.position!.end.offset;
    const listStart = list?.position!.start.offset;
    const padding = listStart === undefined ? '  ' : body.slice(body.lastIndexOf('\n', listStart - 1) + 1, listStart);
    next = replace(offset, offset, `${newline}${list ? '' : newline}${padding}- [ ] ${literal(change.text.trim())}`);
  } else {
    if (!Number.isInteger(change.index)) return null;
    const row = rows[change.index];
    if (!row) return null;
    const { node, parent } = row;
    const start = node.position!.start.offset, end = node.position!.end.offset;
    const lineEnd = body.indexOf('\n', start);
    const line = body.slice(start, lineEnd < 0 ? body.length : lineEnd).replace(/\r$/, '');
    const task = line.match(/^([-+*]\s+\[)([ xX])(\]\s+)/);
    if (!task) return null;
    if (change.kind === 'check') next = replace(start + task[1].length, start + task[1].length + 1, change.checked ? 'x' : ' ');
    else if (change.kind === 'rename') {
      const paragraph = node.children?.[0];
      if (!paragraph?.position) return null;
      next = replace(start + task[0].length, paragraph.position.end.offset, literal(change.text.trim()));
    } else if (change.kind === 'remove') {
      const from = body.lastIndexOf('\n', start - 1) + 1;
      const through = body.startsWith('\r\n', end) ? end + 2 : body[end] === '\n' ? end + 1 : end;
      next = replace(from, through, '');
    } else {
      const siblings = parent.children ?? [], other = siblings[siblings.indexOf(node) + change.direction];
      if (!other || !rows.some(row => row.node === other)) return null;
      const a = change.direction < 0 ? other : node, b = change.direction < 0 ? node : other;
      const from = a.position!.start.offset, to = b.position!.end.offset;
      next = replace(from, to, body.slice(b.position!.start.offset, to) + body.slice(a.position!.end.offset, b.position!.start.offset) + body.slice(from, a.position!.end.offset));
    }
  }
  if (next === body) return null;
  return next.split('\n').map(line => line ? indent + line : line).join('\n');
}
