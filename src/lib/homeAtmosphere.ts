import type {
  HomeAtmosphere,
  HomeAtmosphereMotion,
  HomeAtmosphereTone,
} from "../types";
import { contrastRatio, type ThemePalette } from "./theme";

export interface AtmospherePalette {
  primary: string;
  secondary: string;
  tertiary: string;
  bright: string;
  muted: string;
  background: string;
  backgroundSecondary: string;
  isLight: boolean;
}

type AtmosphereStrokePalette = Omit<
  AtmospherePalette,
  "background" | "backgroundSecondary" | "isLight"
>;

const tonePalettes: Record<
  Exclude<HomeAtmosphereTone, "signature">,
  AtmosphereStrokePalette
> = {
  violet: {
    primary: "#A8B3FF",
    secondary: "#8999EC",
    tertiary: "#C1A6E3",
    bright: "#E5E8FF",
    muted: "#5F6999",
  },
  mint: {
    primary: "#7BC9B0",
    secondary: "#69BCA2",
    tertiary: "#88ACC5",
    bright: "#D7F2E9",
    muted: "#47776A",
  },
  gold: {
    primary: "#D8B675",
    secondary: "#C99168",
    tertiary: "#E1C889",
    bright: "#F3DFB5",
    muted: "#846942",
  },
};

const signaturePalettes: Record<HomeAtmosphere, AtmosphereStrokePalette> = {
  "line-waves": {
    primary: "#7BC9B0",
    secondary: "#8FA1E8",
    tertiary: "#A8B3FF",
    bright: "#DDE3FF",
    muted: "#526780",
  },
  field: {
    primary: "#A8B3FF",
    secondary: "#7DB0CB",
    tertiary: "#75C9B0",
    bright: "#E2E6FF",
    muted: "#536982",
  },
  "signal-decay": {
    primary: "#D8B675",
    secondary: "#C98A70",
    tertiary: "#E4C98D",
    bright: "#F3DFB5",
    muted: "#806541",
  },
};

export const atmosphereToneOptions: Array<{
  id: HomeAtmosphereTone;
  name: string;
}> = [
  { id: "signature", name: "Theme" },
  { id: "violet", name: "Violet" },
  { id: "mint", name: "Mint" },
  { id: "gold", name: "Gold" },
];

export const atmosphereMotionOptions: Array<{
  id: HomeAtmosphereMotion;
  name: string;
}> = [
  { id: "still", name: "Still" },
  { id: "calm", name: "Calm" },
  { id: "alive", name: "Alive" },
];

export function resolveAtmospherePalette(
  atmosphere: HomeAtmosphere,
  tone: HomeAtmosphereTone,
  themePalette?: ThemePalette,
): AtmospherePalette {
  const strokes =
    tone === "signature"
      ? themePalette
        ? themeSignaturePalette(atmosphere, themePalette)
        : signaturePalettes[atmosphere]
      : tonePalettes[tone];
  const resolvedStrokes = themePalette
    ? {
        primary: ensureSignalContrast(strokes.primary, themePalette),
        secondary: ensureSignalContrast(strokes.secondary, themePalette),
        tertiary: ensureSignalContrast(strokes.tertiary, themePalette),
        bright: themePalette.text,
        muted: themePalette.muted,
      }
    : strokes;

  return {
    ...resolvedStrokes,
    background: themePalette?.canvasDeep ?? "#09101d",
    backgroundSecondary: themePalette?.surface0 ?? "#101726",
    isLight: themePalette?.mode === "light",
  };
}

function ensureSignalContrast(
  color: string,
  palette: ThemePalette,
  minimum = 3,
): string {
  const backgrounds = [palette.canvasDeep, palette.surface0];
  const hasEnoughContrast = (candidate: string) =>
    backgrounds.every(
      (background) => contrastRatio(candidate, background) >= minimum,
    );
  if (hasEnoughContrast(color)) return color;

  const target = palette.mode === "dark" ? "#FFFFFF" : "#000000";
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 18; iteration += 1) {
    const amount = (low + high) / 2;
    if (hasEnoughContrast(mixHex(color, target, amount))) {
      high = amount;
    } else {
      low = amount;
    }
  }
  return mixHex(color, target, high);
}

function mixHex(left: string, right: string, amount: number): string {
  const parse = (hex: string) => {
    const value = hex.replace(/^#/, "");
    return [
      Number.parseInt(value.slice(0, 2), 16),
      Number.parseInt(value.slice(2, 4), 16),
      Number.parseInt(value.slice(4, 6), 16),
    ] as const;
  };
  const start = parse(left);
  const end = parse(right);
  const component = (index: number) =>
    Math.round(start[index] + (end[index] - start[index]) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${component(0)}${component(1)}${component(2)}`;
}

function themeSignaturePalette(
  atmosphere: HomeAtmosphere,
  palette: ThemePalette,
): AtmosphereStrokePalette {
  if (atmosphere === "line-waves") {
    return {
      primary: palette.mint,
      secondary: palette.accent,
      tertiary: palette.accentStrong,
      bright: palette.text,
      muted: palette.muted,
    };
  }
  if (atmosphere === "field") {
    return {
      primary: palette.accentStrong,
      secondary: palette.accent,
      tertiary: palette.mint,
      bright: palette.text,
      muted: palette.muted,
    };
  }
  return {
    primary: palette.accent,
    secondary: palette.gold,
    tertiary: palette.accentStrong,
    bright: palette.text,
    muted: palette.muted,
  };
}

export function atmosphereMotionValue(
  motion: HomeAtmosphereMotion,
): number {
  if (motion === "still") {
    return 0;
  }
  return motion === "alive" ? 1 : 0.5;
}
