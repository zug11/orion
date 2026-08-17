import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import {
  Fragment,
  Node as ProseMirrorNode,
  Slice,
} from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { AIWritingLength } from "../../lib/aiWriting";
import type { AIImageProposal } from "../../lib/aiImages";
import type { NoteImageAttachment } from "../../types";
import {
  aiWritingPreviewPluginKey,
  type AIWritingPreviewState,
} from "./AIWritingPreview";

export type AIWritingTargetMode = "inline" | "code" | "blocks" | "append";

export interface AIWritingCapture {
  from: number;
  to: number;
  previewAt: number;
  empty: boolean;
  mode: AIWritingTargetMode;
  selectedMarkdown: string;
  selectedText: string;
  beforeMarkdown: string;
  afterMarkdown: string;
  documentMarkdown: string;
  originalDoc: ProseMirrorNode;
  selectionJSON: Record<string, unknown>;
  storedMarksJSON: readonly Record<string, unknown>[];
  codeLanguage?: string;
}

export interface AIWritingParsedProposal {
  markdown: string;
  document: ProseMirrorNode;
  replacement: Slice;
  codeText?: string;
}

let nextAIWritingPreviewRevision = 1;

export function captureAIWritingSelection(
  editor: Editor,
  length: AIWritingLength,
): AIWritingCapture {
  const { doc, selection, storedMarks } = editor.state;
  const originalFrom = selection.from;
  const originalTo = selection.to;
  const target = normalizeTarget(editor, length);
  const selectedSlice = doc.slice(target.from, target.to);
  const selectedMarkdown = selection.empty
    ? ""
    : target.mode === "code"
      ? fencedCode(
          doc.textBetween(target.from, target.to, "\n"),
          target.codeLanguage,
        )
      : serializeFragment(editor, selectedSlice.content);

  return {
    from: target.from,
    to: target.to,
    previewAt: target.previewAt,
    empty: selection.empty,
    mode: target.mode,
    selectedMarkdown,
    selectedText: selection.empty
      ? ""
      : doc.textBetween(target.from, target.to, "\n\n").trim(),
    beforeMarkdown: serializeFragment(editor, doc.slice(0, target.from).content),
    afterMarkdown: serializeFragment(
      editor,
      doc.slice(target.to, doc.content.size).content,
    ),
    documentMarkdown: editor.getMarkdown(),
    originalDoc: doc,
    selectionJSON: selection.toJSON() as Record<string, unknown>,
    storedMarksJSON: (storedMarks ?? []).map((mark) =>
      mark.toJSON(),
    ) as Record<string, unknown>[],
    codeLanguage: target.codeLanguage,
  };

  function normalizeTarget(
    current: Editor,
    requestedLength: AIWritingLength,
  ): {
    from: number;
    to: number;
    previewAt: number;
    mode: AIWritingTargetMode;
    codeLanguage?: string;
  } {
    const currentSelection = current.state.selection;
    const currentDoc = current.state.doc;
    if (currentSelection.empty) {
      if (current.isEmpty) {
        return {
          from: 0,
          to: currentDoc.content.size,
          previewAt: currentDoc.content.size,
          mode: "blocks",
        };
      }
      const meaningfulCaret = originalFrom > 1;
      if (requestedLength === "sentence" && meaningfulCaret) {
        return {
          from: originalFrom,
          to: originalFrom,
          previewAt: topLevelEnd(currentDoc, originalFrom),
          mode: "inline",
        };
      }
      const insertion = meaningfulCaret
        ? topLevelEnd(currentDoc, originalFrom)
        : currentDoc.content.size;
      return {
        from: insertion,
        to: insertion,
        previewAt: insertion,
        mode: "append",
      };
    }

    const sameTextblock =
      currentSelection.$from.sameParent(currentSelection.$to) &&
      currentSelection.$from.parent.isTextblock;
    if (sameTextblock && currentSelection.$from.parent.type.name === "codeBlock") {
      return {
        from: originalFrom,
        to: originalTo,
        previewAt: topLevelEnd(currentDoc, originalTo),
        mode: "code",
        codeLanguage: String(
          currentSelection.$from.parent.attrs.language ?? "",
        ).trim(),
      };
    }
    if (sameTextblock) {
      return {
        from: originalFrom,
        to: originalTo,
        previewAt: topLevelEnd(currentDoc, originalTo),
        mode: "inline",
      };
    }

    const from = topLevelStart(currentDoc, originalFrom);
    const to = topLevelEnd(currentDoc, originalTo);
    return { from, to, previewAt: to, mode: "blocks" };
  }
}

export function isAIWritingCaptureCurrent(
  editor: Editor,
  capture: AIWritingCapture,
): boolean {
  return editor.state.doc.eq(capture.originalDoc);
}

