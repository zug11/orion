// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { undoDepth } from "@tiptap/pm/history";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NoteBlock } from "./NoteBlock";
import { NoteImage } from "./NoteImage";
import { listNoteBlocks } from "./noteBlocks";
import { useBlockReorder } from "./useBlockReorder";

const paragraph = (text: string): JSONContent => ({ type: "paragraph", content: [{ type: "text", text }] });
const framed = (...content: JSONContent[]): JSONContent => ({ type: "noteBlock", content });
const editors: Editor[] = [];
const roots: HTMLElement[] = [];
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
});
afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) if (!editor.isDestroyed) editor.destroy();
  for (const root of roots.splice(0)) root.remove();
  frames.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
function nextFrame() {
  act(() => { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(16); });
}

function fixture(imageTarget = false) {
  const scroller = document.createElement("div"); scroller.className = "workspace-content";
  const host = document.createElement("div"); host.className = "rich-note-editor";
  const mount = document.createElement("div");
  const controls = document.createElement("div");
  host.append(mount, controls); scroller.append(host); document.body.append(scroller); roots.push(scroller);
  const editor = new Editor({
    element: mount, extensions: [StarterKit, NoteBlock, NoteImage],
    content: { type: "doc", content: [
      framed(paragraph("Move me")),
      imageTarget ? framed({ type: "image", attrs: { src: "orion-image://localhost/image_Abc-123456789", placement: "wrap", widthPercent: 45, offsetY: 80 } }) : paragraph("Second"),
      paragraph("Third"),
    ] },
    editorProps: { handleScrollToSelection: () => true },
  });
  editors.push(editor);
  editor.commands.setTextSelection({ from: 3, to: 6 });
  const source = listNoteBlocks(editor.state.doc)[0];
  vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, 500, imageTarget ? 400 : 300));
  vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => new DOMRect(20, 20 - scroller.scrollTop, 460, 400));
  vi.spyOn(editor.view.dom, "getBoundingClientRect").mockImplementation(() => new DOMRect(20, 20 - scroller.scrollTop, 460, 400));
  const blocks = listNoteBlocks(editor.state.doc);
  const nodes = blocks.map((_block, index) => {
    const node = document.createElement("div");
    const top = imageTarget && index === 2 ? 340 : 40 + index * 80;
    vi.spyOn(node, "getBoundingClientRect").mockImplementation(() => new DOMRect(20, top - scroller.scrollTop, 460, imageTarget && index === 1 ? 0 : 40));
    if (imageTarget && index === 1) {
      const image = document.createElement("div"); image.className = "note-image-view"; node.append(image);
      vi.spyOn(image, "getBoundingClientRect").mockImplementation(() => new DOMRect(20, 120 - scroller.scrollTop, 200, 180));
    }
    return node;
  });
  vi.spyOn(editor.view, "nodeDOM").mockImplementation(position => nodes[blocks.findIndex(block => block.from === position)] ?? null);
  const onAnnounce = vi.fn();
  function Harness() {
    const reorder = useBlockReorder(editor, onAnnounce);
    return <><button onPointerDown={event => reorder.start(event, source)}>Move block</button>
      {reorder.drop && <div data-testid="drop" style={reorder.drop} />}</>;
  }
  const view = render(<Harness />, { container: controls });
  const handle = screen.getByRole("button", { name: "Move block" });
  let captured: number | null = null;
  const setCapture = vi.fn((id: number) => { captured = id; });
  const releaseCapture = vi.fn(() => { captured = null; });
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: setCapture },
    hasPointerCapture: { configurable: true, value: (id: number) => captured === id },
    releasePointerCapture: { configurable: true, value: releaseCapture },
  });
  const start = (y = 180) => {
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 80, clientY: 50 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 80, clientY: y });
    nextFrame();
  };
  const finish = (y = 180) => fireEvent.pointerUp(window, { pointerId: 1, clientX: 80, clientY: y });
  return { ...view, editor, scroller, host, handle, start, finish, setCapture, releaseCapture, onAnnounce };
}

