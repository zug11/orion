// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedDictation } from "../lib/dictationCleanup";
import { prepareDictation } from "../lib/dictationCleanup";
import type { Note } from "../types";
import type { VoiceMemoButton } from "./VoiceMemoButton";
import { RichNoteEditor } from "./RichNoteEditor";

type Props = ComponentProps<typeof RichNoteEditor>;
type MemoProps = ComponentProps<typeof VoiceMemoButton>;
const memo = vi.hoisted(() => ({ current: undefined as MemoProps | undefined }));
vi.mock("./VoiceMemoButton", () => ({
  VoiceMemoButton: (props: MemoProps) => {
    memo.current = props;
    return <button type="button" aria-label="Mock dictation">Dictation</button>;
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.spyOn(window, "scrollBy").mockImplementation(() => undefined);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("workspace-content")) return new DOMRect(0, 0, 1200, 760);
    if (this.classList.contains("rich-note-editor")) return new DOMRect(200, 80, 840, 620);
    if (this.classList.contains("editor-prose")) return new DOMRect(280, 130, 680, 500);
    return new DOMRect(280, 200, 80, 20);
  });
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => [] },
    getBoundingClientRect: { configurable: true, value: () => new DOMRect(280, 200, 80, 20) },
  });
});
afterEach(() => { cleanup(); memo.current = undefined; vi.restoreAllMocks(); });

async function fixture(extra: Partial<Props> = {}) {
  const onChange = vi.fn();
  const props: Props = {
    noteId: "dictation-note", markdown: "Alpha beta", notes: [], concepts: [], sources: [], attachedSourceIds: [],
    onChange, onAttachSource: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn(),
    onTranscribeVoiceMemo: vi.fn().mockResolvedValue("Original words."), ...extra,
  };
  const view = render(<div className="workspace-content"><RichNoteEditor key={props.noteId} {...props} /></div>);
  const editor = (view.container.querySelector(".tiptap") as HTMLElement & { editor: Editor }).editor;
  vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 280, right: 360, top: 200, bottom: 220 });
  await waitFor(() => expect(editor.isFocused).toBe(true));
  return {
    ...view, editor, onChange,
    update: (changes: Partial<Props>) => view.rerender(<div className="workspace-content"><RichNoteEditor key={changes.noteId ?? props.noteId} {...props} {...changes} /></div>),
  };
}

async function start(editor: Editor, position = 6) {
  await act(async () => {
    editor.commands.setTextSelection(position);
    await memo.current!.onSessionStart?.("dictation-session");
  });
  const options = { signal: new AbortController().signal, onPhase: vi.fn() };
  const complete = memo.current!.onComplete;
  return { complete: (text = "Original words.") => complete("dictation-session", text, options), options };
}

