/** Inert paragraph formatting in portable Markdown; only this marker is valid. */
export const JUSTIFY_MARKER = "<!-- orion-text:v1 justify -->";

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { line: number }; end: { line: number } };
}

/** Preserve source positions and code examples; never interpret arbitrary CSS. */
export function remarkNoteTextAlignment() {
  return (tree: MarkdownNode) => {
    const visit = (parent: MarkdownNode) => {
      if (!parent.children) return;
      const last = parent.children[parent.children.length - 1];
      if (["paragraph", "heading"].includes(parent.type) && last?.type === "html" && last.value === JUSTIFY_MARKER) {
        parent.children.pop();
        const preceding = parent.children[parent.children.length - 1];
        if (preceding?.type === "text" && preceding.value?.endsWith(" ")) preceding.value = preceding.value.slice(0, -1);
        parent.data = { ...parent.data, hProperties: { ...parent.data?.hProperties, "data-orion-justify": "true" } };
      }
      parent.children.forEach(visit);
    };
    visit(tree);
  };
}
