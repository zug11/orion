import { object, list, literal as text, finite as num } from "./artifactValidation";
import { DRAWING_TONES, readDrawingPath, type DrawingTone } from "./artifactIllustration";

export type MotionFrame = {
  at: number;
  x?: number;
  y?: number;
  angle?: number;
  scaleX?: number;
  scaleY?: number;
  opacity?: number;
};
export interface MotionMark {
  d: string;
  tone: DrawingTone;
  filled?: boolean;
  strokeWidth?: number;
  fillOpacity?: number;
  pivot?: [number, number];
  motion?: MotionFrame[];
}
export interface MotionDrawing { label: string; marks: MotionMark[] }
export interface MotionPhase { at: number; label: string; caption: string; quote: string }
type MotionContent = {
  label: string;
  unit: string;
  period: number;
  passage: string;
  phases: MotionPhase[];
  views: MotionDrawing[];
};
export type ArtifactMotion = ({ kind: "cycle" } | { kind: "linkedViews" }) & MotionContent;

function invalid(reason: string): never {
  throw new Error(`Orion could not read this moving diagram. ${reason}`);
}
function checkOrder(items: { at: number }[]) {
  if (items[0].at !== 0 || items.some((item, i) => i > 0 && item.at <= items[i - 1].at))
    invalid("Positions must start at zero and increase in order.");
}

const FRAME_LIMITS = { x: [-240, 240], y: [-160, 160], angle: [-1440, 1440], scaleX: [0, 4], scaleY: [0, 4], opacity: [0, 1] } as const;
type Attribute = keyof typeof FRAME_LIMITS;
const attributes = Object.keys(FRAME_LIMITS) as Attribute[];

function mark(raw: unknown, period: number, wraps: boolean): MotionMark {
  const obj = object(raw, ["d", "tone", "filled", "strokeWidth", "fillOpacity", "pivot", "motion"]);
  const d = text(obj.d, 1800);
  readDrawingPath(d, [240, 160]);
  const tone = obj.tone as DrawingTone;
  if (!DRAWING_TONES.includes(tone)) return invalid("Unknown drawing tone.");
  const result: MotionMark = { d, tone };
  if (obj.filled !== undefined) {
    if (typeof obj.filled !== "boolean") return invalid("Invalid fill.");
    result.filled = obj.filled;
  }
  if (obj.strokeWidth !== undefined) result.strokeWidth = num(obj.strokeWidth, 0.25, 4);
  if (obj.fillOpacity !== undefined) result.fillOpacity = num(obj.fillOpacity, 0, 1);
  if (obj.pivot !== undefined) {
    if (!Array.isArray(obj.pivot) || obj.pivot.length !== 2) return invalid("Invalid pivot.");
    result.pivot = [num(obj.pivot[0], 0, 240), num(obj.pivot[1], 0, 160)];
  }
  if (obj.motion !== undefined) {
    const frames = list(obj.motion, 2, 24, rawFrame => {
      const frame = object(rawFrame, ["at", ...attributes]);
      const value: MotionFrame = { at: num(frame.at, 0, period) };
      for (const key of attributes) if (frame[key] !== undefined)
        value[key] = num(frame[key], FRAME_LIMITS[key][0], FRAME_LIMITS[key][1]);
      return value;
    });
    checkOrder(frames);
    if (frames[frames.length - 1].at !== period) return invalid("Movement must cover the full control range.");
    if (wraps) {
      const first = frames[0], last = frames[frames.length - 1];
      for (const key of attributes) {
        const difference = frameValue(last, key) - frameValue(first, key);
        if (key === "angle" ? Math.abs(difference / 360 - Math.round(difference / 360)) > 1e-9 : difference !== 0)
          return invalid("The drawing must return to its starting pose at the end of a cycle.");
      }
    }
    result.motion = frames;
  }
  return result;
}

export function parseArtifactMotion(raw: unknown): ArtifactMotion {
  const obj = object(raw, ["kind", "label", "unit", "period", "passage", "phases", "views"]);
  const kind = obj.kind;
  if (kind !== "cycle" && kind !== "linkedViews") return invalid("Unknown moving diagram.");
  const period = num(obj.period, 0, 1e9);
  if (period <= 0) return invalid("The control range must be positive.");
  const passage = text(obj.passage, 12000);
  const phases = list(obj.phases, 2, 12, item => {
    const p = object(item, ["at", "label", "caption", "quote"]);
    const at = num(p.at, 0, period);
    if (kind === "cycle" && at === period) return invalid("The end of the cycle returns to its beginning.");
    const quote = text(p.quote, 400);
    if (!passage.includes(quote)) return invalid("A phase quote could not be found in its passage.");
    return { at, label: text(p.label, 80), caption: text(p.caption, 600), quote };
  });
  checkOrder(phases);
  const count = kind === "cycle" ? 1 : 2;
  const views = list(obj.views, count, count, item => {
    const view = object(item, ["label", "marks"]);
    const marks = list(view.marks, 1, 32, m => mark(m, period, kind === "cycle"));
    if (!marks.some(m => m.motion?.some((frame, i, frames) =>
      i > 0 && attributes.some(key => frameValue(frame, key) !== frameValue(frames[i - 1], key)))))
      return invalid("Each view must respond to the control.");
    return { label: text(view.label, 80), marks };
  });
  return { kind, label: text(obj.label, 80), unit: text(obj.unit, 24, true), period, passage, phases, views };
}

const defaults: Record<Attribute, number> = { x: 0, y: 0, angle: 0, scaleX: 1, scaleY: 1, opacity: 1 };
function frameValue(frame: MotionFrame, key: Attribute) {
  return frame[key] ?? defaults[key];
}

// Transform attributes are literal keyframes. Each missing field takes its
// neutral value at that frame; angles may span a full turn across two frames.
export function sampleMotion(frames: MotionFrame[], position: number): Record<Attribute, number> {
  const upper = frames.findIndex(frame => frame.at >= position);
  const end = frames[upper < 0 ? frames.length - 1 : upper];
  const start = upper <= 0 ? end : frames[upper - 1];
  const t = end.at === start.at ? 0 : (position - start.at) / (end.at - start.at);
  const result = { ...defaults };
  for (const key of attributes) {
    const low = frameValue(start, key);
    result[key] = low + t * (frameValue(end, key) - low);
  }
  return result;
}

export function phaseAt(phases: MotionPhase[], position: number) {
  const next = phases.findIndex(phase => phase.at > position);
  return phases[next < 0 ? phases.length - 1 : Math.max(0, next - 1)];
}
