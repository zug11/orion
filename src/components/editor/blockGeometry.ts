/** Viewport (or a shared overlay origin) coordinates, in CSS pixels. */
export interface BlockRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BlockExclusion {
  /** The intrinsic image and caption frame, not its full-width float wrapper. */
  rect: BlockRect;
  /** The occupied edge: a left float leaves the text lane on its right. */
  side: "left" | "right" | "both";
  gap?: number;
}

export interface BlockPoint { x: number; y: number }

export interface BlockGeometry {
  /** Adjacent equal-width bands are merged. Empty lanes are omitted. */
  bands: BlockRect[];
  /** Separate outlines where a full-width image interrupts the prose. */
  polygons: BlockPoint[][];
  /** Suitable for an SVG path's d attribute in the input coordinate space. */
  path: string;
  bounds: BlockRect | null;
}

const EPSILON = 0.001;

function validRect(rect: BlockRect) {
  return [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top;
}

function same(a: number, b: number) { return Math.abs(a - b) < EPSILON; }

function outlineBands(bands: BlockRect[]): BlockPoint[] {
  const points: BlockPoint[] = [{ x: bands[0].left, y: bands[0].top }];
  for (const band of bands) {
    points.push({ x: band.right, y: band.top }, { x: band.right, y: band.bottom });
  }
  for (const band of [...bands].reverse()) {
    points.push({ x: band.left, y: band.bottom }, { x: band.left, y: band.top });
  }
  // Remove repeated and collinear corners so stable lanes have one quiet edge.
  const distinct = points.filter((point, index) => index === 0
    || !same(point.x, points[index - 1].x) || !same(point.y, points[index - 1].y));
  const lastPoint = distinct[distinct.length - 1];
  if (same(distinct[0].x, lastPoint.x) && same(distinct[0].y, lastPoint.y)) distinct.pop();
  return distinct.filter((point, index) => {
    const previous = distinct[(index + distinct.length - 1) % distinct.length];
    const next = distinct[(index + 1) % distinct.length];
    return !(same(previous.x, point.x) && same(point.x, next.x))
      && !(same(previous.y, point.y) && same(point.y, next.y));
  });
}

function pathFor(polygons: BlockPoint[][], cornerRadius: number) {
  const coordinate = (value: number) => String(Math.round(value * 1_000) / 1_000);
  const pointText = (point: BlockPoint) => `${coordinate(point.x)} ${coordinate(point.y)}`;
  return polygons.map((polygon) => {
    if (!cornerRadius) return polygon.map((point, index) =>
      `${index ? "L" : "M"}${pointText(point)}`).join(" ") + " Z";
    return polygon.map((point, index) => {
      const previous = polygon[(index + polygon.length - 1) % polygon.length];
      const next = polygon[(index + 1) % polygon.length];
      const incoming = Math.hypot(previous.x - point.x, previous.y - point.y);
      const outgoing = Math.hypot(next.x - point.x, next.y - point.y);
      // Each end consumes at most half of its edge, including short image
      // notches. Adjacent curves can meet but can never cross each other.
      const radius = Math.min(cornerRadius, incoming / 2, outgoing / 2);
      const entry = {
        x: point.x + (previous.x - point.x) * radius / incoming,
        y: point.y + (previous.y - point.y) * radius / incoming,
      };
      const exit = {
        x: point.x + (next.x - point.x) * radius / outgoing,
        y: point.y + (next.y - point.y) * radius / outgoing,
      };
      return `${index ? "L" : "M"}${pointText(entry)} Q${pointText(point)} ${pointText(exit)}`;
    }).join(" ") + " Z";
  }).join(" ");
}

/**
 * Follow the available text lane without resizing or wrapping ProseMirror DOM.
 * A paragraph beside an image has a narrow outline; a paragraph continuing
 * below it widens again. The paragraph stays one editing/deletion unit.
 *
 * Callers supply only images participating in text flow. Inline images should
 * be measured as their own blocks and omitted from these exclusions.
 */
export function createBlockGeometry(
  block: BlockRect,
  exclusions: readonly BlockExclusion[],
  options: { minimumWidth?: number; cornerRadius?: number } = {},
): BlockGeometry {
  const empty: BlockGeometry = { bands: [], polygons: [], path: "", bounds: null };
  if (!validRect(block)) return empty;
  const minimumWidth = typeof options.minimumWidth === "number" && Number.isFinite(options.minimumWidth)
    ? Math.max(EPSILON, options.minimumWidth) : 1;
  const cornerRadius = typeof options.cornerRadius === "number" && Number.isFinite(options.cornerRadius)
    ? Math.max(0, Math.min(24, options.cornerRadius)) : 7;
  const occupied = exclusions.flatMap((exclusion) => {
    if (!validRect(exclusion.rect)) return [];
    const gap = typeof exclusion.gap === "number" && Number.isFinite(exclusion.gap)
      ? Math.max(0, exclusion.gap) : 0;
    const rect = {
      left: exclusion.rect.left - gap,
      right: exclusion.rect.right + gap,
      top: Math.max(block.top, exclusion.rect.top - gap),
      bottom: Math.min(block.bottom, exclusion.rect.bottom + gap),
    };
    if (rect.bottom <= rect.top || rect.right <= block.left || rect.left >= block.right) return [];
    return [{ rect, side: exclusion.side }];
  });
  const edges = [...new Set([block.top, block.bottom, ...occupied.flatMap(({ rect }) => [rect.top, rect.bottom])])]
    .sort((a, b) => a - b);
  const bands: BlockRect[] = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const top = edges[index], bottom = edges[index + 1];
    if (bottom - top < EPSILON) continue;
    const middle = (top + bottom) / 2;
    let left = block.left, right = block.right;
    for (const exclusion of occupied) {
      if (middle < exclusion.rect.top || middle > exclusion.rect.bottom) continue;
      if (exclusion.side === "both") { left = right; break; }
      if (exclusion.side === "left") left = Math.max(left, exclusion.rect.right);
      else right = Math.min(right, exclusion.rect.left);
    }
    if (right - left < minimumWidth) continue;
    const previous = bands[bands.length - 1];
    if (previous && same(previous.bottom, top) && same(previous.left, left) && same(previous.right, right)) {
      previous.bottom = bottom;
    } else bands.push({ left, top, right, bottom });
  }
  if (!bands.length) return empty;
  const connected: BlockRect[][] = [];
  for (const band of bands) {
    const previousGroup = connected[connected.length - 1];
    const previous = previousGroup?.[previousGroup.length - 1];
    if (previous && same(previous.bottom, band.top)
      && Math.min(previous.right, band.right) - Math.max(previous.left, band.left) >= EPSILON) {
      previousGroup!.push(band);
    } else connected.push([band]);
  }
  const polygons = connected.map(outlineBands);
  return {
    bands,
    polygons,
    path: pathFor(polygons, cornerRadius),
    bounds: {
      left: Math.min(...bands.map((band) => band.left)),
      top: bands[0].top,
      right: Math.max(...bands.map((band) => band.right)),
      bottom: bands[bands.length - 1].bottom,
    },
  };
}
