import { commands, Extension, type Editor, type JSONContent } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { AllSelection, Plugin, TextSelection } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { normalizeNoteMargin, splitDocumentMargins, withDocumentMargins } from "../../lib/noteMargins";

export type MarginScope = "document" | "paragraphs";
export interface MarginTarget {
  scope: MarginScope;
  from: number;
  to: number;
  available: boolean;
  /** The current document for this captured target, advanced by the extension. */
  document: ProseMirrorNode;
  adjusted?: boolean;
  all?: boolean;
}
export interface NoteMarginsSnapshot {
  scope: MarginScope;
  left: number | null;
  right: number | null;
  count: number;
  available: boolean;
}

const targets = new WeakMap<Editor, MarginTarget>();
const MARGIN_CHANGE = "orionNoteMarginChange";

function selectedParagraphs(doc: ProseMirrorNode, from: number, to: number) {
  const paragraphs: { position: number; node: ProseMirrorNode }[] = [];
  doc.nodesBetween(from, to, (node, position) => {
    if (node.type.name === "table" || node.type.name === "codeBlock") return false;
    if (!["paragraph", "heading"].includes(node.type.name)) return;
    // A selection ending at the beginning of a paragraph has not selected it.
    if (to <= position + 1 || (node.content.size > 0 && from >= position + node.nodeSize - 1)) return false;
    const path = doc.resolve(position);
    for (let depth = path.depth; depth > 0; depth--) if (path.node(depth).type.name === "table") return false;
    paragraphs.push({ position, node });
    return false;
  });
  return paragraphs;
}

function currentTarget(editor: Editor, target: MarginTarget): boolean {
  return !editor.isDestroyed && editor.isEditable && target.available && target.document === editor.state.doc;
}

/** Capture at the start of an adjustment, before its controls take keyboard focus. */
export function captureMarginTarget(editor: Editor): MarginTarget {
  const { selection, doc } = editor.state;
  const text = selection instanceof TextSelection || selection instanceof AllSelection;
  const target: MarginTarget = {
    scope: text && selection.empty ? "document" : "paragraphs",
    from: selection.from,
    to: selection.to,
    available: text && editor.isEditable && !editor.isDestroyed,
    document: doc,
    all: selection instanceof AllSelection,
  };
  if (target.scope === "paragraphs" && !selectedParagraphs(doc, target.from, target.to).length) target.available = false;
  targets.set(editor, target);
  return target;
}

/** Reattach a captured target when a control mounts or React replays its effects. */
export function activateMarginTarget(editor: Editor, target: MarginTarget): boolean {
  if (!currentTarget(editor, target)) return false;
  targets.set(editor, target);
  return true;
}

export function getNoteMargins(editor: Editor, target?: MarginTarget): NoteMarginsSnapshot {
  const selected = target ?? (() => {
    const { selection, doc } = editor.state;
    return { scope: selection instanceof TextSelection && selection.empty ? "document" : "paragraphs",
      from: selection.from, to: selection.to, available: selection instanceof TextSelection || selection instanceof AllSelection, document: doc } as MarginTarget;
  })();
  const snapshot: NoteMarginsSnapshot = { scope: selected.scope, left: 0, right: 0, count: 0, available: currentTarget(editor, selected) };
  if (!snapshot.available) return snapshot;
  const attrs = selected.scope === "document" ? [editor.state.doc.attrs] : selectedParagraphs(editor.state.doc, selected.from, selected.to).map(({ node }) => node.attrs);
  snapshot.count = selected.scope === "paragraphs" ? attrs.length : 0;
  snapshot.available = attrs.length > 0;
  for (const side of ["left", "right"] as const) {
    const key = side === "left" ? "marginLeft" : "marginRight";
    const values = attrs.map((value) => normalizeNoteMargin(value[key]));
    snapshot[side] = values.every((value) => value === values[0]) ? values[0] ?? 0 : null;
  }
  return snapshot;
}

/** The first selected ordinary paragraph anchors a ruler for a mixed selection. */
export function marginReferenceParagraph(editor: Editor, target?: MarginTarget): { position: number; node: ProseMirrorNode } | null {
  const selection = editor.state.selection;
  if (target && (!currentTarget(editor, target) || target.scope !== "paragraphs")) return null;
  if (!target && (!(selection instanceof TextSelection || selection instanceof AllSelection) || selection.empty)) return null;
  return selectedParagraphs(editor.state.doc, target?.from ?? selection.from, target?.to ?? selection.to)[0] ?? null;
}

/** Attribute-only changes retain ordinary paragraphs, list items, and undo history. */
export function applyNoteMargins(editor: Editor, target: MarginTarget, patch: Partial<{ left: number; right: number }>): boolean {
  if (!currentTarget(editor, target)) return false;
  const attrs: Record<string, number> = {};
  for (const side of ["left", "right"] as const) {
    if (patch[side] === undefined) continue;
    if (!Number.isFinite(patch[side])) return false;
    attrs[side === "left" ? "marginLeft" : "marginRight"] = normalizeNoteMargin(patch[side]);
  }
  if (!Object.keys(attrs).length) return false;
  const selected = target.scope === "document" ? [editor.state.doc] : selectedParagraphs(editor.state.doc, target.from, target.to).map(({ node }) => node);
  if (!selected.length) return false;
  if (!selected.some((node) => Object.entries(attrs).some(([key, value]) => node.attrs[key] !== value))) return true;
  const tr = editor.state.tr.setMeta(MARGIN_CHANGE, { scope: target.scope, from: target.from, to: target.to, attrs, document: editor.state.doc });
  if (!target.adjusted) closeHistory(tr);
  target.adjusted = true;
  editor.view.dispatch(tr);
  return true;
}

