/** Versioned data shared by generated and saved note artifacts. All drawing and
 * interaction are rendered by Orion; the document contains no executable code. */
export const ARTIFACT_FORMATS = ["timeline", "explainer", "quiz", "comparison", "flashcards", "calculator"] as const;
export type ArtifactFormat = typeof ARTIFACT_FORMATS[number];
export const MAX_ARTIFACT_BYTES = 48_000;
export const MAX_ARTIFACT_SOURCE = 12_000;
export const MAX_ARTIFACT_GUIDANCE = 800;

const PAINTS = ["none", "ink", "muted", "accent", "warm", "cool", "surface"] as const;
const OPERATIONS = ["add", "subtract", "multiply", "divide", "min", "max"] as const;
export type ArtifactPaint = typeof PAINTS[number];
export type ArtifactExpression = number | { input: number } | {
  op: typeof OPERATIONS[number];
  left: ArtifactExpression;
  right: ArtifactExpression;
} | {
  op: "periodicPayment";
  principal: ArtifactExpression;
  ratePerPeriod: ArtifactExpression;
  periods: ArtifactExpression;
};
type Paint = { fill: ArtifactPaint; stroke: ArtifactPaint };
export type ArtifactShape = Paint & (
  | { kind: "path"; d: string }
  | { kind: "rect"; x: number; y: number; width: number; height: number; level?: boolean }
  | { kind: "circle"; cx: number; cy: number; r: number }
);
export type ArtifactBlock =
  | { kind: "text"; heading?: string; text: string }
  | { kind: "steps"; items: { label: string; heading: string; text: string }[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "quiz"; items: { question: string; choices: string[]; answer: number; explanation: string }[] }
  | { kind: "cards"; items: { front: string; back: string }[] }
  | {
      kind: "calculator";
      inputs: { label: string; unit: string; min: number; max: number; step: number; initial: number }[];
      outputs: { label: string; unit: string; expression: ArtifactExpression }[];
    }
  | {
      kind: "scene";
      nodes: { label: string; alt: string; x: number; y: number; shapes: ArtifactShape[] }[];
      frames: {
        label: string; caption: string; values: string[]; levels: (number | null)[];
        flows: { from: number; to: number; label: string }[];
      }[];
    };
export interface VisualArtifact {
  version: 1;
  format: ArtifactFormat;
  title: string;
  summary?: string;
  blocks: ArtifactBlock[];
}

function invalid(): never {
  throw new Error("Orion could not read this visual. Try generating it again.");
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}

function list<T>(value: unknown, min: number, max: number, read: (item: unknown, index: number) => T): T[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) return invalid();
  return Array.from(value, read);
}

function literal(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && !value.trim()) ||
      /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(value)) return invalid();
  return value;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) return invalid();
  return value as T;
}

function finite(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return invalid();
  return value;
}

function index(value: unknown, count: number): number {
  const result = finite(value, 0, count - 1);
  return Number.isInteger(result) ? result : invalid();
}

const coordinate = (value: unknown) => finite(value, 0, 100);
const quantity = (value: unknown) => finite(value, -1e9, 1e9);

/** Absolute lines and Béziers only, in a node's unit square (100 x 100).
 * Validate complete command groups, including the SVG implicit repeat syntax. */
function pathData(value: unknown): string {
  const path = literal(value, 1200).trim();
  const arity = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, Z: 0 };
  const token = /[MLHVQCZ]|(?:\d+(?:\.\d*)?|\.\d+)/gy;
  let offset = 0;
  let command: keyof typeof arity | undefined;
  let groups = 0;
  let remaining = 0;
  let complete = false;
  let previousNumber = false;
  while (offset < path.length) {
    const ch = path[offset];
    if (/\s/.test(ch)) { offset++; continue; }
    if (ch === ",") {
      if (!previousNumber || !/^,\s*(?:\d|\.)/.test(path.slice(offset))) return invalid();
      previousNumber = false;
      offset++;
      continue;
    }
    token.lastIndex = offset;
    const next = token.exec(path);
    if (!next) return invalid();
    offset = token.lastIndex;
    const part = next[0];
    if (Object.prototype.hasOwnProperty.call(arity, part)) {
      if ((command && !complete) || (!command && part !== "M")) return invalid();
      command = part as keyof typeof arity;
      remaining = arity[command];
      complete = remaining === 0;
      previousNumber = false;
      if (++groups > 64) return invalid();
      continue;
    }
    if (!command || command === "Z") return invalid();
    coordinate(Number(part));
    if (!remaining) {
      if (++groups > 64) return invalid();
      remaining = arity[command];
    }
    remaining--;
    complete = remaining === 0;
    previousNumber = true;
  }
  return complete ? path : invalid();
}