describe("dictation cleanup in the real rich note editor", () => {
  const hybrid: PreparedDictation = {
    original: "Um, this may help. Make a ticket to fix the menu on Launch. Then keep thinking.",
    blocks: [{ kind: "paragraph", text: "This may help. Make a ticket to fix the menu on Launch. Then keep thinking." }],
    proposal: { blocks: [
      { kind: "paragraph", text: "This may help." },
      { kind: "ticket", text: "Fix the menu", evidence: "Make a ticket to fix the menu on Launch", boardName: "Launch", dueDate: "2026-11-19", urgency: "high" },
      { kind: "paragraph", text: "Then keep thinking." },
    ] },
    sourceId: "source-dictation-session", notice: "",
  };
  const boardNote = { id: "board-note", title: "Work", body: "<!-- orion-kanban:v1 board-launch Launch -->", sourceIds: [], conceptIds: [], tags: [], aliases: [] } as unknown as Note;

  it("inserts automatically at the mapped caret, without approval, as one Undo", async () => {
    const pending = deferred<PreparedDictation>();
    const { editor, onChange, update } = await fixture({ notes: [boardNote], onPrepareDictation: vi.fn().mockReturnValue(pending.promise) });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { editor.commands.insertContentAt(1, "New "); editor.commands.setTextSelection(1); });
    update({ markdown: onChange.mock.lastCall![0] });
    const before = editor.state.doc;
    await act(async () => { pending.resolve(hybrid); await completion; await memo.current!.onSessionEnd?.("dictation-session"); });
    expect(screen.queryByRole("region", { name: "Review dictation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(editor.getMarkdown()).toContain("New Alpha");
    expect(editor.getMarkdown()).toContain("todo board-launch due=2026-11-19 urgency=high");
    expect(editor.getMarkdown()).not.toContain("origin=board");
    expect(editor.getMarkdown().indexOf("This may help.")).toBeLessThan(editor.getMarkdown().indexOf("ticket-"));
    expect(editor.getMarkdown().indexOf("Then keep thinking.")).toBeGreaterThan(editor.getMarkdown().indexOf("ticket-"));
    expect(memo.current?.disabled).not.toBe(true);
    expect(screen.getByRole("button", { name: "Use original dictation" })).toBeInTheDocument();
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(screen.queryByRole("button", { name: "Use original dictation" })).not.toBeInTheDocument();
  });

  it("offers immediate original recovery after insertion and makes recovery undoable", async () => {
    const { editor } = await fixture({ onPrepareDictation: vi.fn().mockResolvedValue(hybrid) });
    const session = await start(editor);
    await act(async () => { await session.complete(); });
    const structured = editor.state.doc;
    fireEvent.click(screen.getByRole("button", { name: "Use original dictation" }));
    expect(editor.getMarkdown()).toBe(`Alpha ${hybrid.original} beta`);
    expect(editor.getMarkdown()).not.toContain("orion-ticket");
    act(() => { editor.commands.undo(); });
    expect(editor.state.doc.eq(structured)).toBe(true);
  });

  it("invalidates original replacement after further writing or an external replacement", async () => {
    const { editor, update } = await fixture({ onPrepareDictation: vi.fn().mockResolvedValue(hybrid) });
    const session = await start(editor);
    await act(async () => { await session.complete(); });
    const recover = screen.getByRole("button", { name: "Use original dictation" });
    act(() => { editor.commands.insertContentAt(1, "Later "); });
    const edited = editor.getMarkdown();
    expect(screen.queryByRole("button", { name: "Use original dictation" })).not.toBeInTheDocument();
    fireEvent.click(recover);
    expect(editor.getMarkdown()).toBe(edited);
    update({ markdown: "Replacement." });
    fireEvent.click(recover);
    expect(editor.getMarkdown()).toBe("Replacement.");
  });

  it("leaves a disappeared board unassigned without delaying insertion", async () => {
    const pending = deferred<PreparedDictation>();
    const { editor, update } = await fixture({ notes: [boardNote], onPrepareDictation: vi.fn().mockReturnValue(pending.promise) });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    update({ notes: [] });
    await act(async () => { pending.resolve(hybrid); await completion; });
    expect(editor.getMarkdown()).toContain("todo - due=2026-11-19 urgency=high");
  });

  it("uses a live board rename before its autosave echo when resolving dictated tickets", async () => {
    const pending = deferred<PreparedDictation>();
    const note = { ...boardNote, id: "dictation-note", body: `${boardNote.body}\n\nAlpha beta` };
    const { editor } = await fixture({ markdown: note.body, notes: [note], onPrepareDictation: vi.fn().mockReturnValue(pending.promise) });
    const session = await start(editor, editor.state.doc.content.size - 1);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    act(() => {
      const board = editor.state.doc.firstChild!;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(0, undefined, { ...board.attrs, title: "Renamed" }));
    });
    await act(async () => { pending.resolve(hybrid); await completion; });
    expect(editor.getMarkdown()).toContain("board-launch Renamed");
    expect(editor.getMarkdown()).toContain("todo - due=2026-11-19 urgency=high");
    expect(editor.getMarkdown()).not.toContain("todo board-launch");
  });

  it("keeps dictated tickets unassigned if a duplicate destination appears during cleanup", async () => {
    const pending = deferred<PreparedDictation>();
    const { editor, update } = await fixture({ notes: [boardNote], onPrepareDictation: vi.fn().mockReturnValue(pending.promise) });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    update({ notes: [boardNote, { ...boardNote, id: "second-board-note", body: "<!-- orion-kanban:v1 board-copy Launch -->" }] });
    await act(async () => { pending.resolve(hybrid); await completion; });
    expect(editor.getMarkdown()).toContain("todo - due=2026-11-19 urgency=high");
  });

  it("falls back to faithful cleaned text if structured output is invalid", async () => {
    const invalid = { ...hybrid, proposal: { blocks: [{ ...hybrid.proposal!.blocks[1], boardId: "forbidden" }] } };
    const { editor } = await fixture({ onPrepareDictation: vi.fn().mockResolvedValue(invalid) });
    const session = await start(editor);
    await act(async () => { await session.complete(); });
    expect(editor.getMarkdown()).toBe(`Alpha ${hybrid.blocks![0].text} beta`);
    expect(editor.getMarkdown()).not.toContain("orion-ticket");
  });

  it("removes recovery on navigation and never applies a detached action to the next note", async () => {
    const { editor, update, container } = await fixture({ onPrepareDictation: vi.fn().mockResolvedValue(hybrid) });
    const session = await start(editor);
    await act(async () => { await session.complete(); });
    const recover = screen.getByRole("button", { name: "Use original dictation" });
    update({ noteId: "another-note", markdown: "Different note." });
    await waitFor(() => expect(container.querySelector(".tiptap")?.textContent).toBe("Different note."));
    fireEvent.click(recover);
    expect(container.querySelector(".tiptap")?.textContent).toBe("Different note.");
    expect(screen.queryByRole("button", { name: "Use original dictation" })).not.toBeInTheDocument();
  });

  it("waits for cleanup and maps its original caret through typing without following a moved cursor", async () => {
    const pending = deferred<PreparedDictation>();
    const prepare = vi.fn().mockReturnValue(pending.promise);
    const { editor, onChange, update } = await fixture({ onPrepareDictation: prepare });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete("Um, spoken words."); });
    expect(prepare).toHaveBeenCalledWith("dictation-session", "Um, spoken words.", {
      onPhase: session.options.onPhase, signal: expect.any(AbortSignal),
    });
    expect(prepare.mock.calls[0][2].signal.aborted).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      editor.commands.insertContentAt(1, "New ");
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    });
    expect(editor.getMarkdown()).toBe("New Alpha beta");
    // Normal parent/autosave echoes acknowledge typing; they are not an
    // external replacement and must not invalidate the dictation capture.
    update({ markdown: onChange.mock.lastCall![0] });
    await act(async () => {
      pending.resolve({ original: "Um, spoken words.", blocks: [{ kind: "paragraph", text: "Spoken words." }], notice: "Cleaned" });
      await completion;
    });
    expect(editor.getMarkdown()).toBe("New Alpha Spoken words. beta");
    expect(onChange.mock.lastCall![0]).toBe("New Alpha Spoken words. beta");
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("New Alpha beta");
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("Alpha beta");
  });

  it("inserts real bullets and to-dos in one Undo without changing neighboring prose", async () => {
    const prepare = vi.fn().mockResolvedValue({
      original: "Agenda budget and timeline. To do send the agenda.", notice: "Cleaned",
      blocks: [
        { kind: "bullet", text: "Budget" }, { kind: "bullet", text: "Timeline" },
        { kind: "todo", text: "Send the agenda" },
      ],
    });
    const { editor } = await fixture({ markdown: "BeforeAfter", onPrepareDictation: prepare });
    const session = await start(editor, 7);
    await act(async () => { await session.complete(); });
    expect(editor.getMarkdown()).toBe("Before\n\n- Budget\n- Timeline\n\n- [ ] Send the agenda\n\nAfter");
    expect(editor.view.dom.querySelectorAll('ul[data-type="taskList"] input[type="checkbox"]')).toHaveLength(1);
    expect(editor.view.dom.querySelector('input[type="checkbox"]')).not.toBeChecked();
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("BeforeAfter");
  });

  it("keeps ordinary local dictation available without a cleanup callback", async () => {
    const { editor } = await fixture();
    const session = await start(editor);
    await act(async () => { await session.complete("Um, keep the original."); });
    expect(editor.getMarkdown()).toBe("Alpha Um, keep the original. beta");
  });

  it("archives and inserts already-transcribed speech without cleanup when capture supplies an aborted signal", async () => {
    const preserveOriginal = vi.fn().mockResolvedValue("source-partial");
    const clean = vi.fn().mockResolvedValue({ blocks: [{ kind: "paragraph", text: "Must not be used." }] });
    const { editor } = await fixture({ onPrepareDictation: (_id, transcript, options) => prepareDictation({
      transcript, aiAvailable: true, preserveOriginal, clean, ...options,
    }) });
    const session = await start(editor);
    session.options.signal = AbortSignal.abort(new Error("A later segment could not be transcribed."));
    await act(async () => { await session.complete("Already transcribed words."); });
    expect(preserveOriginal).toHaveBeenCalledTimes(1);
    expect(clean).not.toHaveBeenCalled();
    expect(editor.getMarkdown()).toBe("Alpha Already transcribed words. beta");
    act(() => { editor.commands.undo(); });
    expect(editor.getMarkdown()).toBe("Alpha beta");
  });

  it("keeps partial transcript recovery attached to the old session when navigation happens during archival", async () => {
    const saved = deferred<string>();
    const preserveOriginal = vi.fn().mockReturnValue(saved.promise);
    const clean = vi.fn();
    const { editor, update, container, onChange } = await fixture({ onPrepareDictation: (_id, transcript, options) => prepareDictation({
      transcript, aiAvailable: true, preserveOriginal, clean, ...options,
    }) });
    const session = await start(editor);
    session.options.signal = AbortSignal.abort(new Error("A segment failed."));
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete("Recovered portion."); });
    expect(preserveOriginal).toHaveBeenCalledTimes(1);
    update({ noteId: "another-note", markdown: "Other writing." });
    onChange.mockClear();
    await act(async () => {
      saved.resolve("source-partial");
      await expect(completion).rejects.toThrow(/original is saved in Sources/);
    });
    expect(clean).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(container.querySelector(".tiptap")?.textContent).toBe("Other writing.");
  });

  it("inserts the complete original if the preparation callback rejects", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error("Cleanup is unavailable."));
    const { editor } = await fixture({ onPrepareDictation: prepare });
    const session = await start(editor);
    await act(async () => { await session.complete("Um, maybe Thursday, I think."); });
    expect(editor.getMarkdown()).toBe("Alpha Um, maybe Thursday, I think. beta");
  });

  it("does not publish a late cleanup after unmounting the captured editor", async () => {
    const pending = deferred<PreparedDictation>();
    const prepare = vi.fn().mockReturnValue(pending.promise);
    const { editor, onChange, unmount } = await fixture({ onPrepareDictation: prepare });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    unmount();
    expect(prepare.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => {
      pending.resolve({ original: "Original words.", blocks: [{ kind: "paragraph", text: "Late words." }], notice: "Cleaned" });
      await expect(completion).rejects.toThrow(/note changed/);
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never inserts a previous note's cleanup into a newly selected note", async () => {
    const pending = deferred<PreparedDictation>();
    const { editor, onChange, update, container } = await fixture({ onPrepareDictation: vi.fn().mockReturnValue(pending.promise) });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    update({ noteId: "another-note", markdown: "Different note." });
    await waitFor(() => expect(container.querySelector(".tiptap")?.textContent).toBe("Different note."));
    onChange.mockClear();
    await act(async () => {
      pending.resolve({ original: "Original words.", blocks: [{ kind: "paragraph", text: "Late words." }], notice: "Cleaned" });
      await expect(completion).rejects.toThrow(/note changed/);
    });
    expect(container.querySelector(".tiptap")?.textContent).toBe("Different note.");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("invalidates the captured insertion when external Markdown replaces the note", async () => {
    const pending = deferred<PreparedDictation>();
    const { editor, onChange, update } = await fixture({ onPrepareDictation: vi.fn().mockReturnValue(pending.promise) });
    const session = await start(editor);
    let completion!: Promise<string | void>;
    act(() => { completion = session.complete(); });
    update({ markdown: "Externally replaced text." });
    expect(editor.getMarkdown()).toBe("Externally replaced text.");
    onChange.mockClear();
    await act(async () => {
      pending.resolve({ original: "Original words.", blocks: [{ kind: "paragraph", text: "Late words." }], sourceId: "source-dictation-session", notice: "Cleaned" });
      await expect(completion).rejects.toThrow(/original is saved in Sources/);
    });
    expect(editor.getMarkdown()).toBe("Externally replaced text.");
    expect(onChange).not.toHaveBeenCalled();
  });
});
