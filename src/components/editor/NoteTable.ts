import type { Editor, JSONContent, MarkdownToken } from "@tiptap/core";
import { Table, TableView, renderTableToMarkdown } from "@tiptap/extension-table";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { CellSelection, TableMap, addColumn, addRow, removeColumn, removeRow } from "@tiptap/pm/tables";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView, ViewMutationRecord } from "@tiptap/pm/view";

import { boundedTableInteger, normalizeTableLayout, tableColumnLabel, MIN_TABLE_WIDTH, TABLE_META_PREFIX, type TableLayout } from "../../lib/noteTables";
export { noteTableLayoutAtLine, tableColumnLabel } from "../../lib/noteTables";

export const MAX_TABLE_COLUMNS = 12;
export const MAX_TABLE_ROWS = 20;
const TABLE_EVENT = "orion-table-selection";
type TableToken = MarkdownToken & { orionLayout?: TableLayout };

export function insertNoteTable(editor: Editor, options: { rows: number; cols: number; withHeaderRow?: boolean }, range?: { from: number; to: number }): boolean {
  if (!editor.isEditable || editor.isDestroyed || editor.isActive("table")) return false;
  const chain = editor.chain().focus();
  if (range) chain.deleteRange(range);
  return chain.insertTable({
    rows: boundedTableInteger(options.rows, 3, 1, MAX_TABLE_ROWS),
    cols: boundedTableInteger(options.cols, 3, 1, MAX_TABLE_COLUMNS),
    withHeaderRow: options.withHeaderRow !== false,
  }).run();
}

export function currentTable(editor: Editor): { node: ProseMirrorNode; pos: number; map: TableMap } | undefined {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "table") return { node, pos: $from.before(depth), map: TableMap.get(node) };
  }
  const node = editor.state.doc.nodeAt(editor.state.selection.from);
  if (node?.type.name === "table") return { node, pos: editor.state.selection.from, map: TableMap.get(node) };
  return undefined;
}

export type TableAction = "add-row-before" | "add-row-after" | "delete-row" | "add-column-before" | "add-column-after" | "delete-column" | "delete-table" | "toggle-header" | "toggle-banding";

export function runTableAction(editor: Editor, action: TableAction): boolean {
  if (!editor.isEditable || editor.isDestroyed || !currentTable(editor)) return false;
  const chain = editor.chain().focus();
  switch (action) {
    case "add-row-before": return chain.addRowBefore().run();
    case "add-row-after": return chain.addRowAfter().run();
    case "delete-row": return chain.deleteRow().run();
    case "add-column-before": return chain.addColumnBefore().run();
    case "add-column-after": return chain.addColumnAfter().run();
    case "delete-column": return chain.deleteColumn().run();
    case "delete-table": return chain.deleteTable().run();
    case "toggle-header": return chain.toggleHeaderRow().run();
    case "toggle-banding": return chain.updateAttributes("table", { banded: currentTable(editor)?.node.attrs.banded === false }).run();
  }
}

function resizeTable(tr: Transaction, pos: number, node: ProseMirrorNode, requestedWidth: number): Transaction {
  const width = boundedTableInteger(requestedWidth, 100, MIN_TABLE_WIDTH, 100);
  const previousWidth = boundedTableInteger(node.attrs.tableWidth, 100, MIN_TABLE_WIDTH, 100);
  const scale = width / previousWidth;
  tr.setNodeMarkup(pos, undefined, { ...node.attrs, tableWidth: width });
  node.descendants((cell, offset) => {
    if (cell.type.spec.tableRole !== "cell" && cell.type.spec.tableRole !== "header_cell") return true;
    if (Array.isArray(cell.attrs.colwidth)) tr.setNodeMarkup(pos + 1 + offset, undefined, { ...cell.attrs, colwidth: cell.attrs.colwidth.map((value: unknown) => typeof value === "number" ? boundedTableInteger(value * scale, 96, 64, 2000) : value) });
    return false;
  });
  return tr;
}

export function setNoteTableWidth(editor: Editor, width: number): boolean {
  const selected = currentTable(editor);
  if (!editor.isEditable || !selected) return false;
  editor.view.dispatch(resizeTable(editor.state.tr, selected.pos, selected.node, width));
  editor.commands.focus();
  return true;
}

