// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import type { AppSnapshot, Note, Source } from "../types";
import { ImageSearchIndex, type ImageEvidence } from "./imageContextSearch";

const NOW = "2026-09-29T00:00:00.000Z";
function note(id: string, body: string, title = id): Note {
  return { id, title, slug: id, summary: "", body, aliases: [], tags: [], kind: "article", status: "ready", conceptIds: [], sourceIds: [], createdAt: NOW, updatedAt: NOW };
}
function source(id: string, text: string): Source {
  return { id, title: id, text, kind: "text", importedAt: NOW, noteIds: [] };
}
function space(notes: Note[] = [], sources: Source[] = []): AppSnapshot {
  return { ...createEmptySnapshot("Research", NOW), notes, sources };
}
function search(index: ImageSearchIndex, query: string, characterBudget = 12_000, excludeIds?: ReadonlySet<string>) {
  return index.search(query, { characterBudget, excludeIds });
}
function exact(evidence: ImageEvidence[], snapshot: AppSnapshot) {
  for (const item of evidence) {
    const body = item.kind === "note" ? snapshot.notes.find((note) => note.id === item.entityId)!.body : snapshot.sources.find((source) => source.id === item.entityId)!.text;
    expect(item.offsetUnit).toBe("utf16");
    expect(item.fullTextLength).toBe(body.length);
    for (const part of item.passages) {
      expect(part.text).toBe(body.slice(part.start, part.end));
      expect(part.text.length).toBeLessThanOrEqual(1_200);
      expect(part.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
  }
}

describe("local image passage search", () => {
  it("finds meaningful matches throughout 100 and 1,000 notes without sending filler", async () => {
    const index = new ImageSearchIndex();
    for (const count of [100, 1_000]) {
      const snapshot = space([...Array.from({ length: count - 1 }, (_, i) => note(`unrelated-${i}`, `Garden maintenance entry ${i}.`)), note("relevant", "Hyphae connect distant tree roots through mycelium.")]);
      await index.prepare(snapshot);
      const result = await search(index, "mycelium hyphae");
      expect(result.evidence.map((item) => item.entityId)).toEqual(["relevant"]);
      expect(result.coverage).toMatchObject({ records: count, limited: false });
      expect(result.hasMore).toBe(false);
      exact(result.evidence, snapshot);
    }
  });

  it("adapts evidence width to the text budget instead of a fixed note quota", async () => {
    const snapshot = space(Array.from({ length: 45 }, (_, i) => note(`n-${i}`, `Coral observation ${i}: reefs support marine organisms.`)));
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const broad = await search(index, "coral", 12_000);
    expect(broad.evidence).toHaveLength(45);
    expect(broad.hasMore).toBe(false);
    const narrow = await search(index, "coral", 120);
    expect(narrow.evidence.length).toBeLessThan(45);
    expect(narrow.evidence.flatMap((item) => item.passages).reduce((n, part) => n + part.text.length, 0)).toBeLessThanOrEqual(120);
    expect(narrow.hasMore).toBe(true);
  });

  it("does not let more than eight million earlier characters hide a late relevant note", async () => {
    const filler = "General observations about gardening and soil. ".repeat(22_000);
    const snapshot = space([...Array.from({ length: 9 }, (_, i) => note(`large-${i}`, filler)), note("late", "Neuroplasticity changes synaptic connectivity.")]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const result = await search(index, "neuroplasticity synaptic");
    expect(result.evidence.map((item) => item.entityId)).toEqual(["late"]);
    expect(result.coverage.limited).toBe(false);
  }, 20_000);

  it("finds exact late passages of long sources, with Unicode offsets intact", async () => {
    const body = `${"🌿 A separate garden observation with naïve botanical notes.\n\n".repeat(20_000)}## İstanbul observations\nThe İSOTOPIC zircon signature reveals geological history. 🪨`;
    const snapshot = space([], [source("long", body)]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const result = await search(index, "zircon", 700);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].passages[0].text).toContain("zircon");
    expect(result.evidence[0].passages[0].start).toBeGreaterThan(1_000_000);
    exact(result.evidence, snapshot);
  }, 15_000);

  it("returns no arbitrary notes for stopwords or an unmatched query", async () => {
    const index = new ImageSearchIndex();
    await index.prepare(space([note("garden", "Roses grow in this garden.")]));
    for (const query of ["the and of", "quasiparticles", "", " "]) {
      expect(await search(index, query)).toMatchObject({ evidence: [], hasMore: false });
    }
  });

  it("routes through note aliases and associated concept aliases", async () => {
    const snapshot = space([note("linked", "Fungal threads exchange nutrients between trees.")]);
    snapshot.notes[0].aliases = ["Wood wide web"];
    snapshot.concepts = [{ id: "c", label: "Fungi", aliases: ["mycorrhiza"], description: "", noteIds: ["linked"], color: "blue", autoLink: true }];
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    expect((await search(index, "wood wide web")).evidence[0].entityId).toBe("linked");
    expect((await search(index, "mycorrhiza")).evidence[0].entityId).toBe("linked");
    expect((await search(index, "unrelated concept")).evidence).toEqual([]);
  });

  it("deduplicates repeated evidence and excludes it across identical note/source copies", async () => {
    const body = "Mycelium connects the roots of neighboring trees.";
    const snapshot = space([note("original", body), note("copy", body)], [source("preserved", body)]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const first = await search(index, "mycelium");
    expect(first.evidence).toHaveLength(1);
    expect(first.hasMore).toBe(false);
    const next = await search(index, "mycelium", 12_000, new Set(first.evidence.map((item) => item.id)));
    expect(next).toMatchObject({ evidence: [], hasMore: false });
  });

  it("can read a new passage of an already visited note", async () => {
    const body = `${"Mycelium exchanges nutrients with roots. ".repeat(40)}\n\n${"Mycelium also responds to drought and external damage. ".repeat(40)}`;
    const snapshot = space([note("long", body)]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const first = await search(index, "mycelium", 1_000);
    const next = await search(index, "drought", 1_000, new Set(first.evidence.map((item) => item.id)));
    expect(next.evidence.length).toBeGreaterThan(0);
    expect(next.evidence[0].entityId).toBe("long");
    expect(next.evidence[0].id).not.toBe(first.evidence[0].id);
    expect(next.evidence[0].passages[0].text).toContain("drought");
  });

  it("resumes unread ranges after a budget-trimmed final passage", async () => {
    const snapshot = space([note("single", "Mycelium connects roots. Mycelium transfers nutrients. Mycelium responds to drought.")]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const first = await search(index, "mycelium", 30);
    expect(first.evidence).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const next = await search(index, "mycelium", 300, new Set(first.evidence.map((item) => item.id)));
    expect(next.evidence.length).toBeGreaterThan(0);
    const original = first.evidence[0].passages[0];
    for (const item of next.evidence) {
      expect(index.evidenceCurrent(item, snapshot)).toBe(true);
      expect(item.passages[0].start >= original.end || item.passages[0].end <= original.start).toBe(true);
    }
    exact([...first.evidence, ...next.evidence], snapshot);
  });

  it("reports metadata sampling and clears that limit when aliases are shortened", async () => {
    const snapshot = space([note("alias", "A local observation.")]);
    snapshot.notes[0].aliases = Array.from({ length: 600 }, (_, i) => `uniqueroute${i}`);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    expect((await search(index, "uniqueroute599")).coverage.limited).toBe(true);
    snapshot.notes[0].aliases = ["mycelium"];
    await index.prepare(snapshot);
    const result = await search(index, "mycelium");
    expect(result.coverage.limited).toBe(false);
    expect(result.evidence).toHaveLength(1);
  });

  it("bounds a frequent-term search by the caller budget without a prefix record pool", async () => {
    const snapshot = space(Array.from({ length: 1_000 }, (_, i) => note(`entry-${i}`, `Coral observation ${i}. ${"Coral supports marine organisms. ".repeat(40)}`)));
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const result = await search(index, "coral", 800);
    expect(result.evidence.flatMap((item) => item.passages).reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(800);
    expect(result.hasMore).toBe(true);
    expect(result.coverage.records).toBe(1_000);
    exact(result.evidence, snapshot);
  });

  it("updates changed records, removes deletions, and checks evidence dependencies", async () => {
    const snapshot = space([note("relevant", "Hyphae connect roots."), note("other", "A calendar of events.")]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const evidence = (await search(index, "hyphae")).evidence[0];
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(true);
    snapshot.notes[1].body = "An unrelated edit.";
    snapshot.notes[0].lastOpenedAt = "2026-09-30T00:00:00.000Z";
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(true);
    snapshot.notes[0].sourceIds = ["provenance"];
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(false);
    snapshot.notes[0].sourceIds = [];
    snapshot.notes[0].body = "Coral forms reefs.";
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(false);
    await index.prepare(snapshot);
    expect((await search(index, "hyphae")).evidence).toEqual([]);
    expect((await search(index, "coral")).evidence[0].entityId).toBe("relevant");
    snapshot.notes = [];
    await index.prepare(snapshot);
    expect((await search(index, "coral")).evidence).toEqual([]);
  });

  it("invalidates changed titles, source provenance and text outside the retrieved excerpt", async () => {
    const snapshot = space([], [source("s", `${"Ordinary field observations. ".repeat(100)}\nZircon reveals the sample age.`)]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const evidence = (await search(index, "zircon", 200)).evidence[0];
    snapshot.sources[0].title = "New title";
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(false);
    snapshot.sources[0].title = "s";
    snapshot.sources[0].sourceUrl = "https://example.com/source";
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(false);
    delete snapshot.sources[0].sourceUrl;
    snapshot.sources[0].text = `Changed${snapshot.sources[0].text.slice(7)}`;
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(false);
  });

  it("uses captured live editor content and never leaks across Spaces with colliding IDs", async () => {
    const first = space([note("same", "Persisted unrelated text.")]);
    const second = space([note("same", "Zircon dates the rock.")]);
    const index = new ImageSearchIndex();
    const live = { id: "same", body: "Live mycelium observations." };
    await index.prepare(first, live);
    const evidence = (await search(index, "mycelium")).evidence[0];
    expect(index.evidenceCurrent(evidence, first, live)).toBe(true);
    expect(index.evidenceCurrent(evidence, first)).toBe(false);
    await index.prepare(second);
    expect((await search(index, "mycelium")).evidence).toEqual([]);
    expect(index.evidenceCurrent(evidence, second)).toBe(false);
    expect((await search(index, "zircon")).evidence[0].entityId).toBe("same");
  });

  it("bounds evidence IDs and avoids splitting emoji with a tiny text budget", async () => {
    const snapshot = space([note("very-long-id".repeat(40), "🌿🌿 Zircon records geological history.")]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const result = await search(index, "zircon", 12);
    expect(result.evidence[0].id.length).toBeLessThanOrEqual(200);
    exact(result.evidence, snapshot);
    expect(result.evidence[0].passages[0].text.length).toBeLessThanOrEqual(12);
  });

  it("discloses oversized-document sampling while retaining the tail and other records", async () => {
    const body = `${"Common gardening observations. ".repeat(180_000)}\nTerminal zircon evidence.`;
    const snapshot = space([note("oversized", body), note("small", "Mycelium in roots.")]);
    const index = new ImageSearchIndex();
    await index.prepare(snapshot);
    const result = await search(index, "zircon");
    expect(result.coverage.limited).toBe(true);
    expect(result.evidence.some((item) => item.passages.some((part) => part.text.includes("Terminal zircon")))).toBe(true);
    expect((await search(index, "mycelium")).evidence[0].entityId).toBe("small");
  }, 15_000);

  it("observes cancellation during large preparation and before search", async () => {
    const snapshot = space([note("large", "Common gardening observations. ".repeat(350_000))]);
    const index = new ImageSearchIndex();
    const controller = new AbortController();
    const pending = index.prepare(snapshot, undefined, controller.signal);
    setTimeout(() => controller.abort(new Error("Stopped indexing")), 0);
    await expect(pending).rejects.toThrow("Stopped indexing");
    await index.prepare(space([note("small", "Coral grows slowly.")]));
    const cancelled = new AbortController();
    cancelled.abort(new Error("Stopped searching"));
    await expect(index.search("coral", { characterBudget: 1_000, signal: cancelled.signal })).rejects.toThrow("Stopped searching");
  });

  it("invalidates in-flight searches and clears ephemeral data", async () => {
    const index = new ImageSearchIndex();
    const snapshot = space([note("small", "Coral grows slowly.")]);
    await index.prepare(snapshot);
    const evidence = (await search(index, "coral")).evidence[0];
    const pending = search(index, "coral");
    index.clear();
    await expect(pending).rejects.toThrow();
    expect(index.evidenceCurrent(evidence, snapshot)).toBe(false);
    await expect(search(index, "coral")).rejects.toThrow("Prepare the active Space");
  });
});
