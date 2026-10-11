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
  captureAIWorkingContext,
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

describe("completed-task provider context from exact rich captures", () => {
  const body = "Visible introduction.\n\n- [x] PRIVATE DONE\n  - [ ] PRIVATE CHILD\n- [ ] OPEN SIBLING\n\nVisible conclusion.";
  function position(editor: Editor, phrase: string) {
    let found = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text?.includes(phrase)) { found = pos + node.text.indexOf(phrase); return false; }
      return true;
    });
    if (found < 0) throw new Error(`Missing fixture text: ${phrase}`);
    return found;
  }
  it.each(["PRIVATE DONE", "PRIVATE CHILD"])("withholds a partial selection inside %s even when its slice lacks a task marker", phrase => {
    const onUpdate = vi.fn(), editor = createEditor(body, onUpdate), from = position(editor, phrase);
    editor.commands.setTextSelection({ from: from + 2, to: from + 6 });
    const originalDoc = editor.state.doc, selection = editor.state.selection.toJSON(), before = editor.getMarkdown();
    onUpdate.mockClear();
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.selectedMarkdown).toBe(phrase.slice(2, 6));
    expect(capture.workingContext).toMatchObject({ selectionTouchesCompleted: true, caretInsideCompleted: false, selectedText: "", selectedMarkdown: "" });
    expect(JSON.stringify(capture.workingContext)).not.toContain("PRIVATE");
    expect(capture.workingContext?.documentMarkdown).toContain("OPEN SIBLING");
    expect(editor.state.doc).toBe(originalDoc); expect(editor.getMarkdown()).toBe(before);
    expect(editor.state.selection.toJSON()).toEqual(selection); expect(onUpdate).not.toHaveBeenCalled();
    // Explicit history can still review the original captured target safely.
    const proposal = parseAIWritingProposal(editor, capture, "replacement");
    expect(showAIWritingPreview(editor, capture, proposal)).toBe(true);
    expect(acceptAIWritingPreview(editor, capture, proposal)).not.toBeNull();
    editor.commands.undo(); expect(editor.state.doc.eq(originalDoc)).toBe(true);
  });
  it("keeps open sibling selection while removing completed descendants from all surrounding context", () => {
    const editor = createEditor(body), from = position(editor, "OPEN SIBLING");
    editor.commands.setTextSelection({ from, to: from + "OPEN SIBLING".length });
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.workingContext).toMatchObject({ selectionTouchesCompleted: false, caretInsideCompleted: false, selectedMarkdown: "OPEN SIBLING", selectedText: "OPEN SIBLING" });
    const context = JSON.stringify(capture.workingContext);
    expect(context).not.toContain("PRIVATE"); expect(context).toContain("Visible introduction"); expect(context).toContain("Visible conclusion");
    expect(capture.documentMarkdown).toContain("PRIVATE DONE");
  });
  it("marks a caret inside the checked subtree even when paragraph writing inserts after the task list", () => {
    const editor = createEditor(body), from = position(editor, "PRIVATE CHILD");
    editor.commands.setTextSelection(from + 4);
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.workingContext).toMatchObject({ caretInsideCompleted: true, selectionTouchesCompleted: false, selectedMarkdown: "" });
    expect(JSON.stringify(capture.workingContext)).not.toContain("PRIVATE");
    expect(capture.originalDoc).toBe(editor.state.doc);
  });
  it("flags a block-normalized replacement crossing hidden and visible tasks", () => {
    const editor = createEditor(body), from = position(editor, "PRIVATE DONE"), to = position(editor, "OPEN SIBLING");
    editor.commands.setTextSelection({ from: from + 3, to: to + 4 });
    const capture = captureAIWritingSelection(editor, "section");
    expect(capture.mode).toBe("blocks"); expect(capture.workingContext?.selectionTouchesCompleted).toBe(true);
    expect(capture.selectedMarkdown).toContain("PRIVATE DONE");
    expect(capture.workingContext?.selectedMarkdown).toContain("OPEN SIBLING");
    expect(JSON.stringify(capture.workingContext)).not.toContain("PRIVATE");
  });
  it("can remove the only checked task without invalidating the projected document", () => {
    const editor = createEditor("- [x] PRIVATE ONLY"), from = position(editor, "PRIVATE ONLY");
    editor.commands.setTextSelection({ from, to: from + 7 });
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.workingContext?.selectionTouchesCompleted).toBe(true);
    expect(JSON.stringify(capture.workingContext)).not.toContain("PRIVATE");
    expect(editor.getMarkdown()).toContain("PRIVATE ONLY");
  });
  it("retains checkbox-looking code examples as ordinary visible code", () => {
    const editor = createEditor("```text\n- [x] Literal example\n```"), from = position(editor, "Literal example");
    editor.commands.setTextSelection({ from, to: from + 7 });
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.workingContext).toMatchObject({ selectionTouchesCompleted: false, caretInsideCompleted: false });
    expect(capture.workingContext?.documentMarkdown).toContain("Literal example");
  });
  it("uses the exact link range instead of the normalized replacement blocks even without completed tasks", () => {
    const editor = createEditor("Outer alpha.\n\nInner beta.\n\nTail prose.");
    const from = position(editor, "alpha"), to = position(editor, "Inner") + 5;
    editor.commands.setTextSelection({ from, to });
    const capture = captureAIWritingSelection(editor, "paragraph");
    expect(capture.selectedMarkdown).toContain("Outer");
    const exact = captureAIWorkingContext(editor, capture, { from, to });
    expect(exact.selectedText).toBe("alpha.\n\nInner");
    expect(exact.selectedMarkdown).not.toContain("Outer");
    expect(exact.selectedMarkdown).not.toContain("beta");
    expect(exact.beforeMarkdown).toContain("Outer");
    expect(exact.afterMarkdown).toContain("beta");
    expect(exact.documentMarkdown).toBe(capture.documentMarkdown);
  });
});
