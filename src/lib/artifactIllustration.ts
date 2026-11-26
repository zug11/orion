/** An explorable drawing, in a single coordinate system. All styling and all
 * geometry tags are supplied by Orion. State changes replace only named parts. */
export const ILLUSTRATION_VIEWS = { landscape: [640, 400], square: [480, 480], portrait: [400, 560] } as const;
export const DRAWING_TONES = ["accent", "warm", "cool", "rose", "neutral", "ground"] as const;
export const DRAWING_PAINTS = [
  "outline",
  "soft",
  "fill",
  "solid",
  "bold",
  "heavy",
  "thin",
  "dashed",
  "dotted",
  "level",
] as const;
export const LEVEL_GLYPHS = ["tank", "battery", "thermometer", "gauge", "balance", "bar", "pie", "coins"] as const;
export const OBJECT_GLYPHS = [
  "sun",
  "solar-panel",
  "house",
  "factory",
  "utility-pole",
  "zap",
  "droplets",
  "waves-horizontal",
  "mountain",
  "leaf",
  "sprout",
  "flame",
  "wind",
  "car",
  "bike",
  "train-front",
  "plane",
  "ship",
  "tractor",
  "users",
  "building-2",
  "landmark",
  "store",
  "warehouse",
  "piggy-bank",
  "scale",
  "heart-pulse",
  "cpu",
  "globe",
] as const;
export const DRAWING_GLYPHS = [...LEVEL_GLYPHS, ...OBJECT_GLYPHS] as const;
export type DrawingGlyph = (typeof DRAWING_GLYPHS)[number];
export type DrawingView = keyof typeof ILLUSTRATION_VIEWS;
export type DrawingTone = (typeof DRAWING_TONES)[number];
export type DrawingPaint = (typeof DRAWING_PAINTS)[number];
export type DrawingPoint = [number, number];
export type DrawingShape = { paint: DrawingPaint } & (
  | { type: "rect"; x: number; y: number; w: number; h: number; r?: number }
  | { type: "circle"; cx: number; cy: number; r: number }
  | { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number }
  | { type: "polygon" | "polyline"; points: DrawingPoint[] }
  | { type: "path"; d: string }
);
export interface DrawingIcon {
  name: DrawingGlyph;
  x: number;
  y: number;
  size: number;
}
export interface DrawingPart {
  id: string;
  name: string;
  tone: DrawingTone;
  selectable: boolean;
  about?: string;
  quote?: string;
  layer?: number;
  level?: number;
  shapes?: DrawingShape[];
  icon?: DrawingIcon;
}
export interface DrawingChange {
  part: string;
  shapes?: DrawingShape[];
  hidden?: boolean;
  emphasis?: boolean;
  level?: number;
}
export interface DrawingStage {
  label: string;
  caption: string;
  changes: DrawingChange[];
}
export interface ArtifactIllustration {
  kind: "illustration";
  passage: string;
  view: DrawingView;
  parts: DrawingPart[];
  states?: { label: string; items: DrawingStage[] };
}

function invalid(message: string): never {
  throw new Error(`Orion could not read this illustration. ${message}`);
}
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    return invalid("Unexpected drawing fields.");
  return value as Record<string, unknown>;
}
function text(value: unknown, length: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > length ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  )
    return invalid("Invalid drawing text.");
  return value;
}
function list<T>(value: unknown, min: number, max: number, read: (v: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max)
    return invalid("Invalid drawing list length.");
  return Array.from(value, read);
}
function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) return invalid("Unknown drawing option.");
  return value as T;
}
function num(value: unknown, max: number, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    return invalid("A drawing coordinate or value is outside its range.");
  return value;
}
function bool(value: unknown): boolean {
  return typeof value === "boolean" ? value : invalid("Expected a true or false drawing option.");
}
function positive(value: unknown, max: number) {
  const n = num(value, max);
  return n > 0 ? n : invalid("Drawing dimensions must be positive.");
}