export type TableDimensionResult = "updated" | "unchanged" | "confirmation-required" | "invalid";

function containsCellContent(cell: ProseMirrorNode): boolean {
  if (cell.textContent.trim()) return true;
  let content = false;
  cell.descendants((node) => {
    // Non-text content, such as an image or checked task, also needs protection.
    if (node.isAtom && node.type.name !== "hardBreak" || node.type.name === "taskItem") content = true;
    return !content;
  });
  return content;
}

function resizeNoteTableAt(view: EditorView, pos: number, requestedRows: number, requestedColumns: number, allowContentRemoval = false): TableDimensionResult {
  const node = view.state.doc.nodeAt(pos);
  if (!view.editable || node?.type.name !== "table") return "invalid";
  const map = TableMap.get(node);
  // Imported tables can exceed picker bounds; never truncate their other axis.
  const rows = boundedTableInteger(requestedRows, map.height, 1, Math.max(MAX_TABLE_ROWS, map.height));
  const columns = boundedTableInteger(requestedColumns, map.width, 1, Math.max(MAX_TABLE_COLUMNS, map.width));
  if (rows === map.height && columns === map.width) return "unchanged";
  if (!allowContentRemoval) {
    const removed = new Set<number>();
    for (let row = 0; row < map.height; row += 1) for (let column = 0; column < map.width; column += 1) {
      if (row >= rows || column >= columns) removed.add(map.map[row * map.width + column]);
    }
    if (Array.from(removed).some((offset) => containsCellContent(node.nodeAt(offset)!))) return "confirmation-required";
  }
  const tr = closeHistory(view.state.tr);
  const rectangle = () => {
    const table = tr.doc.nodeAt(pos)!;
    const nextMap = TableMap.get(table);
    return { table, map: nextMap, tableStart: pos + 1, top: 0, left: 0, right: nextMap.width, bottom: nextMap.height };
  };
  const change = (operation: typeof addRow | typeof removeRow, index: number) => {
    // Table helpers map their input positions through the transaction. Give each
    // helper a fresh mapping, then collect its steps into the one undo event.
    const local = EditorState.create({ schema: view.state.schema, doc: tr.doc }).tr;
    operation(local, rectangle(), index);
    for (const step of local.steps) tr.step(step);
  };
  while (rectangle().map.height < rows) change(addRow, rectangle().map.height);
  while (rectangle().map.width < columns) change(addColumn, rectangle().map.width);
  while (rectangle().map.height > rows) change(removeRow, rectangle().map.height - 1);
  while (rectangle().map.width > columns) change(removeColumn, rectangle().map.width - 1);
  view.dispatch(tr);
  return "updated";
}

/** Changes dimensions at the bottom/right edges in one undoable transaction. */
export function setNoteTableDimensions(editor: Editor, rows: number, columns: number, allowContentRemoval = false): TableDimensionResult {
  if (editor.isDestroyed || !editor.isEditable) return "invalid";
  const selected = currentTable(editor);
  return selected ? resizeNoteTableAt(editor.view, selected.pos, rows, columns, allowContentRemoval) : "invalid";
}

/** TableView keeps Tiptap's real table cells and column-resize implementation. */
class NoteTableView extends TableView {
  private readonly view: EditorView;
  private readonly stage: HTMLDivElement;
  private readonly columns: HTMLDivElement;
  private readonly rows: HTMLDivElement;
  private readonly all: HTMLButtonElement;
  private readonly resize: HTMLButtonElement;
  private readonly rowCount: HTMLDivElement;
  private readonly columnCount: HTMLDivElement;
  private readonly confirmation: HTMLDivElement;
  private readonly observer?: ResizeObserver;
  private animation = 0;
  private pendingCount?: { node: ProseMirrorNode; rows: number; columns: number; axis: "row" | "column" };
  private dragCleanup?: () => void;
  private destroyed = false;

