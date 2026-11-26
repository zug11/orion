import type { DrawingPart, DrawingPoint } from "./artifactIllustration";
import { finite, list, literal, object } from "./artifactValidation";

export type HandleTrack = { from: DrawingPoint; to: DrawingPoint } | { from: DrawingPoint; pivot: DrawingPoint; turn: number };
type Effect = { parts: string[] } & (
  { move: DrawingPoint } | { pivot: DrawingPoint; turn: number } | { opacity: DrawingPoint } | { level: DrawingPoint }
);
export interface DrawingHandle {
  label: string;
  ends: [string, string];
  quote: string;
  track: HandleTrack;
  initial?: number;
  effects: Effect[];
}
export interface DrawingAnimation {
  label: string;
  quote: string;
  duration: number;
  loop?: boolean;
  tracks: ({ keys: DrawingPoint[] } & ({ effects: Effect[] } | { handle: number }))[];
}

type Size = readonly [number, number];
const radians = (degrees: number) => degrees * Math.PI / 180;
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function fail(message: string): never {
  throw new Error("Orion could not read a drawing handle. " + message);
}
function pair(raw: unknown, low: Size, high: Size): DrawingPoint {
  if (!Array.isArray(raw) || raw.length !== 2) return fail("Use a pair of coordinates.");
  return [finite(raw[0], low[0], high[0]), finite(raw[1], low[1], high[1])];
}
function rotate([x, y]: DrawingPoint, [px, py]: DrawingPoint, degrees: number): DrawingPoint {
  const c = Math.cos(radians(degrees)), s = Math.sin(radians(degrees));
  return [px + (x - px) * c - (y - py) * s, py + (x - px) * s + (y - py) * c];
}

export function handlePoint(track: HandleTrack, t: number): DrawingPoint {
  if ("pivot" in track) return rotate(track.from, track.pivot, track.turn * t);
  return [track.from[0] + t * (track.to[0] - track.from[0]), track.from[1] + t * (track.to[1] - track.from[1])];
}

/** Exact extrema of a point sweeping through an arc, including partial and negative turns. */
export function sweptPoints(from: DrawingPoint, pivot: DrawingPoint, turn: number): DrawingPoint[] {
  const start = Math.atan2(from[1] - pivot[1], from[0] - pivot[0]) * 180 / Math.PI;
  const end = start + turn;
  const points = [from, rotate(from, pivot, turn)];
  for (let cardinal = Math.ceil(Math.min(start, end) / 90) * 90; cardinal < Math.max(start, end); cardinal += 90)
    points.push(rotate(from, pivot, cardinal - start));
  return points;
}

export function handleTrackPoints(track: HandleTrack) {
  return "pivot" in track ? sweptPoints(track.from, track.pivot, track.turn) : [track.from, track.to];
}

export function handlePosition(track: HandleTrack, [x, y]: DrawingPoint, current: number): number {
  if ("to" in track) {
    const dx = track.to[0] - track.from[0], dy = track.to[1] - track.from[1];
    return clamp(((x - track.from[0]) * dx + (y - track.from[1]) * dy) / (dx * dx + dy * dy));
  }
  const [px, py] = track.pivot;
  if (Math.hypot(x - px, y - py) < 1) return current;
  const angle = Math.atan2(y - py, x - px) - Math.atan2(track.from[1] - py, track.from[0] - px);
  const along = ((angle * Math.sign(track.turn) * 180 / Math.PI) % 360 + 360) % 360;
  const span = Math.abs(track.turn);
  return along <= span ? along / span : along - span < 360 - along ? 1 : 0;
}

function readTrack(raw: unknown, size: Size): HandleTrack {
  const o = object(raw, ["from", "to", "pivot", "turn"]);
  const from = pair(o.from, [0, 0], size);
  if ("to" in o) {
    object(o, ["from", "to"]);
    const to = pair(o.to, [0, 0], size);
    if (Math.hypot(from[0] - to[0], from[1] - to[1]) < 4) return fail("Give the handle a distinct start and end.");
    return { from, to };
  }
  const pivot = pair(o.pivot, [0, 0], size), turn = finite(o.turn, -330, 330);
  if (Math.hypot(from[0] - pivot[0], from[1] - pivot[1]) < 4 || Math.abs(turn) < 5) return fail("Give a turning handle a visible arc.");
  const track = { from, pivot, turn };
  if (handleTrackPoints(track).some(([x, y]) => x < -1e-8 || y < -1e-8 || x > size[0] + 1e-8 || y > size[1] + 1e-8))
    return fail("Keep the full handle track inside the drawing.");
  return track;
}

