export const NOTE_BLOCK_OPEN = "<!-- orion-block:v1 -->";
export const NOTE_BLOCK_CLOSE = "<!-- /orion-block -->";
export const MAX_NOTE_BLOCK_MARKDOWN = 4_000_000;

interface BlockMarkdownNode {
  type: string;
  value?: string;
  children?: BlockMarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?: {
    start: { line: number; column?: number; offset?: number };
    end: { line: number; column?: number; offset?: number };
  };
}

function delimiter(node: BlockMarkdownNode): "open" | "close" | undefined {
  if (node.type !== "html" || typeof node.value !== "string"
    || node.position?.start.column !== undefined && node.position.start.column !== 1) return;
  const value = node.value.replace(/\r?\n$/, "");
  return value === NOTE_BLOCK_OPEN ? "open" : value === NOTE_BLOCK_CLOSE ? "close" : undefined;
}

/**
 * Retain explicit frames in reading/export without rewriting the Markdown.
 * Children retain their exact AST nodes and source positions for task toggles,
 * citations and table-layout lookup. Code examples are never HTML delimiters.
 */
export function remarkNoteBlocks() {
  return (tree: BlockMarkdownNode) => {
    const pending = [tree];
    const seen = new WeakSet<BlockMarkdownNode>();
    while (pending.length) {
      const parent = pending.pop()!;
      if (seen.has(parent)) continue;
      seen.add(parent);
      if (!parent.children) continue;
      const children = parent.children;
      // Inline HTML comments inside a paragraph are not a block boundary.
      if (parent.type !== "paragraph") {
        const output: BlockMarkdownNode[] = [];
        let start = -1;
        let depth = 0;
        let contents: BlockMarkdownNode[] = [];
        for (let index = 0; index < children.length; index += 1) {
          const child = children[index];
          const marker = delimiter(child);
          if (marker === "open") {
            if (!depth) { start = index; contents = []; }
            depth += 1;
          } else if (marker === "close" && depth) {
            depth -= 1;
            if (!depth) {
              const opening = children[start];
              const from = opening.position?.start.offset;
              const to = child.position?.end.offset;
              if (from !== undefined && to !== undefined && to - from > MAX_NOTE_BLOCK_MARKDOWN) {
                for (let original = start; original <= index; original += 1) output.push(children[original]);
              } else output.push({
                type: "noteBlock", children: contents,
                data: { hName: "div", hProperties: { className: ["note-block-reading"], "data-note-block": "true" } },
                ...(opening.position && child.position
                  ? { position: { start: opening.position.start, end: child.position.end } } : {}),
              });
              contents = [];
            }
          } else if (depth) contents.push(child);
          else output.push(child);
        }
        // An unclosed frame is ordinary input; preserve every original node.
        if (depth) for (let original = start; original < children.length; original += 1) output.push(children[original]);
        parent.children = output;
      }
      for (const child of parent.children) if (child.children) pending.push(child);
    }
  };
}
