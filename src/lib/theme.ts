import type {
  ThemeAccent,
  ThemeCanvasTone,
  ThemeContrast,
  ThemeMode,
  ThemePreset,
  ThemeSurfaceLift,
  ThemeTextWarmth,
} from "../types";

export type ResolvedThemeMode = Exclude<ThemeMode, "system">;

export interface ThemePreferences {
  themePreset: ThemePreset;
  themeAccent: ThemeAccent;
  themeAccentCustom: string;
  themeCanvasTone: ThemeCanvasTone;
  themeCanvasCustom: string;
  themeSurfaceLift: ThemeSurfaceLift;
  themeSurfaceCustom: string;
  themeTextWarmth: ThemeTextWarmth;
  themeContrast: ThemeContrast;
}

interface ThemeSeed {
  canvas: string;
  surface: string;
  accent: string;
}

export interface ThemePalette {
  mode: ResolvedThemeMode;
  canvas: string;
  canvasDeep: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surfaceRaised: string;
  text: string;
  textSoft: string;
  muted: string;
  faint: string;
  accent: string;
  accentStrong: string;
  accentInk: string;
  mint: string;
  gold: string;
  rose: string;
  danger: string;
  line: string;
  lineStrong: string;
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
}

export const themePresetOptions: ReadonlyArray<{
  id: ThemePreset;
  name: string;
  description: string;
  dark: ThemeSeed;
  light: ThemeSeed;
}> = [
  {
    id: "orion",
    name: "Orion",
    description: "Midnight blue, quiet paper, and a clear periwinkle signal.",
    dark: { canvas: "#090d15", surface: "#0e1420", accent: "#9baaff" },
    light: { canvas: "#f3f1eb", surface: "#fbfaf6", accent: "#586ccb" },
  },
  {
    id: "tide",
    name: "Tide",
    description: "Cool marine depth with a precise blue-green accent.",
    dark: { canvas: "#071116", surface: "#0c1a21", accent: "#72cbe0" },
    light: { canvas: "#edf4f4", surface: "#f8fbfa", accent: "#16758b" },
  },
  {
    id: "grove",
    name: "Grove",
    description: "Soft forest neutrals with a measured botanical green.",
    dark: { canvas: "#0a100d", surface: "#111a15", accent: "#80c79b" },
    light: { canvas: "#f0f2eb", surface: "#fafbf5", accent: "#377a52" },
  },
  {
    id: "ember",
    name: "Ember",
    description: "Warm graphite and parchment with a restrained clay glow.",
    dark: { canvas: "#120d0c", surface: "#1a1412", accent: "#e0a477" },
    light: { canvas: "#f4efe8", surface: "#fdf9f3", accent: "#a45d31" },
  },
];

export const themeAccentOptions: ReadonlyArray<{
  id: ThemeAccent;
  name: string;
  dark: string | null;
  light: string | null;
}> = [
  { id: "preset", name: "Preset", dark: null, light: null },
  { id: "iris", name: "Iris", dark: "#aab2ff", light: "#5368ca" },
  { id: "tide", name: "Tide", dark: "#72cbe0", light: "#16758b" },
  { id: "moss", name: "Moss", dark: "#80c79b", light: "#377a52" },
  { id: "ember", name: "Ember", dark: "#e0a477", light: "#a45d31" },
];

export const themeCanvasOptions = [
  { id: "deep", name: "Deep" },
  { id: "balanced", name: "Balanced" },
  { id: "airy", name: "Airy" },
] as const satisfies ReadonlyArray<{ id: ThemeCanvasTone; name: string }>;

export const themeSurfaceOptions = [
  { id: "quiet", name: "Quiet" },
  { id: "balanced", name: "Balanced" },
  { id: "lifted", name: "Lifted" },
] as const satisfies ReadonlyArray<{ id: ThemeSurfaceLift; name: string }>;

export const themeWarmthOptions = [
  { id: "cool", name: "Cool" },
  { id: "neutral", name: "Neutral" },
  { id: "warm", name: "Warm" },
] as const satisfies ReadonlyArray<{ id: ThemeTextWarmth; name: string }>;

export const themeContrastOptions = [
  { id: "soft", name: "Soft" },
  { id: "balanced", name: "Balanced" },
  { id: "high", name: "Crisp" },
] as const satisfies ReadonlyArray<{ id: ThemeContrast; name: string }>;

const PRESET_BY_ID = new Map(
  themePresetOptions.map((preset) => [preset.id, preset]),
);
const ACCENT_BY_ID = new Map(
  themeAccentOptions.map((accent) => [accent.id, accent]),
);

export function resolveThemeMode(
  mode: ThemeMode,
  prefersLight: boolean,
): ResolvedThemeMode {
  return mode === "system" ? (prefersLight ? "light" : "dark") : mode;
}