  constructor(node: ProseMirrorNode, cellMinWidth: number, view: EditorView, HTMLAttributes: Record<string, unknown> = {}) {
    super(node, cellMinWidth, view, HTMLAttributes);
    this.view = view;
    this.dom.classList.add("orion-table-frame");
    this.stage = document.createElement("div");
    this.stage.className = "orion-table-stage";
    this.dom.append(this.stage);
    this.stage.append(this.table);
    this.columns = this.rail("orion-table-columns", "Table columns");
    this.rows = this.rail("orion-table-rows", "Table rows");
    this.all = this.button("Select table", "○", () => this.select("table", 0));
    this.all.className = "orion-table-select-all";
    this.stage.append(this.all);
    this.resize = this.button("Resize table", "", () => undefined);
    this.resize.className = "orion-table-resize";
    this.resize.title = "Drag to resize table; arrow keys adjust width";
    this.resize.addEventListener("pointerdown", this.beginResize);
    this.resize.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      this.commitWidth(Number(this.node.attrs.tableWidth ?? 100) + (event.key === "ArrowRight" ? 5 : -5));
    });
    this.stage.append(this.resize);
    this.rowCount = this.countStepper("row");
    this.columnCount = this.countStepper("column");
    this.confirmation = document.createElement("div");
    this.confirmation.className = "orion-table-count-confirmation";
    this.confirmation.contentEditable = "false";
    this.confirmation.setAttribute("role", "alertdialog");
    this.confirmation.setAttribute("aria-label", "Confirm table size reduction");
    this.confirmation.hidden = true;
    this.confirmation.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.cancelCount(); this.view.focus(); }
    });
    this.stage.append(this.confirmation);
    view.dom.addEventListener(TABLE_EVENT, this.refreshSelection);
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(this.queueLayout);
      this.observer.observe(this.table);
    }
    this.refresh();
  }

  private rail(className: string, label: string): HTMLDivElement {
    const element = document.createElement("div");
    element.className = className;
    element.contentEditable = "false";
    element.setAttribute("role", "group");
    element.setAttribute("aria-label", label);
    this.stage.append(element);
    return element;
  }

  private button(label: string, text: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.contentEditable = "false";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.textContent = text;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); action(); });
    return button;
  }

  private position(): number | undefined {
    try {
      const position = this.view.posAtDOM(this.contentDOM, 0) - 1;
      return this.view.state.doc.nodeAt(position)?.type.name === "table" ? position : undefined;
    } catch { return undefined; }
  }

  private select(axis: "row" | "column" | "table", index: number) {
    const pos = this.position();
    if (pos === undefined || !this.view.editable) return;
    const map = TableMap.get(this.node);
    const start = pos + 1;
    const anchor = start + map.map[axis === "row" ? index * map.width : axis === "column" ? index : 0];
    const head = start + map.map[axis === "row" ? index * map.width + map.width - 1 : axis === "column" ? (map.height - 1) * map.width + index : map.map.length - 1];
    const $anchor = this.view.state.doc.resolve(anchor);
    const $head = this.view.state.doc.resolve(head);
    const selection = axis === "row" ? CellSelection.rowSelection($anchor, $head) : axis === "column" ? CellSelection.colSelection($anchor, $head) : new CellSelection($anchor, $head);
    this.view.dispatch(this.view.state.tr.setSelection(selection));
    this.view.focus();
    this.refreshSelection();
  }

  private countStepper(axis: "row" | "column"): HTMLDivElement {
    const group = document.createElement("div");
    group.className = `orion-table-count orion-table-${axis}-count`;
    group.contentEditable = "false";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `${axis === "row" ? "Row" : "Column"} count`);
    const input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.setAttribute("aria-label", `Number of ${axis}s`);
    input.title = `Number of ${axis}s`;
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    input.addEventListener("blur", () => this.requestCount(axis, Number(input.value)));
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); this.cancelCount(); this.refreshCounts(); this.view.focus(); }
      if (event.key === "Enter") { event.preventDefault(); this.requestCount(axis, Number(input.value)); }
      if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); this.requestCount(axis, Number(input.value) + (event.key === "ArrowUp" ? 1 : -1)); }
    });
    const arrows = document.createElement("span");
    arrows.className = "orion-table-count-arrows";
    for (const [direction, delta] of [["Increase", 1], ["Decrease", -1]] as const) {
      const button = this.button(`${direction} ${axis} count`, "", () => {
        const map = TableMap.get(this.node);
        this.requestCount(axis, (axis === "row" ? map.height : map.width) + delta);
      });
      button.dataset.direction = direction.toLowerCase();
      const chevron = document.createElement("span");
      chevron.className = `orion-table-count-chevron ${delta < 0 ? "is-down" : ""}`;
      chevron.setAttribute("aria-hidden", "true");
      button.append(chevron);
      arrows.append(button);
    }
    group.append(input, arrows);
    this.stage.append(group);
    return group;
  }

  private cancelCount() {
    this.pendingCount = undefined;
    this.confirmation.hidden = true;
    this.dom.classList.remove("has-count-confirmation");
  }

  private refreshCounts() {
    const map = TableMap.get(this.node);
    for (const [group, value, limit] of [[this.rowCount, map.height, MAX_TABLE_ROWS], [this.columnCount, map.width, MAX_TABLE_COLUMNS]] as const) {
      const input = group.querySelector("input")!;
      input.value = String(value);
      input.max = String(Math.max(value, limit));
      group.querySelector<HTMLButtonElement>('[data-direction="increase"]')!.disabled = value >= limit;
      group.querySelector<HTMLButtonElement>('[data-direction="decrease"]')!.disabled = value <= 1;
    }
  }

  private requestCount(axis: "row" | "column", value: number) {
    const pos = this.position();
    if (pos === undefined || !this.view.editable) return;
    const map = TableMap.get(this.node);
    const rows = axis === "row" ? boundedTableInteger(value, map.height, 1, Math.max(map.height, MAX_TABLE_ROWS)) : map.height;
    const columns = axis === "column" ? boundedTableInteger(value, map.width, 1, Math.max(map.width, MAX_TABLE_COLUMNS)) : map.width;
    const result = resizeNoteTableAt(this.view, pos, rows, columns);
    if (result !== "confirmation-required") { this.cancelCount(); this.refreshCounts(); return; }
    this.pendingCount = { node: this.node, rows, columns, axis };
    const difference = axis === "row" ? map.height - rows : map.width - columns;
    const message = document.createElement("span");
    message.textContent = `Remove ${difference} ${axis}${difference === 1 ? "" : "s"} containing content?`;
    const confirm = this.button(`Remove ${axis}s and content`, "Remove", () => {
      const pending = this.pendingCount;
      const currentPos = this.position();
      if (!pending || currentPos === undefined || !this.node.eq(pending.node)) { this.cancelCount(); return; }
      this.cancelCount();
      resizeNoteTableAt(this.view, currentPos, pending.rows, pending.columns, true);
      this.view.focus();
    });
    confirm.className = "is-destructive";
    const cancel = this.button("Keep table size", "Keep", () => { this.cancelCount(); this.refreshCounts(); });
    this.confirmation.replaceChildren(message, cancel, confirm);
    this.confirmation.hidden = false;
    this.dom.classList.add("has-count-confirmation");
    this.refreshCounts();
    this.queueLayout();
    cancel.focus({ preventScroll: true });
  }

  private refresh() {
    const map = TableMap.get(this.node);
    this.stage.style.width = `${boundedTableInteger(this.node.attrs.tableWidth, 100, MIN_TABLE_WIDTH, 100)}%`;
    const widths = this.node.firstChild ? Array.from({ length: this.node.firstChild.childCount }, (_, index) => this.node.firstChild!.child(index)).flatMap((cell) => Array.from({ length: Number(cell.attrs.colspan ?? 1) }, (_, index) => Number(cell.attrs.colwidth?.[index]) || 96)) : [];
    this.stage.style.minWidth = `${Math.max(180, widths.reduce((sum, width) => sum + width, 0))}px`;
    this.dom.dataset.banded = String(this.node.attrs.banded !== false);
    if (this.pendingCount && !this.node.eq(this.pendingCount.node)) this.cancelCount();
    this.refreshCounts();
    this.columns.replaceChildren();
    this.rows.replaceChildren();
    for (let column = 0; column < map.width; column += 1) this.columns.append(this.button(`Select column ${tableColumnLabel(column)}`, tableColumnLabel(column), () => this.select("column", column)));
    for (let row = 0; row < map.height; row += 1) this.rows.append(this.button(`Select row ${row + 1}`, String(row + 1), () => this.select("row", row)));
    this.refreshSelection();
    this.queueLayout();
  }

  private refreshSelection = () => {
    if (this.destroyed) return;
    const pos = this.position();
    const selection = this.view.state.selection;
    const selected = pos !== undefined && selection.from > pos && selection.to < pos + this.node.nodeSize;
    this.dom.classList.toggle("is-table-active", selected && this.view.editable);
    if (!selected) this.cancelCount();
    const selectedCells = selection instanceof CellSelection && selected ? selection : undefined;
    const map = TableMap.get(this.node);
    let rectangle: ReturnType<TableMap["rectBetween"]> | undefined;
    if (selectedCells && pos !== undefined) rectangle = map.rectBetween(selectedCells.$anchorCell.pos - pos - 1, selectedCells.$headCell.pos - pos - 1);
    Array.from(this.columns.children).forEach((button, column) => button.setAttribute("aria-pressed", String(Boolean(rectangle && selectedCells?.isColSelection() && column >= rectangle.left && column < rectangle.right))));
    Array.from(this.rows.children).forEach((button, row) => button.setAttribute("aria-pressed", String(Boolean(rectangle && selectedCells?.isRowSelection() && row >= rectangle.top && row < rectangle.bottom))));
    this.queueLayout();
  };

  private queueLayout = () => {
    if (this.animation || this.destroyed) return;
    this.animation = requestAnimationFrame(() => {
      this.animation = 0;
      if (this.destroyed) return;
      const tableRect = this.table.getBoundingClientRect();
      this.columns.style.width = `${tableRect.width}px`;
      const first = this.table.rows[0];
      if (first) {
        const widths: number[] = [];
        Array.from(first.cells).forEach((cell) => { for (let i = 0; i < cell.colSpan; i += 1) widths.push(cell.getBoundingClientRect().width / cell.colSpan); });
        this.columns.style.gridTemplateColumns = widths.map((width) => `${width}px`).join(" ");
      }
      Array.from(this.table.rows).forEach((row, index) => {
        const rail = this.rows.children[index] as HTMLElement | undefined;
        if (rail) rail.style.height = `${row.getBoundingClientRect().height}px`;
      });
      this.resize.style.left = `${tableRect.width - 5}px`;
      this.resize.style.top = `${tableRect.height - 5}px`;
      this.columnCount.style.left = `${tableRect.width + 8}px`;
      this.confirmation.style.width = `${Math.max(140, Math.min(340, this.dom.clientWidth - 90))}px`;
    });
  };

  private commitWidth(width: number) {
    const pos = this.position();
    if (pos === undefined) return;
    this.view.dispatch(resizeTable(this.view.state.tr, pos, this.node, width));
  }

  private beginResize = (event: PointerEvent) => {
    if (!this.view.editable || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.dragCleanup?.();
    const initialX = event.clientX;
    const initialWidth = Number(this.node.attrs.tableWidth ?? 100);
    const availableWidth = Math.max(1, this.dom.clientWidth - 116);
    let width = initialWidth;
    const initialTableWidth = this.table.getBoundingClientRect().width;
    const initialColumns = Array.from(this.colgroup.children).map((column) => (column as HTMLElement).getBoundingClientRect().width);
    const move = (next: PointerEvent) => {
      width = boundedTableInteger(initialWidth + ((next.clientX - initialX) / availableWidth) * 100, 100, MIN_TABLE_WIDTH, 100);
      this.stage.style.width = `${width}%`;
      const ratio = width / initialWidth;
      this.table.style.width = `${Math.round(initialTableWidth * ratio)}px`;
      Array.from(this.colgroup.children).forEach((column, index) => { (column as HTMLElement).style.width = `${Math.max(64, Math.round(initialColumns[index] * ratio))}px`; });
      this.queueLayout();
    };
    const clean = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      this.dragCleanup = undefined;
    };
    const finish = () => { clean(); this.commitWidth(width); this.view.focus(); };
    const cancel = () => { clean(); super.update(this.node); this.refresh(); };
    this.dragCleanup = clean;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", cancel, { once: true });
  };

  update(node: ProseMirrorNode) {
    if (!super.update(node)) return false;
    this.refresh();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target instanceof Node && this.dom.contains(event.target) && !this.contentDOM.contains(event.target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.target instanceof Node && this.dom.contains(mutation.target) && !this.contentDOM.contains(mutation.target)) return true;
    return super.ignoreMutation(mutation);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.animation);
    this.observer?.disconnect();
    this.dragCleanup?.();
    this.view.dom.removeEventListener(TABLE_EVENT, this.refreshSelection);
  }
}

