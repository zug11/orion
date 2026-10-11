import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { applyChatTextEdits, parseChatEditIntent, chatRequestAllowsEdits, createChatEditProposal, parseChatNoteEdits, validateChatEditTarget } from "./chatEdits";
import { portableChatEvidence } from "./chatCitations";
import { parseChatResult } from "./storage";
import type { ChatEvidence, Note } from "../types";

const note: Note = { id: "note", title: "Draft", body: "An old opening.\n\nKeep **this**.\n\nA long ending.", summary: "", slug: "draft", kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "2026-10-08", updatedAt: "2026-10-08" };
const evidence: ChatEvidence = { id: "e1", kind: "note", entityId: note.id, title: note.title, version: "v1", start: 0, end: note.body.length, text: note.body, offsetUnit: "utf16" };
function snapshot() { const snapshot = createEmptySnapshot("Space", "2026-10-08", "space"); snapshot.notes = [{ ...note }]; return snapshot; }

describe("current-note edit authority and patches", () => {
  it("keeps proposal scope separate from captured-target and creation boundaries", () => {
    for (const intent of ["none", "focused", "rewrite"]) expect(parseChatEditIntent(intent)).toBe(intent);
    expect(parseChatEditIntent(undefined)).toBe("none");
    expect(() => parseChatEditIntent("apply")).toThrow();
    const request = { mode: "chat-reading" as const, prompt: "yes, do that", workspaceName: "Space", editNoteId: "note", history: [], notes: [], sources: [], concepts: [] };
    expect(chatRequestAllowsEdits(request)).toBe(true);
    expect(chatRequestAllowsEdits({ ...request, editNoteId: undefined })).toBe(false);
    expect(chatRequestAllowsEdits({ ...request, mode: "inline-writing" })).toBe(false);
    expect(chatRequestAllowsEdits({ ...request, allowNoteActions: true })).toBe(false);
  });
  it("applies disjoint exact edits without changing surrounding Markdown", () => {
    expect(applyChatTextEdits(note.body, [{ before: "old opening", after: "clear opening" }, { before: "A long ending.", after: "A brief ending." }]))
      .toBe("An clear opening.\n\nKeep **this**.\n\nA brief ending.");
  });
  it("rejects ambiguous, missing, overlapping and whole-note erasure", () => {
    for (const [body, edits] of [
      ["one one", [{ before: "one", after: "two" }]],
      ["one", [{ before: "absent", after: "two" }]],
      ["one two", [{ before: "one two", after: "three" }, { before: "two", after: "four" }]],
      ["one", [{ before: "one", after: "" }]],
    ] as const) expect(() => applyChatTextEdits(body, [...edits])).toThrow();
  });
  it("protects frontmatter, control comments and generated evidence footers", () => {
    expect(() => applyChatTextEdits("---\ntitle: private\n---\n\nHello", [{ before: "private", after: "changed" }])).toThrow();
    expect(() => applyChatTextEdits("<!-- orion-block:v1 token -->\n\nHello", [{ before: "token", after: "changed" }])).toThrow();
    expect(() => applyChatTextEdits("Hello", [{ before: "Hello", after: "---\na: b\n---\n\nnew" }])).toThrow();
    expect(() => applyChatTextEdits("Claim [1](orion-source://source).\n\n## References\n\n1. [Source title](orion-source://source)", [{ before: "Source title", after: "Wrong" }])).toThrow();
    expect(() => applyChatTextEdits("Claim.\n\n## References\n\n1. [Source](orion-source://source)", [{ before: "Claim.", after: "" }])).toThrow(/clear/);
    const saved = portableChatEvidence("A claim [1](#orion-evidence-e1).", [evidence]);
    const footerWord = saved.slice(saved.indexOf("## Cited passages")).match(/Draft/)?.[0];
    expect(footerWord).toBe("Draft");
    expect(() => applyChatTextEdits(saved, [{ before: "Draft", after: "Wrong" }])).toThrow();
  });
  it("bounds payloads and forbids provider-controlled destinations or temporary citations", () => {
    for (const value of [Array(9).fill({ before: "a", after: "b" }), [{ before: "a", after: "b", noteId: "foreign" }], [{ before: "a", after: "x".repeat(6001) }], [{ before: "a", after: "[[e1]]" }], [{ before: "a", after: "<!-- orion-block:v1 -->" }], [{ before: "a", after: "<!-- /orion-block -->" }]]) expect(() => parseChatNoteEdits(value)).toThrow();
  });
  it("requires the exact target passage to have been read and rejects stale or foreign applications", () => {
    const space = snapshot(), edits = [{ before: "old opening", after: "new opening" }];
    expect(() => createChatEditProposal(space, note.id, edits, [])).toThrow();
    expect(() => createChatEditProposal(space, note.id, edits, [{ ...evidence, entityId: "other" }])).toThrow();
    const proposal = createChatEditProposal(space, note.id, edits, [evidence])!;
    expect(proposal.noteId).toBe(note.id);
    expect(() => validateChatEditTarget(space, proposal)).not.toThrow();
    expect(() => validateChatEditTarget({ ...space, workspace: { ...space.workspace, id: "other" } }, proposal)).toThrow();
    space.notes[0].body += " New typing.";
    expect(() => validateChatEditTarget(space, proposal)).toThrow(/changed/);
    expect(createChatEditProposal(space, undefined, edits, [evidence])).toBeUndefined();
  });
  it("drops all edit payloads during reading and ignores unauthorized final edits", () => {
    const edits = [{ before: "a", after: "b" }];
    expect(parseChatResult({ reply: "Ready", readRequests: [], noteEdits: edits }, true, false).noteEdits).toBeUndefined();
    expect(parseChatResult({ reply: "", readRequests: [{ kind: "note", id: "note", query: "", start: null }], noteEdits: "malicious" }, true, true).noteEdits).toBeUndefined();
    expect(parseChatResult({ reply: "Ready", readRequests: [], noteEdits: edits }, true, true).noteEdits).toEqual(edits);
  });
});

import { chatEditableBody, chatProposalBody, createChatRewriteProposal, parseChatRewrite } from "./chatEdits";
it("preserves original metadata in a full rewrite", () => {
  const space = snapshot();
  const original = "---\nprivate: kept\n---\n\nAn old thought.\n\n## References\n\n1. [Source](orion-source://source)";
  space.notes[0].body = original;
  const proposal = createChatRewriteProposal(space, note.id, "A new thought.\n\nAn added paragraph.");
  expect(chatProposalBody(proposal)).toBe(original.replace("An old thought.", "A new thought.\n\nAn added paragraph."));
  expect(chatEditableBody(original).body).toBe("An old thought.");
  expect(() => createChatRewriteProposal(space, "foreign", "new")).toThrow();
  for (const rewrite of ["", "---\nx: y\n---\n\nNew", "<!-- orion-block:v1 changed -->\n\nNew", "[[e1]]", "x".repeat(24001)]) {
    expect(() => createChatRewriteProposal(space, note.id, rewrite)).toThrow();
  }
  expect(parseChatRewrite("😀".repeat(24000))).toHaveLength(48000);
});
