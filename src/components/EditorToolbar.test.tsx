// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { NoteMargins, NoteMarkdown } from "./editor/NoteMargins";
import { TableKit } from "@tiptap/extension-table";
import { NoteStarterKit } from "./editor/NoteStarterKit";
import { NoteTextAlignment } from "./editor/NoteTextAlignment";
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
      NoteStarterKit, NoteTextAlignment, NoteMargins,
      TableKit.configure({table:false}), NoteTable, NoteImage,
      NoteMarkdown.configure({ markedOptions: { gfm: true } }),
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
  it("toggles justification for the current paragraph and supports Undo", () => {
    const editor = createEditor("A paragraph to justify.\n\nLeave this paragraph alone.");
    renderToolbar(editor);
    const justify = screen.getByRole("button", { name: "Justify text" });
    fireEvent.click(justify);
    expect(justify).toHaveAttribute("aria-pressed", "true");
    expect(editor.state.doc.firstChild?.attrs.textAlign).toBe("justify");
    expect(editor.state.doc.child(1).attrs.textAlign).toBe("left");
    expect(editor.getMarkdown()).toContain("<!-- orion-text:v1 justify -->");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(justify).toHaveAttribute("aria-pressed", "false");
    expect(editor.getMarkdown()).not.toContain("orion-text:");
  });

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

    fireEvent.click(await screen.findByRole("button", { name: "Add row below" }));
    await waitFor(() =>
      expect(tableGeometry(editor)).toEqual({ rows: 4, columns: 3 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add column right" }));
    await waitFor(() =>
      expect(tableGeometry(editor)).toEqual({ rows: 4, columns: 4 }),
    );

    const markdown = editor.getMarkdown();
    expect(markdown).toContain("| --- | --- | --- | --- |");
    const reopened = createEditor(markdown);
    expect(tableGeometry(reopened)).toEqual({ rows: 4, columns: 4 });
  });

  it("keeps heading levels inside More and preserves them on Markdown reopen", () => {
    const editor=createEditor("Deep section");renderToolbar(editor);
    expect(screen.queryByRole("button",{name:"Text style"})).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox",{name:"Text style"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"More formatting"}));
    const style = screen.getByRole("combobox",{name:"Text style"});
    expect(screen.getByRole("menu",{name:"More formatting"})).toContainElement(style);
    expect([...style.querySelectorAll("option")].map(option => option.textContent))
      .toEqual(["Text", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"]);
    fireEvent.change(style, {target: {value:"6"}});
    expect(editor.getMarkdown().trim()).toBe("###### Deep section");
    expect(createEditor(editor.getMarkdown()).getJSON().content?.[0].attrs?.level).toBe(6);
    expect(screen.queryByRole("menu",{name:"More formatting"})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button",{name:"More formatting"}));
    fireEvent.change(screen.getByRole("combobox",{name:"Text style"}), {target: {value:"0"}});
    expect(editor.getMarkdown().trim()).toBe("Deep section");
  });

  it("preserves native heading select keyboard behavior and Escape returns to More", () => {
    const editor=createEditor("Deep section");renderToolbar(editor);
    const trigger = screen.getByRole("button",{name:"More formatting"});
    fireEvent.click(trigger);
    const style = screen.getByRole("combobox",{name:"Text style"});
    style.focus();
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      expect(fireEvent.keyDown(style,{key})).toBe(true);
      expect(style).toHaveFocus();
    }
    fireEvent.keyDown(style,{key:"Escape"});
    expect(screen.queryByRole("menu",{name:"More formatting"})).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("opens More by pointer without focusing or highlighting Text style, while preserving the passage", () => {
    const editor=createEditor("Alpha beta.");
    editor.commands.setTextSelection({from:1,to:6});
    const selection=editor.state.selection.toJSON();
    renderToolbar(editor);
    const trigger=screen.getByRole("button",{name:"More formatting"});
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger,{detail:1});
    const menu=screen.getByRole("menu",{name:"More formatting"});
    const style=screen.getByRole("combobox",{name:"Text style"});
    expect(menu).toHaveFocus();
    expect(menu).toHaveStyle({outline:"none"});
    expect(style).not.toHaveFocus();
    expect(editor.state.selection.toJSON()).toEqual(selection);
    fireEvent.keyDown(menu,{key:"ArrowDown"});
    expect(style).toHaveFocus();
    fireEvent.keyDown(style,{key:"Escape"});
    expect(trigger).toHaveFocus();
    expect(editor.state.selection.toJSON()).toEqual(selection);
  });

  it.each(["Enter", " ", "ArrowDown"])("opens More from the keyboard with %s and focuses its first control", (key) => {
    renderToolbar(createEditor());
    const trigger=screen.getByRole("button",{name:"More formatting"});
    trigger.focus();
    fireEvent.keyDown(trigger,{key});
    expect(screen.getByRole("combobox",{name:"Text style"})).toHaveFocus();
    fireEvent.keyDown(document.activeElement!,{key:"Escape"});
    expect(trigger).toHaveFocus();
  });

  it("starts at the last enabled item with ArrowUp from the menu container", () => {
    renderToolbar(createEditor());
    fireEvent.click(screen.getByRole("button",{name:"More formatting"}),{detail:1});
    const menu=screen.getByRole("menu",{name:"More formatting"});
    const choices=Array.from(menu.querySelectorAll<HTMLElement>('button:not([disabled]),select:not([disabled])'));
    fireEvent.keyDown(menu,{key:"ArrowUp"});
    expect(choices[choices.length - 1]).toHaveFocus();
    expect(fireEvent.keyDown(choices[choices.length - 1],{key:"Tab"})).toBe(true);
  });

  it.each([
    ["text", "More formatting"],
    ["image", "More image options"],
    ["table", "More table options"],
  ] as const)("keeps Block controls in the existing %s More and preserves the target selection", (context, moreName) => {
    const editor = createEditor(context === "image" ? '![A](data:image/png;base64,aGVsbG8=)' : "Alpha beta");
    if (context === "image") editor.commands.setNodeSelection(0);
    else if (context === "table") insertNoteTable(editor,{rows:2,cols:2});
    else editor.commands.setTextSelection({from:1,to:6});
    const before = editor.state.selection.toJSON();
    const document = editor.state.doc;
    const onToggleBlockControls = vi.fn();
    render(<EditorToolbar editor={editor} concepts={[]} onOpenLink={vi.fn()} onUnlink={vi.fn()}
      citationAvailable={false} onOpenCitation={vi.fn()} onToggleBlockControls={onToggleBlockControls} blockControls/>);
    expect(screen.queryByRole("button",{name:"Block controls"})).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitemcheckbox",{name:"Block controls"})).not.toBeInTheDocument();
    expect(screen.getAllByRole("button",{name:/More (?:formatting|image options|table options)/})).toHaveLength(1);
    const more = screen.getByRole("button",{name:moreName});
    fireEvent.mouseDown(more);fireEvent.click(more);
    const button = screen.getByRole("menuitemcheckbox",{name:"Block controls"});
    expect(button).toHaveAttribute("aria-checked","true");
    const icon = button.querySelector('[data-orion-icon="blocks"]');
    expect(icon).toHaveAttribute("aria-hidden","true");
    expect(icon?.querySelectorAll("rect")).toHaveLength(3);
    fireEvent.mouseDown(button);fireEvent.click(button);
    expect(onToggleBlockControls).toHaveBeenCalledOnce();
    expect(editor.state.selection.toJSON()).toEqual(before);
    expect(editor.state.doc).toBe(document);
    expect(screen.queryByRole("menuitemcheckbox",{name:"Block controls"})).not.toBeInTheDocument();
    expect(more).toHaveAttribute("aria-expanded","false");
  });

  it.each([
    ["text", "More formatting", "ai"],
    ["image", "More image options", "ai"],
    ["table", "More table options", "ai"],
    ["text", "More formatting", "image"],
    ["image", "More image options", "image"],
    ["table", "More table options", "image"],
  ] as const)("disables %s block changes in %s during %s work", (context, moreName, busy) => {
    const editor = createEditor(context === "image" ? '![A](data:image/png;base64,aGVsbG8=)' : "Alpha beta");
    if (context === "image") editor.commands.setNodeSelection(0);
    else if (context === "table") insertNoteTable(editor,{rows:2,cols:2});
    const onToggleBlockControls = vi.fn();
    render(<EditorToolbar editor={editor} concepts={[]} onOpenLink={vi.fn()} onUnlink={vi.fn()}
      citationAvailable={false} onOpenCitation={vi.fn()} onToggleBlockControls={onToggleBlockControls}
      aiWritingBusy={busy === "ai"} imageBusy={busy === "image"}/>);
    fireEvent.click(screen.getByRole("button",{name:moreName}));
    const item = screen.getByRole("menuitemcheckbox",{name:"Block controls"});
    expect(item).toHaveAttribute("aria-checked","false");
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(onToggleBlockControls).not.toHaveBeenCalled();
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
