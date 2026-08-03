export interface ScrollPositionTarget {
  scrollLeft: number;
  scrollTop: number;
}

export interface ScrollPosition {
  scrollLeft: number;
  scrollTop: number;
}

export interface NoteHistoryEntry extends ScrollPosition {
  noteId: string;
}

export interface NoteHistoryState {
  entries: NoteHistoryEntry[];
  index: number;
}

const TOP_LEFT: ScrollPosition = { scrollLeft: 0, scrollTop: 0 };

export function readScrollPosition(
  target: ScrollPositionTarget | null,
): ScrollPosition {
  return target
    ? { scrollLeft: target.scrollLeft, scrollTop: target.scrollTop }
    : { ...TOP_LEFT };
}

export function restoreScrollPosition(
  target: ScrollPositionTarget | null,
  position: ScrollPosition,
): void {
  if (!target) return;
  target.scrollLeft = position.scrollLeft;
  target.scrollTop = position.scrollTop;
}

export function resetScrollPosition(
  target: ScrollPositionTarget | null,
): void {
  restoreScrollPosition(target, TOP_LEFT);
}

export function createNoteHistoryEntry(
  noteId: string,
  position: ScrollPosition = TOP_LEFT,
): NoteHistoryEntry {
  return { noteId, ...position };
}

export function pushNoteHistory(
  entries: readonly NoteHistoryEntry[],
  index: number,
  noteId: string,
  currentPosition: ScrollPosition | null,
  limit = 40,
): NoteHistoryState {
  const recorded = recordCurrentPosition(entries, index, currentPosition);
  const currentEntries = recorded.slice(0, index + 1);
  if (currentEntries[currentEntries.length - 1]?.noteId === noteId) {
    return { entries: recorded, index };
  }
  const nextEntries = [
    ...currentEntries,
    createNoteHistoryEntry(noteId),
  ].slice(-limit);
  return { entries: nextEntries, index: nextEntries.length - 1 };
}

export function moveNoteHistory(
  entries: readonly NoteHistoryEntry[],
  index: number,
  direction: -1 | 1,
  currentPosition: ScrollPosition | null,
): NoteHistoryState | null {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= entries.length) {
    return null;
  }
  return {
    entries: recordCurrentPosition(entries, index, currentPosition),
    index: nextIndex,
  };
}

function recordCurrentPosition(
  entries: readonly NoteHistoryEntry[],
  index: number,
  position: ScrollPosition | null,
): NoteHistoryEntry[] {
  const next = entries.map((entry) => ({ ...entry }));
  if (position && next[index]) {
    next[index] = { ...next[index], ...position };
  }
  return next;
}
