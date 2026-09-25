// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { NoteStarterKit } from "../components/editor/NoteStarterKit";
import { expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { ChatEvidence } from "../types";
import { mergeSavedChatPassages, portableChatEvidence, savedChatEvidence, savedChatEvidenceFromLink, splitSavedChatPassages } from "./chatCitations";
import { canonicalizeSourceCitations, removeSourceCitations } from "./sourceCitations";
import { applyChatResult, saveChatReplyAsNote } from "./chat";
import { buildWebExportDocument } from "./webExport";
import { runChatReading } from "./chatReading";
import { deleteNoteFromSnapshot } from "./noteDeletion";
import { stableKnowledgeHash } from "./spaceKnowledge";

const NOW = "2026-09-09T00:00:00.000Z";
function fixture(text = "Exact 😀 passage.\n\n[link](https://example.com) <img src=x> **words**") {
  const snapshot = createEmptySnapshot("Evidence", NOW);
  snapshot.sources = [{ id: "source", title: "Original [lecture]", kind: "text", importedAt: NOW, text: `Before. ${text} After. Uncited private source text.`, noteIds: [] }];
  const evidence: ChatEvidence = { id: "e1", kind: "source", entityId: "source", title: "Original [lecture]", version: "original-version", start: 8, end: 8 + text.length, text, offsetUnit: "utf16" };
  return { snapshot, evidence };
}

it("preserves bounded citation metadata through ordinary Markdown editing", () => {
  const markdown = '[Passage 1](#orion-passage-e1 "orion-evidence-v1:%7B%22id%22%3A%22e1%22%7D")\n\n> Plain quote.';
  const editor = new Editor({ extensions: [StarterKit, Markdown], content: markdown, contentType: "markdown" });
  expect(editor.getMarkdown()).toContain('"orion-evidence-v1:%7B%22id%22%3A%22e1%22%7D"');
  editor.destroy();
});

it("retains exact Unicode ranges and quote after source canonicalization and Tiptap edits", () => {
  const { snapshot, evidence } = fixture();
  const portable = portableChatEvidence("A claim. [1](#orion-evidence-e1) Again [1](#orion-evidence-e1)", [evidence]);
  expect(savedChatEvidence(portable)).toEqual([evidence]);
  expect(portable.match(/## Cited passages/g)).toHaveLength(1);
  const canonical = canonicalizeSourceCitations(portable, snapshot.sources);
  const editor = new Editor({
    extensions: [NoteStarterKit.configure({ link: { protocols: ["orion-source"] } }), Markdown],
    content: canonical.body, contentType: "markdown",
  });
  editor.commands.insertContent("An edit. ");
  const edited = canonicalizeSourceCitations(editor.getMarkdown(), snapshot.sources).markdown;
  expect(savedChatEvidence(edited)).toEqual([evidence]);
  expect(savedChatEvidence(canonicalizeSourceCitations(edited, snapshot.sources).markdown)).toEqual([evidence]);
  expect(editor.getHTML()).not.toContain("<img");
  expect(editor.getHTML()).not.toContain("orion-passage:v1:");
  editor.destroy();
});

it("preserves authored headings and keeps citation-footer ordering through removal and Undo", () => {
  const { evidence } = fixture();
  const authored = "Authored.\n\n## Cited passages\n\nThese are my own words.";
  expect(splitSavedChatPassages(authored)).toEqual({ body: authored, footer: "", evidence: [] });
  const other = { ...evidence, id: "e2" };
  const portable = portableChatEvidence("First [[e1]] then second [[e2]].", [evidence, other]);
  const section = splitSavedChatPassages(portable);
  const removed = mergeSavedChatPassages(section.body.replace("[1](#orion-passage-e1)", ""), section.footer);
  expect(savedChatEvidence(removed).map((item) => item.id)).toEqual(["e2"]);
  const undo = mergeSavedChatPassages(section.body, section.footer);
  expect(savedChatEvidence(undo).map((item) => item.id)).toEqual(["e1", "e2"]);
  expect(undo.match(/## Cited passages/g)).toHaveLength(1);
});

it("appends host evidence after action limits, only for actually cited passages", () => {
  const { snapshot, evidence } = fixture("實😀".repeat(900));
  const uncited = { ...evidence, id: "e2" };
  const saved = applyChatResult(snapshot, "Create a note", {
    reply: "Created it.", evidence: [evidence, uncited],
    noteActions: [{ title: "Saved", summary: "Bounded action", body: `${"A".repeat(5_950)} [1](#orion-evidence-e1)`, tags: [], aliases: [] }],
  }, NOW, () => "message", () => "saved");
  expect(saved.notes).toHaveLength(1);
  expect(saved.notes[0].body.length).toBeGreaterThan(6_000);
  expect(savedChatEvidence(saved.notes[0].body)).toEqual([evidence]);
  expect(saved.notes[0].sourceIds).toEqual(["source"]);
  expect(saved.sources[0].noteIds).toEqual(["saved"]);
});

it("does not drop a valid near-limit creation action when resolving evidence markers", async () => {
  const { snapshot } = fixture();
  let step = 0;
  const result = await runChatReading(snapshot, "Create a note about this source", async (request) => {
    if (step++ === 0) return { reply: "", readRequests: [{ kind: "source", id: "source", query: "", start: 0 }] };
    const packet = JSON.parse(request.readingContext!);
    return { reply: "Created.", noteActions: [{ title: "Bounded", summary: "Bounded", body: "A".repeat(5_990) + `[[${packet.evidence[0].id}]]`, tags: [], aliases: [] }] };
  });
  const applied = applyChatResult(snapshot, "Create a note about this source", result, NOW, () => "message", () => "saved");
  expect(applied.notes).toHaveLength(1);
  expect(savedChatEvidence(applied.notes[0].body)).toHaveLength(1);
});

it("preserves a note passage and its version after deleting the original note", () => {
  const { snapshot, evidence } = fixture();
  const original = applyChatResult(snapshot, "Create a note", { reply: "Created.", noteActions: [{ title: "Original note", summary: "", body: evidence.text, tags: [], aliases: [] }] }, NOW, () => "message", () => "origin");
  const noteEvidence = { ...evidence, kind: "note" as const, entityId: "origin", start: 0, end: evidence.text.length };
  const saved = applyChatResult(original, "Create a note", { reply: "Created.", evidence: [noteEvidence], noteActions: [{ title: "Saved passage", summary: "", body: "A claim [[e1]].", tags: [], aliases: [] }] }, NOW, () => "message", () => "saved");
  const deleted = deleteNoteFromSnapshot(saved, "origin", NOW).snapshot;
  expect(savedChatEvidence(deleted.notes.find((note) => note.id === "saved")!.body)).toEqual([noteEvidence]);
  expect(deleted.notes[0].body).not.toContain("orion-note://origin");
});

it("keeps reply evidence independently from Chat and retains it after source deletion", () => {
  const { snapshot, evidence } = fixture();
  snapshot.studio.messages = [{ id: "reply", role: "assistant", content: "Claim [1](#orion-evidence-e1)", evidence: [evidence], cardIds: [], contextCardIds: [], createdAt: NOW }];
  const saved = saveChatReplyAsNote(snapshot, "reply", NOW, "saved");
  const markdown = canonicalizeSourceCitations(saved.notes[0].body, snapshot.sources).markdown;
  const deleted = removeSourceCitations(markdown, ["source"], []);
  expect(savedChatEvidence(deleted)).toEqual([evidence]);
  expect(deleted).toContain("Exact 😀 passage");
  expect(deleted).not.toContain("orion-source://source");
  expect(saveChatReplyAsNote(saved, "reply", NOW, "duplicate")).toBe(saved);
});

it("does not upgrade a changed legacy source when keeping its historical passage", () => {
  const { snapshot, evidence } = fixture();
  const legacy = { ...evidence, version: stableKnowledgeHash(JSON.stringify(snapshot.sources[0])) };
  snapshot.studio.messages = [{ id: "reply", role: "assistant", content: "Claim [1](#orion-evidence-e1)", evidence: [legacy], cardIds: [], contextCardIds: [], createdAt: NOW }];
  snapshot.sources[0] = { ...snapshot.sources[0], text: snapshot.sources[0].text + " A later addition." };
  const saved = saveChatReplyAsNote(snapshot, "reply", NOW, "saved");
  expect(savedChatEvidence(saved.notes[0].body)).toEqual([legacy]);
});

it("rejects malformed, oversized, mismatched and unknown-field metadata", () => {
  const { evidence } = fixture();
  const encoded = (value: unknown) => "orion-passage:v1:" + btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  expect(savedChatEvidenceFromLink("#orion-passage-e2", encoded(evidence))).toBeUndefined();
  expect(savedChatEvidenceFromLink("#orion-passage-e1", encoded({ ...evidence, end: 999 }))).toBeUndefined();
  expect(savedChatEvidenceFromLink("#orion-passage-e1", encoded({ ...evidence, spaceId: "other" }))).toBeUndefined();
  expect(savedChatEvidenceFromLink("#orion-passage-e1", "orion-passage:v1:" + "A".repeat(32_001))).toBeUndefined();
  expect(savedChatEvidenceFromLink("javascript:alert(1)", encoded(evidence))).toBeUndefined();
  const portable = portableChatEvidence("Claim [1](#orion-evidence-e1)", [evidence]);
  expect(savedChatEvidence(`\`\`\`md\n${portable}\n\`\`\``)).toEqual([]);
  expect(savedChatEvidence(portableChatEvidence(portable, []))).toEqual([]);
});

it("retains every valid maximum-size passage even when punctuation expands in Markdown", () => {
  const { evidence } = fixture("_".repeat(3_000));
  const passages = Array.from({ length: 12 }, (_, index) => ({ ...evidence, id: `e${index + 1}`, title: "_".repeat(600), version: "v".repeat(200), entityId: `${index}`.padEnd(200, "s") }));
  const markdown = portableChatEvidence(passages.map((item) => `[[${item.id}]]`).join(" "), passages);
  expect(savedChatEvidence(markdown)).toEqual(passages);
});

it("exports only the retained literal quote and attribution, with local citation targets", () => {
  const { snapshot, evidence } = fixture();
  snapshot.studio.messages = [{ id: "reply", role: "assistant", content: "Claim [1](#orion-evidence-e1)", evidence: [evidence], cardIds: [], contextCardIds: [], createdAt: NOW }];
  const saved = saveChatReplyAsNote(snapshot, "reply", NOW, "saved");
  const { html } = buildWebExportDocument(saved, "note", "saved");
  const page = new DOMParser().parseFromString(html, "text/html");
  expect(page.body.textContent).toContain(evidence.text.replace(/\n+/g, "\n"));
  expect(html).not.toContain("Uncited private source text");
  expect(html).not.toContain("orion-passage:v1:");
  expect(html).not.toContain("original-version");
  expect(page.querySelectorAll("blockquote img")).toHaveLength(0);
  const citation = page.querySelector('a[href$="--passage-e1"]');
  expect(citation).not.toBeNull();
  expect(page.getElementById(citation!.getAttribute("href")!.slice(1))).not.toBeNull();
});
