// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { insertVoiceTranscriptAt } from "./voiceDictation";

const editors: Editor[] = [];

function createEditor(content: string) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("voice dictation insertion", () => {
  it("inserts normalized speech at the chosen text cursor", () => {
    const editor = createEditor("Alpha beta");

    expect(
      insertVoiceTranscriptAt(editor, 6, "  A spoken thought.  "),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe("Alpha A spoken thought. beta");
  });

  it("does not create an editor transaction for an empty transcript", () => {
    const editor = createEditor("Keep this.");

    expect(insertVoiceTranscriptAt(editor, 1, "   ")).toBe(false);
    expect(editor.getMarkdown()).toBe("Keep this.");
  });
});