export function parseAIWritingProposal(
  editor: Editor,
  capture: AIWritingCapture,
  markdown: string,
): AIWritingParsedProposal {
  if (/^---\s*\n[^]*?\n---(?:\s*\n|$)/u.test(markdown)) {
    throw new Error("AI writing cannot replace note frontmatter.");
  }
  const manager = editor.markdown;
  if (!manager) {
    throw new Error("The Markdown editor is not ready for AI writing.");
  }

  if (capture.mode === "code") {
    const codeText = unwrapCode(markdown);
    const previewMarkdown = fencedCode(codeText, capture.codeLanguage);
    const document = ProseMirrorNode.fromJSON(
      editor.schema,
      manager.parse(previewMarkdown),
    );
    document.check();
    return {
      markdown: previewMarkdown,
      document,
      replacement: Slice.empty,
      codeText,
    };
  }

  const document = ProseMirrorNode.fromJSON(
    editor.schema,
    manager.parse(markdown),
  );
  document.check();
  if (document.childCount === 0 || document.content.size === 0) {
    throw new Error("Orion returned an empty writing suggestion.");
  }
  if (capture.mode === "inline") {
    const onlyChild = document.childCount === 1 ? document.firstChild : null;
    if (!onlyChild || onlyChild.type.name !== "paragraph") {
      throw new Error(
        "Orion returned block formatting for an inline selection. Try again or select the whole paragraph.",
      );
    }
    return {
      markdown,
      document,
      replacement: new Slice(onlyChild.content, 0, 0),
    };
  }
  return {
    markdown,
    document,
    replacement: new Slice(document.content, 0, 0),
  };
}

export function showAIWritingPreview(
  editor: Editor,
  capture: AIWritingCapture,
  proposal: AIWritingParsedProposal,
  options?: { label?: string; ariaLabel?: string },
): boolean {
  if (!isAIWritingCaptureCurrent(editor, capture)) return false;
  const preview: AIWritingPreviewState = {
    from: capture.from,
    to: capture.to,
    previewAt: capture.previewAt,
    proposal: proposal.document,
    revision: nextAIWritingPreviewRevision++,
    ...options,
  };
  editor.view.dispatch(
    editor.state.tr
      .setMeta("addToHistory", false)
      .setMeta(aiWritingPreviewPluginKey, preview),
  );
  return true;
}

export function parseAIImagePreview(
  editor: Editor,
  proposal: AIImageProposal,
): AIWritingParsedProposal {
  const imageType = editor.schema.nodes.image;
  if (!imageType) {
    throw new Error("The editor cannot display generated images.");
  }
  const image = imageType.create({
    src: `data:${proposal.mimeType};base64,${proposal.base64Data}`,
    alt: proposal.alt,
    title: proposal.fileName,
  });
  const document = editor.schema.topNodeType.create(null, image);
  document.check();
  return {
    markdown: `![${escapeImageAlt(proposal.alt)}](generated-image-preview)`,
    document,
    replacement: new Slice(document.content, 0, 0),
  };
}

export function acceptAIImagePreview(
  editor: Editor,
  capture: AIWritingCapture,
  attachment: NoteImageAttachment,
  alt: string,
): { from: number; to: number } | null {
  if (!isAIWritingCaptureCurrent(editor, capture)) return null;
  const imageType = editor.schema.nodes.image;
  if (!imageType) return null;
  const image = imageType.create({
    src: attachment.src,
    alt,
    title: attachment.fileName,
  });
  const position = Math.min(capture.previewAt, editor.state.doc.content.size);
  let transaction = closeHistory(editor.state.tr)
    .setMeta(aiWritingPreviewPluginKey, null)
    .insert(position, image);
  if (!transaction.docChanged) return null;
  const from = transaction.mapping.map(position, -1);
  const end = transaction.mapping.map(position, 1);
  transaction = transaction
    .setMeta("orionAIImageAccept", true)
    .setSelection(selectionNear(transaction.doc, Math.min(end, transaction.doc.content.size)))
    .scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeHistory(editor.state.tr));
  return { from, to: Math.min(end, editor.state.doc.content.size) };
}

export function clearAIWritingPreview(
  editor: Editor,
  capture: AIWritingCapture,
  restoreSelection: boolean,
): void {
  let transaction = editor.state.tr
    .setMeta("addToHistory", false)
    .setMeta(aiWritingPreviewPluginKey, null);
  if (restoreSelection && editor.state.doc.eq(capture.originalDoc)) {
    transaction = transaction.setSelection(
      selectionFromCapture(transaction.doc, capture),
    );
    if (capture.storedMarksJSON.length > 0) {
      transaction = transaction.setStoredMarks(
        capture.storedMarksJSON.map((mark) =>
          editor.schema.markFromJSON(mark),
        ),
      );
    }
  }
  editor.view.dispatch(transaction);
}

