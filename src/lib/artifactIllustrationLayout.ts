import {
  ILLUSTRATION_VIEWS,
  readDrawingPath,
  type ArtifactIllustration,
  type DrawingChange,
  type DrawingPoint,
  type DrawingShape,
} from "./artifactIllustration";

type Bounds = { left: number; top: number; right: number; bottom: number };
const empty = (): Bounds => ({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
function include(box: Bounds, x: number, y: number) {
  box.left = Math.min(box.left, x);
  box.right = Math.max(box.right, x);
  box.top = Math.min(box.top, y);
  box.bottom = Math.max(box.bottom, y);
}
function union(box: Bounds, child: Bounds) {
  include(box, child.left, child.top);
  include(box, child.right, child.bottom);
}

// Endpoint-to-centre conversion for an SVG elliptical arc. Sampling its selected
// arc keeps an arc wrapping a sprocket from cropping or framing the whole bike.
function includeArc(box: Bounds, start: DrawingPoint, args: number[], path?: DrawingPoint[]) {
  let [rx, ry] = args;
  const [, , angle, large, sweep, x, y] = args;
  include(box, x, y);
  if (!rx || !ry || (start[0] === x && start[1] === y)) return;
  const phi = (angle * Math.PI) / 180,
    cos = Math.cos(phi),
    sin = Math.sin(phi);
  const dx = (start[0] - x) / 2,
    dy = (start[1] - y) / 2;
  const ax = dx * cos + dy * sin,
    ay = -dx * sin + dy * cos;
  const scale = Math.sqrt((ax / rx) ** 2 + (ay / ry) ** 2);
  if (scale > 1) {
    rx *= scale;
    ry *= scale;
  }
  // Extremely small radii can underflow intermediate products. The declared
  // view plus endpoints remains a safe frame in that case.
  const denom = rx * rx * ay * ay + ry * ry * ax * ax;
  if (!Number.isFinite(denom) || !denom) return;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - denom) / denom));
  const px = (k * rx * ay) / ry,
    py = (-k * ry * ax) / rx;
  const cx = cos * px - sin * py + (start[0] + x) / 2,
    cy = sin * px + cos * py + (start[1] + y) / 2;
  const begin = Math.atan2((ay - py) / ry, (ax - px) / rx),
    end = Math.atan2((-ay - py) / ry, (-ax - px) / rx);
  let delta = end - begin;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  for (let i = 1; i < 24; i++) {
    const t = begin + (delta * i) / 24;
    const sx = cx + cos * rx * Math.cos(t) - sin * ry * Math.sin(t),
      sy = cy + sin * rx * Math.cos(t) + cos * ry * Math.sin(t);
    if (Number.isFinite(sx) && Number.isFinite(sy)) {
      include(box, sx, sy);
      path?.push([sx, sy]);
    }
  }
}
function shapeBounds(shape: DrawingShape, size: readonly [number, number]): Bounds {
  const box = empty();
  switch (shape.type) {
    case "rect":
      return { left: shape.x, top: shape.y, right: shape.x + shape.w, bottom: shape.y + shape.h };
    case "circle":
      return {
        left: shape.cx - shape.r,
        top: shape.cy - shape.r,
        right: shape.cx + shape.r,
        bottom: shape.cy + shape.r,
      };
    case "ellipse":
      return {
        left: shape.cx - shape.rx,
        top: shape.cy - shape.ry,
        right: shape.cx + shape.rx,
        bottom: shape.cy + shape.ry,
      };
    case "line":
      include(box, shape.x1, shape.y1);
      include(box, shape.x2, shape.y2);
      break;
    case "polygon":
    case "polyline":
      for (const [x, y] of shape.points) include(box, x, y);
      break;
    case "path": {
      let point: DrawingPoint = [0, 0],
        start: DrawingPoint = [0, 0];
      for (const { op, args } of readDrawingPath(shape.d, size)) {
        if (op === "Z") {
          point = start;
          continue;
        }
        if (op === "H") point = [args[0], point[1]];
        else if (op === "V") point = [point[0], args[0]];
        else {
          if (op === "A") includeArc(box, point, args);
          else for (let i = 0; i < args.length; i += 2) include(box, args[i], args[i + 1]);
          point = [args[args.length - 2], args[args.length - 1]];
        }
        include(box, ...point);
        if (op === "M") start = point;
      }
    }
  }
  return box;
}

