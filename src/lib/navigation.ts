export interface ScrollPositionTarget {
  scrollLeft: number;
  scrollTop: number;
}

export function resetScrollPosition(
  target: ScrollPositionTarget | null,
): void {
  if (!target) return;
  target.scrollLeft = 0;
  target.scrollTop = 0;
}