// A closed grammar shared with the MCP validator. No URL, style, markup,
// implicit command repetitions or relative coordinates can reach SVG. Read
// complete command groups, validating arc flags and endpoints independently.
export function readDrawingPath(d: string, size: readonly [number, number]): { op: string; args: number[] }[] {
  const [width, height] = size;
  const groups: { op: string; args: number[] }[] = [];
  const limits: Record<string, number[]> = {
    M: [width, height],
    L: [width, height],
    H: [width],
    V: [height],
    Q: [width, height, width, height],
    C: [width, height, width, height, width, height],
    A: [width, height, 360, 1, 1, width, height],
    Z: [],
  };
  const token = /([MLHVQCAZ])|(-?(?:\d+(?:\.\d*)?|\.\d+))/gy;
  const trimmed = d.trim();
  let at = 0;
  let group: { op: string; args: number[] } | undefined;
  while (at < trimmed.length) {
    token.lastIndex = at;
    const m = token.exec(trimmed);
    if (!m) return invalid("Malformed illustration path.");
    if (m[1]) {
      if (
        (!group && m[1] !== "M") ||
        (group && group.args.length !== limits[group.op].length) ||
        groups.length >= 96
      )
        return invalid("Incomplete illustration path.");
      group = { op: m[1], args: [] };
      groups.push(group);
    } else {
      if (!group || group.args.length >= limits[group.op].length)
        return invalid("Expected an explicit drawing command.");
      const i = group.args.length,
        n = Number(m[2]);
      if (group.op === "A" && (i === 3 || i === 4) && !["0", "1"].includes(m[2]))
        return invalid("Invalid arc flag.");
      group.args.push(num(n, limits[group.op][i], group.op === "A" && i === 2 ? -360 : 0));
    }
    at = token.lastIndex;
    const beforeSpace = at;
    while (at < trimmed.length && /\s/u.test(trimmed[at])) at++;
    if (trimmed[at] === ",") {
      if (!m[2] || !/^,\s*[-.\d]/u.test(trimmed.slice(at))) return invalid("Malformed drawing separator.");
      at++;
      while (at < trimmed.length && /\s/u.test(trimmed[at])) at++;
    } else if (m[2] && at === beforeSpace && trimmed[at] === ".") return invalid("Separate drawing coordinates.");
  }
  if (!group || group.args.length !== limits[group.op].length) return invalid("Incomplete illustration path.");
  return groups;
}

function drawingShape(raw: unknown, size: readonly [number, number]): DrawingShape {
  const type = (raw as { type?: unknown } | null)?.type;
  const props = (keys: string[]) => record(raw, ["type", "paint", ...keys]);
  const paint = oneOf((raw as { paint?: unknown } | null)?.paint, DRAWING_PAINTS);
  const [width, height] = size;
  if (paint === "level" && type !== "rect") return invalid("Level fill needs a rectangle.");
  switch (type) {
    case "rect": {
      const o = props(["x", "y", "w", "h", "r"]),
        x = num(o.x, width),
        y = num(o.y, height);
      const w = positive(o.w, width - x),
        h = positive(o.h, height - y);
      return { type, paint, x, y, w, h, ...(o.r === undefined ? {} : { r: num(o.r, Math.min(w, h) / 2) }) };
    }
    case "circle":
    case "ellipse": {
      const o = props(type === "circle" ? ["cx", "cy", "r"] : ["cx", "cy", "rx", "ry"]);
      const cx = num(o.cx, width),
        cy = num(o.cy, height);
      const mx = Math.min(cx, width - cx),
        my = Math.min(cy, height - cy);
      return type === "circle"
        ? { type, paint, cx, cy, r: positive(o.r, Math.min(mx, my)) }
        : { type, paint, cx, cy, rx: positive(o.rx, mx), ry: positive(o.ry, my) };
    }
    case "line": {
      const o = props(["x1", "y1", "x2", "y2"]);
      return {
        type,
        paint,
        x1: num(o.x1, width),
        y1: num(o.y1, height),
        x2: num(o.x2, width),
        y2: num(o.y2, height),
      };
    }
    case "polygon":
    case "polyline": {
      const o = props(["points"]);
      return {
        type,
        paint,
        points: list(o.points, type === "polygon" ? 3 : 2, 80, (point) => {
          if (!Array.isArray(point) || point.length !== 2) return invalid("Expected a drawing point.");
          return [num(point[0], width), num(point[1], height)];
        }),
      };
    }
    case "path": {
      const d = text(props(["d"]).d, 4000);
      readDrawingPath(d, size);
      return { type, paint, d };
    }
    default:
      return invalid("Unknown drawing shape.");
  }
}

