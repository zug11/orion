import { describe, expect, it } from "vitest";
import { createEmptySnapshot, createEmptyVault } from "../data/defaults";
import { renameSpaceInVault } from "./spaceNames";
import { mergeWindowVault, WindowVaultConflict } from "./windowVault";

const BEFORE = "2026-09-28T01:00:00.000Z";
const AFTER = "2026-09-28T01:30:00.000Z";

function fixture() {
  const vault = createEmptyVault("Main", BEFORE);
  vault.spaces.push(createEmptySnapshot("Research", BEFORE, "space-research"));
  vault.spaces[1].spaceOverview = { title: "An existing overview", body: "Keep this overview.", relatedNoteIds: [], generatedAt: BEFORE, stale: false };
  return vault;
}

describe("renameSpaceInVault", () => {
  it("changes only the requested name and revision, preserving identity, content and navigation", () => {
    const vault = fixture();
    const target = vault.spaces[1];
    const result = renameSpaceInVault(vault, target.workspace.id, "  Client   archive ", AFTER, "Research");
    expect(result.error).toBeNull();
    expect(result.vault.activeSpaceId).toBe(vault.activeSpaceId);
    expect(result.vault.spaces.map((space) => space.workspace.id)).toEqual(vault.spaces.map((space) => space.workspace.id));
    expect(result.vault.spaces[0]).toBe(vault.spaces[0]);
    expect(result.vault.spaces[1]).toEqual({ ...target, workspace: { ...target.workspace, name: "Client archive" }, updatedAt: AFTER });
    expect(result.vault.spaces[1].notes).toBe(target.notes);
    expect(result.vault.spaces[1].sources).toBe(target.sources);
    expect(result.vault.spaces[1].settings).toBe(target.settings);
    expect(result.vault.spaces[1].spaceOverview).toBe(target.spaceOverview);
    expect(result.vault.updatedAt).toBe(AFTER);
    expect(target.workspace.name).toBe("Research");
    expect(vault.updatedAt).toBe(BEFORE);
  });

  it.each([" ", "mAiN", "a".repeat(61)])("rejects invalid or duplicate name %j without mutation", (name) => {
    const vault = fixture();
    const result = renameSpaceInVault(vault, "space-research", name, AFTER, "Research");
    expect(result.error).toBeTruthy();
    expect(result.vault).toBe(vault);
  });

  it("allows a case-only rename and accepts the unchanged name without a new revision", () => {
    const vault = fixture();
    expect(renameSpaceInVault(vault, "space-research", "RESEARCH", AFTER, "Research").vault.spaces[1].workspace.name).toBe("RESEARCH");
    expect(renameSpaceInVault(vault, "space-research", " Research ", AFTER, "Research").vault).toBe(vault);
  });

  it("rejects a missing exact ID and a stale original name", () => {
    const vault = fixture();
    for (const [id, expected] of [["missing", "Research"], ["space-research", "Old research"]]) {
      const result = renameSpaceInVault(vault, id, "New name", AFTER, expected);
      expect(result.error).toBeTruthy();
      expect(result.vault).toBe(vault);
    }
  });

  it("merges with another window's content change while surfacing competing renames", () => {
    const base = fixture();
    const local = renameSpaceInVault(base, "space-research", "My research", AFTER, "Research").vault;
    const remote = { ...base, updatedAt: AFTER, spaces: base.spaces.map((space) => space.workspace.id === "space-research"
      ? { ...space, workspace: { ...space.workspace, description: "An independent edit" } } : space) };
    const merged = mergeWindowVault(base, local, remote);
    expect(merged.spaces[1].workspace).toEqual({ ...base.spaces[1].workspace, name: "My research", description: "An independent edit" });
    const competing = renameSpaceInVault(base, "space-research", "Other research", AFTER, "Research").vault;
    expect(() => mergeWindowVault(base, local, competing)).toThrow(WindowVaultConflict);
  });
});
