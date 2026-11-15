// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import TaskList from "@tiptap/extension-task-list";
import { TableKit } from "@tiptap/extension-table";
import { NoteTable } from "./NoteTable";
import { NoteKanban } from "./NoteKanban";
import type { DictationProposal } from "../../lib/dictationCleanup";
import { NoteStarterKit, NoteTaskItem } from "./NoteStarterKit";
import { afterEach, describe, expect, it } from "vitest";
import { insertCleanedVoiceTranscriptAt, insertVoiceTranscriptAt, insertStructuredVoiceTranscriptAt,
  restoreOriginalDictation } from "./voiceDictation";

const editors: Editor[] = [];

function createEditor(content: string) {
  const editor = new Editor({
    extensions: [
      NoteStarterKit,
      NoteKanban,
      TableKit.configure({ table: false }),
      NoteTable,
      TaskList,
      NoteTaskItem.configure({ nested: true }),
      Markdown.configure({ markedOptions: { gfm: true } }),
    ],
    content,
    contentType: "markdown",
  });
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("voice dictation insertion", () => {
  const raw = "I think this may help. Launch work: fix <img src=x> **literal**, then test it. Make a ticket to call Jo on Launch. Remember to buy milk. Small costs ten dollars, Medium twenty dollars.";
  const mixed: DictationProposal = { blocks: [
    { kind: "paragraph", text: "I think this may help." },
    { kind: "kanban", text: "Launch", evidence: "Launch work: fix <img src=x> **literal**, then test it.", tickets: [
      { text: "Fix <img src=x> **literal**", evidence: "fix <img src=x> **literal**", dueDate: "", urgency: "" },
      { text: "Test it", evidence: "then test it", dueDate: "", urgency: "" },
    ] },
    { kind: "ticket", text: "Call Jo", evidence: "Make a ticket to call Jo on Launch.", boardName: "Launch", dueDate: "2026-11-19", urgency: "high" },
    { kind: "todo", text: "Buy milk" },
    { kind: "table", text: "", evidence: "Small costs ten dollars, Medium twenty dollars.", columns: ["Edition", "Cost", "Notes"], rows: [["Small", "$10", ""], ["Medium", "$20", ""]] },
  ] };

  it("inserts fresh linked boards, tickets, ordinary todos and editable tables together in one Undo", () => {
    const editor = createEditor("BeforeAfter");
    const before = editor.state.doc;
    expect(insertStructuredVoiceTranscriptAt(editor, 7, mixed, raw, [], before)).toBe(true);
    const after = editor.state.doc;
    const tasks: Array<Record<string, unknown>> = [];
    let boardId = "";
    editor.state.doc.descendants(node => {
      if (node.type.name === "taskItem") tasks.push(node.attrs);
      if (node.type.name === "noteKanban") boardId = node.attrs.boardId;
    });
    expect(boardId).toMatch(/^board-/);
    expect(tasks).toHaveLength(4);
    expect(tasks[0]).toMatchObject({ checked: false, ticketStatus: "todo", ticketBoard: boardId });
    expect(tasks[1].ticketBoard).toBe(boardId);
    expect(tasks[2]).toMatchObject({ ticketBoard: boardId, ticketDueDate: "2026-11-19", ticketUrgency: "high" });
    expect(new Set(tasks.slice(0, 3).map(task => task.ticketId)).size).toBe(3);
    expect(tasks[3].ticketId).toBeFalsy();
    expect(tasks[0].ticketOrigin).toBeFalsy();
    expect(editor.view.dom.querySelector("img")).toBeNull();
    expect(editor.view.dom.querySelectorAll("table th")).toHaveLength(3);
    expect(editor.view.dom.querySelectorAll("table td")).toHaveLength(6);
    expect(editor.state.doc.textContent).toContain("<img src=x> **literal**");
    expect(editor.state.doc.firstChild?.textContent).toBe("Before");
    expect(editor.state.doc.lastChild?.textContent).toBe("After");
    const reloaded = createEditor(editor.getMarkdown());
    expect(reloaded.state.doc.textContent).toBe(after.textContent);
    expect(reloaded.getMarkdown()).toContain(boardId);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.eq(after)).toBe(true);
  });

  it("rejects malformed or stale insertions before any mutation", () => {
    const editor = createEditor("Keep this.");
    const before = editor.state.doc;
    const ticket = { kind: "ticket" as const, text: "Call Jo", evidence: "Make a ticket to call Jo on Launch.", boardName: "Launch", dueDate: "", urgency: "" as const };
    expect(insertStructuredVoiceTranscriptAt(editor, 1, { blocks: [{ ...ticket, dueDate: "2026-02-30" }] }, raw, [], before)).toBe(false);
    expect(insertStructuredVoiceTranscriptAt(editor, 1, { blocks: [{ ...ticket, text: "a".repeat(141) }] }, raw, [], before)).toBe(false);
    expect(editor.state.doc.eq(before)).toBe(true);
    editor.commands.insertContentAt(1, "Changed ");
    const changed = editor.state.doc;
    expect(insertStructuredVoiceTranscriptAt(editor, 1, mixed, raw, [], before)).toBe(false);
    expect(editor.state.doc.eq(changed)).toBe(true);
  });

  it("gives repeated mixed dictations distinct identities and independent Undo while keeping nested boards linked", () => {
    const editor = createEditor("");
    const empty = editor.state.doc;
    expect(insertStructuredVoiceTranscriptAt(editor, 1, mixed, raw, [], empty)).toBe(true);
    const first = editor.state.doc;
    const firstBoard = first.content.content.find(node => node.type.name === "noteKanban")!;
    const firstTicketIds = new Set<string>();
    first.descendants(node => { if (node.attrs.ticketId) firstTicketIds.add(node.attrs.ticketId); });
    expect(insertStructuredVoiceTranscriptAt(editor, first.content.size, mixed, raw,
      [{ id: firstBoard.attrs.boardId, title: "Launch", noteId: "note" }], first)).toBe(true);
    const second = editor.state.doc;
    const boardIds: string[] = [], ticketIds: string[] = [], assignments: string[] = [];
    second.descendants(node => {
      if (node.type.name === "noteKanban") boardIds.push(node.attrs.boardId);
      if (node.attrs.ticketId) { ticketIds.push(node.attrs.ticketId); assignments.push(node.attrs.ticketBoard); }
    });
    expect(new Set(boardIds).size).toBe(2);
    expect(new Set(ticketIds).size).toBe(6);
    expect(ticketIds.slice(3).some(id => firstTicketIds.has(id))).toBe(false);
    expect(assignments).toEqual([boardIds[0], boardIds[0], boardIds[0], boardIds[1], boardIds[1], ""]);
    const reloaded = createEditor(editor.getMarkdown());
    expect(reloaded.state.doc.textContent).toBe(second.textContent);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(first)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(empty)).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.commands.redo()).toBe(true);
    expect(editor.state.doc.eq(second)).toBe(true);
  });

  it.each([{ boards: [] }, { boards: [{ id: "board-one", title: "Launch", noteId: "note" }, { id: "board-two", title: "Launch", noteId: "note" }] }])("leaves missing or ambiguous existing board names unassigned", ({ boards }) => {
    const editor = createEditor("");
    const ticket = mixed.blocks[2];
    expect(insertStructuredVoiceTranscriptAt(editor, 1, { blocks: [ticket] }, raw, boards, editor.state.doc)).toBe(true);
    expect(editor.getMarkdown()).toContain("todo - due=2026-11-19 urgency=high");
  });

  it("restores the raw transcript without losing surrounding prose and can undo back to the structured result", () => {
    const editor = createEditor("BeforeAfter");
    const before = editor.state.doc;
    expect(insertStructuredVoiceTranscriptAt(editor, 7, mixed, raw, [], before)).toBe(true);
    const after = editor.state.doc;
    expect(restoreOriginalDictation(editor, before, after, 7, raw)).toBe(true);
    expect(editor.state.doc.textContent).toBe(`Before ${raw} After`);
    expect(editor.getMarkdown()).not.toContain("orion-ticket");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(after)).toBe(true);
    editor.commands.insertContentAt(1, "Later ");
    const edited = editor.state.doc;
    expect(restoreOriginalDictation(editor, before, after, 7, raw)).toBe(false);
    expect(editor.state.doc.eq(edited)).toBe(true);
  });

  it("round trips literal table separators and markup without executing it or losing empty cells", () => {
    const editor = createEditor("");
    const evidence = "Compare A | B with <script>alert(1)</script>, and keep the other value unknown.";
    const proposal: DictationProposal = { blocks: [{
      kind: "table", text: "", evidence, columns: ["Option", "Value"],
      rows: [["A | B", "<script>alert(1)</script>"], ["Unknown", ""]],
    }] };
    expect(insertStructuredVoiceTranscriptAt(editor, 1, proposal, evidence, [], editor.state.doc)).toBe(true);
    const after = editor.state.doc;
    expect(editor.view.dom.querySelector("script")).toBeNull();
    const reloaded = createEditor(editor.getMarkdown());
    expect(reloaded.state.doc.textContent).toBe(after.textContent);
    expect(reloaded.view.dom.querySelector("script")).toBeNull();
    expect(reloaded.view.dom.querySelectorAll("table td")).toHaveLength(4);
    expect(reloaded.view.dom.querySelectorAll("table td")[3].textContent).toBe("");
  });

  it("inserts normalized speech at the chosen text cursor", () => {
    const editor = createEditor("Alpha beta");

    expect(
      insertVoiceTranscriptAt(editor, 6, "  A spoken thought.  "),
    ).toBe(true);
    expect(editor.getMarkdown()).toBe("Alpha A spoken thought. beta");
  });

  it("does not create an editor transaction for an empty transcript", () => {
    const editor = createEditor("Keep this.");

    expect(insertVoiceTranscriptAt(editor, 1, "   ")).toBe(false);
    expect(editor.getMarkdown()).toBe("Keep this.");
  });

  it("inserts a cleaned sentence inline without replacing the current selection", () => {
    const editor = createEditor("Alpha beta");
    editor.commands.setTextSelection({ from: 1, to: 6 });

    expect(insertCleanedVoiceTranscriptAt(editor, 6, [
      { kind: "paragraph", text: "A spoken thought." },
    ])).toBe(true);
    expect(editor.getMarkdown()).toBe("Alpha A spoken thought. beta");
  });

  it("groups bullets and unchecked tasks as ordinary editable list nodes", () => {
    const editor = createEditor("");

    expect(insertCleanedVoiceTranscriptAt(editor, 1, [
      { kind: "paragraph", text: "For Thursday:" },
      { kind: "bullet", text: "Budget" },
      { kind: "bullet", text: "Timeline" },
      { kind: "todo", text: "Send the agenda" },
      { kind: "todo", text: "Book the room" },
      { kind: "paragraph", text: "I think that should work." },
    ])).toBe(true);
    expect(editor.state.doc.content.content.map(node => node.type.name)).toEqual([
      "paragraph", "bulletList", "taskList", "paragraph",
    ]);
    expect(editor.state.doc.child(1).childCount).toBe(2);
    expect(editor.state.doc.child(2).childCount).toBe(2);
    expect(editor.state.doc.child(2).child(0).attrs.checked).toBe(false);
    expect(editor.getMarkdown()).toBe(
      "For Thursday:\n\n- Budget\n- Timeline\n\n- [ ] Send the agenda\n- [ ] Book the room\n\nI think that should work.",
    );
  });

  it("preserves prose on both sides when inserting blocks in a paragraph", () => {
    const editor = createEditor("BeforeAfter");
    expect(insertCleanedVoiceTranscriptAt(editor, 7, [
      { kind: "bullet", text: "First" },
      { kind: "bullet", text: "Second" },
    ])).toBe(true);
    expect(editor.getMarkdown()).toBe("Before\n\n- First\n- Second\n\nAfter");
  });

  it.each([1, 6])("preserves surrounding prose at paragraph boundary %i", position => {
    const editor = createEditor("Words");
    expect(insertCleanedVoiceTranscriptAt(editor, position, [
      { kind: "paragraph", text: "First thought." },
      { kind: "paragraph", text: "Perhaps another." },
    ])).toBe(true);
    expect(editor.state.doc.textContent).toBe(position === 1
      ? "First thought.Perhaps another.Words"
      : "WordsFirst thought.Perhaps another.");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("Words");
  });

  it("treats HTML, Markdown, links, and multilingual speech as literal text", () => {
    const editor = createEditor("");
    const literal = "<script>alert(1)</script> **bold** [link](https://example.com) 你好 — peut-être";
    expect(insertCleanedVoiceTranscriptAt(editor, 1, [
      { kind: "bullet", text: literal },
      { kind: "todo", text: "- [x] quoted task" },
    ])).toBe(true);
    expect(editor.state.doc.child(0).textContent).toBe(literal);
    expect(editor.state.doc.child(1).textContent).toBe("- [x] quoted task");
    editor.state.doc.descendants(node => {
      expect(node.marks).toEqual([]);
      expect(["paragraph", "bulletList", "listItem", "taskList", "taskItem", "text"]).toContain(node.type.name);
    });
    expect(editor.view.dom.querySelector("script,a,strong")).toBeNull();
    const reloaded = createEditor(editor.getMarkdown());
    expect(reloaded.state.doc.textContent).toBe(editor.state.doc.textContent);
    expect(reloaded.view.dom.querySelector("script,strong")).toBeNull();
    // Ordinary URL autolinking may recognize a visible address on reload;
    // the provider's bracket syntax must never become a labelled link.
    expect(reloaded.view.dom.querySelector("a")?.textContent).toBe("https://example.com");
  });

  it.each(["plain", "structured"])("undoes %s dictation independently of preceding and subsequent typing", mode => {
    const editor = createEditor("Start");
    editor.commands.insertContentAt(6, " typed");
    const before = editor.state.doc;
    if (mode === "plain") expect(insertVoiceTranscriptAt(editor, 12, "Dictation.")).toBe(true);
    else expect(insertCleanedVoiceTranscriptAt(editor, 12, [
      { kind: "bullet", text: "First" },
      { kind: "todo", text: "Second" },
    ])).toBe(true);
    const dictated = editor.state.doc;
    editor.commands.insertContent(" afterward");
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(dictated)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.state.doc.eq(before)).toBe(true);
    expect(editor.commands.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe("Start");
  });

  it("rejects malformed blocks without changing text or selection", () => {
    const editor = createEditor("Keep this.");
    editor.commands.setTextSelection(3);
    const before = editor.state;
    expect(insertCleanedVoiceTranscriptAt(editor, 1, [])).toBe(false);
    expect(insertCleanedVoiceTranscriptAt(editor, 1, [{ kind: "paragraph", text: " " }])).toBe(false);
    expect(insertCleanedVoiceTranscriptAt(editor, Number.NaN, [{ kind: "paragraph", text: "Hi" }])).toBe(false);
    expect(editor.state).toBe(before);
  });
});