export function parseArtifactIllustration(raw: unknown): ArtifactIllustration {
  const obj = record(raw, ["kind", "passage", "view", "parts", "states"]);
  if (obj.kind !== "illustration") return invalid("Expected an illustration.");
  const view = oneOf(obj.view, ["landscape", "square", "portrait"] as const),
    size = ILLUSTRATION_VIEWS[view];
  const passage = text(obj.passage, 12000);
  const ids = new Set<string>();
  let shapeCount = 0;
  const shapes = (value: unknown) =>
    list(value, 1, 60, (item) => {
      if (++shapeCount > 520) return invalid("Too many shapes in this illustration.");
      return drawingShape(item, size);
    });
  const parts = list(obj.parts, 1, 28, (value) => {
    const p = record(value, [
      "id",
      "name",
      "tone",
      "selectable",
      "about",
      "quote",
      "shapes",
      "icon",
      "layer",
      "level",
    ]);
    const id = text(p.id, 40);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id)) return invalid("Parts need unique drawing IDs.");
    ids.add(id);
    const part: DrawingPart = {
      id,
      name: text(p.name, 80),
      tone: oneOf(p.tone, DRAWING_TONES),
      selectable: bool(p.selectable),
    };
    if (p.about !== undefined || part.selectable) part.about = text(p.about, 600);
    if (p.quote !== undefined || part.selectable) {
      part.quote = text(p.quote, 400);
      if (!passage.includes(part.quote)) return invalid("A part's quote could not be found in its passage.");
    }
    if (p.shapes !== undefined) part.shapes = shapes(p.shapes);
    if (p.icon !== undefined) {
      const icon = record(p.icon, ["name", "x", "y", "size"]),
        x = num(icon.x, size[0]),
        y = num(icon.y, size[1]);
      part.icon = {
        name: oneOf(icon.name, DRAWING_GLYPHS),
        x,
        y,
        size: positive(icon.size, Math.min(size[0] - x, size[1] - y)),
      };
    }
    if (!part.shapes && !part.icon) return invalid("Each part needs a drawing or a library glyph.");
    if (p.layer !== undefined) {
      part.layer = num(p.layer, 3, -3);
      if (!Number.isInteger(part.layer)) return invalid("Expected a whole-number layer.");
    }
    if (p.level !== undefined) part.level = num(p.level, 1);
    return part;
  });
  if (!parts.some((p) => p.selectable)) return invalid("Choose at least one part to explore.");
  const result: ArtifactIllustration = { kind: "illustration", view, passage, parts };
  if (obj.states !== undefined) {
    const states = record(obj.states, ["label", "items"]);
    result.states = {
      label: text(states.label, 80),
      items: list(states.items, 2, 8, (item) => {
        const state = record(item, ["label", "caption", "changes"]),
          seen = new Set<string>();
        const changes = list(state.changes, 0, 28, (v) => {
          const c = record(v, ["part", "hidden", "emphasis", "level", "shapes"]);
          const part = text(c.part, 40);
          if (!ids.has(part) || seen.has(part)) return invalid("A stage names an unknown or duplicate part.");
          seen.add(part);
          const change: DrawingChange = { part };
          if (c.hidden !== undefined) change.hidden = bool(c.hidden);
          if (c.emphasis !== undefined) change.emphasis = bool(c.emphasis);
          if (c.level !== undefined) change.level = num(c.level, 1);
          if (c.shapes !== undefined) change.shapes = shapes(c.shapes);
          return change;
        });
        return { label: text(state.label, 80), caption: text(state.caption, 600), changes };
      }),
    };
  }
  return result;
}

export function validateIllustrationSource(block: ArtifactIllustration, source: string): void {
  if (!source.includes(block.passage))
    return invalid("The illustration's passage differs from the selected text.");
}
