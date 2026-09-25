import type { WindowGlassSettings } from "../types";

export const defaultWindowGlass: WindowGlassSettings = {
  enabled: true,
  tintOpacity: 30,
  blur: 50,
};

export interface WindowGlassStatus {
  material: "solid" | "frosted" | "liquid";
  liquidAvailable: boolean;
  interactiveAvailable: boolean;
  error?: boolean;
}

export function isWindowGlassSettings(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const glass = value as Record<string, unknown>;
  return (
    (glass.material === undefined || (typeof glass.material === "string" && ["solid", "frosted", "liquid"].includes(glass.material))) &&
    (glass.style === undefined || (typeof glass.style === "string" && ["regular", "clear"].includes(glass.style))) &&
    ["enabled", "sidebar", "topbar", "interactive"].every((key) => glass[key] === undefined || typeof glass[key] === "boolean") &&
    ["tintOpacity", "sidebarOpacity", "topbarOpacity", "blur"].every((key) => glass[key] === undefined || inRange(glass[key], 0, 100)) &&
    (glass.cornerRadius === undefined || inRange(glass.cornerRadius, 0, 24))
  );
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

export function normalizeWindowGlass(value: unknown): WindowGlassSettings {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const bounded = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(Math.min(100, Math.max(0, value))) : fallback;
  // Existing vaults may have two different tints. Keep the average of the
  // enabled areas (or both saved tints when off) as the single shared choice.
  const bothOff = source.sidebar === false && source.topbar === false;
  const legacyTints = [
    source.sidebar !== false || bothOff ? source.sidebarOpacity : undefined,
    source.topbar !== false || bothOff ? source.topbarOpacity : undefined,
  ].filter((tint): tint is number => typeof tint === "number" && Number.isFinite(tint));
  const legacyOpacity = legacyTints.length
    ? legacyTints.reduce((sum, tint) => sum + bounded(tint, defaultWindowGlass.tintOpacity), 0) / legacyTints.length
    : defaultWindowGlass.tintOpacity;

  return {
    enabled: typeof source.enabled === "boolean" ? source.enabled : source.material !== "solid" && !bothOff,
    tintOpacity: bounded(source.tintOpacity, Math.round(legacyOpacity)),
    blur: bounded(source.blur, defaultWindowGlass.blur),
  };
}

/** Fully covered or disabled glass is removed without discarding its tuning. */
export function requestedWindowMaterial(glass: WindowGlassSettings): WindowGlassStatus["material"] {
  return glass.enabled && glass.tintOpacity < 100 ? "liquid" : "solid";
}
