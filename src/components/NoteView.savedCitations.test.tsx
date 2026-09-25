// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ChatEvidence, Note, Source } from "../types";
import { portableChatEvidence } from "../lib/chatCitations";
import { stableKnowledgeHash } from "../lib/spaceKnowledge";
import { sourceEvidenceVersion } from "../lib/evidenceVersions";
import { createEmptySnapshot } from "../data/defaults";
import { saveChatReplyAsNote } from "../lib/chat";
import { NoteView } from "./NoteView";

it("opens a saved note's original passage and retains it when the original changes or disappears", () => {
  const source: Source = { id: "original", title: "Original source", kind: "text", importedAt: "2026-09-09T00:00:00.000Z", text: "Original precise 😀 words.", noteIds: [] };
  const evidence: ChatEvidence = { id: "e1", kind: "source", entityId: source.id, title: source.title, version: stableKnowledgeHash(JSON.stringify(source)), start: 0, end: source.text.length, text: source.text, offsetUnit: "utf16" };
  const note: Note = { id: "saved", title: "Saved answer", slug: "saved", summary: "Answer", body: portableChatEvidence("Answer [1](#orion-evidence-e1).", [evidence]), aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [source.id], createdAt: source.importedAt, updatedAt: source.importedAt };
  const onOpenSource = vi.fn();
  const props = { note, notes: [note], concepts: [], onOpenNote: vi.fn(), onOpenSource, onOpenConcept: vi.fn(), onUpdateNote: vi.fn(), onDeleteNote: vi.fn(), onRegisterConcept: vi.fn(), onDisableConceptAutoLink: vi.fn() };
  const { rerender, container } = render(<NoteView {...props} sources={[source]} />);
  expect(screen.queryByRole("complementary", { name: "Cited passage" })).not.toBeInTheDocument();
  const citation = screen.getAllByRole("button", { name: "Read citation: Original source" })[0];
  citation.focus();
  fireEvent.click(citation);
  const panel = screen.getByRole("complementary", { name: "Cited passage" });
  expect(panel).toHaveTextContent(source.text);
  expect(panel).toHaveTextContent("Exact passage read for this saved note.");
  expect(container.querySelector('[title^="orion-passage:"]')).toBeNull();
  fireEvent.click(within(panel).getByRole("button", { name: "Open source" }));
  expect(onOpenSource).toHaveBeenCalledWith("original");
  rerender(<NoteView {...props} sources={[{ ...source, text: "Revised source text." }]} />);
  expect(panel).toHaveTextContent("This item has changed since the passage was saved.");
  expect(panel).toHaveTextContent(source.text);
  rerender(<NoteView {...props} sources={[]} />);
  expect(panel).toHaveTextContent("no longer in this Space");
  expect(within(panel).getByRole("button", { name: "Open source" })).toBeDisabled();
  fireEvent.keyDown(panel, { key: "Escape" });
  expect(screen.queryByRole("complementary", { name: "Cited passage" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "Read citation: Original source" })[0]).toHaveFocus();
});

it.each(["current", "legacy"])("does not label %s Keep as note's own provenance attachment as a changed original", (versionKind) => {
  const now = "2026-09-09T00:00:00.000Z";
  const snapshot = createEmptySnapshot("Research", now);
  const source: Source = { id: "original", title: "Original source", kind: "text", importedAt: now, text: "Exact original words.", noteIds: [] };
  const evidence: ChatEvidence = { id: "e1", kind: "source", entityId: source.id, title: source.title, version: versionKind === "legacy" ? stableKnowledgeHash(JSON.stringify(source)) : sourceEvidenceVersion(source), start: 0, end: source.text.length, text: source.text, offsetUnit: "utf16" };
  snapshot.sources = [source];
  snapshot.studio.messages = [{ id: "reply", role: "assistant", content: "Answer [1](#orion-evidence-e1).", evidence: [evidence], cardIds: [], contextCardIds: [], createdAt: now }];
  const saved = saveChatReplyAsNote(snapshot, "reply", now, "saved");
  expect(saved.sources[0].noteIds).toEqual(["saved"]);
  render(<NoteView note={saved.notes[0]} notes={saved.notes} sources={saved.sources} concepts={saved.concepts}
    onOpenNote={vi.fn()} onOpenSource={vi.fn()} onOpenConcept={vi.fn()} onUpdateNote={vi.fn()}
    onDeleteNote={vi.fn()} onRegisterConcept={vi.fn()} onDisableConceptAutoLink={vi.fn()} />);
  fireEvent.click(screen.getAllByRole("button", { name: "Read citation: Original source" })[0]);
  const panel = screen.getByRole("complementary", { name: "Cited passage" });
  expect(panel).toHaveTextContent("Exact passage read for this saved note.");
  expect(panel).not.toHaveTextContent("has changed");
});
