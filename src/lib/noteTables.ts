export const MIN_TABLE_WIDTH = 35;
export const TABLE_META_PREFIX = "<!-- orion-table:v1 ";

export interface TableLayout {
  width: number;
  banded: boolean;
  header: boolean;
  columns: (number | null)[];
}

export function boundedTableInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

export function normalizeTableLayout(value: unknown): TableLayout | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    width: boundedTableInteger(record.width, 100, MIN_TABLE_WIDTH, 100),
    banded: record.banded !== false,
    header: record.header !== false,
    columns: Array.isArray(record.columns)
      ? record.columns.slice(0, 100).map((width) => typeof width === "number" && Number.isFinite(width) ? boundedTableInteger(width, 80, 48, 2000) : null)
      : [],
  };
}

export function parseNoteTableMetadata(value: string): TableLayout | undefined {
  const match = value.trim().match(/^<!-- orion-table:v1 ([^\r\n]{1,1600}) -->$/);
  if (!match) return undefined;
  try { return normalizeTableLayout(JSON.parse(match[1])); } catch { return undefined; }
}

/** GFM AST line numbers are one-based. Only immediately preceding metadata applies. */
export function noteTableLayoutAtLine(markdown: string, line: number): TableLayout | undefined {
  if (!Number.isInteger(line) || line < 2) return undefined;
  const lines = markdown.split(/\r?\n/);
  let previous = line - 2;
  if (lines[previous]?.trim() === "") previous -= 1;
  return lines[previous] === lines[previous]?.trim() ? parseNoteTableMetadata(lines[previous] ?? "") : undefined;
}

interface TableMarkdownNode {
  type: string;
  value?: string;
  children?: TableMarkdownNode[];
  position?: { start: { line: number }; end: { line: number } };
}

/** Hide editor-owned metadata without rewriting Markdown or shifting line maps.
 * Fenced/indented/inline code examples are different AST nodes and stay visible.
 */
export function remarkNoteTableMetadata() {
  return (tree: TableMarkdownNode) => {
    const visit = (parent: TableMarkdownNode) => {
      if (!parent.children) return;
      parent.children = parent.children.filter((node, index, siblings) => {
        const next = siblings[index + 1];
        const gap = next?.position && node.position ? next.position.start.line - node.position.end.line : -1;
        return !(node.type === "html" && typeof node.value === "string" && parseNoteTableMetadata(node.value) && next?.type === "table" && gap >= 1 && gap <= 2);
      });
      parent.children.forEach(visit);
    };
    visit(tree);
  };
}

export function tableColumnLabel(index: number): string {
  let value = Math.max(0, Math.floor(index)) + 1;
  let result = "";
  while (value > 0) {
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}


interface TableMarkupNode {
  type: string;
  value?: string;
  tagName?: string;
  children?: readonly TableMarkupNode[];
}

/** Only a truly empty GFM header can be suppressed by header-off metadata. */
export function noteTableHeaderInfo(node?: TableMarkupNode): { empty: boolean; columns: number } {
  const header = node?.children?.find((child) => child.type === "element" && child.tagName === "thead");
  const row = header?.children?.find((child) => child.type === "element" && child.tagName === "tr");
  const hasContent = (current: TableMarkupNode): boolean => current.type === "text"
    ? Boolean(current.value?.trim())
    : current.tagName === "img" || Boolean(current.children?.some(hasContent));
  return {
    empty: Boolean(header && !hasContent(header)),
    columns: row?.children?.filter((child) => child.type === "element" && /^(th|td)$/.test(child.tagName ?? "")).length ?? 0,
  };
}
