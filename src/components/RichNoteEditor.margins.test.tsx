// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RichNoteEditor } from "./RichNoteEditor";
import { applyNoteMargins, captureMarginTarget, finishMarginAdjustment } from "./editor/NoteMargins";

afterEach(cleanup);

it("does not replace an in-progress margin drag with an earlier local parent echo", async () => {
  const original = "A paragraph that keeps its selection while its margins change.\n\nSurrounding prose.";
  const onChange = vi.fn();
  const props = { noteId: "margin-draft", notes: [], concepts: [], sources: [], attachedSourceIds: [], onChange,
    onAttachSource: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const view = render(<RichNoteEditor {...props} markdown={original}/>);
  const editor = (view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  act(() => { editor.commands.setTextSelection({ from: 1, to: editor.state.doc.firstChild!.nodeSize - 1 }); });
  const selection = editor.state.selection.toJSON();
  const target = captureMarginTarget(editor);
  act(() => { applyNoteMargins(editor, target, { left: 25 }); });
  const firstEcho = onChange.mock.lastCall![0] as string;
  act(() => { applyNoteMargins(editor, target, { left: 10 }); });
  const latestEcho = onChange.mock.lastCall![0] as string;

  // React can deliver the preceding parent render after the next pointer move.
  view.rerender(<RichNoteEditor {...props} markdown={firstEcho}/>);
  expect(editor.state.doc.firstChild!.attrs.marginLeft).toBe(10);
  expect(editor.state.selection.toJSON()).toEqual(selection);
  expect(target.available).toBe(true);
  view.rerender(<RichNoteEditor {...props} markdown={latestEcho}/>);
  act(() => { expect(applyNoteMargins(editor, target, { left: 7 })).toBe(true); });
  const finalEcho = onChange.mock.lastCall![0] as string;
  view.rerender(<RichNoteEditor {...props} markdown={finalEcho}/>);
  finishMarginAdjustment(editor, target);
  expect(editor.state.doc.firstChild!.attrs.marginLeft).toBe(7);
  act(() => { editor.commands.undo(); });
  expect(editor.getMarkdown()).toBe(original);
  view.rerender(<RichNoteEditor {...props} markdown={original}/>);

  // Previously acknowledged text is no longer a pending echo. A real external
  // change (including a revert to an earlier margin) must still replace it.
  view.rerender(<RichNoteEditor {...props} markdown={firstEcho}/>);
  expect(editor.state.doc.firstChild!.attrs.marginLeft).toBe(25);
  view.rerender(<RichNoteEditor {...props} markdown="A replacement from another window."/>);
  expect(editor.getMarkdown()).toBe("A replacement from another window.");
});
