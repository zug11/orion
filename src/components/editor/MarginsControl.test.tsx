// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { undoDepth } from "@tiptap/pm/history";
import { StrictMode, useCallback, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorToolbar } from "../EditorToolbar";
import { MarginsControl } from "./MarginsControl";
import { NoteStarterKit } from "./NoteStarterKit";
import { NoteMargins, NoteMarkdown, applyNoteMargins, captureMarginTarget, finishMarginAdjustment } from "./NoteMargins";

const editors: Editor[] = [];
const mounts: HTMLElement[] = [];
function createEditor(content = "Alpha beta.\n\nSecond paragraph.\n\nLeave this alone.") {
  const mount = document.createElement("div");
  mount.className = "editor-prose";
  mount.style.cssText = "padding: 0; border: 0";
  document.body.append(mount);
  mounts.push(mount);
  const editor = new Editor({ element: mount,
    extensions: [NoteStarterKit, NoteMargins, NoteMarkdown.configure({ markedOptions: { gfm: true } })],
    content, contentType: "markdown", editorProps: { handleScrollToSelection: () => true },
  });
  editor.view.dom.style.padding = "0";
  editor.view.dom.style.border = "0";
  vi.spyOn(mount, "getBoundingClientRect").mockImplementation(() => new DOMRect(100, 100, 1000, 400));
  vi.spyOn(editor.view.dom, "getBoundingClientRect").mockImplementation(() => {
    const left = Number(editor.state.doc.attrs.marginLeft) || 0;
    const right = Number(editor.state.doc.attrs.marginRight) || 0;
    return new DOMRect(100 + left * 10, 100, 1000 - (left + right) * 10, 400);
  });
  editors.push(editor);
  return editor;
}
function Harness({ editor, disabled = false }: { editor: Editor; disabled?: boolean }) {
  const [visible, setVisible] = useState(false);
  const close = useCallback(() => setVisible(false), []);
  return <div className="editor-formatting-dock">
    <div className="editor-toolbar-shell"><EditorToolbar editor={editor} concepts={[]} onOpenLink={vi.fn()} onUnlink={vi.fn()}
      citationAvailable={false} onOpenCitation={vi.fn()} aiWritingBusy={disabled}
      marginsVisible={visible} onToggleMargins={() => setVisible(value => !value)}/></div>
    {visible && <MarginsControl editor={editor} disabled={disabled} onClose={close}/>}
  </div>;
}
function openMargins() {
  const trigger = screen.queryByRole("button", { name: "Margins" });
  if (trigger) { fireEvent.mouseDown(trigger); fireEvent.click(trigger); }
  else {
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Margins" }));
  }
  return screen.getByRole("group", { name: "Margins ruler" });
}
function beginDrag(side: "Left" | "Right", clientX = side === "Left" ? 100 : 1100) {
  const handle = screen.getByRole("slider", { name: `${side} margin` });
  let captured: number | null = null;
  const setCapture = vi.fn((id: number) => { captured = id; });
  const releaseCapture = vi.fn(() => { captured = null; });
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: setCapture },
    hasPointerCapture: { configurable: true, value: (id: number) => captured === id },
    releasePointerCapture: { configurable: true, value: releaseCapture },
  });
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX });
  return { handle, setCapture, releaseCapture,
    move: (x: number) => fireEvent.pointerMove(window, { pointerId: 1, clientX: x }),
    finish: (x = clientX) => fireEvent.pointerUp(window, { pointerId: 1, clientX: x }),
    cancel: () => fireEvent.pointerCancel(window, { pointerId: 1 }),
  };
}
function key(side: "Left" | "Right", value: string, shiftKey = false) {
  const handle = screen.getByRole("slider", { name: `${side} margin` });
  fireEvent.keyDown(handle, { key: value, shiftKey });
  fireEvent.keyUp(handle, { key: value, shiftKey });
}
afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.destroy();
  for (const mount of mounts.splice(0)) mount.remove();
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Margins ruler", () => {
  it("realigns after a scroller returns to its horizontal origin without remeasuring later vertical scrolls", () => {
    const editor = createEditor();
    const surface = editor.view.dom.closest<HTMLElement>(".editor-prose")!;
    surface.scrollLeft = 70;
    render(<Harness editor={editor}/>); openMargins();
    const track = screen.getByLabelText("Margins in percent of text width");
    expect(track.style.marginLeft).toBe("100px");
    const bounds = vi.mocked(surface.getBoundingClientRect);
    bounds.mockReturnValue(new DOMRect(170, 100, 1000, 400));
    surface.scrollLeft = 0;
    fireEvent.scroll(surface);
    expect(track.style.marginLeft).toBe("170px");
    bounds.mockClear();
    surface.scrollTop = 160;
    fireEvent.scroll(surface);
    expect(bounds).not.toHaveBeenCalled();
    expect(track.style.marginLeft).toBe("170px");
  });
  it("toggles a ruler inside the editor dock without a popover or numeric fields", () => {
    const view = render(<Harness editor={createEditor()}/>);
    expect(screen.queryByRole("slider")).not.toBeInTheDocument();
    const ruler = openMargins();
    expect(view.container.querySelector(".editor-formatting-dock")).toContainElement(ruler);
    expect(view.container.querySelector(".editor-toolbar-shell")).not.toContainElement(ruler);
    expect(ruler).toHaveAccessibleDescription("Document");
    expect(screen.getByRole("button", { name: "Margins" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(ruler.querySelector("input")).toBeNull();
    expect(screen.queryByRole("button", { name: "Hide margins" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset margins" }).textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Margins" }));
    expect(screen.queryByRole("group", { name: "Margins ruler" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Margins" })).toHaveAttribute("aria-pressed", "false");
  });
  it("drags both document edges with immediate changes and one Undo per drag", () => {
    const editor = createEditor(); editor.commands.setTextSelection(3);
    render(<Harness editor={editor}/>); openMargins();
    const left = beginDrag("Left"); left.move(170);
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 7, marginRight: 0 });
    left.move(220);
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 12, marginRight: 0 });
    expect(editor.state.doc.firstChild?.attrs.marginLeft).toBe(0);
    left.finish(220);
    expect(left.setCapture).toHaveBeenCalledWith(1);
    expect(undoDepth(editor.state)).toBe(1);
    const right = beginDrag("Right"); right.move(1020);
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 12, marginRight: 8 });
    right.finish(1020);
    expect(undoDepth(editor.state)).toBe(2);
    expect(editor.state.selection.from).toBe(3); expect(editor.state.selection.to).toBe(3);
    expect(createEditor(editor.getMarkdown()).state.doc.attrs).toMatchObject({ marginLeft: 12, marginRight: 8 });
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 12, marginRight: 0 });
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 0, marginRight: 0 });
  });
  it("changes selected paragraphs and follows reselection while the ruler stays open", () => {
    const editor = createEditor(); const secondStart = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection({ from: 2, to: secondStart + 4 });
    const selection = editor.state.selection.toJSON();
    render(<Harness editor={editor}/>); openMargins();
    const first = beginDrag("Left"); first.move(220); first.finish(220);
    expect(screen.getByRole("group", { name: "Margins ruler" })).toHaveAccessibleDescription("Selected paragraphs");
    expect(editor.state.doc.child(0).attrs.marginLeft).toBe(12);
    expect(editor.state.doc.child(1).attrs.marginLeft).toBe(12);
    expect(editor.state.doc.child(2).attrs.marginLeft).toBe(0);
    expect(editor.state.doc.attrs.marginLeft).toBe(0); expect(editor.state.doc.childCount).toBe(3);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    act(() => { editor.commands.setTextSelection({ from: secondStart, to: secondStart + 5 }); });
    const second = beginDrag("Right"); second.move(1010); second.finish(1010);
    expect(editor.state.doc.child(0).attrs.marginRight).toBe(0);
    expect(editor.state.doc.child(1).attrs.marginRight).toBe(9);
    expect(editor.state.doc.child(2).attrs.marginRight).toBe(0);
    act(() => { editor.commands.setTextSelection(2); }); key("Left", "ArrowRight");
    expect(editor.state.doc.attrs.marginLeft).toBe(1);
    expect(editor.state.doc.child(0).attrs.marginLeft).toBe(12);
    expect(screen.getByRole("group", { name: "Margins ruler" })).toBeVisible();
    expect(screen.getByRole("group", { name: "Margins ruler" })).toHaveAccessibleDescription("Document");
  });
  it("supports keyboard direction, larger steps, bounded endpoints and undoable Reset", () => {
    const editor = createEditor(); render(<Harness editor={editor}/>); openMargins();
    key("Left", "ArrowRight", true); key("Right", "ArrowLeft");
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 5, marginRight: 1 });
    key("Left", "End"); key("Left", "ArrowRight");
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 25, marginRight: 1 });
    key("Left", "Home");
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 0, marginRight: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Reset margins" }));
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 0, marginRight: 0 });
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 0, marginRight: 1 });
  });
  it("shows mixed edges and preserves each paragraph's opposite margin during dragging", () => {
    const editor = createEditor(); editor.commands.setTextSelection({ from: 1, to: 5 });
    const first = captureMarginTarget(editor);
    applyNoteMargins(editor, first, { left: 5, right: 7 }); finishMarginAdjustment(editor, first);
    const secondStart = editor.state.doc.child(0).nodeSize + 1;
    editor.commands.setTextSelection({ from: secondStart, to: secondStart + 5 });
    const second = captureMarginTarget(editor);
    applyNoteMargins(editor, second, { left: 10, right: 14 }); finishMarginAdjustment(editor, second);
    editor.commands.setTextSelection({ from: 1, to: secondStart + 5 });
    render(<Harness editor={editor}/>); openMargins();
    expect(screen.getByRole("slider", { name: "Left margin" })).toHaveAttribute("aria-valuetext", "Mixed");
    expect(screen.getByRole("slider", { name: "Right margin" })).toHaveAttribute("aria-valuetext", "Mixed");
    const left = beginDrag("Left", 150); left.move(220); left.finish(220);
    expect(editor.state.doc.child(0).attrs).toMatchObject({ marginLeft: 12, marginRight: 7 });
    expect(editor.state.doc.child(1).attrs).toMatchObject({ marginLeft: 12, marginRight: 14 });
    expect(screen.getByRole("slider", { name: "Right margin" })).toHaveAttribute("aria-valuetext", "Mixed");
    fireEvent.click(screen.getByRole("button", { name: "Reset margins" }));
    expect(editor.state.doc.child(0).attrs).toMatchObject({ marginLeft: 0, marginRight: 0 });
    expect(editor.state.doc.child(1).attrs).toMatchObject({ marginLeft: 0, marginRight: 0 });
  });
  it("keeps native drag interaction working through StrictMode effect replay", () => {
    const editor = createEditor(); render(<StrictMode><Harness editor={editor}/></StrictMode>); openMargins();
    const left = beginDrag("Left"); left.move(200); left.finish(200);
    const right = beginDrag("Right"); right.move(1030); right.finish(1030);
    expect(editor.state.doc.attrs).toMatchObject({ marginLeft: 10, marginRight: 7 });
  });
  it("cancels a stale drag and retargets a replaced document", () => {
    const editor = createEditor(); editor.commands.setTextSelection({ from: 1, to: 5 });
    render(<Harness editor={editor}/>); openMargins();
    const left = beginDrag("Left"); left.move(200);
    act(() => { editor.commands.setContent("Replacement note.", { contentType: "markdown" }); });
    left.move(250); left.cancel();
    expect(editor.getMarkdown()).toBe("Replacement note.");
    key("Right", "ArrowLeft");
    expect(editor.state.doc.attrs.marginRight).toBe(1);
    expect(editor.state.doc.firstChild?.attrs.marginRight).toBe(0);
  });
  it("offers the same inline ruler through More at narrow widths", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) { this.callback([{ target: element, contentRect: { width: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
      unobserve() {} disconnect() {}
    });
    const editor = createEditor(); const view = render(<Harness editor={editor}/>);
    expect(screen.queryByRole("button", { name: "Margins" })).not.toBeInTheDocument();
    const ruler = openMargins(); expect(view.container).toContainElement(ruler);
    expect(screen.queryByRole("menu", { name: "More formatting" })).not.toBeInTheDocument();
    key("Left", "ArrowRight"); expect(editor.state.doc.attrs.marginLeft).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "More formatting" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Margins" }));
    expect(screen.queryByRole("group", { name: "Margins ruler" })).not.toBeInTheDocument();
  });
  it("disables the trigger and handles during AI writing", () => {
    const editor = createEditor(); const view = render(<Harness editor={editor}/>); openMargins();
    view.rerender(<Harness editor={editor} disabled/>);
    expect(screen.getByRole("button", { name: "Margins" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Left margin" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "Right margin" })).toBeDisabled();
    key("Left", "ArrowRight"); expect(editor.state.doc.attrs.marginLeft).toBe(0);
  });
});
