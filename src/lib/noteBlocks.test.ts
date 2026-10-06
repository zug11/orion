import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";
import { noteTableLayoutAtLine, remarkNoteTableMetadata } from "./noteTables";
import { MAX_NOTE_BLOCK_MARKDOWN, NOTE_BLOCK_CLOSE, NOTE_BLOCK_OPEN, remarkNoteBlocks } from "./noteBlocks";

const render = (markdown: string, frames = true) => renderToStaticMarkup(createElement(ReactMarkdown,
  { remarkPlugins: [remarkGfm, ...(frames ? [remarkNoteBlocks] : [])], children: markdown }));

describe("persistent block reading and export", () => {
  it("renders one frame around rich content and hides only its valid boundary comments", () => {
    const markdown = `Outside before\n\n${NOTE_BLOCK_OPEN}\n## Heading\n\nParagraph with **bold**.\n\n- One\n- Two\n${NOTE_BLOCK_CLOSE}\n\nOutside after`;
    const html = render(markdown);
    expect(html).toContain('<p>Outside before</p>');
    expect(html).toContain('<div class="note-block-reading" data-note-block="true">');
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>One</li>');
    expect(html).toContain('</div>\n<p>Outside after</p>');
    expect(html).not.toContain("orion-block");
  });

  it("retains table metadata and exact task source lines inside a frame", () => {
    const metadata = '<!-- orion-table:v1 {"width":71,"header":false,"banded":false,"columns":[175,230]} -->';
    const markdown = `Before\n\n${NOTE_BLOCK_OPEN}\n\n- [ ] Task\n\n${metadata}\n| | |\n| --- | --- |\n| A | B |\n\n${NOTE_BLOCK_CLOSE}`;
    const lines: number[] = [];
    const html = renderToStaticMarkup(createElement(ReactMarkdown, {
      remarkPlugins: [remarkGfm, remarkNoteBlocks, remarkNoteTableMetadata],
      children: markdown,
      components: {
        li: ({ node, children }) => {
          lines.push(node!.position!.start.line);
          return createElement("li", null, children);
        },
        table: ({ node, children }) => {
          const layout = noteTableLayoutAtLine(markdown, node!.position!.start.line);
          return createElement("table", { "data-width": layout?.width, "data-header": String(layout?.header) }, children);
        },
      },
    }));
    expect(lines).toEqual([5]);
    expect(html).toContain('data-width="71" data-header="false"');
    expect(html).not.toContain("orion-table");
    expect(html).not.toContain("orion-block");
  });

  it.each([
    `\`\`\`markdown\n${NOTE_BLOCK_OPEN}\nExample\n${NOTE_BLOCK_CLOSE}\n\`\`\``,
    `    ${NOTE_BLOCK_OPEN}\n    Example\n    ${NOTE_BLOCK_CLOSE}`,
    `\`${NOTE_BLOCK_OPEN}\` and \`${NOTE_BLOCK_CLOSE}\``,
    "<!-- orion-block:v2 -->\n\nUnknown\n\n<!-- /orion-block -->",
    `${NOTE_BLOCK_OPEN}\n\nUnclosed`,
    `${NOTE_BLOCK_OPEN} inline words\n\nUnframed\n\n${NOTE_BLOCK_CLOSE}`,
  ])("leaves code examples and malformed or unknown comments unchanged: %s", (markdown) => {
    expect(render(markdown)).toBe(render(markdown, false));
  });

  it("flattens balanced nested frames and preserves each original content node", () => {
    const inner = { type: "paragraph", children: [{ type: "text", value: "Keep me" }], position: { start: { line: 3, column: 1 }, end: { line: 3, column: 8 } } };
    const tree: Parameters<ReturnType<typeof remarkNoteBlocks>>[0] = { type: "root", children: [
      { type: "html", value: NOTE_BLOCK_OPEN }, { type: "html", value: NOTE_BLOCK_OPEN }, inner,
      { type: "html", value: NOTE_BLOCK_CLOSE }, { type: "html", value: NOTE_BLOCK_CLOSE },
    ] };
    remarkNoteBlocks()(tree);
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0].type).toBe("noteBlock");
    expect(tree.children![0].children).toEqual([inner]);
    expect(tree.children![0].children![0]).toBe(inner);
    expect(inner.position.start.line).toBe(3);
  });

  it("leaves oversized wrappers untouched and terminates on a malformed cyclic AST", () => {
    const tree = { type: "root", children: [
      { type: "html", value: NOTE_BLOCK_OPEN, position: { start: { line: 1, offset: 0 }, end: { line: 1, offset: 22 } } },
      { type: "paragraph", children: [{ type: "text", value: "Body" }] },
      { type: "html", value: NOTE_BLOCK_CLOSE, position: { start: { line: 3, offset: MAX_NOTE_BLOCK_MARKDOWN + 1 }, end: { line: 3, offset: MAX_NOTE_BLOCK_MARKDOWN + 22 } } },
    ] };
    const originals = [...tree.children];
    remarkNoteBlocks()(tree);
    expect(tree.children).toEqual(originals);
    const cyclic: { type: string; children?: typeof cyclic[] } = { type: "root" };
    cyclic.children = [cyclic];
    expect(() => remarkNoteBlocks()(cyclic)).not.toThrow();
  });
});