export function resolveThemePalette(
  preferences: ThemePreferences,
  mode: ResolvedThemeMode,
): ThemePalette {
  const preset =
    PRESET_BY_ID.get(preferences.themePreset) ?? themePresetOptions[0];
  const seed = preset[mode];
  const customCanvas = validThemeColor(preferences.themeCanvasCustom);
  const canvas = customCanvas
    ? clampBackgroundForMode(customCanvas, mode)
    : preferences.themeCanvasTone === "deep"
      ? mixColor(seed.canvas, "#000000", mode === "dark" ? 0.16 : 0.055)
      : preferences.themeCanvasTone === "airy"
        ? mixColor(seed.canvas, "#ffffff", mode === "dark" ? 0.045 : 0.28)
        : seed.canvas;
  const surfaceStrength =
    preferences.themeSurfaceLift === "quiet"
      ? 0.64
      : preferences.themeSurfaceLift === "lifted"
        ? 1
        : 0.84;
  const customSurface = validThemeColor(preferences.themeSurfaceCustom);
  const surface1 = customSurface
    ? ensureContrast(clampBackgroundForMode(customSurface, mode), canvas, 1.08)
    : mixColor(canvas, seed.surface, surfaceStrength);
  const liftTarget = mode === "dark" ? "#ffffff" : "#000000";
  const surface0 = mixColor(canvas, surface1, 0.52);
  const surface2 = mixColor(
    surface1,
    liftTarget,
    mode === "dark" ? 0.034 : 0.025,
  );
  const surface3 = mixColor(
    surface1,
    liftTarget,
    mode === "dark" ? 0.072 : 0.06,
  );
  const surfaceRaised = mixColor(
    surface1,
    "#ffffff",
    mode === "dark" ? 0.055 : 0.48,
  );
  const canvasDeep = mixColor(
    canvas,
    "#000000",
    mode === "dark" ? 0.3 : 0.045,
  );

  const warmthTarget =
    preferences.themeTextWarmth === "warm"
      ? mode === "dark"
        ? "#fff0dc"
        : "#392b24"
      : preferences.themeTextWarmth === "cool"
        ? mode === "dark"
          ? "#dceaff"
          : "#18293a"
        : mode === "dark"
          ? "#e9edf5"
          : "#1b2431";
  const contrastTarget =
    preferences.themeContrast === "soft"
      ? 7
      : preferences.themeContrast === "high"
        ? 14
        : 10;
  const text = ensureContrast(warmthTarget, surface1, contrastTarget);
  const softMix = preferences.themeContrast === "soft" ? 0.7 : 0.78;
  const mutedMix = preferences.themeContrast === "high" ? 0.62 : 0.55;
  const textSoft = ensureContrast(mixColor(canvas, text, softMix), surface1, 4.5);
  const muted = ensureContrast(mixColor(canvas, text, mutedMix), surface1, 4.5);
  const faint = ensureContrast(mixColor(canvas, text, 0.44), surface1, 4.5);

  const selectedAccent = ACCENT_BY_ID.get(preferences.themeAccent);
  const customAccent = validThemeColor(preferences.themeAccentCustom);
  const accentSeed =
    customAccent ??
    (!selectedAccent || selectedAccent.id === "preset"
      ? seed.accent
      : selectedAccent[mode] ?? seed.accent);
  const accent = ensureContrast(accentSeed, surface1, 4.5);
  const accentStrong = ensureContrast(accentSeed, surface1, 6);
  const accentInk = betterForeground(accentStrong);
  const semanticTarget = (dark: string, light: string) =>
    ensureContrast(mode === "dark" ? dark : light, surface1, 4.5);
  const shadowTint =
    preferences.themeTextWarmth === "warm" ? "46, 31, 22" : "0, 0, 0";

  return {
    mode,
    canvas,
    canvasDeep,
    surface0,
    surface1,
    surface2,
    surface3,
    surfaceRaised,
    text,
    textSoft,
    muted,
    faint,
    accent,
    accentStrong,
    accentInk,
    mint: semanticTarget("#7bc9b0", "#337f6c"),
    gold: semanticTarget("#d8b675", "#8b671f"),
    rose: semanticTarget("#d792a6", "#a24b68"),
    danger: semanticTarget("#e7909b", "#ad4353"),
    line: rgba(text, mode === "dark" ? 0.13 : 0.12),
    lineStrong: rgba(text, mode === "dark" ? 0.23 : 0.21),
    shadowSm: `0 8px 24px rgba(${shadowTint}, ${mode === "dark" ? 0.18 : 0.07})`,
    shadowMd: `0 18px 50px rgba(${shadowTint}, ${mode === "dark" ? 0.3 : 0.12})`,
    shadowLg: `0 34px 90px rgba(${shadowTint}, ${mode === "dark" ? 0.46 : 0.18})`,
  };
}

