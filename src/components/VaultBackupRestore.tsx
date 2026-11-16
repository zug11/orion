import { useEffect, useState } from "react";
import { listVaultBackups, restoreVaultBackup, type VaultBackup } from "../lib/storage";

function describe(backup: VaultBackup): string {
  const when = new Date(backup.savedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const size = backup.bytes >= 1024 * 1024
    ? `${(backup.bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(backup.bytes / 1024))} KB`;
  return `${when} · ${size}`;
}

/**
 * Offered only when the library cannot be opened. Orion keeps recent versions
 * of the vault; the native host validates the chosen one and sets the
 * unreadable file aside before replacing it.
 */
export function VaultBackupRestore({ onRestored, onError }: {
  onRestored: () => void;
  onError: (message: string) => void;
}) {
  const [backups, setBackups] = useState<VaultBackup[]>([]);
  const [selected, setSelected] = useState("");
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void listVaultBackups().then((items) => {
      if (cancelled) return;
      setBackups(items);
      setSelected(items[0]?.name ?? "");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  if (backups.length === 0) return null;

  async function restore() {
    const backup = backups.find((item) => item.name === selected);
    if (!backup || restoring) return;
    if (!window.confirm(`Replace the library that could not be opened with the backup from ${describe(backup)}? The current file is kept in Orion’s backups folder.`)) return;
    setRestoring(true);
    try {
      await restoreVaultBackup(backup.name);
      onRestored();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="vault-backup-restore">
      <label htmlFor="vault-backup-choice">Or restore a recent backup</label>
      <select
        id="vault-backup-choice"
        value={selected}
        disabled={restoring}
        onChange={(event) => setSelected(event.target.value)}
      >
        {backups.map((backup) => (
          <option key={backup.name} value={backup.name}>{describe(backup)}</option>
        ))}
      </select>
      <button className="button ghost" type="button" disabled={restoring || !selected} onClick={() => void restore()}>
        {restoring ? "Restoring…" : "Restore"}
      </button>
    </div>
  );
}
