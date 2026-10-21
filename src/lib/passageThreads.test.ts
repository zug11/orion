import { expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { Note, ChatRequest } from "../types";
import { spaceNoteVersion } from "./spaceKnowledge";
import type { VoiceSelection } from "./voiceSelection";
import { addHumanPassageComment, passageComments, passageArticleReference, passageConversationSnapshot, isPassageThreads, locatePassage, passageAnchorFromSelection, passageIsCurrent, passagePlainText, threadEditProposal, validatePassageRewrite } from "./passageThreads";
import { portableChatEvidence } from "./chatCitations";
import { buildGenerateWritingRequest, createGeneratePlaceholderNote } from "./generate";
import { runChatReading } from "./chatReading";
import { applyChatResult } from "./chat";
import { chatProposalBody } from "./chatEdits";
const now = "2026-10-12T00:00:00.000Z";

it("saves human comments as local metadata, retains existing notes and safely retries the same draft", () => {
  const { snapshot, note, selection } = fixture();
  const original = structuredClone(snapshot);
  const saved = addHumanPassageComment(snapshot, selection, "  Develop this image.  ", "human", now);
  expect(snapshot).toEqual(original);
  expect(saved.notes[0].body).toBe(note.body);
  expect(saved.studio).toEqual(snapshot.studio);
  const thread = saved.notes[0].discussionThreads![0];
  expect(thread).toMatchObject({ state: "open", anchor: { quote: "warm light" }, messages: [{ role: "user", content: "Develop this image." }] });
  expect(isPassageThreads(saved.notes[0].discussionThreads)).toBe(true);
  expect(addHumanPassageComment(saved, selection, "Develop this image.", "human", now)).toBe(saved);
  expect(() => addHumanPassageComment(saved, selection, "Different", "human", now)).toThrow(/already saved/);
  expect(passageArticleReference(saved, saved.notes[0], thread, thread.messages[0].id).comment).toBe("Develop this image.");
  expect(passageComments({ ...thread, messages: [...thread.messages, { ...thread.messages[0], id: "prompt", content: "A private follow-up prompt" }] })).toEqual(thread.messages);
});

it("rejects stale, foreign, empty, oversized and excessive human comments without touching the note", () => {
  const { snapshot, selection } = fixture();
  expect(() => addHumanPassageComment(snapshot, { ...selection, spaceId: "elsewhere" }, "Comment", "h", now)).toThrow(/original Space/);
  expect(() => addHumanPassageComment(snapshot, { ...selection, version: "old" }, "Comment", "h", now)).toThrow(/changed/);
  expect(() => addHumanPassageComment(snapshot, selection, " ", "h", now)).toThrow(/Write a comment/);
  expect(() => addHumanPassageComment(snapshot, selection, "a".repeat(12001), "h", now)).toThrow(/12,000/);
  const saved = addHumanPassageComment(snapshot, selection, "Comment", "h", now);
  snapshot.notes[0].discussionThreads = Array.from({ length: 32 }, (_, i) => ({ ...saved.notes[0].discussionThreads![0], id: `t${i}` }));
  expect(() => addHumanPassageComment(snapshot, selection, "Comment", "new", now)).toThrow(/limit/);
});

it("develops a comment and its original passage as bounded article context without serialised citations or unrelated chat", () => {
  const { snapshot, note, selection } = fixture();
  const anchor = passageAnchorFromSelection(snapshot, selection);
  const content = portableChatEvidence("Consider the narrator. [[e1]]\n\n" + "Nuance. ".repeat(250) + "The closing image matters.", [{
    id: "e1", kind: "note", entityId: note.id, title: note.title, version: spaceNoteVersion(note), start: 0, end: note.body.length, text: note.body, offsetUnit: "utf16",
  }]);
  const thread = { id: "t", state: "open" as const, anchor, createdAt: now, updatedAt: now,
    messages: [{ id: "m", role: "assistant" as const, content, createdAt: now }] };
  note.discussionThreads = [thread];
  const passage = passageArticleReference(snapshot, note, thread, "m");
  expect(passage.passage).toBe("warm light");
  expect(passage.comment).toContain("The closing image matters.");
  expect(passage.comment).not.toMatch(/orion-passage|Cited passages|&#46;/);
  snapshot.notes.push({ ...note, id: "unrelated", title: "Private unrelated note", body: "Not attached" });
  snapshot.notes.push(createGeneratePlaceholderNote({ id: "out", title: "Article", kind: "note", now }));
  const request = buildGenerateWritingRequest(snapshot, { originNoteId: "out", kind: "note", instruction: "Develop this idea.", useSpaceNotes: false, passage });
  expect(request.notes).toHaveLength(3);
  expect(request.notes[1].body).toBe("warm light");
  expect(request.notes[2].body).toContain("The closing image matters.");
  expect(JSON.stringify(request)).not.toMatch(/orion-passage:v1|Private unrelated note/);
  expect(request.history).toEqual([]);
  expect(request.prompt).toContain("standalone article");
  expect(() => buildGenerateWritingRequest(snapshot, { originNoteId: "out", kind: "note", instruction: "", passage: { ...passage, spaceId: "foreign" } })).toThrow(/another Space/);
});

it("does not generate from pending, stale, or completed-task passages", () => {
  const { snapshot, note } = fixture("- [x] Finished secret work");
  const thread = { id: "t", state: "open" as const, anchor: { quote: "Finished secret work", text: "Finished secret work" }, createdAt: now, updatedAt: now,
    messages: [{ id: "m", role: "assistant" as const, content: "Develop this.", createdAt: now }] };
  note.discussionThreads = [thread];
  expect(() => passageArticleReference(snapshot, note, thread, "m")).toThrow(/completed work/);
  note.body = "Different passage.";
  expect(() => passageArticleReference(snapshot, note, thread, "m")).toThrow(/reattach/);
  note.body = "Finished secret work";
  expect(() => passageArticleReference(snapshot, note, { ...thread, state: "proposed" }, "m")).toThrow(/Accept/);
});
function fixture(body = "Before **warm light** after.\n\nAnother paragraph.") {
  const snapshot = createEmptySnapshot("Test", now, "space");
  const note: Note = { id: "note", title: "Draft", slug: "draft", body, summary: "", aliases: [], tags: [], sourceIds: [], conceptIds: [], kind: "article", status: "ready", createdAt: now, updatedAt: now };
  snapshot.notes = [note];
  const selection: VoiceSelection = { id: "sel", spaceId: "space", noteId: "note", noteTitle: "Draft", version: spaceNoteVersion(note), text: "warm light", range: { from: 7, to: 17, unit: "dom-text-utf16" }, hiddenTaskRanges: [] };
  return { snapshot, note, selection };
}
it("uses exact text or a uniquely containing formatted block, rejecting stale, foreign and repeated passages", () => {
  const { snapshot, note, selection } = fixture();
  expect(passageAnchorFromSelection(snapshot, selection)).toEqual({ quote: "warm light", text: "warm light" });
  expect(passageAnchorFromSelection(snapshot, { ...selection, text: "Before warm light after." }).quote).toBe("Before **warm light** after.");
  expect(() => passageAnchorFromSelection(snapshot, { ...selection, spaceId: "foreign" })).toThrow();
  expect(() => passageAnchorFromSelection(snapshot, { ...selection, version: "old" })).toThrow();
  note.body += "\n\nBefore **warm light** after.";
  expect(() => passageAnchorFromSelection(snapshot, { ...selection, version: spaceNoteVersion(note) })).toThrow();
});
it("keeps inline typography and Unicode boundaries, rejects ambiguous rendered targets", () => {
  expect(passagePlainText("some**word**s with [light](https://example.com) &amp; rain")).toBe("somewords with light & rain");
  expect(locatePassage("A 🧭  warm\nlight.", "🧭 warm light")).toEqual({ from: 2, to: 16 });
  expect(locatePassage("same same", "same")).toBeUndefined();
});
it("adds after the containing block and makes a review proposal without mutating prose", () => {
  const { snapshot, note, selection } = fixture();
  const anchor = passageAnchorFromSelection(snapshot, selection);
  const proposal = threadEditProposal(snapshot, note.id, anchor, "A new paragraph.", "addition");
  expect(proposal.edits?.[0]).toEqual({ before: "Before **warm light** after.", after: "Before **warm light** after.\n\nA new paragraph." });
  expect(note.body).toBe(proposal.baseBody);
  note.body = "Different prose.";
  expect(passageIsCurrent(note, anchor)).toBe(false);
  expect(() => threadEditProposal(snapshot, note.id, anchor, "Replacement", "rewrite")).toThrow(/changed/);
});
it("adds only the comment prose when its retained citation is larger than the edit limit", () => {
  const { snapshot, note, selection } = fixture("Before **warm light** after.\n\n" + "Background material. ".repeat(130));
  const anchor = passageAnchorFromSelection(snapshot, selection);
  const prose = "Let the image return in the closing paragraph. See [this reference](https://example.com).";
  const content = portableChatEvidence(prose + " [[e1]]", [{
    id: "e1", kind: "note", entityId: note.id, title: note.title, version: spaceNoteVersion(note), start: 0, end: note.body.length, text: note.body, offsetUnit: "utf16",
  }]);
  expect(content.length).toBeGreaterThan(6000);
  const original = note.body;
  const proposal = threadEditProposal(snapshot, note.id, anchor, content, "addition");
  expect(chatProposalBody(proposal)).toBe(original.replace("Before **warm light** after.", "Before **warm light** after.\n\n" + prose));
  expect(note.body).toBe(original);
  expect(content).toContain("orion-passage:v1:");
});
it("keeps oversized passage edits bounded and gives a useful recovery action", () => {
  const { snapshot, note, selection } = fixture();
  const anchor = passageAnchorFromSelection(snapshot, selection);
  expect(() => threadEditProposal(snapshot, note.id, anchor, "A".repeat(6000), "addition")).toThrow(/shorter.*Generate article/);
  expect(() => threadEditProposal(snapshot, note.id, anchor, "<!-- orion-metadata -->", "rewrite")).toThrow(/invalid text change/);
});
it("validates optional backwards-compatible metadata and bounded proposals", () => {
  expect(isPassageThreads([])).toBe(true);
  const thread = { id: "t", anchor: { quote: "text", text: "text" }, state: "proposed", createdAt: now, updatedAt: now, messages: [{ id: "m", role: "assistant", content: "Comment", createdAt: now, proposal: { kind: "rewrite", text: "Replacement" } }] };
  expect(isPassageThreads([thread])).toBe(true);
  expect(isPassageThreads([thread, thread])).toBe(false);
  expect(isPassageThreads([{ ...thread, messages: [] }])).toBe(false);
  expect(isPassageThreads([{ ...thread, messages: [{ ...thread.messages[0], content: "x".repeat(12001) }] }])).toBe(false);
});
it("sends highlighted text as reference with exact note evidence and no creation authority", async () => {
  const { snapshot, selection } = fixture();
  const driver = vi.fn(async (request: ChatRequest) => {
    expect(request.history.some(message => message.content.includes("warm light"))).toBe(true);
    expect(JSON.parse(request.readingContext!).evidence.some((item: {text:string}) => item.text.includes("warm light"))).toBe(true);
    expect(request.allowNoteActions).toBe(false);
    return { reply: "The phrase is evocative." };
  });
  await runChatReading(snapshot, "What do you think of this?", driver, { focusNoteId: "note", selection });
  expect(driver).toHaveBeenCalledTimes(1);
  await expect(runChatReading(snapshot, "this?", driver, { focusNoteId: "note", selection: { ...selection, version: "old" } })).rejects.toThrow(/no longer current/);
  expect(driver).toHaveBeenCalledTimes(1);
});
it("persists the original request anchor alongside the reply, independently of later selection", () => {
  const { snapshot, selection } = fixture();
  const passage = { noteId: "note", anchor: passageAnchorFromSelection(snapshot, selection) };
  let id = 0;
  const next = applyChatResult(snapshot, "Discuss this.", { reply: "A comment." }, now, () => `m${id++}`, undefined, passage);
  selection.text = "Another paragraph.";
  expect(next.studio.messages[1].passage).toEqual({ noteId: "note", anchor: { quote: "warm light", text: "warm light" } });
  expect(next.notes[0].body).toBe(snapshot.notes[0].body);
});

it("discarding new agent proposals preserves the accepted discussion", async () => {
  const { reviewPassageComment, validatePassageRewrite } = await import("./passageThreads");
  const accepted = { id: "m", role: "assistant" as const, content: "Original comment", createdAt: now };
  const thread = { id: "t", anchor: { quote: "warm light", text: "warm light" }, state: "proposed" as const, createdAt: now, updatedAt: now,
    messages: [accepted, { ...accepted, id: "new", content: "Proposed follow-up", pending: true }] };
  expect(reviewPassageComment(thread, false)?.messages).toEqual([accepted]);
  expect(reviewPassageComment(thread, true)?.messages.some(message => message.pending)).toBe(false);
  const { snapshot } = fixture();
  const rewrite = threadEditProposal(snapshot, "note", thread.anchor, "soft light", "rewrite");
  expect(() => validatePassageRewrite(rewrite, thread.anchor)).not.toThrow();
  expect(() => validatePassageRewrite({ ...rewrite, edits: [{ before: snapshot.notes[0].body, after: "Everything changed" }] }, thread.anchor)).toThrow(/beyond/);
});

it("accepts the real reader's focused proposal and legacy proposals without a mode flag", async () => {
  const { snapshot, selection } = fixture();
  const anchor = passageAnchorFromSelection(snapshot, selection);
  const result = await runChatReading(snapshot, "Suggest a focused revision of this passage.", async () => ({
    reply: "Ready for review.", editIntent: "focused", noteEdits: [{ before: "warm light", after: "soft light" }],
  }), { purpose: "edit", focusNoteId: "note", editPassage: anchor.quote });
  expect(result.editProposal).toBeDefined();
  expect(() => validatePassageRewrite(result.editProposal!, anchor)).not.toThrow();
  expect(() => validatePassageRewrite({ ...result.editProposal!, mode: undefined }, anchor)).not.toThrow();
  expect(() => validatePassageRewrite({ ...result.editProposal!, mode: "rewrite" }, anchor)).toThrow(/beyond/);
});

it("continues with the passage's history without mixing the ordinary chat or exposing pending comments", () => {
  const { snapshot } = fixture();
  snapshot.studio.messages = [{ id: "unrelated", role: "user", content: "A different conversation", cardIds: [], contextCardIds: [], createdAt: now }];
  const thread = { id: "t", state: "open" as const, anchor: { quote: "warm light", text: "warm light" }, createdAt: now, updatedAt: now,
    messages: [{ id: "a", role: "assistant" as const, content: "The initial comment", createdAt: now },
      { id: "u", role: "user" as const, content: "What about rhythm?", createdAt: now },
      { id: "pending", role: "assistant" as const, content: "Unaccepted agent proposal", pending: true, createdAt: now }] };
  const scoped = passageConversationSnapshot(snapshot, thread, true);
  expect(scoped.studio.messages.map(m => m.content)).toEqual(["The initial comment", "What about rhythm?"]);
  expect(snapshot.studio.messages[0].id).toBe("unrelated");
  expect(passageConversationSnapshot(snapshot, thread, false).studio.messages).toEqual([]);
});

it("persists a standalone note comment without inventing passage text or edit authority", () => {
  const { snapshot, note } = fixture("");
  const target = { scope: "note" as const, spaceId: "space", noteId: note.id, version: spaceNoteVersion(note) };
  const saved = addHumanPassageComment(snapshot, target, "An idea for later.", "general", now);
  const thread = saved.notes[0].discussionThreads![0];
  expect(saved.notes[0].body).toBe("");
  expect(saved.studio).toEqual(snapshot.studio);
  expect(isPassageThreads(JSON.parse(JSON.stringify([thread])))).toBe(true);
  expect(passageIsCurrent({ ...saved.notes[0], body: "New prose." }, thread.anchor)).toBe(true);
  expect(() => threadEditProposal(saved, note.id, thread.anchor, "New prose.", "addition")).toThrow(/attach/i);
  expect(passageArticleReference(saved, saved.notes[0], thread, thread.messages[0].id).comment).toBe("An idea for later.");
  expect(isPassageThreads([{ ...thread, anchor: { scope: "note", quote: "fake", text: "" } }])).toBe(false);
  expect(() => addHumanPassageComment(snapshot, { ...target, version: "stale" }, "Idea", "other", now)).toThrow(/changed/);
});
