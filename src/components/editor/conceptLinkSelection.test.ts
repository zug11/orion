import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyConceptLinkToEditor,
  captureConceptLinkSelection,
  isConceptLinkDocumentCurrent,
} from "./conceptLinkSelection";

const editors: Editor[] = [];

function createEditor(markdown: string): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        link: {
          protocols: ["orion-concept"],
        },
      }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content: markdown,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("concept link selections", () => {
  it("keeps the familiar short-selection behavior inline", () => {
    const editor = createEditor("SQL powers the report.");
    editor.commands.setTextSelection({ from: 1, to: 4 });
    const selection = captureConceptLinkSelection(editor);

    expect(selection.mode).toBe("inline");
    expect(
      applyConceptLinkToEditor(
        editor,
        selection,
        "SQL",
        "orion-concept://concept-sql",
      ),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe(
      "[SQL](orion-concept://concept-sql) powers the report.",
    );
  });

  it("uses a custom title as the only link and preserves selected prose", () => {
    const original = [
      "The database records each person and their assigned role.",
      "",
      "A second paragraph explains how permissions inherit.",
    ].join("\n");
    const editor = createEditor(original);
    editor.commands.setTextSelection({
      from: 1,
      to: editor.state.doc.content.size - 1,
    });
    const selection = captureConceptLinkSelection(editor);

    expect(selection.mode).toBe("context");
    expect(
      applyConceptLinkToEditor(
        editor,
        selection,
        "Role inheritance",
        "orion-concept://concept-role-inheritance",
      ),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe(
      `[Role inheritance](orion-concept://concept-role-inheritance)\n\n${original}`,
    );
  });

  it("keeps even a short selection untouched when its page has a custom title", () => {
    const original = "SQL powers the report.";
    const editor = createEditor(original);
    editor.commands.setTextSelection({ from: 1, to: 4 });
    const selection = captureConceptLinkSelection(editor);

    expect(selection.mode).toBe("inline");
    applyConceptLinkToEditor(
      editor,
      selection,
      "Query language",
      "orion-concept://concept-query-language",
    );

    expect(editor.getMarkdown()).toBe(
      `[Query language](orion-concept://concept-query-language)\n\n${original}`,
    );
  });

  it("never applies a link mark across selected code", () => {
    const original = [
      "```ts",
      "const role = permissions.get(user);",
      "return role.canEdit;",
      "```",
    ].join("\n");
    const editor = createEditor(original);
    editor.commands.setTextSelection({
      from: 1,
      to: editor.state.doc.content.size - 1,
    });
    const selection = captureConceptLinkSelection(editor);

    expect(selection.mode).toBe("context");
    applyConceptLinkToEditor(
      editor,
      selection,
      "Permission check",
      "orion-concept://concept-permission-check",
    );

    const markdown = editor.getMarkdown();
    expect(markdown).toContain(
      "[Permission check](orion-concept://concept-permission-check)",
    );
    expect(markdown).toContain(original);
    expect(markdown.match(/orion-concept:\/\//g)).toHaveLength(1);
  });

  it("treats selected inline code as protected context", () => {
    const editor = createEditor("Run `SELECT 1` to test the connection.");
    editor.commands.setTextSelection({ from: 5, to: 13 });

    expect(captureConceptLinkSelection(editor).mode).toBe("context");
  });

  it("treats a long single paragraph as context rather than one giant link", () => {
    const paragraph = "A careful contextual passage. ".repeat(8).trim();
    const editor = createEditor(paragraph);
    editor.commands.setTextSelection({
      from: 1,
      to: editor.state.doc.content.size - 1,
    });

    expect(captureConceptLinkSelection(editor).mode).toBe("context");
  });

  it("detects an editor change while an asynchronous page title is resolving", () => {
    const editor = createEditor("A selected passage about inherited roles.");
    const capturedMarkdown = editor.getMarkdown();

    expect(isConceptLinkDocumentCurrent(editor, capturedMarkdown)).toBe(true);
    editor.commands.insertContentAt(
      editor.state.doc.content.size,
      " A later edit.",
    );

    expect(isConceptLinkDocumentCurrent(editor, capturedMarkdown)).toBe(false);
  });
});
