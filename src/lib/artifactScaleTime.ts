import { readDrawingPath } from "./artifactIllustration";
import { finite, invalid, list, literal, object, oneOf } from "./artifactValidation";

const lengthUnits = ["pm", "nm", "µm", "mm", "cm", "m", "km", "AU", "ly"] as const;
type LengthUnit = typeof lengthUnits[number];
const metresPerUnit: Record<LengthUnit, number> = {
  pm: 1e-12, nm: 1e-9, "µm": 1e-6, mm: 0.001, cm: 0.01, m: 1, km: 1000,
  AU: 149597870700, ly: 9460730472580800,
};
const timeUnits = ["seconds", "minutes", "hours", "days", "years"] as const;
type TimeUnit = typeof timeUnits[number];
interface NamedMeasurement { label: string; detail?: string }
export interface ScaleItem extends NamedMeasurement { size: number; unit: LengthUnit; path?: string }
export interface ArtifactScaleZoom { kind: "scaleZoom"; items: ScaleItem[] }
export type DayEvent = NamedMeasurement & ({ beforeEnd: number } | { daySecond: number });
export interface ArtifactDeepTime { kind: "deepTime"; duration: number; unit: TimeUnit; events: DayEvent[] }
export const DAY_SECONDS = 86400;

function named(obj: Record<string, unknown>): NamedMeasurement {
  return { label: literal(obj.label, 80), ...(obj.detail === undefined ? {} : {detail: literal(obj.detail, 500)}) };
}

export function parseArtifactScaleZoom(value: unknown): ArtifactScaleZoom {
  const block = object(value, ["kind", "items"]);
  if (block.kind !== "scaleZoom") return invalid();
  const items = list(block.items, 2, 12, item => {
    const row = object(item, ["label", "size", "unit", "detail", "path"]);
    const size = finite(row.size, 1e-60, 1e60);
    const unit = oneOf(row.unit, lengthUnits);
    const path = row.path === undefined ? undefined : literal(row.path, 1200);
    if (path) readDrawingPath(path, [100, 100]);
    return { ...named(row), size, unit, ...(path ? {path} : {}) };
  });
  return { kind: "scaleZoom", items };
}

export function parseArtifactDeepTime(value: unknown): ArtifactDeepTime {
  const block = object(value, ["kind", "duration", "unit", "events"]);
  if (block.kind !== "deepTime") return invalid();
  const duration = finite(block.duration, 1e-60, 1e60);
  const unit = oneOf(block.unit, timeUnits);
  const events = list(block.events, 1, 16, item => {
    const row = object(item, ["label", "daySecond", "beforeEnd", "detail"]);
    if ((row.daySecond === undefined) === (row.beforeEnd === undefined)) return invalid();
    return row.daySecond === undefined
      ? { ...named(row), beforeEnd: finite(row.beforeEnd, 0, duration) }
      : { ...named(row), daySecond: finite(row.daySecond, 0, DAY_SECONDS) };
  });
  return { kind: "deepTime", duration, unit, events };
}

export function daySecondOf(event: DayEvent, duration: number): number {
  if ("daySecond" in event) return event.daySecond;
  if (event.beforeEnd === 0) return DAY_SECONDS;
  return Math.min(DAY_SECONDS - DAY_SECONDS * Number.EPSILON, ((duration - event.beforeEnd) / duration) * DAY_SECONDS);
}

export function timeRemaining(seconds: number, duration: number): number {
  return ((DAY_SECONDS - seconds) / DAY_SECONDS) * duration;
}

export function dayClockTime(seconds: number): string {
  // Reserve 24:00 for the endpoint, including when the last event is less than a second before it.
  const whole = seconds === DAY_SECONDS ? DAY_SECONDS : Math.min(DAY_SECONDS - 1, Math.round(seconds));
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map(part => String(part).padStart(2, "0")).join(":");
}

const compact = new Intl.NumberFormat(undefined, {maximumSignificantDigits: 4});
const scientific = new Intl.NumberFormat(undefined, {notation: "scientific", maximumSignificantDigits: 4});
export function dimension(value: number, unit?: string) {
  const magnitude = Math.abs(value);
  const text = (magnitude !== 0 && (magnitude < 0.001 || magnitude >= 1e15) ? scientific : compact).format(value);
  return unit ? `${text} ${unit}` : text;
}

export function durationText(value: number, unit: TimeUnit) {
  const label = value === 1 ? unit.slice(0, -1) : unit;
  if (value >= 1e9 && value < 1e15) return `${dimension(value / 1e9)} billion ${unit}`;
  if (value >= 1e6 && value < 1e9) return `${dimension(value / 1e6)} million ${unit}`;
  return dimension(value, label);
}

export function adaptiveLength(metres: number) {
  const unit = [...lengthUnits].reverse().find(unit => metres >= metresPerUnit[unit]) ?? "pm";
  return dimension(metres / metresPerUnit[unit], unit);
}

export interface ScaleStop {
  item: ScaleItem;
  metres: number;
  centre: number;
  field: number;
  zoom: number;
}

export function scaleStops(items: readonly ScaleItem[]): ScaleStop[] {
  const stops = items.map(item => ({item, metres: item.size * metresPerUnit[item.unit], centre: 0, field: 0, zoom: 0}))
    .sort((a, b) => b.metres - a.metres);
  let occupied = 0;
  // Anchor the smallest object at the origin. Accumulating outwards retains its coordinates
  // even when the largest subject is many orders of magnitude wider than the smallest.
  for (let i = stops.length - 1; i >= 0; i--) {
    const stop = stops[i];
    stop.centre = -(occupied + stop.metres / 2);
    occupied += stop.metres * 1.32;
    stop.field = stop.metres * (3.6 - 1.4 * i / (stops.length - 1));
  }
  const full = stops[0].field;
  const depth = Math.log(full / stops[stops.length - 1].field);
  for (const stop of stops) stop.zoom = Math.log(full / stop.field) / depth;
  return stops;
}

export function scaleCamera(stops: ScaleStop[], progress: number) {
  const start = stops[0], end = stops[stops.length - 1];
  const field = start.field * (end.field / start.field) ** progress;
  const i = stops.findIndex(stop => stop.zoom >= progress);
  const near = i < 0 ? end : stops[i], far = i > 0 ? stops[i - 1] : near;
  // Interpolate the camera in physical space as the field changes logarithmically.
  // Multiplication by the field ratio avoids losing the smaller object's position.
  const t = far === near ? 0 : (field - near.field) / (far.field - near.field);
  const centre = near.centre + Math.min(1, Math.max(0, t)) * (far.centre - near.centre);
  const nearest = Math.abs(far.zoom - progress) < Math.abs(near.zoom - progress) ? far : near;
  const targetBar = field / 4;
  const pow = 10 ** Math.floor(Math.log10(targetBar));
  const bar = [1, 2, 5, 10].map(n => n * pow)
    .reduce((best, n) => Math.abs(Math.log(n / targetBar)) < Math.abs(Math.log(best / targetBar)) ? n : best);
  return {field, centre, nearest, bar};
}
