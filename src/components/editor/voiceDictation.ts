import type { Editor, JSONContent } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";

export interface VoiceDictationBlock {
  kind: "paragraph" | "bullet" | "todo";
  text: string;
}

/** Dictation is one undoable insertion, separate from typing on either side. */
function insertDictationContent(editor: Editor, position: number, content: JSONContent | JSONContent[]): boolean {
  const inserted = editor.chain()
    .focus()
    .command(({ tr }) => { closeHistory(tr); return true; })
    .insertContentAt(position, content, {
      errorOnInvalidContent: true,
      applyInputRules: false,
      applyPasteRules: false,
    })
    .run();
  if (inserted) editor.view.dispatch(closeHistory(editor.state.tr));
  return inserted;
}

export function insertVoiceTranscriptAt(
  editor: Editor,
  position: number,
  transcript: string,
): boolean {
  const normalized = transcript.trim().replace(/\s+/g, " ");
  if (!normalized || editor.isDestroyed || !Number.isFinite(position)) return false;

  const insertionPosition = Math.min(
    Math.max(0, Math.trunc(position)),
    editor.state.doc.content.size,
  );
  const before = editor.state.doc.textBetween(
    Math.max(0, insertionPosition - 1),
    insertionPosition,
  );
  const after = editor.state.doc.textBetween(
    insertionPosition,
    Math.min(editor.state.doc.content.size, insertionPosition + 1),
  );
  const leadingSpace = Boolean(
    before &&
      !/[\s([{\u201c\u2018"']/.test(before) &&
      !/^[,.;:!?\u2026)\]}]/.test(normalized),
  );
  const trailingSpace = Boolean(
    after &&
      !/[\s.,!?;:)\]}'\u201d\u2019]/.test(after) &&
      !/[([{\u201c\u2018"']$/.test(normalized),
  );

  return insertDictationContent(editor, insertionPosition, {
    type: "text",
    text: `${leadingSpace ? " " : ""}${normalized}${trailingSpace ? " " : ""}`,
  });
}

/** Provider output has no markup authority: only literal text and these blocks. */
export function insertCleanedVoiceTranscriptAt(
  editor: Editor,
  position: number,
  blocks: readonly VoiceDictationBlock[],
): boolean {
  if (editor.isDestroyed || blocks.length === 0 || !Number.isFinite(position) ||
      blocks.some(block => !["paragraph", "bullet", "todo"].includes(block.kind) || !block.text.trim())) return false;
  if (blocks.length === 1 && blocks[0].kind === "paragraph") {
    return insertVoiceTranscriptAt(editor, position, blocks[0].text);
  }

  const content: JSONContent[] = [];
  for (const block of blocks) {
    const paragraph: JSONContent = {
      type: "paragraph",
      content: [{ type: "text", text: block.text.trim() }],
    };
    if (block.kind === "paragraph") {
      content.push(paragraph);
      continue;
    }
    const listType = block.kind === "todo" ? "taskList" : "bulletList";
    const item: JSONContent = {
      type: block.kind === "todo" ? "taskItem" : "listItem",
      ...(block.kind === "todo" ? { attrs: { checked: false } } : {}),
      content: [paragraph],
    };
    const previous = content[content.length - 1];
    if (previous?.type === listType) previous.content!.push(item);
    else content.push({ type: listType, content: [item] });
  }
  // Validate the complete insertion before dispatching; an unavailable list
  // extension must leave the existing note and selection intact.
  try {
    for (const node of content) editor.schema.nodeFromJSON(node).check();
  } catch {
    return false;
  }
  return insertDictationContent(editor, Math.min(Math.max(0, Math.trunc(position)), editor.state.doc.content.size), content);
}
