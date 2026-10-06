import { Node, mergeAttributes, type Editor, type JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { canSplit } from "@tiptap/pm/transform";
import { MAX_NOTE_BLOCK_MARKDOWN, NOTE_BLOCK_CLOSE, NOTE_BLOCK_OPEN } from "../../lib/noteBlocks";
export { MAX_NOTE_BLOCK_MARKDOWN, NOTE_BLOCK_CLOSE, NOTE_BLOCK_OPEN } from "../../lib/noteBlocks";

/** Find a complete frame without treating fenced code examples as delimiters.
 * Nested frames are flattened while scanning, before invoking the Markdown
 * lexer, so hostile nesting cannot recursively re-enter this tokenizer.
 */
function readFrame(source: string): { raw: string; body: string } | undefined {
  const opening = source.match(/^<!-- orion-block:v1 -->\r?\n/);
  if (!opening) return;
  let position = opening[0].length;
  let depth = 1;
  let fence: { character: string; length: number } | undefined;
  const body: string[] = [];
  const boundary = () => { if (body[body.length - 1]?.trim()) body.push("\n"); };
  while (position < source.length && position < MAX_NOTE_BLOCK_MARKDOWN) {
    const newline = source.indexOf("\n", position);
    const end = newline < 0 ? source.length : newline + 1;
    if (end > MAX_NOTE_BLOCK_MARKDOWN) return;
    const rawLine = source.slice(position, end);
    const line = rawLine.replace(/\r?\n$/, "");
    const fenced = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenced && fenced[1][0] === fence.character && fenced[1].length >= fence.length && !fenced[2].trim()) fence = undefined;
      body.push(rawLine);
    } else if (fenced && (fenced[1][0] === "~" || !fenced[2].includes("`"))) {
      fence = { character: fenced[1][0], length: fenced[1].length };
      body.push(rawLine);
    } else if (line === NOTE_BLOCK_OPEN) {
      depth += 1;
      // Keep the paragraph boundary without nesting another persisted frame.
      boundary();
    } else if (line === NOTE_BLOCK_CLOSE) {
      depth -= 1;
      if (!depth) return { raw: source.slice(0, end), body: body.join("").replace(/\r?\n$/, "") };
      boundary();
    } else body.push(rawLine);
    position = end;
  }
}

function flattenFrames(nodes: JSONContent[]): JSONContent[] {
  return nodes.flatMap((node) => node.type === "noteBlock"
    ? flattenFrames(node.content ?? [])
    : node.content ? [{ ...node, content: flattenFrames(node.content) }] : [node]);
}

function commitEnter(editor: Editor, transaction: Transaction): boolean {
  editor.view.dispatch(transaction.scrollIntoView());
  editor.view.dispatch(closeHistory(editor.state.tr).setMeta("addToHistory", false).setMeta("skipTrailingNode", true));
  return true;
}

