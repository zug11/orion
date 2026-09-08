import { describe, expect, it } from "vitest";
import { createEmptyVault } from "../data/defaults";
import type { Note, OrionVault } from "../types";
import { mergeWindowVault, persistWindowVault, preserveWindowNavigation, vaultValuesEqual, WindowVaultConflict } from "./windowVault";

function fixture() {
  const vault = createEmptyVault("Windows", "2026-09-07T00:00:00.000Z");
  vault.spaces[0].notes = ["one", "two"].map((id): Note => ({
    id, title: id, slug: id, body: `Original ${id}`, summary: "", aliases: [], tags: [],
    kind: "article", status: "ready", sourceIds: [], conceptIds: [],
    createdAt: vault.updatedAt, updatedAt: vault.updatedAt,
  }));
  return vault;
}
const copy = (vault: OrionVault) => structuredClone(vault);

describe("shared vault, independent windows", () => {
  it("treats native JSON key ordering as the same content and avoids redundant writes", async () => {
    const base = fixture();
    const reordered = JSON.parse(JSON.stringify(base), (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).reverse());
    }) as OrionVault;
    expect(vaultValuesEqual(base, reordered)).toBe(true);
    let saved = false;
    await persistWindowVault(base, copy(base), { load: async () => reordered, save: async () => { saved = true; } });
    expect(saved).toBe(false);
  });
  it("merges edits to separate notes without changing disk order or navigation", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "Local text";
    local.spaces[0].activeNoteId = "one";
    remote.spaces[0].notes[1].body = "Other window text";
    remote.spaces[0].activeNoteId = "two";
    const merged = mergeWindowVault(base, local, remote);
    expect(merged.spaces[0].notes.map((n) => n.body)).toEqual(["Local text", "Other window text"]);
    expect(merged.spaces[0].activeNoteId).toBe("one");
    expect(base.spaces[0].notes[0].body).toBe("Original one");
  });

  it("merges different fields on one note and keeps independent tag changes", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "Edited prose";
    local.spaces[0].notes[0].tags = ["local"];
    remote.spaces[0].notes[0].title = "Renamed elsewhere";
    remote.spaces[0].notes[0].tags = ["remote"];
    expect(mergeWindowVault(base, local, remote).spaces[0].notes[0]).toMatchObject({
      title: "Renamed elsewhere", body: "Edited prose", tags: ["remote", "local"],
    });
  });

  it("requires an explicit choice for competing prose and preserves unrelated changes with either choice", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "My version";
    remote.spaces[0].notes[0].body = "Other version";
    local.spaces[0].notes[1].title = "My other edit";
    remote.spaces[0].notes[1].summary = "Their other edit";
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
    for (const choice of ["local", "remote"] as const) {
      const notes = mergeWindowVault(base, local, remote, choice).spaces[0].notes;
      expect(notes[0].body).toBe(choice === "local" ? "My version" : "Other version");
      expect(notes[1]).toMatchObject({ title: "My other edit", summary: "Their other edit" });
    }
  });

  it("does not resurrect deletions, and makes deletion versus editing a conflict", () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    remote.spaces[0].notes.shift();
    local.spaces[0].activeNoteId = "one";
    const merged = mergeWindowVault(base, local, remote);
    expect(merged.spaces[0].notes.map((n) => n.id)).toEqual(["two"]);
    expect(merged.spaces[0].activeNoteId).toBeNull();
    local.spaces[0].notes[0].body = "Unsaved edit";
    expect(() => mergeWindowVault(base, local, remote)).toThrow(WindowVaultConflict);
  });

  it("keeps windows in separate Spaces when another window navigates", () => {
    const local = fixture(), other = createEmptyVault("Other").spaces[0];
    local.spaces.push(other);
    local.spaces[0].activeNoteId = "one";
    const remote = copy(local); remote.activeSpaceId = other.workspace.id;
    remote.spaces[0].activeNoteId = "two";
    expect(preserveWindowNavigation(remote, local)).toMatchObject({ activeSpaceId: local.activeSpaceId });
    expect(preserveWindowNavigation(remote, local).spaces[0].activeNoteId).toBe("one");
  });

  it("retries an atomic revision race against fresh disk data", async () => {
    const base = fixture(), local = copy(base); let disk = copy(base), attempts = 0;
    local.spaces[0].notes[0].body = "Mine";
    const saved = await persistWindowVault(base, local, {
      load: async () => copy(disk),
      save: async (next, revision) => {
        if (attempts++ === 0) {
          disk.spaces[0].notes[1].body = "Concurrent edit";
          disk.updatedAt = "2026-09-07T00:00:00.001Z";
          throw new Error("ORION_VAULT_CONFLICT");
        }
        expect(revision).toBe(disk.updatedAt); disk = next;
      },
    });
    expect(saved.spaces[0].notes.map((n) => n.body)).toEqual(["Mine", "Concurrent edit"]);
    expect(attempts).toBe(2);
  });

  it("does not apply a conflict choice to a newer unseen version", async () => {
    const base = fixture(), local = copy(base), remote = copy(base);
    local.spaces[0].notes[0].body = "My text";
    remote.spaces[0].notes[0].body = "A newer edit";
    remote.updatedAt = "2026-09-07T00:00:01.000Z";
    await expect(persistWindowVault(base, local, {
      load: async () => remote, save: async () => { throw new Error("Must not save"); },
    }, { choice: "local", revision: base.updatedAt })).rejects.toThrow(WindowVaultConflict);
  });
});