describe("persistent block drag lifecycle", () => {
  it("captures the pointer, leaves content unchanged during dragging, and commits one move with preserved selection", () => {
    const { editor, start, finish, host, setCapture, releaseCapture, onAnnounce } = fixture();
    const original = editor.state.doc;
    const selection = editor.state.selection.toJSON();
    start();
    expect(setCapture).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("drop")).toBeVisible();
    expect(host).toHaveClass("is-block-dragging");
    expect(editor.state.doc).toBe(original);
    expect(editor.state.selection.toJSON()).toEqual(selection);
    expect(undoDepth(editor.state)).toBe(0);
    finish();
    expect(editor.state.doc.firstChild).toBe(original.child(1));
    expect(editor.state.doc.child(1)).toBe(original.firstChild);
    expect(editor.state.selection.anchor).toBe(original.child(1).nodeSize + 3);
    expect(editor.state.selection.head).toBe(original.child(1).nodeSize + 6);
    expect(releaseCapture).toHaveBeenCalledWith(1);
    expect(screen.queryByTestId("drop")).toBeNull();
    expect(host).not.toHaveClass("is-block-dragging");
    expect(onAnnounce).toHaveBeenCalledOnce();
    act(() => { expect(editor.commands.undo()).toBe(true); });
    expect(editor.state.doc.eq(original)).toBe(true);
    expect(editor.state.selection.toJSON()).toEqual(selection);
  });

  it.each(["escape", "cancel", "lost capture", "blur", "unmount"])("cancels without an edit on %s and ignores a later pointer release", reason => {
    const { editor, start, finish, handle, host, unmount, releaseCapture, onAnnounce } = fixture();
    const original = editor.state.doc;
    start();
    if (reason === "escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "cancel") fireEvent.pointerCancel(window, { pointerId: 1 });
    else if (reason === "lost capture") fireEvent.lostPointerCapture(handle, { pointerId: 1 });
    else if (reason === "blur") fireEvent.blur(window);
    else unmount();
    finish();
    nextFrame();
    expect(editor.state.doc).toBe(original);
    expect(undoDepth(editor.state)).toBe(0);
    expect(host).not.toHaveClass("is-block-dragging");
    expect(screen.queryByTestId("drop")).toBeNull();
    expect(releaseCapture).toHaveBeenCalledWith(1);
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it("ignores cancellation from a different pointer", () => {
    const { editor, start, finish, releaseCapture } = fixture();
    const original = editor.state.doc;
    start();
    fireEvent.pointerCancel(window, { pointerId: 9 });
    expect(screen.getByTestId("drop")).toBeVisible();
    expect(releaseCapture).not.toHaveBeenCalled();
    finish();
    expect(editor.state.doc.child(1)).toBe(original.firstChild);
  });

  it("cancels immediately when document content changes and never overwrites that edit", () => {
    const { editor, start, finish, releaseCapture } = fixture();
    start();
    act(() => { editor.commands.insertContentAt(editor.state.doc.content.size - 1, " changed"); });
    const changed = editor.state.doc;
    expect(screen.queryByTestId("drop")).toBeNull();
    expect(releaseCapture).toHaveBeenCalledWith(1);
    finish();
    expect(editor.state.doc).toBe(changed);
    expect(editor.state.doc.lastChild?.textContent).toBe("Third changed");
  });

  it("handles editor destruction before the next animation frame without measuring its unavailable view", () => {
    const { editor, start, finish, releaseCapture } = fixture();
    start();
    editor.destroy();
    expect(finish).not.toThrow();
    expect(screen.queryByTestId("drop")).toBeNull();
    expect(releaseCapture).toHaveBeenCalledWith(1);
  });

  it("scrolls near the viewport edge only while a drag remains active", () => {
    const { editor, start, scroller } = fixture();
    const original = editor.state.doc;
    start(280);
    const first = scroller.scrollTop;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(16);
    nextFrame();
    expect(scroller.scrollTop).toBeGreaterThan(first);
    fireEvent.keyDown(window, { key: "Escape" });
    const cancelled = scroller.scrollTop;
    nextFrame();
    expect(scroller.scrollTop).toBe(cancelled);
    expect(editor.state.doc).toBe(original);
  });

  it("uses a floated image's visible height when choosing before or after its frame", () => {
    const { editor, start, finish } = fixture(true);
    const original = editor.state.doc;
    start(170);
    expect(screen.queryByTestId("drop")).toBeNull();
    finish(170);
    expect(editor.state.doc).toBe(original);
    start(260);
    expect(screen.getByTestId("drop")).toBeVisible();
    finish(260);
    expect(editor.state.doc.firstChild).toBe(original.child(1));
    expect(editor.state.doc.child(1)).toBe(original.firstChild);
  });
});
