// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import StarterKit from "@tiptap/starter-kit";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoteTable, insertNoteTable } from "./editor/NoteTable";
import { TablePicker } from "./editor/TablePicker";
import { NoteImage } from "./editor/NoteImage";
import { useState } from "react";
import { EditorToolbar } from "./EditorToolbar";

const editors: Editor[] = [];

function createEditor(content = "Alpha beta") {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TableKit.configure({table:false}), NoteTable, NoteImage,
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

function ToolbarHarness({editor}:{editor:Editor}) {
  const [table,setTable]=useState(false);
  return <><EditorToolbar editor={editor} concepts={[]} onOpenLink={vi.fn()} onUnlink={vi.fn()}
    citationAvailable={false} onOpenCitation={vi.fn()} onAnnounce={vi.fn()} onOpenTable={()=>setTable(true)}/>
    {table&&<TablePicker editor={editor} onClose={()=>setTable(false)}/>}</>;
}
function renderToolbar(editor:Editor) {return render(<ToolbarHarness editor={editor}/>);}
function moreAction(name:string) {
  fireEvent.click(screen.getByRole("button",{name:"More formatting"}));
  fireEvent.click(screen.getByRole("menuitem",{name}));
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
  it("changes the reading font without changing prose, undo history, or selection", () => {
    const editor = createEditor();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const onNoteTypefaceChange = vi.fn();
    const props = {
      editor, concepts: [], onOpenLink: vi.fn(), onUnlink: vi.fn(),
      citationAvailable: false, onOpenCitation: vi.fn(), onNoteTypefaceChange,
    };
    const { rerender } = render(<EditorToolbar {...props} noteTypeface="sans" />);
    const select = screen.getByRole("combobox", { name: "Note font" });
    expect([...select.querySelectorAll("option")].map((option) => option.textContent))
      .toEqual(["Sans serif", "Serif"]);
    fireEvent.change(select, { target: { value: "serif" } });
    expect(onNoteTypefaceChange).toHaveBeenLastCalledWith("serif");
    rerender(<EditorToolbar {...props} noteTypeface="serif" />);
    expect(select).toHaveValue("serif");
    expect(editor.getMarkdown()).toBe("Alpha beta");
    expect(editor.state.selection.from).toBe(1);
    expect(editor.state.selection.to).toBe(6);
    expect(editor.can().undo()).toBe(false);
    select.focus();
    fireEvent.keyDown(select, { key: "Home" });
    expect(select).toHaveFocus();
    fireEvent.change(select, { target: { value: "sans" } });
    expect(onNoteTypefaceChange).toHaveBeenLastCalledWith("sans");
  });

  it("round-trips inline code, strikethrough, fenced code, and dividers", () => {
    const inline = createEditor();
    inline.commands.setTextSelection({ from: 1, to: 6 });
    const inlineToolbar = renderToolbar(inline);
    moreAction("Inline code");
    expect(inline.getMarkdown()).toBe("`Alpha` beta");
    inlineToolbar.unmount();

    const strike = createEditor();
    strike.commands.setTextSelection({ from: 1, to: 6 });
    const strikeToolbar = renderToolbar(strike);
    moreAction("Strikethrough");
    expect(strike.getMarkdown()).toBe("~~Alpha~~ beta");
    strikeToolbar.unmount();

    const block = createEditor("const answer = 42;");
    block.commands.setTextSelection({ from: 1, to: 19 });
    const blockToolbar = renderToolbar(block);
    moreAction("Code block");
    expect(block.getMarkdown()).toContain("```\nconst answer = 42;\n```");
    blockToolbar.unmount();

    const divider = createEditor("Above");
    divider.commands.setTextSelection(divider.state.doc.content.size);
    renderToolbar(divider);
    moreAction("Insert divider");
    expect(divider.getMarkdown()).toContain("---");
  });

  it("inserts and edits a portable GFM table", async () => {
    const editor = createEditor("");
    renderToolbar(editor);

    fireEvent.click(screen.getByRole("button", { name: "Insert table" }));
    fireEvent.click(screen.getByRole("button", { name: "3 columns, 3 rows" }));
    expect(tableGeometry(editor)).toEqual({ rows: 3, columns: 3 });

    fireEvent.click(await screen.findByRole("button", { name: "More table options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add row below" }));
    await waitFor(() =>
      expect(tableGeometry(editor)).toEqual({ rows: 4, columns: 3 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "More table options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add column right" }));
    await waitFor(() =>
      expect(tableGeometry(editor)).toEqual({ rows: 4, columns: 4 }),
    );

    const markdown = editor.getMarkdown();
    expect(markdown).toContain("| --- | --- | --- | --- |");
    const reopened = createEditor(markdown);
    expect(tableGeometry(reopened)).toEqual({ rows: 4, columns: 4 });
  });

  it("offers all six heading levels and keeps them on Markdown reopen", () => {
    const editor=createEditor("Deep section");renderToolbar(editor);
    fireEvent.click(screen.getByRole("button",{name:"Text style"}));
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(7);
    fireEvent.click(screen.getByRole("menuitemradio",{name:/Heading 6/}));
    expect(editor.getMarkdown().trim()).toBe("###### Deep section");
    expect(createEditor(editor.getMarkdown()).getJSON().content?.[0].attrs?.level).toBe(6);
  });
  it("replaces writing controls with object controls and restores them on text selection", async () => {
    const editor=createEditor("Opening paragraph.");const view=renderToolbar(editor);
    act(()=>{insertNoteTable(editor,{rows:2,cols:2});});
    expect(await screen.findByRole("toolbar",{name:"Table formatting"})).toBeVisible();
    expect(screen.queryByRole("button",{name:"Bold"})).not.toBeInTheDocument();
    act(()=>{editor.commands.setTextSelection(editor.state.doc.content.size-1);});
    expect(await screen.findByRole("button",{name:"Bold"})).toBeVisible();
    view.unmount();
    const image=createEditor('![A](data:image/png;base64,aGVsbG8=)');renderToolbar(image);
    act(()=>image.commands.setNodeSelection(0));
    expect(await screen.findByRole("toolbar",{name:"Image formatting"})).toBeVisible();
    expect(screen.queryByRole("button",{name:"Bold"})).not.toBeInTheDocument();
  });

  it("keeps undo and redo together in the trailing history group", async () => {
    const editor = createEditor();
    renderToolbar(editor);

    const history = screen.getByRole("group", { name: "Editing history" });
    const undo = screen.getByRole("button", { name: "Undo" });
    const redo = screen.getByRole("button", { name: "Redo" });

    expect(history).toContainElement(undo);
    expect(history).toContainElement(redo);

    moreAction("Insert divider");
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

    const toggle = screen.getByRole("button", { name: "Turn on AI tools" });
    expect(toggle).toHaveTextContent(/^$/);
    expect(toggle).toHaveAttribute("title", "AI tools: write, rewrite and generate images");
    expect(toggle.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    fireEvent.mouseDown(toggle);
    fireEvent.click(toggle);

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
