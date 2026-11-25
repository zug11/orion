export interface ScrollPositionTarget {
  scrollLeft: number;
  scrollTop: number;
}

export interface ScrollPosition {
  scrollLeft: number;
  scrollTop: number;
}

export type NavigationScreen =
  | "home"
  | "notes"
  | "contacts"
  | "sources"
  | "chat"
  | "settings"
  | "note";

export type NavigationRoute = (
  | { screen: Exclude<NavigationScreen, "note"> }
  | { screen: "note"; noteId: string }) & { ticketId?:string; boardId?:string };

export interface NavigationEntry extends ScrollPosition {
  route: NavigationRoute;
}

export interface NavigationHistoryState {
  entries: NavigationEntry[];
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

/** Restore a reading position that may extend past the initial editor or image layout. */
export function restoreReadingPosition(pane: HTMLElement | null, position: ScrollPosition) {
  if (!pane) return;
  const restore = () => {
    restoreScrollPosition(pane, position);
    return Math.abs(pane.scrollTop - position.scrollTop) < 1 &&
      Math.abs(pane.scrollLeft - position.scrollLeft) < 1;
  };
  if (restore() || typeof ResizeObserver === "undefined") return;

  // Retry on actual layout changes only. A reader moving elsewhere owns the scroll again.
  const listeners = new AbortController();
  const resize = new ResizeObserver(retry);
  const children = new MutationObserver(observeContent);
  function observeLayout(element: Element) {
    resize.observe(element);
    // Note surfaces use display: contents, so their children supply the layout box.
    if (element === pane || getComputedStyle(element).display === "contents") {
      children.observe(element, { childList: true });
      for (const child of element.children) observeLayout(child);
    }
  }
  function observeContent() {
    if (!pane || listeners.signal.aborted) return;
    resize.disconnect();
    children.disconnect();
    observeLayout(pane);
  }
  function stop() {
    resize.disconnect();
    children.disconnect();
    listeners.abort();
  }
  function retry() {
    if (!listeners.signal.aborted && restore()) stop();
  }
  observeContent();
  const options = { signal: listeners.signal, capture: true, passive: true };
  for (const event of ["wheel", "pointerdown", "touchstart"]) pane.addEventListener(event, stop, options);
  window.addEventListener("keydown", stop, options);
  return stop;
}

export function routesMatch(
  left: NavigationRoute,
  right: NavigationRoute,
): boolean {
  return (
    left.screen === right.screen &&
    left.ticketId === right.ticketId && left.boardId === right.boardId &&
    (left.screen !== "note" ||
      (right.screen === "note" && left.noteId === right.noteId))
  );
}

export function createNavigationEntry(
  route: NavigationRoute,
  position: ScrollPosition = TOP_LEFT,
): NavigationEntry {
  return { route, ...position };
}

export function pushNavigationHistory(
  entries: readonly NavigationEntry[],
  index: number,
  route: NavigationRoute,
  currentPosition: ScrollPosition | null,
  limit = 40,
): NavigationHistoryState {
  const recorded = recordCurrentPosition(entries, index, currentPosition);
  const currentEntries = recorded.slice(0, index + 1);
  const current = currentEntries[currentEntries.length - 1];
  if (current && routesMatch(current.route, route)) {
    return { entries: recorded, index };
  }
  const nextEntries = [
    ...currentEntries,
    createNavigationEntry(route),
  ].slice(-limit);
  return { entries: nextEntries, index: nextEntries.length - 1 };
}

export function moveNavigationHistory(
  entries: readonly NavigationEntry[],
  index: number,
  direction: -1 | 1,
  currentPosition: ScrollPosition | null,
): NavigationHistoryState | null {
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
  entries: readonly NavigationEntry[],
  index: number,
  position: ScrollPosition | null,
): NavigationEntry[] {
  const next = entries.map((entry) => ({
    ...entry,
    route: { ...entry.route },
  }));
  if (position && next[index]) {
    next[index] = { ...next[index], ...position };
  }
  return next;
}