export function parseDrawingDynamics(handles: unknown, animation: unknown, parts: DrawingPart[], size: Size, passage: string, levelParts: Set<string>) {
  const ids = new Set(parts.map(part => part.id));
  const rotations = new Set<string>();
  function readEffects(raw: unknown) {
    const owners = new Set<string>();
    return list(raw, 1, 12, (rawEffect): Effect => {
      const e = object(rawEffect, ["parts", "move", "turn", "pivot", "level", "opacity"]);
      const targets = list(e.parts, 1, 28, v => literal(v, 40));
      if (targets.some(id => !ids.has(id)) || new Set(targets).size !== targets.length) return fail("Effects must name distinct existing parts.");
      if ("move" in e) {
        object(e, ["parts", "move"]);
        const move = pair(e.move, [-size[0], -size[1]], size);
        if (move[0] === 0 && move[1] === 0) return fail("Give the movement a nonzero distance.");
        for (const id of targets) {
          if (owners.has("move:" + id)) return fail("Combine movement of the same part on this control or track into one offset.");
          owners.add("move:" + id);
        }
        return { parts: targets, move };
      }
      const key = "turn" in e ? "turn" : "level" in e ? "level" : "opacity";
      for (const id of targets) {
        if (owners.has(key + ":" + id) || (key === "turn" && rotations.has(id)))
          return fail("Use one rotation per part and one level or opacity per part on each control or track.");
        if (key === "turn") rotations.add(id);
        owners.add(key + ":" + id);
      }
      if (key === "turn") {
        object(e, ["parts", "pivot", "turn"]);
        const turn = finite(e.turn, -720, 720);
        if (!turn) return fail("Give the rotation a nonzero angle.");
        return { parts: targets, pivot: pair(e.pivot, [0, 0], size), turn };
      }
      object(e, ["parts", key]);
      const range = pair(e[key], [0, 0], [1, 1]);
      if (range[0] === range[1]) return fail("Give the effect two different values.");
      if (key === "level" && targets.some(id => !levelParts.has(id))) return fail("A fill level needs a level-painted rectangle or responsive glyph.");
      return key === "level" ? { parts: targets, level: range } : { parts: targets, opacity: range };
    });
  }
  const result: {handles?: DrawingHandle[]; animation?: DrawingAnimation} = {};
  const labels = new Set<string>();
  if (handles !== undefined) result.handles = list(handles, 1, 4, (entry): DrawingHandle => {
    const o = object(entry, ["label", "ends", "quote", "track", "initial", "effects"]);
    const label = literal(o.label, 80), quote = literal(o.quote, 400);
    if (labels.has(label.trim()) || !passage.includes(quote)) return fail("Give each control a distinct label and an exact source quote.");
    labels.add(label.trim());
    const ends = list(o.ends, 2, 2, v => literal(v, 64)) as [string, string];
    if (ends[0].trim() === ends[1].trim()) return fail("Name two different endpoints.");
    return { label, ends, quote, track: readTrack(o.track, size), effects: readEffects(o.effects),
      ...(o.initial !== undefined && { initial: finite(o.initial, 0, 1) }) };
  });
  if (animation !== undefined) {
    const o = object(animation, ["label","quote","duration","loop","tracks"]);
    const duration = finite(o.duration, 0.5, 60), quote = literal(o.quote, 400);
    if (!passage.includes(quote)) return fail("Quote the passage that the animation illustrates.");
    if (o.loop !== undefined && typeof o.loop !== "boolean") return fail("Use a boolean for loop.");
    const driven = new Set<number>();
    const tracks: DrawingAnimation["tracks"] = list(o.tracks, 1, 8, raw => {
      const track = object(raw, ["keys", "effects", "handle"]);
      const keys = list(track.keys, 2, 32, v => pair(v, [0, 0], [duration, 1]));
      if (keys[0][0] !== 0 || keys[keys.length - 1][0] !== duration ||
        keys.some(([t], i) => i > 0 && t <= keys[i - 1][0]) || keys.every(([, v]) => v === keys[0][1]))
        return fail("Cover the animation from zero to duration with increasing keyframe times and a changing value.");
      const difference = keys[keys.length - 1][1] - keys[0][1];
      if ("handle" in track) {
        object(track, ["keys","handle"]);
        const index = finite(track.handle, 0, (result.handles?.length ?? 0) - 1);
        const handle = result.handles?.[index];
        if (!handle || driven.has(index) || keys[0][1] !== (handle.initial ?? 0) || (o.loop && difference !== 0) ||
          !keys.some(([,v]) => v === 0) || !keys.some(([,v]) => v === 1))
          return fail("A track driving a handle must start at its initial position, cover its full travel and close its loop.");
        driven.add(index);
        return {keys, handle: index};
      }
      const effects = readEffects(track.effects);
      if (o.loop && difference !== 0 && !effects.every(effect => "turn" in effect &&
        Math.abs(effect.turn * difference / 360 - Math.round(effect.turn * difference / 360)) < 1e-9))
        return fail("Bring each looping track back to its starting value.");
      return { keys, effects };
    });
    result.animation = {label: literal(o.label, 80), quote, duration, tracks, ...(o.loop !== undefined && {loop: o.loop})};
  }
  return result;
}