export function restoreMarginSelection(editor: Editor, target: MarginTarget): boolean {
  if (!currentTarget(editor, target)) return false;
  const selection = target.all ? new AllSelection(editor.state.doc) : TextSelection.create(editor.state.doc, target.from, target.to);
  editor.view.dispatch(closeHistory(editor.state.tr.setSelection(selection)));
  target.adjusted = false;
  editor.commands.focus();
  return true;
}

export function finishMarginAdjustment(editor: Editor, target: MarginTarget): void {
  if (!editor.isDestroyed && target.adjusted) editor.view.dispatch(closeHistory(editor.state.tr));
  target.adjusted = false;
  if (targets.get(editor) === target) targets.delete(editor);
}

export const NoteMargins = Extension.create({
  name: "noteMargins",
  addGlobalAttributes() {
    return [{ types: ["doc"], attributes: {
      marginLeft: { default: 0, rendered: false },
      marginRight: { default: 0, rendered: false },
    } }];
  },
  addProseMirrorPlugins() {
    return [new Plugin({
      // Appended formatting transactions form one undo event per open control session,
      // including root attributes whose empty StepMaps cannot group by text adjacency.
      appendTransaction(transactions, _oldState, state) {
        const request = transactions.map((tr) => tr.getMeta(MARGIN_CHANGE)).find(Boolean) as {
          scope: MarginScope; from: number; to: number; attrs: Record<string, number>; document: ProseMirrorNode;
        } | undefined;
        if (!request || request.document !== state.doc) return null;
        const tr = state.tr;
        if (request.scope === "document") {
          for (const [key, value] of Object.entries(request.attrs)) if (tr.doc.attrs[key] !== value) tr.setDocAttribute(key, value);
        } else for (const { position, node } of selectedParagraphs(state.doc, request.from, request.to)) {
          if (Object.entries(request.attrs).some(([key, value]) => node.attrs[key] !== value)) tr.setNodeMarkup(position, undefined, { ...node.attrs, ...request.attrs });
        }
        return tr.docChanged ? tr : null;
      },
      props: { attributes: (state) => ({
      "data-orion-document-margin-left": String(normalizeNoteMargin(state.doc.attrs.marginLeft)),
      "data-orion-document-margin-right": String(normalizeNoteMargin(state.doc.attrs.marginRight)),
      style: `margin-left: ${normalizeNoteMargin(state.doc.attrs.marginLeft)}%; margin-right: ${normalizeNoteMargin(state.doc.attrs.marginRight)}%;`,
    }) } })];
  },
  onTransaction({ transaction, appendedTransactions }) {
    const target = targets.get(this.editor);
    if (!target || !target.available) return;
    if (!transaction.getMeta(MARGIN_CHANGE) && [transaction, ...appendedTransactions].some((tr) => tr.docChanged)) target.adjusted = false;
    for (const tr of [transaction, ...appendedTransactions]) {
      if (target.document !== tr.before || tr.getMeta("noteMarginsSetContent")) {
        target.available = false;
        return;
      }
      const from = tr.mapping.mapResult(target.from, 1);
      const to = tr.mapping.mapResult(target.to, target.scope === "paragraphs" ? -1 : 1);
      if (target.scope === "paragraphs" && (from.deletedAcross || to.deletedAcross || from.pos >= to.pos)) target.available = false;
      target.from = from.pos;
      target.to = to.pos;
      target.document = tr.doc;
    }
  },
});

/** Keep root metadata in the Markdown manager without adding any visible nodes. */
export const NoteMarkdown = Markdown.extend({
  onBeforeCreate(event) {
    const initialContent = this.editor.options.content;
    this.parent?.(event);
    const manager = this.storage.manager;
    const parse = manager.parse.bind(manager);
    const serialize = manager.serialize.bind(manager);
    manager.parse = (markdown: string): JSONContent => {
      const { body, margins } = splitDocumentMargins(markdown);
      const document = parse(body);
      return { ...document, attrs: { ...document.attrs, marginLeft: margins.left, marginRight: margins.right } };
    };
    manager.serialize = (document: JSONContent): string => withDocumentMargins(serialize(document), {
      left: document.type === "doc" ? normalizeNoteMargin(document.attrs?.marginLeft) : 0,
      right: document.type === "doc" ? normalizeNoteMargin(document.attrs?.marginRight) : 0,
    });
    if (this.editor.options.contentType === "markdown" && typeof initialContent === "string") {
      const document = manager.parse(initialContent);
      if (!document.content?.length) document.content = [{ type: "paragraph" }];
      this.editor.options.content = document;
    }
  },
  addCommands() {
    return {
      ...this.parent?.(),
      setContent: (content, options) => (props) => {
        const parsed = options?.contentType === "markdown" && typeof content === "string"
          ? this.storage.manager.parse(content) : content;
        const document = parsed && typeof parsed === "object" && !Array.isArray(parsed) && "type" in parsed && parsed.type === "doc" ? parsed as JSONContent : null;
        const result = commands.setContent(parsed, options)(props);
        if (result && props.dispatch) {
          props.tr.setDocAttribute("marginLeft", normalizeNoteMargin(document?.attrs?.marginLeft));
          props.tr.setDocAttribute("marginRight", normalizeNoteMargin(document?.attrs?.marginRight));
          props.tr.setMeta("noteMarginsSetContent", true);
        }
        return result;
      },
    };
  },
});