function shape(value: unknown): ArtifactShape {
  const kind = (value as {kind?: unknown} | null)?.kind;
  const geometry = kind === "path" ? ["d"] : kind === "circle" ? ["cx", "cy", "r"] : ["x", "y", "width", "height", "level"];
  const obj = object(value, ["kind", "fill", "stroke", ...geometry]);
  const fill = oneOf(obj.fill, PAINTS);
  const stroke = oneOf(obj.stroke, PAINTS);
  if (fill === "none" && stroke === "none") return invalid();
  if (kind === "path") return { kind, d: pathData(obj.d), fill, stroke };
  if (kind === "circle") {
    const cx = coordinate(obj.cx), cy = coordinate(obj.cy), r = coordinate(obj.r);
    if (!r || r > Math.min(cx, cy, 100 - cx, 100 - cy)) return invalid();
    return { kind, cx, cy, r, fill, stroke };
  }
  if (kind !== "rect") return invalid();
  const x = coordinate(obj.x), y = coordinate(obj.y);
  const width = coordinate(obj.width), height = coordinate(obj.height);
  if (!width || !height || x + width > 100 || y + height > 100 ||
      (obj.level !== undefined && typeof obj.level !== "boolean")) return invalid();
  return { kind, x, y, width, height, fill, stroke, ...(obj.level === undefined ? {} : { level: obj.level }) };
}

function expression(value: unknown, inputCount: number, depth = 0, budget = { remaining: 63 }): ArtifactExpression {
  if (depth > 5 || --budget.remaining < 0) return invalid();
  if (typeof value === "number") return quantity(value);
  if (value && typeof value === "object" && "input" in value) {
    return { input: index(object(value, ["input"]).input, inputCount) };
  }
  const operand = (child: unknown) => expression(child, inputCount, depth + 1, budget);
  if ((value as { op?: unknown } | null)?.op === "periodicPayment") {
    const obj = object(value, ["op", "principal", "ratePerPeriod", "periods"]);
    return {
      op: "periodicPayment",
      principal: operand(obj.principal),
      ratePerPeriod: operand(obj.ratePerPeriod),
      periods: operand(obj.periods),
    };
  }
  const obj = object(value, ["op", "left", "right"]);
  return { op: oneOf(obj.op, OPERATIONS),
    left: operand(obj.left), right: operand(obj.right) };
}

export function evaluateArtifactExpression(expr: ArtifactExpression, values: readonly number[]): number | null {
  if (typeof expr === "number") return Number.isFinite(expr) ? expr : null;
  if ("input" in expr) return Number.isFinite(values[expr.input]) ? values[expr.input] : null;
  if (expr.op === "periodicPayment") {
    const principal = evaluateArtifactExpression(expr.principal, values);
    const rate = evaluateArtifactExpression(expr.ratePerPeriod, values);
    const periods = evaluateArtifactExpression(expr.periods, values);
    if (principal === null || principal < 0 || rate === null || rate < 0 ||
        periods === null || !Number.isSafeInteger(periods) || periods < 1) return null;
    if (rate === 0) return principal / periods;
    // 1 - (1 + rate)^(-periods), retaining precision for rates close to zero.
    const discount = -Math.expm1(-periods * Math.log1p(rate));
    const payment = principal * (rate / discount);
    return Number.isFinite(payment) ? payment : null;
  }
  const left = evaluateArtifactExpression(expr.left, values);
  const right = evaluateArtifactExpression(expr.right, values);
  if (left === null || right === null) return null;
  let result: number;
  switch (expr.op) {
    case "add": result = left + right; break;
    case "subtract": result = left - right; break;
    case "multiply": result = left * right; break;
    case "divide": if (right === 0) return null; result = left / right; break;
    case "min": result = Math.min(left, right); break;
    case "max": result = Math.max(left, right); break;
  }
  return Number.isFinite(result) ? result : null;
}

function scene(value: unknown): Extract<ArtifactBlock, {kind: "scene"}> {
  const obj = object(value, ["kind", "nodes", "frames"]);
  const nodes = list(obj.nodes, 1, 8, value => {
    const node = object(value, ["label", "alt", "x", "y", "shapes"]);
    return { label: literal(node.label, 80), alt: literal(node.alt, 300),
      x: coordinate(node.x), y: coordinate(node.y), shapes: list(node.shapes, 1, 24, shape) };
  });
  const frames = list(obj.frames, 1, 12, value => {
    const frame = object(value, ["label", "caption", "values", "levels", "flows"]);
    return {
      label: literal(frame.label, 80), caption: literal(frame.caption, 1000),
      values: list(frame.values, nodes.length, nodes.length, value => literal(value, 100, true)),
      levels: list(frame.levels, nodes.length, nodes.length, value => value === null ? null : finite(value, 0, 1)),
      flows: list(frame.flows, 0, 16, value => {
        const flow = object(value, ["from", "to", "label"]);
        const from = index(flow.from, nodes.length), to = index(flow.to, nodes.length);
        if (from === to) return invalid();
        return { from, to, label: literal(flow.label, 80, true) };
      }),
    };
  });
  return { kind: "scene", nodes, frames };
}

