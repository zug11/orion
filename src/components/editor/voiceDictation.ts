import type { Editor } from "@tiptap/core";

export function insertVoiceTranscriptAt(
  editor: Editor,
  position: number,
  transcript: string,
): boolean {
  const normalized = transcript.trim().replace(/\s+/g, " ");
  if (!normalized || editor.isDestroyed) return false;

  const insertionPosition = Math.min(
    Math.max(0, position),
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

  return editor
    .chain()
    .focus()
    .setTextSelection(insertionPosition)
    .insertContent({
      type: "text",
      text: `${leadingSpace ? " " : ""}${normalized}${trailingSpace ? " " : ""}`,
    })
    .run();
}
