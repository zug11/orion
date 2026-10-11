// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writingTimer } from "../../lib/writingSession";
import { RichNoteEditor } from "../RichNoteEditor";
import { finishInlineFlow, getInlineFlow } from "./FlowWriting";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { cleanup(); writingTimer.stop(); vi.restoreAllMocks(); vi.useRealTimers(); });
const original = "Existing note stays intact.";
function setup(strict = false) {
  const onChange = vi.fn();
  const props = { noteId: "flow-note", markdown: original, notes: [], concepts: [], sources: [], attachedSourceIds: [], onChange,
    onAttachSource: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const tree = <RichNoteEditor {...props}/>;
  const view = render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  const editor = (view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 0, right: 1, top: 0, bottom: 20 });
  act(() => vi.advanceTimersByTime(32));
  return { view, editor, onChange, props };
}
function startFlow() {
  fireEvent.click(screen.getByRole("button", { name: "Writing timer" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Writing mode" }), { target: { value: "flow" } });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Session duration in minutes" }), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Start Flow" }));
}
function write(editor: Editor, text: string) { act(() => { editor.commands.insertContent(text); }); }

it("uses the real editor and toolbar without a modal; expired text never autosaves or returns through Undo", () => {
  const { editor, onChange, view } = setup(true); startFlow();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getAllByRole("textbox", { name: "Note body" })).toHaveLength(1);
  write(editor, "Temporary words");
  act(() => vi.advanceTimersByTime(7000));
  expect(Number((view.container.querySelector(".flow-writing-passage") as HTMLElement).style.opacity)).toBeLessThan(.5);
  write(editor, " keep moving");
  expect((view.container.querySelector(".flow-writing-passage") as HTMLElement).style.opacity).toBe("1");
  expect(onChange).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(10_000));
  expect(editor.getText()).toBe(original);
  expect(onChange).not.toHaveBeenCalled();
  expect(getInlineFlow(editor)).toBeNull();
  act(() => { editor.commands.undo(); editor.commands.redo(); });
  expect(editor.getText()).not.toContain("Temporary");
  expect(screen.getAllByText("Flow text disappeared. Existing text is unchanged.").length).toBeGreaterThan(0);
});

it("Stop and keep persists the rich passage once, preserving formatting and giving it one Undo step", () => {
  const { editor, onChange } = setup(); startFlow();
  act(() => { editor.commands.toggleBold(); editor.commands.insertContent("Keep these words"); });
  act(() => vi.advanceTimersByTime(9900));
  fireEvent.click(screen.getByRole("button", { name: "Stop and keep" }));
  expect(editor.getHTML()).toContain("<strong>Keep these words</strong>");
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenLastCalledWith(`${original}\n\n**Keep these words**`);
  act(() => { editor.commands.insertContent(" later"); editor.commands.undo(); });
  expect(editor.getText()).toContain("Keep these words");
  expect(editor.getText()).not.toContain("later");
  act(() => { editor.commands.undo(); });
  expect(editor.getText()).toBe(original);
});

it("protects pre-session text and rejects late Stop/input even when interval callbacks were suspended", () => {
  const { editor, onChange } = setup(); startFlow(); write(editor, "Discard me");
  act(() => { editor.commands.setTextSelection({ from: 1, to: 9 }); editor.commands.insertContent("Overwrite"); });
  expect(editor.getText()).toContain(original);
  vi.setSystemTime(12_000);
  act(() => { editor.commands.setTextSelection(editor.state.doc.content.size - 1); editor.commands.insertContent("too late"); });
  fireEvent.click(screen.getByRole("button", { name: "Stop and keep" }));
  expect(editor.getText()).toBe(original);
  expect(onChange).not.toHaveBeenCalled();
});

it("keeps continuous writing automatically at the session deadline", () => {
  const { editor, onChange } = setup(); startFlow(); write(editor, "Start");
  for (let step = 1; step <= 6; step++) {
    act(() => vi.advanceTimersByTime(9000)); write(editor, ` word${step}`);
  }
  act(() => vi.advanceTimersByTime(6000));
  expect(getInlineFlow(editor)).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(editor.getText()).toContain("word6");
});

it("does not leak a draft through parent echoes, external replacements, or another note", () => {
  const { editor, onChange, props, view } = setup(); startFlow(); write(editor, "Never save me");
  view.rerender(<RichNoteEditor {...props}/>);
  expect(editor.getText()).toContain("Never save me");
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<RichNoteEditor {...props} markdown="Replacement from another window."/>);
  expect(editor.getText()).toBe("Replacement from another window.");
  expect(getInlineFlow(editor)).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
  view.rerender(<RichNoteEditor key="other-note" {...props} noteId="other-note" markdown="Another note."/>);
  expect(screen.getByRole("textbox", { name: "Note body" })).toHaveTextContent("Another note.");
});

it("retains a draft when keeping is temporarily unavailable", () => {
  const { editor, onChange } = setup(); startFlow(); write(editor, "Keep me");
  act(() => editor.setEditable(false));
  act(() => { expect(finishInlineFlow(editor, true)).toBe(false); });
  act(() => vi.advanceTimersByTime(60_000));
  expect(editor.getText()).toContain("Keep me");
  act(() => editor.setEditable(true));
  act(() => { finishInlineFlow(editor, true); });
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("expiry preserves earlier Undo history without putting the lost passage in Redo", () => {
  const { editor, onChange } = setup();
  act(() => { editor.commands.insertContent("Earlier edit. "); });
  const baseline = editor.getText();
  onChange.mockClear();
  startFlow(); write(editor, "Never recover this");
  act(() => vi.advanceTimersByTime(10_000));
  expect(editor.getText()).toBe(baseline);
  expect(onChange).not.toHaveBeenCalled();
  act(() => { editor.commands.undo(); });
  expect(editor.getText()).toBe(original);
  act(() => { editor.commands.redo(); });
  expect(editor.getText()).toBe(baseline);
  expect(editor.getText()).not.toContain("Never recover");
});

it("IME composition keeps both deadlines paused while writing in the editor", () => {
  const { editor } = setup(); startFlow(); write(editor, "Draft");
  fireEvent.compositionStart(screen.getByRole("textbox", { name: "Note body" }));
  act(() => vi.advanceTimersByTime(30_000));
  expect(getInlineFlow(editor)?.session.phase).toBe("writing");
  expect(editor.getText()).toContain("Draft");
  fireEvent.compositionEnd(screen.getByRole("textbox", { name: "Note body" }));
  act(() => vi.runAllTicks());
  act(() => vi.advanceTimersByTime(9000));
  expect(editor.getText()).toContain("Draft");
  fireEvent.click(screen.getByRole("button", { name: "Stop and keep" }));
  expect(getInlineFlow(editor)).toBeNull();
});

it("the ordinary timer survives editor remounts and supports toolbar pause, resume and stop", () => {
  const { view, onChange } = setup();
  fireEvent.click(screen.getByRole("button", { name: "Writing timer" }));
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Start timer" }));
  act(() => vi.advanceTimersByTime(15_000)); view.unmount();
  act(() => vi.advanceTimersByTime(10_000)); setup();
  expect(screen.getByRole("button", { name: "Writing timer" })).toHaveTextContent("0:35");
  fireEvent.click(screen.getByRole("button", { name: "Writing timer" }));
  fireEvent.click(screen.getByRole("button", { name: "Pause timer" }));
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByRole("timer")).toHaveTextContent("0:35");
  fireEvent.click(screen.getByRole("button", { name: "Resume timer" }));
  act(() => vi.advanceTimersByTime(35_000));
  expect(screen.getByText("Time’s up. Writing kept.")).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
});