const baseTokenizer = Table.config.markdownTokenizer!;

/** Layout metadata is bounded, inert, and adjacent to otherwise portable GFM. */
export const NoteTable = Table.extend({
  addOptions() {
    return { ...this.parent!(), resizable: true, renderWrapper: true, cellMinWidth: 64, View: NoteTableView };
  },
  addAttributes() {
    return {
      ...this.parent?.(),
      tableWidth: { default: 100, parseHTML: (element: HTMLElement) => boundedTableInteger(Number(element.dataset.orionWidth ?? 100), 100, MIN_TABLE_WIDTH, 100), renderHTML: (attributes: Record<string, unknown>) => ({ "data-orion-width": attributes.tableWidth }) },
      banded: { default: true, parseHTML: (element: HTMLElement) => element.dataset.banded !== "false", renderHTML: (attributes: Record<string, unknown>) => ({ "data-banded": String(attributes.banded !== false) }) },
    };
  },
  markdownTokenizer: {
    ...baseTokenizer,
    start(src) {
      const index = src.indexOf(TABLE_META_PREFIX);
      return index >= 0 ? index : typeof baseTokenizer.start === "function" ? baseTokenizer.start(src) : -1;
    },
    tokenize(src, tokens, helper) {
      const match = src.match(/^<!-- orion-table:v1 ([^\r\n]{1,1600}) -->\r?\n[ \t]*(?:\r?\n)?/);
      if (!match) return baseTokenizer.tokenize(src, tokens, helper);
      let layout: TableLayout | undefined;
      try { layout = normalizeTableLayout(JSON.parse(match[1])); } catch { return undefined; }
      if (!layout) return undefined;
      const next = helper.blockTokens(src.slice(match[0].length))[0];
      if (next?.type !== "table" || !next.raw) return undefined;
      return { ...next, raw: match[0] + next.raw, orionLayout: layout };
    },
  },
  parseMarkdown(token, helpers) {
    const parsed = Table.config.parseMarkdown!.call(this, token, helpers) as JSONContent;
    const layout = (token as TableToken).orionLayout;
    if (!layout || !parsed?.content) return parsed;
    parsed.attrs = { ...parsed.attrs, tableWidth: layout.width, banded: layout.banded };
    if (!layout.header && parsed.content[0]?.content?.every((cell) => !cell.content?.some((paragraph) => paragraph.content?.length))) parsed.content.shift();
    parsed.content.forEach((row) => {
      row.content?.forEach((cell, index) => {
        if (!layout.header && cell.type === "tableHeader") cell.type = "tableCell";
        if (layout.columns[index]) cell.attrs = { ...cell.attrs, colwidth: [layout.columns[index]] };
      });
    });
    return parsed;
  },
  renderMarkdown(node, helpers) {
    const markdown = renderTableToMarkdown(node, helpers);
    const cells = node.content?.[0]?.content ?? [];
    const layout: TableLayout = {
      width: boundedTableInteger(node.attrs?.tableWidth, 100, MIN_TABLE_WIDTH, 100),
      banded: node.attrs?.banded !== false,
      header: cells.some((cell) => cell.type === "tableHeader"),
      columns: cells.flatMap((cell) => Array.from({ length: boundedTableInteger(cell.attrs?.colspan, 1, 1, 100) }, (_, i) => typeof cell.attrs?.colwidth?.[i] === "number" ? boundedTableInteger(cell.attrs.colwidth[i], 80, 48, 2000) : null)),
    };
    if (layout.width === 100 && layout.banded && layout.header && layout.columns.every((width) => width === null)) return markdown;
    return `\n${TABLE_META_PREFIX}${JSON.stringify(layout)} -->\n${markdown.trim()}\n`;
  },
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        key: new PluginKey("orionTableChrome"),
        view(view) {
          return { update(updatedView, previous) {
            if (!updatedView.state.selection.eq(previous.selection) || updatedView.state.doc !== previous.doc) updatedView.dom.dispatchEvent(new Event(TABLE_EVENT));
          }, destroy() { view.dom.dispatchEvent(new Event(TABLE_EVENT)); } };
        },
      }),
    ];
  },
});
