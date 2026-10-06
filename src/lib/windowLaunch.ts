import type { OrionVault } from "../types";

export interface WindowLaunch {
  writing: boolean;
  spaceId: string | null;
  noteId: string | null;
}

function boundedId(value: string | null): string | null {
  return value && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value : null;
}

export function parseWindowLaunch(search: string): WindowLaunch {
  const params = new URLSearchParams(search);
  return {
    writing: params.get("view") === "writing",
    spaceId: boundedId(params.get("space")),
    noteId: boundedId(params.get("note")),
  };
}

/** A note ID is meaningful only inside the explicitly requested Space. */
export function windowLaunchNote(vault: OrionVault, launch: WindowLaunch) {
  return vault.spaces.find((space) => space.workspace.id === launch.spaceId)
    ?.notes.find((note) => note.id === launch.noteId) ?? null;
}

export function applyWindowLaunch(vault: OrionVault, launch: WindowLaunch): OrionVault {
  const target = vault.spaces.find((space) => space.workspace.id === launch.spaceId);
  if (!target) return vault;
  const note = windowLaunchNote(vault, launch);
  return {
    ...vault,
    activeSpaceId: target.workspace.id,
    spaces: note ? vault.spaces.map((space) => space === target
      ? { ...space, activeNoteId: note.id } : space) : vault.spaces,
  };
}

export function documentWindowUrl(base: string, spaceId: string, noteId?: string, writing = false): string {
  const url = new URL(base);
  url.search = "";
  url.hash = "";
  url.searchParams.set("space", spaceId);
  if (noteId) url.searchParams.set("note", noteId);
  if (writing) url.searchParams.set("view", "writing");
  return url.href;
}