export function illustrationLayout(block: ArtifactIllustration) {
  const size = ILLUSTRATION_VIEWS[block.view],
    box = empty();
  const geometry = new Map<DrawingShape, Bounds>();
  const record = (shape: DrawingShape) => {
    const bounds = shapeBounds(shape, size);
    geometry.set(shape, bounds);
    union(box, bounds);
  };
  for (const part of block.parts) {
    part.shapes?.forEach(record);
    if (part.icon) {
      const { x, y, size } = part.icon;
      include(box, x, y);
      include(box, x + size, y + size);
    }
  }
  for (const stage of block.states?.items ?? [])
    for (const change of stage.changes) change.shapes?.forEach(record);
  // Keep the shared frame across states, including badge space. Drawing outside
  // the declared canvas (e.g. arcs) is clipped consistently with the source view.
  box.left = Math.max(0, box.left);
  box.top = Math.max(0, box.top);
  box.right = Math.min(size[0], box.right);
  box.bottom = Math.min(size[1], box.bottom);
  const span = Math.max(40, box.right - box.left, box.bottom - box.top),
    pad = span * 0.065;
  const left = box.left - pad,
    top = box.top - pad;
  const width = Math.max(pad * 4, box.right - box.left + 2 * pad),
    height = Math.max(pad * 4, box.bottom - box.top + 2 * pad);
  return { left, top, width, height, geometry };
}
type Contour = DrawingPoint[][];
function featureContour(shape: DrawingShape | undefined, box: Bounds, size: readonly [number, number]): Contour {
  const { left, top, right, bottom } = box;
  if (!shape || shape.type === "rect")
    return [
      [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
        [left, top],
      ],
    ];
  if (shape.type === "line")
    return [
      [
        [shape.x1, shape.y1],
        [shape.x2, shape.y2],
      ],
    ];
  if (shape.type === "circle" || shape.type === "ellipse")
    return [
      Array.from({ length: 25 }, (_, i) => {
        const a = (i * Math.PI) / 12;
        return [shape.cx + (Math.cos(a) * (right - left)) / 2, shape.cy + (Math.sin(a) * (bottom - top)) / 2];
      }),
    ];
  if (shape.type === "polyline" || shape.type === "polygon")
    return [shape.type === "polygon" ? [...shape.points, shape.points[0]] : shape.points];
  const paths: Contour = [];
  let point: DrawingPoint = [0, 0],
    ring: DrawingPoint[] = [];
  if (shape.type !== "path") return paths;
  for (const { op, args } of readDrawingPath(shape.d, size)) {
    if (op === "M") {
      point = [args[0], args[1]];
      ring = [point];
      paths.push(ring);
      continue;
    }
    if (op === "Z") {
      point = ring[0];
      ring.push(point);
      continue;
    }
    if (op === "H") point = [args[0], point[1]];
    else if (op === "V") point = [point[0], args[0]];
    else {
      if (op === "A") includeArc(empty(), point, args, ring);
      if (op === "C" || op === "Q") {
        for (let j = 1; j < 8; j++) {
          const t = j / 8,
            u = 1 - t;
          const curve = (axis: number) =>
            op === "C"
              ? u ** 3 * point[axis] +
                3 * u * u * t * args[axis] +
                3 * u * t * t * args[axis + 2] +
                t ** 3 * args[axis + 4]
              : u * u * point[axis] + 2 * u * t * args[axis] + t * t * args[axis + 2];
          ring.push([curve(0), curve(1)]);
        }
      }
      point = [args[args.length - 2], args[args.length - 1]];
    }
    ring.push(point);
  }
  // Decimate elaborate paths for label placement only. The renderer draws every command.
  return paths.map((points) => {
    const stride = Math.max(1, Math.ceil(points.length / 80));
    return points.filter((_, i) => i % stride === 0 || i === points.length - 1);
  });
}
function nearest(x: number, y: number, contour: Contour): { point: DrawingPoint; distance: number } {
  let point: DrawingPoint = [0, 0],
    distance = Infinity;
  for (const ring of contour) {
    for (let i = 0; i < ring.length; i++) {
      const [ax, ay] = ring[i],
        [bx, by] = ring[Math.max(0, i - 1)],
        dx = bx - ax,
        dy = by - ay;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
      const nx = ax + t * dx,
        ny = ay + t * dy,
        squared = (x - nx) ** 2 + (y - ny) ** 2;
      if (squared < distance) {
        distance = squared;
        point = [nx, ny];
      }
    }
  }
  return { point, distance: Math.sqrt(distance) };
}
export interface DrawingBadge {
  x: number;
  y: number;
  anchor: DrawingPoint;
  leader: boolean;
}
export function illustrationBadges(
  block: ArtifactIllustration,
  changes: DrawingChange[],
  layout: ReturnType<typeof illustrationLayout>
) {
  const result = new Map<string, DrawingBadge>();
  const radius = Math.max(layout.width, layout.height) * 0.019;
  const features = block.parts.flatMap((part) => {
    const change = changes.find((c) => c.part === part.id);
    if (!part.selectable || change?.hidden) return [];
    const first = (change?.shapes ?? part.shapes)?.[0],
      icon = part.icon;
    const box = first
      ? layout.geometry.get(first)
      : icon && { left: icon.x, top: icon.y, right: icon.x + icon.size, bottom: icon.y + icon.size };
    if (!box) return [];
    return [
      {
        id: part.id,
        box,
        contour: featureContour(first, box, ILLUSTRATION_VIEWS[block.view]),
        area: Math.max(radius, box.right - box.left) * Math.max(radius, box.bottom - box.top),
      },
    ];
  });
  // Give small features first choice. Larger enclosures can use another side;
  // the reverse order puts callouts for an enclosure on the parts inside it.
  features.sort((a, b) => a.area - b.area);
  for (const feature of features) {
    const { box } = feature,
      cx = (box.left + box.right) / 2,
      cy = (box.top + box.bottom) / 2;
    const guideX = Math.max(radius / 3, (box.right - box.left) / 2),
      guideY = Math.max(radius / 3, (box.bottom - box.top) / 2);
    let best: DrawingBadge | undefined,
      score = -Infinity;
    for (const offset of [1.35, 2.55]) {
      for (let i = 0; i < 16; i++) {
        const angle = (i * Math.PI) / 8 - Math.PI / 2;
        // Start on the actual silhouette, including the inside of an open
        // U-shaped clamp. A bounding-box corner may be nowhere on the part.
        const anchor = nearest(
          cx + guideX * Math.cos(angle),
          cy + guideY * Math.sin(angle),
          feature.contour
        ).point;
        const x = Math.max(
          layout.left + radius,
          Math.min(layout.left + layout.width - radius, anchor[0] + offset * radius * Math.cos(angle))
        );
        const y = Math.max(
          layout.top + radius,
          Math.min(layout.top + layout.height - radius, anchor[1] + offset * radius * Math.sin(angle))
        );
        const own = nearest(x, y, feature.contour);
        let quality = -Math.abs(own.distance - 1.35 * radius) - offset * 0.1 * radius;
        for (const badge of result.values())
          quality -= 10 * Math.max(0, 2.45 * radius - Math.hypot(x - badge.x, y - badge.y));
        for (const other of features) {
          if (other === feature) continue;
          const b = other.box;
          if (
            x < b.left - 2 * radius ||
            x > b.right + 2 * radius ||
            y < b.top - 2 * radius ||
            y > b.bottom + 2 * radius
          )
            continue;
          const distance = nearest(x, y, other.contour).distance;
          quality -= 3 * Math.max(0, own.distance + radius - distance);
          const enclosing =
            b.left <= box.left && b.right >= box.right && b.top <= box.top && b.bottom >= box.bottom;
          if (!enclosing && x >= b.left && x <= b.right && y >= b.top && y <= b.bottom) {
            quality -= 18 * radius;
          }
        }
        // Where several positions are equally clear, prefer the top-right.
        quality += radius * (0.05 * Math.cos(angle) - 0.08 * Math.sin(angle));
        if (quality > score) {
          score = quality;
          best = { x, y, anchor: own.point, leader: own.distance > radius * 1.2 && own.distance < radius * 3.5 };
        }
      }
    }
    if (best) result.set(feature.id, best);
  }
  return result;
}