function calculator(value: unknown): Extract<ArtifactBlock, {kind: "calculator"}> {
  const obj = object(value, ["kind", "inputs", "outputs"]);
  const inputs = list(obj.inputs, 1, 6, value => {
    const input = object(value, ["label", "unit", "min", "max", "step", "initial"]);
    const min = quantity(input.min), max = quantity(input.max), step = quantity(input.step);
    if (min >= max || step <= 0 || step > max - min || min + step === min) return invalid();
    const initial = finite(input.initial, min, max);
    const ticks = (initial - min) / step;
    if (!Number.isSafeInteger(Math.round(ticks)) || Math.abs(ticks - Math.round(ticks)) > 1e-7) return invalid();
    return { label: literal(input.label, 100), unit: literal(input.unit, 32, true), min, max, step, initial };
  });
  const outputs = list(obj.outputs, 1, 6, value => {
    const output = object(value, ["label", "unit", "expression"]);
    const result = expression(output.expression, inputs.length);
    if (evaluateArtifactExpression(result, inputs.map(input => input.initial)) === null) return invalid();
    return { label: literal(output.label, 100), unit: literal(output.unit, 32, true), expression: result };
  });
  return { kind: "calculator", inputs, outputs };
}

function block(value: unknown): ArtifactBlock {
  switch ((value as { kind?: unknown } | null)?.kind) {
    case "text": {
      const obj = object(value, ["kind", "heading", "text"]);
      return { kind: "text", text: literal(obj.text, 2000),
        ...(obj.heading === undefined ? {} : {heading: literal(obj.heading, 160)}) };
    }
    case "steps": {
      const obj = object(value, ["kind", "items"]);
      return { kind: "steps", items: list(obj.items, 1, 24, value => {
        const item = object(value, ["label", "heading", "text"]);
        return { label: literal(item.label, 80), heading: literal(item.heading, 180), text: literal(item.text, 1200) };
      }) };
    }
    case "table": {
      const obj = object(value, ["kind", "columns", "rows"]);
      const columns = list(obj.columns, 2, 6, (value, column) =>
        literal(value, 100, column === 0 && value === ""));
      const rows = list(obj.rows, 1, 24, row =>
        list(row, columns.length, columns.length, (value, column) =>
          literal(value, 400, column !== 0 || columns[0] !== "")));
      return { kind: "table", columns, rows };
    }
    case "quiz": {
      const obj = object(value, ["kind", "items"]);
      return { kind: "quiz", items: list(obj.items, 1, 20, value => {
        const item = object(value, ["question", "choices", "answer", "explanation"]);
        const choices = list(item.choices, 2, 6, value => literal(value, 350));
        if (new Set(choices.map(choice => choice.trim())).size !== choices.length) return invalid();
        return { question: literal(item.question, 500), choices, answer: index(item.answer, choices.length),
          explanation: literal(item.explanation, 800) };
      }) };
    }
    case "cards": {
      const obj = object(value, ["kind", "items"]);
      return { kind: "cards", items: list(obj.items, 1, 32, value => {
        const card = object(value, ["front", "back"]);
        return { front: literal(card.front, 500), back: literal(card.back, 1200) };
      }) };
    }
    case "scene": return scene(value);
    case "calculator": return calculator(value);
    default: return invalid();
  }
}

export function parseVisualArtifact(value: unknown): VisualArtifact {
  const obj = object(value, ["version", "format", "title", "summary", "blocks"]);
  if (obj.version !== 1) return invalid();
  const format = oneOf(obj.format, ARTIFACT_FORMATS);
  const blocks = list(obj.blocks, 1, 12, block);
  const requiredKind = { timeline: "steps", explainer: undefined, quiz: "quiz",
    comparison: "table", flashcards: "cards", calculator: "calculator" }[format];
  if (requiredKind && !blocks.some(block => block.kind === requiredKind)) return invalid();
  const artifact: VisualArtifact = { version: 1, format, title: literal(obj.title, 160),
    ...(obj.summary === undefined ? {} : { summary: literal(obj.summary, 600) }), blocks };
  if (new TextEncoder().encode(JSON.stringify(artifact)).length > MAX_ARTIFACT_BYTES) return invalid();
  return artifact;
}

/** The provider receives only this projection, even if a caller supplies Chat context. */
export function parseArtifactGenerationInput(value: unknown) {
  const obj = object(value, ["source", "guidance", "format"]);
  return { source: literal(obj.source, MAX_ARTIFACT_SOURCE), guidance: literal(obj.guidance, MAX_ARTIFACT_GUIDANCE, true),
    format: obj.format === "auto" ? "auto" as const : oneOf(obj.format, ARTIFACT_FORMATS) };
}
