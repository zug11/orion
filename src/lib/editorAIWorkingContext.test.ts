import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { buildAIWritingRequest } from "./aiWriting";
import { projectEditorAIContext, type EditorAIWorkingContext } from "./editorAIWorkingContext";
import { buildLinkTitleRequest } from "./linkTitle";
import type { Note } from "../types";

const secret = "PRIVATE-completed-sentinel";
const raw = `Before.\n\n- [x] ${secret}\n  private continuation\n\nVisible selection.\n\nAfter.`;
function fixture() {
  const snapshot = createEmptySnapshot("Work", "2026-10-11", "space-test");
  const note: Note = { id: "origin", title: "Notes", slug: "notes", body: raw, summary: secret,
    kind: "article", status: "ready", aliases: [], tags: [], sourceIds: [], conceptIds: [], createdAt: "now", updatedAt: "now" };
  snapshot.notes = [note, { ...note, id: "related", title: "Visible selection", body: `Visible selection related.\n\n- [x] ${secret}-related` }];
  snapshot.sources = [{ id: "source", title: "Visible selection evidence", kind: "text", fileName: "source.txt", mimeType: "text/plain", byteSize: 10,
    importedAt: "now", text: `Visible selection support.\n\n- [x] ${secret}-source`, noteIds: ["origin"] }];
  snapshot.spaceOverview = { title: "Overview", body: secret, relatedNoteIds: ["origin"], generatedAt: "now", stale: false };
  return snapshot;
}
const projection: EditorAIWorkingContext = {
  documentMarkdown: "Before.\n\nVisible selection.\n\nAfter.", selectedMarkdown: "Visible selection.", selectedText: "Visible selection.",
  beforeMarkdown: "Before.", afterMarkdown: "After.", selectionTouchesCompleted: false, caretInsideCompleted: false,
};
const input = { originNoteId: "origin", documentMarkdown: raw, selectedMarkdown: "Visible selection.", selectedText: "Visible selection.",
  beforeMarkdown: `Before.\n\n- [x] ${secret}`, afterMarkdown: "After.", workingContext: projection };

describe("editor provider working context", () => {
  it("filters the live draft and every derived/related context without mutating the original", () => {
    const snapshot = fixture(), before = JSON.stringify(snapshot), captured = JSON.stringify(input);
    const result = projectEditorAIContext(snapshot, input, "rewrite");
    expect(result.taskView).toBe("working");
    expect(JSON.stringify(result.snapshot)).not.toContain(secret);
    expect(result.input.documentMarkdown).toBe(projection.documentMarkdown);
    expect(result.input.beforeMarkdown).toBe("Before.");
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(JSON.stringify(input)).toBe(captured);
  });
  it("clears cached derivatives when the checked task is still only an unsaved edit", () => {
    const snapshot = fixture(); snapshot.notes = [{ ...snapshot.notes[0], body: "Old visible draft" }]; snapshot.sources = [];
    const result = projectEditorAIContext(snapshot, input, "rewrite");
    expect(result.snapshot.notes[0].summary).toBe("");
    expect(result.snapshot.spaceOverview).toBeUndefined();
    expect(snapshot.notes[0].body).toBe("Old visible draft");
  });
  it("rejects protected selections and carets rather than replacing a filtered target", () => {
    for (const purpose of ["rewrite", "image", "write"] as const) {
      for (const flags of [{ selectionTouchesCompleted: true }, { caretInsideCompleted: true }]) {
        expect(() => projectEditorAIContext(fixture(), { ...input, workingContext: { ...projection, ...flags } }, purpose)).toThrow(/completed work/);
      }
    }
  });
  it("requires exact rich boundaries if a plain selection lost its checkbox marker", () => {
    expect(() => projectEditorAIContext(fixture(), { originNoteId: "origin", selectedText: secret }, "rewrite")).toThrow(/boundary/);
    expect(() => projectEditorAIContext(fixture(), { originNoteId: "origin", beforeMarkdown: "partial task" }, "write")).toThrow(/boundary/);
  });
  it("allows deliberate history from the current instruction only", () => {
    const protectedInput = { ...input, selectedText: secret, selectedMarkdown: secret,
      workingContext: { ...projection, selectionTouchesCompleted: true }, instruction: "Rewrite the completed tasks for an audit." };
    const result = projectEditorAIContext(fixture(), protectedInput, "rewrite");
    expect(result.taskView).toBe("history");
    expect(result.input.selectedText).toBe(secret);
    expect(result.snapshot.notes[0].body).toBe(raw);
    expect(() => projectEditorAIContext(fixture(), { ...protectedInput, instruction: "Do not include completed tasks" }, "rewrite")).toThrow(/completed work/);
    expect(() => projectEditorAIContext(fixture(), { ...protectedInput, instruction: "", selectedText: "Review completed tasks" }, "rewrite")).toThrow(/completed work/);
  });
  it("leaves literal code examples and ordinary prose available", () => {
    const snapshot = fixture(); snapshot.notes[0].body = "```md\n- [x] example\n```";
    const result = projectEditorAIContext(snapshot, { originNoteId: "origin", selectedMarkdown: "```md\n- [x] example\n```" }, "rewrite");
    expect(result.input.selectedMarkdown).toContain("- [x] example");
  });
  it("sends only projected passages for every inline writing operation, including Enrich", () => {
    for (const action of ["continue", "rewrite", "clarify", "tighten", "simplify", "expand", "enrich"] as const) {
      const request = buildAIWritingRequest(fixture(), { ...input, action,
        caretContext: { beforeMarkdown: input.beforeMarkdown, afterMarkdown: input.afterMarkdown } });
      expect(JSON.stringify(request)).not.toContain(secret);
      expect(request.notes.map(note => note.body).join(" ")).toContain("Visible selection.");
      expect(request.notes.map(note => note.body).join(" ")).toContain("Before.");
      if (action === "enrich") expect(request.sources.some(source => source.text.includes("Visible selection support"))).toBe(true);
    }
  });
  it("names links without completed surroundings or derived summaries", () => {
    const request = buildLinkTitleRequest(fixture(), "origin", "Visible selection.", [], {
      documentMarkdown: raw, workingContext: projection,
    });
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(request.notes[0].body).toBe("Visible selection.");
    expect(() => buildLinkTitleRequest(fixture(), "origin", secret, [], {
      documentMarkdown: raw, workingContext: { ...projection, selectionTouchesCompleted: true },
    })).toThrow(/completed work/);
  });
});
