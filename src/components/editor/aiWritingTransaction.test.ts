// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AIWritingPreview } from "./AIWritingPreview";
import {
  acceptAIImagePreview,
  acceptAIWritingPreview,
  captureAIWritingSelection,
  clearAIWritingPreview,
  parseAIImagePreview,
  parseAIWritingProposal,
  showAIWritingPreview,
} from "./aiWritingTransaction";

const fixtures: { editor: Editor; element: HTMLDivElement }[] = [];

function createEditor(markdown: string, onUpdate = vi.fn()) {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      TableKit.configure({
        table: { resizable: false, renderWrapper: true },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ markedOptions: { gfm: true } }),
      Image,
      AIWritingPreview,
    ],
    content: markdown,
    contentType: "markdown",
    onUpdate,
  });
  fixtures.push({ editor, element });
  return editor;
}

afterEach(() => {
  for (const { editor, element } of fixtures.splice(0)) {
    editor.destroy();
    element.remove();
  }
});

describe("AI writing editor transactions", () => {
  it("previews outside the document, discards exactly, and preserves history", () => {
    const onUpdate = vi.fn();
    const editor = createEditor("Alpha **beta** gamma.", onUpdate);
    editor.commands.setTextSelection({ from: 7, to: 11 });
    const beforeJSON = editor.getJSON();
    const beforeMarkdown = editor.getMarkdown();
    const beforeSelection = editor.state.selection.toJSON();
    const capture = captureAIWritingSelection(editor, "paragraph");
    const proposal = parseAIWritingProposal(editor, capture, "stronger");

    expect(showAIWritingPreview(editor, capture, proposal)).toBe(true);
    expect(editor.getJSON()).toEqual(beforeJSON);
    expect(editor.getMarkdown()).toBe(beforeMarkdown);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(
      fixtures
        .find((fixture) => fixture.editor === editor)
        ?.element.querySelector('[data-ai-writing-preview="true"]'),
    ).toHaveTextContent("stronger");

    clearAIWritingPreview(editor, capture, true);
    expect(editor.getJSON()).toEqual(beforeJSON);
    expect(editor.state.selection.toJSON()).toEqual(beforeSelection);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("accepts once and one ordinary Undo restores the exact original", () => {
    const onUpdate = vi.fn();
    const editor = createEditor("Alpha beta gamma.", onUpdate);
    editor.commands.setTextSelection({ from: 7, to: 11 });
    const original = editor.getJSON();
    const capture = captureAIWritingSelection(editor, "paragraph");
    const proposal = parseAIWritingProposal(editor, capture, "clearer");
    showAIWritingPreview(editor, capture, proposal);

    expect(acceptAIWritingPreview(editor, capture, proposal)).not.toBeNull();
    expect(editor.getMarkdown()).toBe("Alpha clearer gamma.");
    expect(onUpdate).toHaveBeenCalledOnce();

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
  });

  it("previews a generated image transiently and inserts it after unchanged prose as one undoable edit", () => {
    const onUpdate = vi.fn();
    const editor = createEditor("Alpha illustrated passage omega.", onUpdate);
    editor.commands.setTextSelection({ from: 7, to: 26 });
    const original = editor.getJSON();
    const originalMarkdown = editor.getMarkdown();
    const capture = captureAIWritingSelection(editor, "paragraph");
    const proposal = parseAIImagePreview(editor, {
      fileName: "orion-generated-image.jpg",
      mimeType: "image/jpeg",
      byteSize: 4,
      base64Data: "/9j/2Q==",
      alt: "Generated illustration of an evolving system",
    });

    expect(
      showAIWritingPreview(editor, capture, proposal, {
        label: "Proposed image",
        ariaLabel: "Generated image preview",
      }),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe(originalMarkdown);
    expect(onUpdate).not.toHaveBeenCalled();
    const preview = fixtures
      .find((fixture) => fixture.editor === editor)
      ?.element.querySelector<HTMLElement>(
        '[data-ai-writing-preview="true"]',
      );
    expect(preview).toHaveAttribute("aria-label", "Generated image preview");
    expect(preview?.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/jpeg;base64,/9j/2Q==",
    );

    expect(
      acceptAIImagePreview(
        editor,
        capture,
        {
          id: "image_123456789012345678",
          fileName: "orion-generated-image.jpg",
          mimeType: "image/jpeg",
          byteSize: 4,
          src: "orion-image://localhost/image_123456789012345678",
        },
        "Generated illustration of an evolving system",
      ),
    ).not.toBeNull();
    expect(editor.getMarkdown()).toContain(originalMarkdown);
    expect(editor.getMarkdown()).toContain(
      "orion-image://localhost/image_123456789012345678",
    );
    expect(onUpdate).toHaveBeenCalledOnce();

    editor.commands.undo();
    expect(editor.getJSON()).toEqual(original);
  });

  it("continues at a meaningful caret and appends when the default caret is not meaningful", () => {
    const atCaret = createEditor("First thought. Last thought.");
    atCaret.commands.setTextSelection(15);
    const caretCapture = captureAIWritingSelection(atCaret, "paragraph");
    const caretProposal = parseAIWritingProposal(
      atCaret,
      caretCapture,
      "A connecting paragraph.",
    );
    acceptAIWritingPreview(atCaret, caretCapture, caretProposal);
    expect(atCaret.getMarkdown()).toContain(
      "First thought. Last thought.\n\nA connecting paragraph.",
    );

    const atStart = createEditor("Existing paragraph.");
    atStart.commands.setTextSelection(1);
    const appendCapture = captureAIWritingSelection(atStart, "paragraph");
    const appendProposal = parseAIWritingProposal(
      atStart,
      appendCapture,
      "New ending.",
    );
    acceptAIWritingPreview(atStart, appendCapture, appendProposal);
    expect(atStart.getMarkdown()).toBe("Existing paragraph.\n\nNew ending.");
  });

  it("adds natural spacing for an inline sentence continuation", () => {
    const betweenSentences = createEditor("Alpha. Beta.");
    betweenSentences.commands.setTextSelection(7);
    const middleCapture = captureAIWritingSelection(
      betweenSentences,
      "sentence",
    );
    const middleProposal = parseAIWritingProposal(
      betweenSentences,
      middleCapture,
      "Inserted sentence.",
    );
    acceptAIWritingPreview(betweenSentences, middleCapture, middleProposal);
    expect(betweenSentences.getMarkdown()).toBe(
      "Alpha. Inserted sentence. Beta.",
    );

    const paragraphEnd = createEditor("Alpha.");
    paragraphEnd.commands.setTextSelection(paragraphEnd.state.doc.content.size - 1);
    const endCapture = captureAIWritingSelection(paragraphEnd, "sentence");
    const endProposal = parseAIWritingProposal(
      paragraphEnd,
      endCapture,
      "Inserted sentence.",
    );
    acceptAIWritingPreview(paragraphEnd, endCapture, endProposal);
    expect(paragraphEnd.getMarkdown()).toBe("Alpha. Inserted sentence.");
  });

  it("replaces the empty editor placeholder instead of leaving a blank paragraph", () => {
    const editor = createEditor("");
    const capture = captureAIWritingSelection(editor, "paragraph");
    const proposal = parseAIWritingProposal(editor, capture, "A clean beginning.");

    expect(capture.mode).toBe("blocks");
    acceptAIWritingPreview(editor, capture, proposal);
    expect(editor.getMarkdown()).toBe("A clean beginning.");
  });

  it("redraws a retry proposal even when the replacement has the same size", () => {
    const editor = createEditor("Alpha beta gamma.");
    editor.commands.setTextSelection({ from: 7, to: 11 });
    const capture = captureAIWritingSelection(editor, "paragraph");
    const first = parseAIWritingProposal(editor, capture, "clear");
    const second = parseAIWritingProposal(editor, capture, "crisp");

    showAIWritingPreview(editor, capture, first);
    showAIWritingPreview(editor, capture, second);

    const preview = fixtures
      .find((fixture) => fixture.editor === editor)
      ?.element.querySelector('[data-ai-writing-preview="true"]');
    expect(preview).toHaveTextContent("crisp");
    expect(preview).not.toHaveTextContent("clear");
  });

  it("keeps a partial fenced-code rewrite literal and preserves the code block", () => {
    const editor = createEditor("```ts\nconst old = 1;\n```");
    editor.commands.setTextSelection({ from: 1, to: 15 });
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.mode).toBe("code");
    const proposal = parseAIWritingProposal(
      editor,
      capture,
      "```ts\nconst fresh = 2;\n```",
    );

    acceptAIWritingPreview(editor, capture, proposal);
    expect(editor.getMarkdown()).toContain("```ts\nconst fresh = 2;");
  });

  it("rejects block output for an inline selection", () => {
    const editor = createEditor("Alpha beta gamma.");
    editor.commands.setTextSelection({ from: 7, to: 11 });
    const capture = captureAIWritingSelection(editor, "paragraph");

    expect(() =>
      parseAIWritingProposal(editor, capture, "One paragraph.\n\nAnother."),
    ).toThrow(/block formatting/i);
  });
});
