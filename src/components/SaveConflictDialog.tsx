import { useEffect, useRef } from "react";
import type { ConflictChoice, WindowVaultConflict } from "../lib/windowVault";

export function SaveConflictDialog({ conflict, onChoose }: {
  conflict: WindowVaultConflict;
  onChoose: (choice: ConflictChoice) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  const names = [...new Set(conflict.fields.map((field) =>
    field.match(/(?:notes|sources)\[([^\]]+)\]/)?.[1] ?? "Space content or settings",
  ))].slice(0, 5);
  return (
    <dialog ref={dialog} className="window-save-conflict" aria-labelledby="window-save-conflict-title"
      onCancel={(event) => event.preventDefault()}>
      <span className="eyebrow neutral">Changes from another window</span>
      <h2 id="window-save-conflict-title">Choose which changes to keep</h2>
      <p>Both windows changed the same content in {names.map((name) => `“${name}”`).join(", ")}.</p>
      <p>Your edits are still here. This choice applies only to overlapping changes; edits to other content will be kept.</p>
      <div className="window-save-conflict__actions">
        <button className="button" autoFocus onClick={() => onChoose("remote")}>Use other window’s changes</button>
        <button className="button primary" onClick={() => onChoose("local")}>Keep this window’s changes</button>
      </div>
    </dialog>
  );
}
