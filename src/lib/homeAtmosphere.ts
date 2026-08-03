import type {
  HomeAtmosphere,
  HomeAtmosphereMotion,
  HomeAtmosphereTone,
} from "../types";

export interface AtmospherePalette {
  primary: string;
  secondary: string;
  tertiary: string;
  bright: string;
  muted: string;
}

const tonePalettes: Record<
  Exclude<HomeAtmosphereTone, "signature">,
  AtmospherePalette
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

const signaturePalettes: Record<HomeAtmosphere, AtmospherePalette> = {
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
  { id: "signature", name: "Orion" },
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
): AtmospherePalette {
  return tone === "signature"
    ? signaturePalettes[atmosphere]
    : tonePalettes[tone];
}

export function atmosphereMotionValue(
  motion: HomeAtmosphereMotion,
): number {
  if (motion === "still") {
    return 0;
  }
  return motion === "alive" ? 1 : 0.5;
}
