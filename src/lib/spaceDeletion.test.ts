import { describe, expect, it } from "vitest";
import { createEmptySnapshot, createEmptyVault } from "../data/defaults";
import { deleteSpaceFromVault } from "./spaceDeletion";

const CREATED_AT = "2026-08-12T01:00:00.000Z";
const DELETED_AT = "2026-08-12T01:30:00.000Z";

function vaultWithSpaces() {
  const vault = createEmptyVault("First", CREATED_AT);
  const first = vault.spaces[0];
  const second = createEmptySnapshot("Second", CREATED_AT, "space-second");
  const third = createEmptySnapshot("Third", CREATED_AT, "space-third");
  return {
    ...vault,
    spaces: [first, second, third],
    activeSpaceId: second.workspace.id,
  };
}

describe("deleteSpaceFromVault", () => {
  it("selects the following Space when the active Space is deleted", () => {
    const vault = vaultWithSpaces();
    const result = deleteSpaceFromVault(vault, "space-second", DELETED_AT);

    expect(result.deleted).toBe(true);
    expect(result.activeSpaceChanged).toBe(true);
    expect(result.nextActiveSpaceId).toBe("space-third");
    expect(result.vault.spaces.map((space) => space.workspace.name)).toEqual([
      "First",
      "Third",
    ]);
    expect(result.vault.updatedAt).toBe(DELETED_AT);
  });

  it("keeps the active Space when another Space is deleted", () => {
    const vault = vaultWithSpaces();
    const result = deleteSpaceFromVault(vault, "space-third", DELETED_AT);

    expect(result.deleted).toBe(true);
    expect(result.activeSpaceChanged).toBe(false);
    expect(result.nextActiveSpaceId).toBe("space-second");
  });

  it("falls back to the previous Space when deleting the active final row", () => {
    const vault = vaultWithSpaces();
    vault.activeSpaceId = "space-third";
    const result = deleteSpaceFromVault(vault, "space-third", DELETED_AT);

    expect(result.deleted).toBe(true);
    expect(result.activeSpaceChanged).toBe(true);
    expect(result.nextActiveSpaceId).toBe("space-second");
  });

  it("does nothing when the requested Space does not exist", () => {
    const vault = vaultWithSpaces();
    const result = deleteSpaceFromVault(vault, "space-missing", DELETED_AT);

    expect(result.deleted).toBe(false);
    expect(result.vault).toBe(vault);
    expect(result.nextActiveSpaceId).toBe("space-second");
  });

  it("refuses to delete the vault's final Space", () => {
    const vault = createEmptyVault("Only", CREATED_AT);
    const result = deleteSpaceFromVault(
      vault,
      vault.activeSpaceId,
      DELETED_AT,
    );

    expect(result.deleted).toBe(false);
    expect(result.vault).toBe(vault);
  });
});
