import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultBackupRestore } from "./VaultBackupRestore";

const storage = vi.hoisted(() => ({ listVaultBackups: vi.fn(), restoreVaultBackup: vi.fn() }));
vi.mock("../lib/storage", () => storage);

const BACKUPS = [
  { name: "vault-20261115T092000Z.json", savedAt: "2026-11-15T09:20:00Z", bytes: 5_242_880 },
  { name: "vault-20261114T180000Z.json", savedAt: "2026-11-14T18:00:00Z", bytes: 2048 },
];

describe("VaultBackupRestore", () => {
  beforeEach(() => {
    storage.listVaultBackups.mockReset().mockResolvedValue(BACKUPS);
    storage.restoreVaultBackup.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("stays out of the way when there is nothing to restore", async () => {
    storage.listVaultBackups.mockResolvedValue([]);
    const { container } = render(<VaultBackupRestore onRestored={vi.fn()} onError={vi.fn()} />);
    await waitFor(() => expect(storage.listVaultBackups).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("restores the chosen backup only after confirmation", async () => {
    const onRestored = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    render(<VaultBackupRestore onRestored={onRestored} onError={vi.fn()} />);
    const choice = await screen.findByLabelText("Or restore a recent backup");
    expect(choice).toHaveValue(BACKUPS[0].name);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("5.0 MB"),
      expect.stringContaining("2 KB"),
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(storage.restoreVaultBackup).not.toHaveBeenCalled();

    fireEvent.change(choice, { target: { value: BACKUPS[1].name } });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(storage.restoreVaultBackup).toHaveBeenCalledWith(BACKUPS[1].name);
  });

  it("reports a refused restore and leaves the choice available", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    storage.restoreVaultBackup.mockRejectedValue("That backup refers to source text that is no longer stored.");
    const onError = vi.fn();
    const onRestored = vi.fn();
    render(<VaultBackupRestore onRestored={onRestored} onError={onError} />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("That backup refers to source text that is no longer stored."));
    expect(onRestored).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Restore" })).toBeEnabled();
  });
});