export function acceptAIWritingPreview(
  editor: Editor,
  capture: AIWritingCapture,
  proposal: AIWritingParsedProposal,
): { from: number; to: number } | null {
  if (!isAIWritingCaptureCurrent(editor, capture)) return null;

  let transaction = closeHistory(editor.state.tr).setMeta(
    aiWritingPreviewPluginKey,
    null,
  );
  if (capture.mode === "code") {
    transaction = transaction.insertText(
      proposal.codeText ?? "",
      capture.from,
      capture.to,
    );
  } else if (capture.mode === "append") {
    transaction = transaction.insert(capture.from, proposal.replacement.content);
  } else if (capture.mode === "inline") {
    transaction = transaction.replace(
      capture.from,
      capture.to,
      inlineReplacementWithSafeSpacing(
        editor,
        capture,
        proposal.replacement,
      ),
    );
  } else {
    transaction = transaction.replace(
      capture.from,
      capture.to,
      proposal.replacement,
    );
  }
  const from = transaction.mapping.map(capture.from, -1);
  const to = transaction.mapping.map(capture.to, 1);
  if (!transaction.docChanged || from > to) return null;
  transaction = transaction
    .setMeta("orionAIWritingAccept", true)
    .setSelection(selectionNear(transaction.doc, to))
    .scrollIntoView();
  editor.view.dispatch(transaction);
  editor.view.dispatch(closeHistory(editor.state.tr));
  return { from, to };
}

function inlineReplacementWithSafeSpacing(
  editor: Editor,
  capture: AIWritingCapture,
  replacement: Slice,
): Slice {
  const { doc } = editor.state;
  const before = doc.textBetween(
    Math.max(0, capture.from - 1),
    capture.from,
  );
  const after = doc.textBetween(
    capture.to,
    Math.min(doc.content.size, capture.to + 1),
  );
  const proposalText = replacement.content.textBetween(
    0,
    replacement.content.size,
  );
  const addLeadingSpace = Boolean(
    before &&
      !/[\s([{"'“‘]/u.test(before) &&
      proposalText &&
      !/^[\s.,!?;:)\]}"'”’]/u.test(proposalText),
  );
  const addTrailingSpace = Boolean(
    after &&
      !/[\s.,!?;:)\]}"'”’]/u.test(after) &&
      proposalText &&
      !/[\s([{"'“‘]$/u.test(proposalText),
  );
  let content = replacement.content;
  if (addLeadingSpace) {
    content = Fragment.from(editor.schema.text(" ")).append(content);
  }
  if (addTrailingSpace) {
    content = content.append(Fragment.from(editor.schema.text(" ")));
  }
  return new Slice(content, replacement.openStart, replacement.openEnd);
}

function serializeFragment(editor: Editor, content: Fragment): string {
  if (content.size === 0) return "";
  const manager = editor.markdown;
  if (!manager) return content.textBetween(0, content.size, "\n\n");
  return manager
    .serialize({
      type: "doc",
      content: content.toJSON() as JSONContent[],
    })
    .trim();
}

function topLevelStart(doc: ProseMirrorNode, position: number): number {
  const resolved = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  if (resolved.depth === 0) return resolved.pos;
  return resolved.before(1);
}

function topLevelEnd(doc: ProseMirrorNode, position: number): number {
  const resolved = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  if (resolved.depth === 0) return resolved.pos;
  const before = resolved.before(1);
  return resolved.pos === before ? resolved.pos : resolved.after(1);
}

function fencedCode(value: string, language = ""): string {
  const fence = value.includes("```") ? "~~~~" : "```";
  return `${fence}${language}\n${value.replace(/\n$/u, "")}\n${fence}`;
}

function unwrapCode(value: string): string {
  const match = value.match(
    /^\s*(`{3,}|~{3,})[^\n]*\n([^]*?)\n\1\s*$/u,
  );
  return (match?.[2] ?? value).replace(/^\n|\n$/g, "");
}

function selectionFromCapture(
  doc: ProseMirrorNode,
  capture: AIWritingCapture,
): Selection {
  try {
    return Selection.fromJSON(doc, capture.selectionJSON);
  } catch {
    return selectionNear(doc, Math.min(capture.from, doc.content.size));
  }
}

function selectionNear(doc: ProseMirrorNode, position: number): Selection {
  const resolved = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  return TextSelection.near(resolved, -1);
}

function escapeImageAlt(value: string): string {
  return value.replace(/[\\\[\]]/g, "\\$&");
}
