import { JUSTIFY_MARKER } from "./noteTextAlignment";

export interface NoteMargins { left: number; right: number }
export const MAX_NOTE_MARGIN = 25;

function splitFrontmatter(markdown: string) {
  const prefix = markdown.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)+/)?.[0] ?? "";
  return { prefix, content: markdown.slice(prefix.length) };
}

/** A percentage of the available writing width, never arbitrary CSS. */
export function normalizeNoteMargin(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(MAX_NOTE_MARGIN, Math.round(value))) : 0;
}

function parseMarker(value: string, kind: "document" | "paragraph"): NoteMargins | null {
  const match = value.match(new RegExp(`^<!-- orion-${kind}-margins:v1 (0|[1-9]\\d?) (0|[1-9]\\d?) -->$`));
  if (!match) return null;
  const left = Number(match[1]);
  const right = Number(match[2]);
  return left <= MAX_NOTE_MARGIN && right <= MAX_NOTE_MARGIN ? { left, right } : null;
}

export function parseParagraphMarginsMarker(value: string): NoteMargins | null {
  return parseMarker(value, "paragraph");
}

export function paragraphMarginsMarker(margins: NoteMargins): string {
  const left = normalizeNoteMargin(margins.left);
  const right = normalizeNoteMargin(margins.right);
  return left || right ? `<!-- orion-paragraph-margins:v1 ${left} ${right} -->` : "";
}

/** Recognize only a document prefix, outside frontmatter and literal code. */
export function splitDocumentMargins(markdown: string): { body: string; margins: NoteMargins } {
  const { prefix, content } = splitFrontmatter(markdown);
  const line = content.match(/^([^\r\n]*)(?:\r?\n|$)/);
  const margins = line ? parseMarker(line[1], "document") : null;
  if (!margins || !line) return { body: markdown, margins: { left: 0, right: 0 } };
  const body = content.slice(line[0].length).replace(/^\r?\n/, "");
  return { body: `${prefix}${body}`, margins };
}

export function withDocumentMargins(markdown: string, margins: NoteMargins): string {
  const left = normalizeNoteMargin(margins.left);
  const right = normalizeNoteMargin(margins.right);
  if (!left && !right) return markdown;
  const { prefix, content } = splitFrontmatter(markdown);
  return `${prefix}<!-- orion-document-margins:v1 ${left} ${right} -->${content ? `\n\n${content}` : ""}`;
}

export function noteMarginsStyle(margins: NoteMargins): { marginLeft: string; marginRight: string } {
  return { marginLeft: `${normalizeNoteMargin(margins.left)}%`, marginRight: `${normalizeNoteMargin(margins.right)}%` };
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
  spread?: boolean;
}

/** Preserve paragraph structure and positions; strip only the finite formatting suffix. */
export function remarkNoteMargins() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode, container?: MarkdownNode) => {
      if (!parent.children) return;
      if (["paragraph", "heading"].includes(parent.type)) {
        let margins: NoteMargins | null = null;
        let justify = false;
        while (parent.children.length) {
          const last = parent.children[parent.children.length - 1];
          if (last.type !== "html") break;
          const parsed = parseParagraphMarginsMarker(last.value ?? "");
          if (!parsed && last.value !== JUSTIFY_MARKER) break;
          // The last occurrence wins; a duplicate cannot override it from earlier prose.
          if (parsed && !margins) margins = parsed;
          if (last.value === JUSTIFY_MARKER) justify = true;
          parent.children.pop();
          const previous = parent.children[parent.children.length - 1];
          if (previous?.type === "text" && previous.value?.endsWith(" ")) {
            previous.value = previous.value.slice(0, -1);
            if (!previous.value) parent.children.pop();
          }
        }
        if (margins || justify) parent.data = { ...parent.data, hProperties: {
          ...parent.data?.hProperties,
          ...(margins ? { "data-orion-margin-left": String(margins.left), "data-orion-margin-right": String(margins.right) } : {}),
          ...(justify ? { "data-orion-justify": "true" } : {}),
        } };
        // Tight-list serialization drops the paragraph element, including its formatting.
        if (margins && container?.type === "listItem") container.spread = true;
      }
      parent.children.forEach((child) => visit(child, parent));
    };
    visit(tree);
  };
}
