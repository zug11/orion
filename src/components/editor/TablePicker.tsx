import type { Editor } from "@tiptap/core";
import { useEditorState } from "@tiptap/react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { currentTable, insertNoteTable, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, runTableAction, setNoteTableWidth, type TableAction } from "./NoteTable";
import { useMenuHeight } from "./useMenuHeight";
import "./NoteTable.css";

interface TablePickerProps {
  editor: Editor;
  onClose: () => void;
  onInsert?: (rows: number, columns: number) => void;
  /** Captured slash-command range; removed in the same insertion transaction. */
  range?: { from: number; to: number };
  canInsert?: () => boolean;
}

/** Word-style size grid, sharing the editor's current insertion point. */
export function TablePicker({ editor, onClose, onInsert, range, canInsert }: TablePickerProps) {
  const [dimensions, setDimensions] = useState({ rows: 3, columns: 3 });
  const [header, setHeader] = useState(true);
  const [custom, setCustom] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [stale, setStale] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const [coarse, setCoarse] = useState(() => window.matchMedia?.("(pointer: coarse)").matches ?? false);
  const columns = coarse ? 5 : 8;
  const rows = 6;

  useEffect(() => {
    const media = window.matchMedia?.("(pointer: coarse)");
    if (!media) return;
    const update = () => setCoarse(media.matches);
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    // WebKit drops focus when the grid/custom control that owns it unmounts.
    // Move it into the newly visible mode so Escape and arrows keep working.
    const control = custom
      ? shellRef.current?.querySelector<HTMLInputElement>('input[type="number"]')
      : gridRef.current?.querySelector<HTMLButtonElement>(`[data-row="${Math.min(dimensions.rows, rows)}"][data-column="${Math.min(dimensions.columns, columns)}"]`);
    control?.focus({ preventScroll: true });
    const dismiss = (event: MouseEvent) => {
      if (event.target instanceof Node && !shellRef.current?.contains(event.target)) onCloseRef.current();
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [columns, custom]);

  function insert(selected = dimensions) {
    if (canInsert && !canInsert()) { setStale(true); return; }
    if (insertNoteTable(editor, { rows: selected.rows, cols: selected.columns, withHeaderRow: header }, range)) {
      onInsert?.(selected.rows, selected.columns);
      onClose();
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); editor.commands.focus(); return; }
    if (custom || !(event.target instanceof HTMLButtonElement) || !event.target.dataset.row) return;
    const change = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] }[event.key];
    if (!change) return;
    event.preventDefault();
    event.stopPropagation();
    const next = { rows: Math.max(1, Math.min(rows, dimensions.rows + change[0])), columns: Math.max(1, Math.min(columns, dimensions.columns + change[1])) };
    setDimensions(next);
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-row="${next.rows}"][data-column="${next.columns}"]`)?.focus();
  }

  return <div className="orion-table-picker" role="dialog" aria-label="Insert table" ref={shellRef} onKeyDown={keyDown} onMouseDown={(event) => event.stopPropagation()}>
    {stale && <p className="orion-table-picker-error" role="alert">The note changed. Close this picker and choose an insertion point again.</p>}
    <div className="orion-table-picker-heading"><strong>Insert table</strong><span aria-live="polite">{dimensions.columns} × {dimensions.rows}</span></div>
    {!custom && <div className="orion-table-picker-grid" ref={gridRef} style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }} role="group" aria-label="Choose table dimensions">
      {Array.from({ length: rows * columns }, (_, index) => {
        const row = Math.floor(index / columns) + 1;
        const column = index % columns + 1;
        const selected = row <= dimensions.rows && column <= dimensions.columns;
        return <button key={index} type="button" data-row={row} data-column={column} aria-label={`${column} ${column === 1 ? "column" : "columns"}, ${row} ${row === 1 ? "row" : "rows"}`} className={selected ? "is-picked" : ""} onMouseEnter={() => setDimensions({ rows: row, columns: column })} onFocus={() => setDimensions({ rows: row, columns: column })} onClick={() => insert({ rows: row, columns: column })}><span /></button>;
      })}
    </div>}
    {custom && <div className="orion-table-custom-size">
      <label>Columns<input aria-label="Table columns" type="number" min={1} max={MAX_TABLE_COLUMNS} value={dimensions.columns} onChange={(event) => setDimensions((previous) => ({ ...previous, columns: Math.max(1, Math.min(MAX_TABLE_COLUMNS, Number(event.target.value) || 1)) }))} /></label>
      <label>Rows<input aria-label="Table rows" type="number" min={1} max={MAX_TABLE_ROWS} value={dimensions.rows} onChange={(event) => setDimensions((previous) => ({ ...previous, rows: Math.max(1, Math.min(MAX_TABLE_ROWS, Number(event.target.value) || 1)) }))} /></label>
    </div>}
    <label className="orion-table-header-toggle"><input type="checkbox" checked={header} onChange={(event) => setHeader(event.target.checked)} />Header row</label>
    <div className="orion-table-picker-footer">
      <button type="button" onClick={() => setCustom((value) => !value)}>{custom ? "Grid picker" : "Custom size…"}</button>
      {custom && <button type="button" className="primary" onClick={() => insert()}>Insert table</button>}
    </div>
  </div>;
}

interface TableToolbarProps {
  editor: Editor;
  onAnnounce?: (message: string) => void;
  overflowTarget?: HTMLElement | null;
}

/** Render inside the stable contextual toolbar instead of text formatting tools. */
export function TableToolbar({ editor, onAnnounce, overflowTarget }: TableToolbarProps) {
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const moreHeight = useMenuHeight(more, triggerRef);
  useEffect(() => {
    if (!more) return;
    moreRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMore(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [more]);
  const state = useEditorState({ editor, selector: ({ editor: current }) => {
    if (current.isDestroyed) return undefined;
    const table = currentTable(current);
    if (!table) return undefined;
    return { rows: table.map.height, columns: table.map.width, header: table.node.firstChild?.firstChild?.type.name === "tableHeader", banded: table.node.attrs.banded !== false, width: Number(table.node.attrs.tableWidth ?? 100), canAddRow: table.map.height < MAX_TABLE_ROWS && current.can().addRowAfter(), canAddColumn: table.map.width < MAX_TABLE_COLUMNS && current.can().addColumnAfter() };
  } });
  if (!state) return null;

  function action(value: TableAction) {
    setMore(false);
    if (runTableAction(editor, value)) onAnnounce?.({ "add-row-before": "Row added above.", "add-row-after": "Row added below.", "delete-row": "Row deleted.", "add-column-before": "Column added to the left.", "add-column-after": "Column added to the right.", "delete-column": "Column deleted.", "delete-table": "Table deleted.", "toggle-header": "Header row updated.", "toggle-banding": "Row shading updated." }[value]);
  }

  const moreControl = <div className="orion-table-more orion-table-toolbar" ref={moreRef}>
      <button ref={triggerRef} className="orion-table-more-trigger" type="button" aria-label="More table options" aria-haspopup="menu" aria-expanded={more} onMouseDown={(event) => event.preventDefault()} onClick={() => setMore(!more)}>•••</button>
      {more && <div className="orion-table-more-menu editor-floating-menu" style={{ maxHeight: Math.min(390, moreHeight) }} role="menu" aria-label="More table options" onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setMore(false); triggerRef.current?.focus(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
        const index = controls.indexOf(document.activeElement as HTMLButtonElement);
        controls[event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length]?.focus();
      }}>
        <button type="button" role="menuitemcheckbox" aria-checked={state.banded} onMouseDown={(event) => event.preventDefault()} onClick={() => action("toggle-banding")}><span>Alternate rows</span><span aria-hidden="true">{state.banded ? "✓" : ""}</span></button>
        <div className="orion-table-menu-separator" role="separator" />
        {([
          ["add-row-before", "Add row above", !state.canAddRow], ["add-row-after", "Add row below", !state.canAddRow], ["delete-row", "Delete selected row", false],
          ["add-column-before", "Add column left", !state.canAddColumn], ["add-column-after", "Add column right", !state.canAddColumn], ["delete-column", "Delete selected column", false],
        ] as const).map(([value, label, disabled]) => <button key={value} type="button" role="menuitem" disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={() => action(value)}>{label}</button>)}
        <div className="orion-table-menu-separator" role="separator" />
        <button type="button" role="menuitem" className="orion-table-delete" onMouseDown={(event) => event.preventDefault()} onClick={() => action("delete-table")}>Delete table</button>
      </div>}
    </div>;
  return <><div className="orion-table-toolbar" role="group" aria-label="Table tools">
    <span className="orion-table-toolbar-label">Table <span>{state.columns} × {state.rows}</span></span>
    <button type="button" aria-pressed={state.header} onMouseDown={(event) => event.preventDefault()} onClick={() => action("toggle-header")}>Header</button>
    <label className="orion-table-width-label">Width <select aria-label="Table width" value={state.width} onChange={(event) => setNoteTableWidth(editor, Number(event.target.value))}>{Array.from(new Set([50, 65, 80, 100, state.width])).sort((a, b) => a - b).map((width) => <option key={width} value={width}>{width}%</option>)}</select></label>
    {!overflowTarget && moreControl}
  </div>{overflowTarget && createPortal(moreControl, overflowTarget)}</>;
}
