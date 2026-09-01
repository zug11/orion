import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { reconcileConceptVocabulary, findConceptByPhrase } from "../lib/concepts";
import { decorateAutoLinks } from "../lib/wiki";
import type { OrganizeContentResult, OrganizedNote } from "../types";
import { buildImportPayload, type OrganizedSource } from "./ImportStudio";

const NOW = "2026-08-31T00:00:00.000Z";

function draft(title: string, body = title): OrganizedNote {
  return { title, body, summary: title, aliases: [], tags: [], links: [] };
}

function organized(result: OrganizeContentResult): OrganizedSource {
  return {
    item: {
      id: "import-fixture", fileName: "fixture.md", mimeType: "text/markdown",
      byteSize: 42, status: "ready", included: true,
      parsed: {
        title: "Argument fixture", fileName: "fixture.md", mimeType: "text/markdown",
        format: "markdown", byteSize: 42, text: "Synthetic arguments and their qualifications.", warnings: [],
      },
    },
    result,
  };
}

function result(notes: OrganizedNote[]): OrganizeContentResult {
  return { notes, wikiArticles: [], concepts: [], suggestedConnections: [] };
}

describe("planned import connections", () => {
  it("resolves durable phrases to one argument after sibling outputs exist and retains typed relationships", () => {
    const a = draft("Exclusion is a structural condition", "The abject middle is a structural position. Recognition matters to this argument.");
    const b = draft("Recognition can interrupt projection", "Recognition interrupts projection under specific conditions.");
    const c = draft("Recognition can also reinforce projection", "Recognition can also repeat the existing pattern.");
    const d = draft("A separate argument", "An independent idea from the same source.");
    b.aliases = ["recognition"];
    c.aliases = ["recognition"];
    a.links = [{ targetTitle: b.title, context: "An untyped writer link." }];
    const plan = result([a, b, c, d]);
    plan.concepts = [
      { label: "abject middle", aliases: [], description: a.summary, canonicalTitle: a.title, relatedTitles: [] },
      { label: "recognition", aliases: [], description: b.summary, canonicalTitle: b.title, relatedTitles: [] },
    ];
    plan.suggestedConnections = [
      { fromTitle: a.title, toTitle: b.title, kind: "supports", reason: "The structural account gives the recognition argument its premise." },
      { fromTitle: c.title, toTitle: b.title, kind: "qualifies", reason: "Recognition can repeat projection rather than interrupting it." },
      { fromTitle: a.title, toTitle: c.title, kind: "conflicts", reason: "These claims disagree about whether interruption is possible." },
    ];
    const payload = buildImportPayload([organized(plan)], createEmptySnapshot("Arguments", NOW));
    const notes = new Map(payload.notes.map((note) => [note.title, note]));
    const recognition = findConceptByPhrase(payload.concepts, "recognition");
    expect(recognition?.canonicalNoteId).toBe(notes.get(b.title)?.id);
    expect(recognition?.noteIds).toEqual([notes.get(b.title)?.id]);
    const linked = decorateAutoLinks(a.body, payload.concepts).filter((segment) => segment.type === "concept");
    expect(linked).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: "Recognition", targetNoteIds: [notes.get(b.title)?.id] }),
    ]));
    expect(payload.relationships.map(({ kind }) => kind).sort()).toEqual(["conflicts", "qualifies", "supports"]);
    expect(payload.relationships.some(({ fromNoteId, toNoteId }) =>
      fromNoteId === notes.get(d.title)?.id || toNoteId === notes.get(d.title)?.id)).toBe(false);
    const reloaded = reconcileConceptVocabulary(payload.notes, payload.concepts);
    expect(findConceptByPhrase(reloaded.concepts, "recognition")?.canonicalNoteId).toBe(notes.get(b.title)?.id);
  });

  it("does not silently redirect an established canonical phrase", () => {
    const snapshot = createEmptySnapshot("Arguments", NOW);
    const existing = buildImportPayload([organized(result([draft("Established recognition account")]))], snapshot);
    existing.notes[0].aliases = ["recognition"];
    const vocabulary = reconcileConceptVocabulary(existing.notes, existing.concepts);
    snapshot.notes = vocabulary.notes;
    snapshot.concepts = vocabulary.concepts;
    const plan = result([draft("A new recognition argument")]);
    plan.concepts = [{ label: "recognition", aliases: [], description: "New interpretation.", canonicalTitle: plan.notes[0].title, relatedTitles: [] }];
    const before = structuredClone(snapshot);
    expect(() => buildImportPayload([organized(plan)], snapshot)).toThrow(/cannot redirect the established link phrase/);
    expect(snapshot).toEqual(before);
  });

  it("can deliberately resolve an existing shared alias without replacing an established destination", () => {
    const snapshot = createEmptySnapshot("Arguments", NOW);
    const a = draft("Recognition interrupts projection");
    const b = draft("Recognition can repeat projection");
    a.aliases = ["recognition"];
    b.aliases = ["recognition"];
    const existing = buildImportPayload([organized(result([a, b]))], snapshot);
    snapshot.notes = existing.notes;
    snapshot.concepts = existing.concepts;
    expect(findConceptByPhrase(snapshot.concepts, "recognition")?.canonicalNoteId).toBeUndefined();
    const plan = result([]);
    plan.concepts = [{ label: "recognition", aliases: [], description: "The chosen recognition account.", canonicalTitle: a.title, relatedTitles: [] }];
    const payload = buildImportPayload([organized(plan)], snapshot);
    const canonicalId = snapshot.notes.find((note) => note.title === a.title)!.id;
    expect(findConceptByPhrase(payload.concepts, "recognition")?.canonicalNoteId).toBe(canonicalId);
    snapshot.concepts = payload.concepts;
    expect(() => buildImportPayload([organized(plan)], snapshot)).not.toThrow();
  });

  it.each([false, true])("rejects a planned phrase redirecting another output's exact title (alias=%s)", (asAlias) => {
    const plan = result([draft("Recognition"), draft("Different recognition account")]);
    plan.concepts = [{
      label: asAlias ? "mutual recognition" : "recognition",
      aliases: asAlias ? ["recognition"] : [], description: "A different account.",
      canonicalTitle: "Different recognition account", relatedTitles: [],
    }];
    expect(() => buildImportPayload([organized(plan)], createEmptySnapshot("Arguments", NOW))).toThrow(/cannot redirect the note title/);
  });

  it("retains more than eighteen planned links and never connects same-source notes automatically", () => {
    const notes = Array.from({ length: 22 }, (_, index) => draft(`Argument ${index}`));
    const plan = result(notes);
    plan.suggestedConnections = notes.slice(1, 21).map((note) => ({
      fromTitle: notes[0].title, toTitle: note.title, kind: "qualifies",
      reason: `${note.title} supplies a distinct limiting condition.`,
    }));
    const payload = buildImportPayload([organized(plan)], createEmptySnapshot("Arguments", NOW));
    expect(payload.relationships).toHaveLength(20);
    expect(payload.relationships.every(({ kind }) => kind === "qualifies")).toBe(true);
    const unrelated = payload.notes.find(({ title }) => title === "Argument 21")!;
    expect(payload.relationships.some(({ toNoteId }) => toNoteId === unrelated.id)).toBe(false);
  });
});