/** Split only direct prose children; nested editors keep their normal Enter. */
export function enterNoteBlock(editor: Editor): boolean {
  if (editor.isDestroyed || !editor.isEditable || editor.view.composing) return false;
  const { state } = editor;
  const { selection } = state;
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return false;

  if (selection instanceof NodeSelection) {
    const frame = selection.node.type.name === "noteBlock" && selection.$from.depth === 0 ? selection.node
      : selection.node.type.name === "image" && selection.$from.depth === 1
        && selection.$from.parent.type.name === "noteBlock" && selection.$from.parent.childCount === 1
        ? selection.$from.parent : undefined;
    if (!frame) return false;
    const from = selection.$from.depth === 0 ? selection.from : selection.$from.before(1);
    const position = from + frame.nodeSize;
    const boundary = state.doc.resolve(position);
    if (!state.doc.canReplaceWith(boundary.index(), boundary.index(), frame.type)) return false;
    const next = frame.type.create(frame.attrs, paragraph.create());
    const tr = closeHistory(state.tr).insert(position, next);
    tr.setSelection(TextSelection.create(tr.doc, position + 2));
    return commitEnter(editor, tr);
  }

  if (!(selection instanceof TextSelection) || selection.$from.depth !== 2 || selection.$to.depth !== 2
    || selection.$from.node(1).type.name !== "noteBlock"
    || selection.$from.node(1) !== selection.$to.node(1)
    || !["paragraph", "heading"].includes(selection.$from.parent.type.name)
    || !["paragraph", "heading"].includes(selection.$to.parent.type.name)) return false;

  const tr = closeHistory(state.tr).deleteSelection();
  const cursor = tr.selection.$from;
  if (cursor.depth !== 2 || cursor.node(1).type.name !== "noteBlock") return false;
  const frame = cursor.node(1);
  // Heading-end Enter starts ordinary prose. Interior/start splits retain the
  // heading type; both halves retain text marks and shared paragraph attributes.
  const rightType = cursor.parentOffset === cursor.parent.content.size ? paragraph : cursor.parent.type;
  const types = [{ type: frame.type, attrs: frame.attrs }, { type: rightType, attrs: cursor.parent.attrs }];
  if (!canSplit(tr.doc, cursor.pos, 2, types)) return false;
  const step = tr.steps.length;
  tr.split(cursor.pos, 2, types);
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.slice(step).map(cursor.pos, 1)));
  const marks = state.storedMarks ?? (selection.empty ? selection.$from.marks() : selection.$from.marksAcross(selection.$to)) ?? [];
  tr.ensureMarks(marks.filter((mark) => editor.extensionManager.splittableMarks.includes(mark.type.name)));
  return commitEnter(editor, tr);
}

/** Explicit persistent framing over ordinary rich content, without another editor. */
export const NoteBlock = Node.create({
  name: "noteBlock",
  // Before StarterKit's Enter keymap, below Paragraph's schema priority.
  priority: 200,
  group: "block",
  content: "block+",
  defining: true,
  draggable: false,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey("orionNoteBlockEnter"),
      props: {
        // Returning true here bypasses all editor keymaps without cancelling the
        // browser's IME confirmation (handleKeyDown would preventDefault).
        handleDOMEvents: { keydown: (_view, event) => event.key === "Enter" && (event.isComposing || event.keyCode === 229) },
        handleKeyDown: (_view, event) => {
          if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
            || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return false;
          // Slash choices are handled by the editor's existing capture listener
          // before ProseMirror receives this bubbling key event.
          return enterNoteBlock(this.editor);
        },
      },
    })];
  },
  parseHTML() { return [{ tag: "div[data-note-block]" }]; },
  renderHTML({ HTMLAttributes }) {
    // No flow-root, overflow or containment: image floats keep native prose flow.
    return ["div", mergeAttributes(HTMLAttributes, { "data-note-block": "true", class: "note-block-node" }), 0];
  },
  markdownTokenizer: {
    name: "noteBlock",
    level: "block",
    start(source) {
      const match = /(?:^|\n)<!-- orion-block:v1 -->(?:\r?\n|$)/.exec(source);
      return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : -1;
    },
    tokenize(source, _tokens, helpers) {
      const frame = readFrame(source);
      if (!frame) return;
      return { type: "noteBlock", raw: frame.raw, tokens: helpers.blockTokens(frame.body) };
    },
  },
  parseMarkdown(token, helpers) {
    const children = flattenFrames((helpers.parseBlockChildren ?? helpers.parseChildren)(token.tokens ?? []));
    return { type: "noteBlock", content: children.length ? children : [{ type: "paragraph" }] };
  },
  renderMarkdown(node, helpers) {
    const body = helpers.renderChildren(flattenFrames(node.content ?? []), "\n\n");
    return `${NOTE_BLOCK_OPEN}\n${body}\n${NOTE_BLOCK_CLOSE}`;
  },
});
