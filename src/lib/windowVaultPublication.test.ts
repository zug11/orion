import { describe, expect, it } from "vitest";
import { createEmptyVault } from "../data/defaults";
import { reconcileSnapshotConceptVocabulary } from "./concepts";
import { mergeWindowVault } from "./windowVault";
import { publishWindowVault } from "./windowVaultPublication";
import type { Note } from "../types";

function fixture() {
  const vault = createEmptyVault("Local", "2026-10-12T00:00:00.000Z");
  const note: Note = { id: "draft", title: "Draft", slug: "draft", body: "An original thought.", summary: "", kind: "article", status: "ready", tags: [], aliases: [], sourceIds: [], conceptIds: [], createdAt: vault.updatedAt, updatedAt: vault.updatedAt };
  vault.spaces[0].notes = [note, { ...note, id: "other", title: "Other note" }];
  vault.spaces.push(createEmptyVault("Second Space").spaces[0]);
  vault.spaces = vault.spaces.map(reconcileSnapshotConceptVocabulary);
  return vault;
}

describe("publishing a saved vault without rebuilding unchanged knowledge", () => {
  it("reuses every Space, note and vocabulary after an ordinary autosave round trip", () => {
    const local = fixture(), disk = structuredClone(local); disk.updatedAt = "2026-10-12T00:00:01.000Z";
    const published = publishWindowVault(local, mergeWindowVault(local, local, disk, "local"));
    expect(published.updatedAt).toBe(disk.updatedAt);
    expect(published.spaces).toBe(local.spaces);
    expect(published.spaces[0].notes).toBe(local.spaces[0].notes);
    expect(published.spaces[0].concepts).toBe(local.spaces[0].concepts);
  });
  it("preserves newer typing while publishing the earlier save", () => {
    const before = fixture(), saved = structuredClone(before), live = { ...before, spaces: [...before.spaces] };
    live.spaces[0] = { ...before.spaces[0], notes: before.spaces[0].notes.map(note => note.id === "draft" ? { ...note, body: "Newer unsaved typing" } : note) };
    const published = publishWindowVault(live, mergeWindowVault(before, live, saved, "local"));
    expect(published.spaces[0]).toBe(live.spaces[0]); expect(published.spaces[0].notes[0].body).toBe("Newer unsaved typing");
  });
  it("reconciles an external note into link vocabulary while retaining other Spaces and notes", () => {
    const local = fixture(), remote = structuredClone(local);
    remote.spaces[0].notes.push({ ...remote.spaces[0].notes[0], id: "external", title: "Incoming idea", conceptIds: [] });
    const published = publishWindowVault(local, mergeWindowVault(local, local, remote));
    expect(published.spaces[1]).toBe(local.spaces[1]);
    expect(published.spaces[0].notes[0]).toBe(local.spaces[0].notes[0]);
    expect(published.spaces[0].concepts.some(concept => concept.canonicalNoteId === "external")).toBe(true);
    expect(local.spaces[0].notes).toHaveLength(2);
  });
});
