import type { Editor } from "@tiptap/core";

export const MAX_INLINE_LINK_TITLE_CHARS = 120;

export type ConceptLinkSelectionMode = "none" | "inline" | "context";

export interface ConceptLinkSelection {
  from: number;
  to: number;
  selectedText: string;
  mode: ConceptLinkSelectionMode;
  contextInsertionPosition: number;
}

export function isConceptLinkDocumentCurrent(
  editor: Editor,
  documentMarkdown: string,
): boolean {
  return editor.getMarkdown() === documentMarkdown;
}

export function captureConceptLinkSelection(
  editor: Editor,
): ConceptLinkSelection {
  const { from, to } = editor.state.selection;
  const selectedText =
    from === to
      ? ""
      : editor.state.doc.textBetween(from, to, "\n", "\n").trim();
  const $from = editor.state.doc.resolve(from);

  return {
    from,
    to,
    selectedText,
    mode:
      from === to
        ? "none"
        : canApplyInlineLink(editor, from, to, selectedText)
          ? "inline"
          : "context",
    contextInsertionPosition: $from.depth > 0 ? $from.before(1) : from,
  };
}

export function applyConceptLinkToEditor(
  editor: Editor,
  selection: ConceptLinkSelection,
  phrase: string,
  href: string,
): boolean {
  if (
    selection.mode === "inline" &&
    normalizeTitle(phrase) === normalizeTitle(selection.selectedText)
  ) {
    return editor
      .chain()
      .focus()
      .setTextSelection({ from: selection.from, to: selection.to })
      .setLink({ href, target: null, rel: null })
      .run();
  }

  const linkMark = {
    type: "link",
    attrs: {
      href,
      target: null,
      rel: null,
      class: "editor-explicit-link",
    },
  };

  if (selection.mode !== "none") {
    return editor
      .chain()
      .focus()
      .insertContentAt(
        selection.contextInsertionPosition,
        {
          type: "paragraph",
          content: [{ type: "text", text: phrase, marks: [linkMark] }],
        },
        { updateSelection: false },
      )
      .run();
  }

  const before = editor.state.doc.textBetween(
    Math.max(0, selection.from - 1),
    selection.from,
  );
  const after = editor.state.doc.textBetween(
    selection.to,
    Math.min(editor.state.doc.content.size, selection.to + 1),
  );
  const addLeadingSpace = Boolean(before && !/[\s([{"'“‘]/.test(before));
  const addTrailingSpace = Boolean(
    after && !/[\s.,!?;:)\]}'"”’]/.test(after),
  );

  return editor
    .chain()
    .focus()
    .insertContentAt(
      { from: selection.from, to: selection.to },
      [
        ...(addLeadingSpace ? [{ type: "text", text: " " }] : []),
        { type: "text", text: phrase, marks: [linkMark] },
        ...(addTrailingSpace ? [{ type: "text", text: " " }] : []),
      ],
      { updateSelection: true },
    )
    .run();
}

function canApplyInlineLink(
  editor: Editor,
  from: number,
  to: number,
  selectedText: string,
): boolean {
  if (
    !selectedText ||
    selectedText.length > MAX_INLINE_LINK_TITLE_CHARS ||
    selectedText.includes("\n")
  ) {
    return false;
  }

  const $from = editor.state.doc.resolve(from);
  const $to = editor.state.doc.resolve(to);
  if (
    !$from.sameParent($to) ||
    !$from.parent.isTextblock ||
    $from.parent.type.spec.code
  ) {
    return false;
  }

  let safe = true;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (
      node.type.spec.code ||
      node.type.name === "codeBlock" ||
      node.marks.some((mark) => mark.type.name === "code")
    ) {
      safe = false;
      return false;
    }
    return safe;
  });
  return safe;
}

function normalizeTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