export type DrawingPose = { dx: number; dy: number; pivot?: DrawingPoint; angle: number; level?: number; opacity?: number };
export function animationValue(keys: DrawingPoint[], time: number) {
  if (time <= keys[0][0]) return keys[0][1];
  const next = keys.findIndex(([t]) => t >= time);
  if (next < 0) return keys[keys.length - 1][1];
  const [t, v] = keys[next - 1], [end, value] = keys[next];
  return v + (value - v) * ((time - t) / (end - t));
}
/** Several times may show the same pose. Dragging stays on the closest
 * traverse; a drag onto a held position can remain within its hold. */
export function animationTimeForValue(keys: DrawingPoint[], value: number, current: number) {
  let best = current, distance = Infinity;
  for (let i = 1; i < keys.length; i++) {
    const [a, from] = keys[i - 1], [b, to] = keys[i];
    if (value < Math.min(from, to) || value > Math.max(from, to)) continue;
    const t = from === to ? Math.max(a, Math.min(b, current)) : a + (value - from) / (to - from) * (b - a);
    if (Math.abs(t - current) < distance) { best = t; distance = Math.abs(t - current); }
  }
  return best;
}
export function currentHandlePositions(handles: DrawingHandle[], positions: readonly number[], animation?: DrawingAnimation, time = 0) {
  const values = handles.map((h,i) => positions[i] ?? h.initial ?? 0);
  for (const track of animation?.tracks ?? []) if ("handle" in track) values[track.handle] = animationValue(track.keys,time);
  return values;
}
export function drawingPoses(handles: DrawingHandle[], positions: readonly number[], animation?: DrawingAnimation, time = 0) {
  const poses = new Map<string, DrawingPose>();
  const apply = (effects: Effect[], t: number) => {
    for (const effect of effects) for (const id of effect.parts) {
      const pose: DrawingPose = poses.get(id) ?? { dx: 0, dy: 0, angle: 0 };
      if ("move" in effect) { pose.dx += effect.move[0] * t; pose.dy += effect.move[1] * t; }
      else if ("turn" in effect) { pose.pivot = effect.pivot; pose.angle = effect.turn * t; }
      else if ("level" in effect) pose.level = (pose.level ?? 1) * (effect.level[0] + (effect.level[1] - effect.level[0]) * t);
      else pose.opacity = (pose.opacity ?? 1) * (effect.opacity[0] + (effect.opacity[1] - effect.opacity[0]) * t);
      poses.set(id, pose);
    }
  };
  const values = currentHandlePositions(handles, positions, animation, time);
  handles.forEach((handle, i) => apply(handle.effects, clamp(values[i])));
  for (const track of animation?.tracks ?? []) if ("effects" in track) apply(track.effects, animationValue(track.keys, time));
  return poses;
}
export function posePoint(point: DrawingPoint, pose: DrawingPose): DrawingPoint {
  const [x, y] = pose.pivot ? rotate(point, pose.pivot, pose.angle) : point;
  return [x + pose.dx, y + pose.dy];
}
export function poseTransform(pose: DrawingPose | undefined) {
  if (!pose || (!pose.dx && !pose.dy && !pose.angle)) return undefined;
  const c = Math.cos(radians(pose.angle)), s = Math.sin(radians(pose.angle));
  const [x, y] = posePoint([0, 0], pose);
  return "matrix(" + [c, s, -s, c, x, y].map(v => Number(v.toFixed(6))).join(" ") + ")";
}

export function handleValueText(handle: DrawingHandle, t: number) {
  return t <= 0 ? handle.ends[0] : t >= 1 ? handle.ends[1] : Math.round(t * 100) + "% of travel";
}
