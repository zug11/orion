// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorToolbar } from "./EditorToolbar";

const editors: Editor[] = [];

function createEditor(content = "Alpha beta") {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TableKit.configure({
        table: { resizable: false, renderWrapper: true },
      }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

function renderToolbar(editor: Editor) {
  return render(
    <EditorToolbar
      editor={editor}
      concepts={[]}
      onOpenLink={vi.fn()}
      onUnlink={vi.fn()}
      citationAvailable={false}
      onOpenCitation={vi.fn()}
      onAnnounce={vi.fn()}
    />,
  );
}

function tableGeometry(editor: Editor) {
  let rows = 0;
  let columns = 0;
  editor.state.doc.descendants((node) => {
    if (node.type.name !== "table") return true;
    rows = node.childCount;
    columns = node.firstChild?.childCount ?? 0;
    return false;
  });
  return { rows, columns };
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("EditorToolbar", () => {
  it("round-trips inline code, strikethrough, fenced code, and dividers", () => {
    const inline = createEditor();
    inline.commands.setTextSelection({ from: 1, to: 6 });
    const inlineToolbar = renderToolbar(inline);
    fireEvent.click(
      inlineToolbar.getByRole("button", { name: "Inline code" }),
    );
    expect(inline.getMarkdown()).toBe("`Alpha` beta");
    inlineToolbar.unmount();

    const strike = createEditor();
    strike.commands.setTextSelection({ from: 1, to: 6 });
    const strikeToolbar = renderToolbar(strike);
    fireEvent.click(
      strikeToolbar.getByRole("button", { name: "Strikethrough" }),
    );
    expect(strike.getMarkdown()).toBe("~~Alpha~~ beta");
    strikeToolbar.unmount();

    const block = createEditor("const answer = 42;");
    block.commands.setTextSelection({ from: 1, to: 19 });
    const blockToolbar = renderToolbar(block);
    fireEvent.click(blockToolbar.getByRole("button", { name: "Code block" }));
    expect(block.getMarkdown()).toContain("```\nconst answer = 42;\n```");
    blockToolbar.unmount();

    const divider = createEditor("Above");
    divider.commands.setTextSelection(divider.state.doc.content.size);
    const dividerToolbar = renderToolbar(divider);
    fireEvent.click(
      dividerToolbar.getByRole("button", { name: "Insert divider" }),
    );
    expect(divider.getMarkdown()).toContain("---");
  });

  it("inserts and edits a portable GFM table", async () => {
    const editor = createEditor("");
    renderToolbar(editor);

    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    expect(tableGeometry(editor)).toEqual({ rows: 3, columns: 3 });

    const actions = await screen.findByRole("combobox", {
      name: "Table actions",
    });
    fireEvent.change(actions, { target: { value: "add-row-after" } });
    await waitFor(() =>
      expect(tableGeometry(editor)).toEqual({ rows: 4, columns: 3 }),
    );
    fireEvent.change(actions, { target: { value: "add-column-after" } });
    await waitFor(() =>
      expect(tableGeometry(editor)).toEqual({ rows: 4, columns: 4 }),
    );

    const markdown = editor.getMarkdown();
    expect(markdown).toContain("| --- | --- | --- | --- |");
    const reopened = createEditor(markdown);
    expect(tableGeometry(reopened)).toEqual({ rows: 4, columns: 4 });
  });

  it("keeps undo and redo together in the trailing history group", async () => {
    const editor = createEditor();
    renderToolbar(editor);

    const history = screen.getByRole("group", { name: "Editing history" });
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });

    expect(history).toContainElement(undo);
    expect(history).toContainElement(redo);

    fireEvent.click(screen.getByRole("button", { name: "Insert divider" }));
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);
    await waitFor(() => expect(redo).toBeEnabled());

    expect(history).toContainElement(undo);
    expect(history).toContainElement(redo);
  });

  it("keeps dictation in a fixed toolbar group", () => {
    const editor = createEditor();
    render(
      <EditorToolbar
        editor={editor}
        concepts={[]}
        onOpenLink={vi.fn()}
        onUnlink={vi.fn()}
        citationAvailable={false}
        onOpenCitation={vi.fn()}
        noteId="note-one"
        onTranscribeVoiceMemo={vi.fn()}
        onCompleteVoiceMemo={vi.fn()}
      />,
    );

    const dictation = screen.getByRole("group", { name: "Dictation" });
    expect(dictation).toContainElement(
      screen.getByRole("button", { name: "Start dictation" }),
    );
    expect(dictation).not.toBe(
      screen.getByRole("group", { name: "Editing history" }),
    );
  });

  it("toggles AI writing without changing the editor selection or document", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const beforeSelection = editor.state.selection.toJSON();
    const beforeMarkdown = editor.getMarkdown();
    const onToggleAIWriting = vi.fn();
    render(
      <EditorToolbar
        editor={editor}
        concepts={[]}
        onOpenLink={vi.fn()}
        onUnlink={vi.fn()}
        citationAvailable={false}
        onOpenCitation={vi.fn()}
        aiWritingAvailable
        onToggleAIWriting={onToggleAIWriting}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Turn on AI writing" }));

    expect(onToggleAIWriting).toHaveBeenCalledOnce();
    expect(editor.state.selection.toJSON()).toEqual(beforeSelection);
    expect(editor.getMarkdown()).toBe(beforeMarkdown);
  });

  it("opens a raster image picker and returns every selected image", () => {
    const editor = createEditor();
    const onInsertImages = vi.fn();
    const { container } = render(
      <EditorToolbar
        editor={editor}
        concepts={[]}
        onOpenLink={vi.fn()}
        onUnlink={vi.fn()}
        citationAvailable={false}
        onOpenCitation={vi.fn()}
        onInsertImages={onInsertImages}
      />,
    );
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    const files = [
      new File(["one"], "one.png", { type: "image/png" }),
      new File(["two"], "two.webp", { type: "image/webp" }),
    ];

    expect(input).not.toBeNull();
    expect(input).toHaveAttribute("multiple");
    fireEvent.change(input!, { target: { files } });
    expect(onInsertImages).toHaveBeenCalledWith(files);
  });
});