export function themeCssVariables(
  preferences: ThemePreferences,
  mode: ResolvedThemeMode,
): Record<`--${string}`, string> {
  const palette = resolveThemePalette(preferences, mode);
  return {
    "--ink": palette.canvas,
    "--ink-deep": palette.canvasDeep,
    "--surface-0": palette.surface0,
    "--surface-1": palette.surface1,
    "--surface-2": palette.surface2,
    "--surface-3": palette.surface3,
    "--surface-raised": palette.surfaceRaised,
    "--line": palette.line,
    "--line-strong": palette.lineStrong,
    "--text": palette.text,
    "--text-soft": palette.textSoft,
    "--muted": palette.muted,
    "--faint": palette.faint,
    "--periwinkle": palette.accent,
    "--periwinkle-strong": palette.accentStrong,
    "--periwinkle-wash": rgba(palette.accent, mode === "dark" ? 0.13 : 0.1),
    "--mint": palette.mint,
    "--mint-wash": rgba(palette.mint, mode === "dark" ? 0.12 : 0.1),
    "--gold": palette.gold,
    "--gold-wash": rgba(palette.gold, mode === "dark" ? 0.12 : 0.1),
    "--rose": palette.rose,
    "--danger": palette.danger,
    "--danger-wash": rgba(palette.danger, mode === "dark" ? 0.1 : 0.09),
    "--accent-ink": palette.accentInk,
    "--theme-canvas-glow": rgba(palette.accent, mode === "dark" ? 0.1 : 0.07),
    "--theme-selection": rgba(palette.accent, mode === "dark" ? 0.32 : 0.22),
    "--theme-grain-dot-1": rgba(palette.text, mode === "dark" ? 0.18 : 0.11),
    "--theme-grain-dot-2": rgba(palette.text, mode === "dark" ? 0.12 : 0.075),
    "--shadow-sm": palette.shadowSm,
    "--shadow-md": palette.shadowMd,
    "--shadow-lg": palette.shadowLg,
  };
}

export function contrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(hexToRgb(foreground));
  const backgroundLuminance = relativeLuminance(hexToRgb(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function ensureContrast(
  foreground: string,
  background: string,
  minimum: number,
): string {
  if (contrastRatio(foreground, background) >= minimum) return foreground;
  const towardWhite = contrastRatio("#ffffff", background);
  const towardBlack = contrastRatio("#000000", background);
  const target = towardWhite >= towardBlack ? "#ffffff" : "#000000";
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const amount = (low + high) / 2;
    if (
      contrastRatio(mixColor(foreground, target, amount), background) >=
      minimum
    ) {
      high = amount;
    } else {
      low = amount;
    }
  }
  return mixColor(foreground, target, high);
}

function clampBackgroundForMode(
  color: string,
  mode: ResolvedThemeMode,
): string {
  const luminance = relativeLuminance(hexToRgb(color));
  if (mode === "dark" && luminance > 0.08) {
    return mixToLuminance(color, "#000000", 0.08, "at-most");
  }
  if (mode === "light" && luminance < 0.68) {
    return mixToLuminance(color, "#ffffff", 0.68, "at-least");
  }
  return color;
}

function mixToLuminance(
  color: string,
  target: string,
  boundary: number,
  direction: "at-most" | "at-least",
): string {
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const amount = (low + high) / 2;
    const candidate = mixColor(color, target, amount);
    const luminance = relativeLuminance(hexToRgb(candidate));
    const reached =
      direction === "at-most" ? luminance <= boundary : luminance >= boundary;
    if (reached) {
      high = amount;
    } else {
      low = amount;
    }
  }
  return mixColor(color, target, high);
}

function validThemeColor(value: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : null;
}

function betterForeground(background: string): string {
  const dark = "#080b12";
  const light = "#ffffff";
  return contrastRatio(dark, background) >= contrastRatio(light, background)
    ? dark
    : light;
}

function mixColor(left: string, right: string, amount: number): string {
  const start = hexToRgb(left);
  const end = hexToRgb(right);
  const weight = clamp(amount, 0, 1);
  return rgbToHex({
    r: Math.round(start.r + (end.r - start.r) * weight),
    g: Math.round(start.g + (end.g - start.g) * weight),
    b: Math.round(start.b + (end.b - start.b) * weight),
  });
}

function rgba(hex: string, alpha: number): string {
  const color = hexToRgb(hex);
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${clamp(alpha, 0, 1)})`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalized)) {
    throw new Error(`Invalid theme color: ${hex}`);
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function rgbToHex(color: { r: number; g: number; b: number }): string {
  const component = (value: number) =>
    Math.round(clamp(value, 0, 255)).toString(16).padStart(2, "0");
  return `#${component(color.r)}${component(color.g)}${component(color.b)}`;
}

function relativeLuminance(color: { r: number; g: number; b: number }): number {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return (
    channel(color.r) * 0.2126 +
    channel(color.g) * 0.7152 +
    channel(color.b) * 0.0722
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
