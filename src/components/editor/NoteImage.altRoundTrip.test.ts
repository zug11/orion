import { describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { NoteImage } from "./NoteImage";
import { escapeNoteImageMarkdownText, unescapeNoteImageMarkdownText } from "../../lib/noteImageLayout";

const src = "orion-image://localhost/image_Abc-123456789";

function reopen(markdown: string): { markdown: string; alt: string } {
  const editor = new Editor({
    extensions: [StarterKit, NoteImage, Markdown],
    content: markdown,
    contentType: "markdown",
  });
  try {
    let alt = "";
    editor.state.doc.descendants((node) => {
      if (node.type.name === "image") alt = String(node.attrs.alt ?? "");
    });
    return { markdown: editor.getMarkdown(), alt };
  } finally {
    editor.destroy();
  }
}

describe("image alt text across save and reopen", () => {
  const alts = [
    "Plain description",
    'A "quoted" chart',
    "Path C:\\notes\\figure",
    "Brackets [a] and ]b[",
    'Mixed \\"edge\\" [case] \\\\',
  ];

  it.each(alts)("keeps %j identical however often the note is reopened", (alt) => {
    const first = `![${escapeNoteImageMarkdownText(alt)}](${src})`;
    let current = first;
    for (let pass = 0; pass < 4; pass += 1) {
      const result = reopen(current);
      expect(result.alt).toBe(alt);
      expect(result.markdown.trim()).toBe(first);
      current = result.markdown;
    }
  });

  it("inverts only the escapes the Markdown lexer leaves behind", () => {
    expect(unescapeNoteImageMarkdownText('A \\"quoted\\" \\\\ path')).toBe('A "quoted" \\ path');
    expect(unescapeNoteImageMarkdownText("no escapes")).toBe("no escapes");
    expect(unescapeNoteImageMarkdownText(undefined)).toBe("");
  });
});
